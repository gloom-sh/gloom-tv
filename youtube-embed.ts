import type { ResolvedLiveStream } from "./types";
import type { TvChannel } from "./channels";
import { gridVideoCandidates, isValidYoutubeVideoId, verifyWatchVideo, youtubePageUrl } from "./youtube-evidence";

const MAX_WATCH_CHECKS = 6;
const MAX_LIVE_WATCH_CHECKS = 3;
const WATCH_PROBE_TIMEOUT_MS = 1500;

export function buildYoutubeLiveEmbedUrl(
  videoId: string,
  options?: { muted?: boolean; origin?: string; widgetReferrer?: string },
): string {
  if (!isValidYoutubeVideoId(videoId)) {
    throw new Error("A concrete YouTube video ID is required for an embed URL.");
  }
  const params = new URLSearchParams({
    autoplay: "1",
    mute: options?.muted === false ? "0" : "1",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
    enablejsapi: "1",
  });
  if (options?.origin) {
    params.set("origin", options.origin);
    params.set("widget_referrer", options.widgetReferrer ?? options.origin);
  }
  return `https://www.youtube.com/embed/${videoId}?${params}`;
}

export function isYoutubeEmbedUrl(url: string): boolean {
  return /https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//.test(url);
}

export function fallbackTvStream(
  channel: TvChannel,
  options: { muted?: boolean; videoId: string; title?: string; isLive?: boolean; publishedText?: string },
): ResolvedLiveStream {
  const now = Date.now();
  return {
    provider: "youtube",
    sourceId: channel.id,
    videoId: options.videoId,
    title: options?.title?.trim() || `${channel.name} ${options.isLive === false ? "latest video" : "Live"}`,
    isLive: options.isLive ?? true,
    publishedText: options.publishedText,
    manifestUrl: buildYoutubeLiveEmbedUrl(options.videoId, {
      muted: options.muted,
    }),
    watchUrl: `https://www.youtube.com/watch?v=${options.videoId}`,
    resolvedAt: now,
    expiresAt: now + 10 * 60 * 1000,
  };
}

function publicPageUrl(response: Response): URL {
  if (response.url.startsWith("https://consent.youtube.com/")) throw new Error("YouTube returned a consent page.");
  const pageUrl = youtubePageUrl(response.url);
  if (!pageUrl || !/^\/(?:watch$|channel\/|@|c\/|user\/)/.test(pageUrl.pathname)) {
    throw new Error("YouTube did not return a public channel or watch page.");
  }
  return pageUrl;
}

async function fetchYoutubePage(url: string, fetchImpl: typeof fetch, kind: "live" | "videos" | "watch", signal?: AbortSignal): Promise<{ pageUrl: URL; html: string } | undefined> {
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...(kind !== "watch" ? { "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+667" } : {}),
    },
    ...(kind === "watch" ? { credentials: "omit", signal } : {}),
    redirect: "follow",
  });
  if (kind === "watch") {
    if (signal?.aborted) {
      void response.body?.cancel().catch(() => {});
      return;
    }
    const pageUrl = publicPageUrl(response);
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`YouTube watch page is unavailable (${response.status}).`);
    const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal });
    return { pageUrl, html: await (body ? new Response(body) : response).text() };
  }
  const html = await response.text();
  const pageUrl = publicPageUrl(response);
  if (pageUrl.pathname !== "/watch" && /(?:Before you continue to YouTube|consent\.youtube\.com)/i.test(html)) {
    throw new Error("YouTube returned a consent page.");
  }
  if (response.status === 404 && kind !== "videos") return;
  if (!response.ok) throw new Error(`YouTube ${kind} page is unavailable (${response.status}).`);
  return { pageUrl, html };
}

async function probeYoutubeWatch(videoId: string, fetchImpl: typeof fetch) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), WATCH_PROBE_TIMEOUT_MS);
      }),
      fetchYoutubePage(`https://www.youtube.com/watch?v=${videoId}`, fetchImpl, "watch", controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function resolveYoutubeLivePage(
  channel: TvChannel,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedLiveStream> {
  const baseUrl = `https://www.youtube.com/channel/${channel.channelId}`;
  let checksLeft = MAX_WATCH_CHECKS;
  for (const kind of ["live", "videos"] as const) {
    const page = await fetchYoutubePage(`${baseUrl}/${kind}`, fetchImpl, kind);
    if (!page) continue;
    const isLive = kind === "live";
    if (page.pageUrl.pathname === "/watch") {
      const verified = verifyWatchVideo(page.html, page.pageUrl, channel.channelId, isLive);
      if (isLive && verified) return fallbackTvStream(channel, verified);
      continue;
    }
    const candidates = gridVideoCandidates(page.html, page.pageUrl, channel.channelId, isLive);
    for (const candidate of candidates.slice(0, isLive ? MAX_LIVE_WATCH_CHECKS : checksLeft)) {
      checksLeft--;
      const watch = await probeYoutubeWatch(candidate.videoId, fetchImpl);
      if (!watch) continue;
      const verified = verifyWatchVideo(watch.html, watch.pageUrl, channel.channelId, isLive, candidate.videoId);
      if (verified) return fallbackTvStream(channel, { ...verified, publishedText: candidate.publishedText });
    }
  }
  throw new Error(`${channel.name} does not currently have a verified public video.`);
}
