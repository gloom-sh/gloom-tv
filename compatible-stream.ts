import { randomUUID } from "node:crypto";
import type { ResolvedLiveStream } from "./types";
import { isYoutubeEmbedUrl } from "./youtube-embed";

const LOOPBACK = "127.0.0.1";
const FFMPEG_PACKAGE = "@seydx/node-av-ffmpeg-lgpl-win32-x64";

function findTranscoder(): string | null {
  if (process.platform === "win32" && process.arch === "x64") {
    try {
      return require.resolve(`${FFMPEG_PACKAGE}/ffmpeg.exe`);
    } catch {}
  }
  return Bun.which("ffmpeg");
}

export function selectHlsVariant(playlist: string, manifestUrl: string): string {
  const variants = [...playlist.matchAll(/^#EXT-X-STREAM-INF:[^\r\n]*\bRESOLUTION=\d+x(\d+)[^\r\n]*\r?\n([^#\r\n][^\r\n]*)/gm)]
    .map(([, height, uri]) => ({ height: Number(height), uri: uri! }))
    .sort((left, right) => right.height - left.height);
  const variant = variants.find(({ height }) => height <= 360) ?? variants.at(-1);
  return variant ? new URL(variant.uri, manifestUrl).href : manifestUrl;
}

interface StreamTicket {
  token: string;
  manifestUrl: string;
  expiresAt: number;
}

export function createCompatibleStreams(transcoder = findTranscoder()) {
  const tickets = new Map<string, StreamTicket>();
  const processes = new Set<Bun.Subprocess<"ignore", "pipe", "ignore">>();
  let server: Bun.Server<undefined> | undefined;

  async function respond(request: Request): Promise<Response> {
    const activeServer = server;
    const url = new URL(request.url);
    const ticket = tickets.get(url.pathname);
    if (request.method !== "GET" || url.hostname !== LOOPBACK || !ticket || ticket.expiresAt <= Date.now() || !transcoder) {
      return new Response(null, { status: 404 });
    }

    try {
      const manifest = await fetch(ticket.manifestUrl, { signal: AbortSignal.timeout(10_000) });
      if (!manifest.ok) return new Response(null, { status: 502 });
      const variantUrl = selectHlsVariant(await manifest.text(), manifest.url);
      if (request.signal.aborted || server !== activeServer) return new Response(null, { status: 503 });
      const process = Bun.spawn([
        transcoder, "-nostdin", "-loglevel", "error", "-rw_timeout", "10000000",
        "-protocol_whitelist", "https,tls,tcp,crypto", "-f", "hls", "-live_start_index", "-2", "-i", variantUrl,
        "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=-2:'min(360,ih)'", "-r", "30",
        "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "6", "-b:v", "650k", "-g", "60",
        "-c:a", "libopus", "-b:a", "64k", "-f", "webm", "-live", "1", "-cluster_time_limit", "500", "pipe:1",
      ], { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
      processes.add(process);
      void process.exited.then(() => processes.delete(process));
      const reader = process.stdout.getReader();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel() {
          if (process.exitCode === null) process.kill();
          return reader.cancel();
        },
      }), {
        headers: { "Content-Type": "video/webm", "Cache-Control": "no-store" },
      });
    } catch {
      return new Response(null, { status: 502 });
    }
  }

  return {
    url(stream: ResolvedLiveStream): string | undefined {
      if (!transcoder || isYoutubeEmbedUrl(stream.manifestUrl)) return undefined;
      const now = Date.now();
      for (const [path, ticket] of tickets) {
        if (ticket.expiresAt <= now) tickets.delete(path);
      }
      try {
        if (!server) {
          server = Bun.serve({ hostname: LOOPBACK, port: 0, idleTimeout: 30, fetch: respond });
          server.unref();
        }
      } catch {
        return undefined;
      }
      const existing = [...tickets.values()].find(({ manifestUrl }) => manifestUrl === stream.manifestUrl);
      const ticket = existing ?? { token: `/${randomUUID()}`, manifestUrl: stream.manifestUrl, expiresAt: stream.expiresAt };
      tickets.set(ticket.token, ticket);
      return new URL(ticket.token, server.url).href;
    },
    dispose() {
      tickets.clear();
      void server?.stop(true);
      server = undefined;
      for (const process of processes) process.kill();
      processes.clear();
    },
  };
}
