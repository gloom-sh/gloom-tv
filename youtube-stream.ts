import { TV_CHANNELS, type TvChannel } from "./channels";
import type { ResolvedLiveStream } from "./types";
import { resolveYoutubeLivePage } from "./youtube-embed";
import { isValidYoutubeVideoId } from "./youtube-evidence";

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_LIVE_CANDIDATES = 6;

export interface ResolvedTvStream extends ResolvedLiveStream {
  sourceId: TvChannel["id"];
}

type YoutubeModule = typeof import("youtubei.js");
type YoutubeClient = InstanceType<YoutubeModule["Innertube"]>;

let clientPromise: Promise<YoutubeClient> | null = null;
const streamCache = new Map<TvChannel["id"], ResolvedTvStream>();
const activeResolutions = new Map<TvChannel["id"], Promise<ResolvedTvStream>>();

async function getYoutubeClient(): Promise<{ client: YoutubeClient; module: YoutubeModule }> {
  const module = await import("youtubei.js");
  module.Log.setLevel(module.Log.Level.ERROR);
  clientPromise ??= module.Innertube.create({
    generate_session_locally: true,
    enable_session_cache: true,
  });
  return { client: await clientPromise, module };
}

function isTvSourceId(sourceId: string): sourceId is TvChannel["id"] {
  return TV_CHANNELS.some((channel) => channel.id === sourceId);
}

function asResolvedTvStream(stream: ResolvedLiveStream): ResolvedTvStream {
  if (!isTvSourceId(stream.sourceId)) {
    throw new Error(`Unknown TV channel: ${stream.sourceId}`);
  }
  return { ...stream, sourceId: stream.sourceId };
}

function usableCachedStream(sourceId: TvChannel["id"]): ResolvedTvStream | null {
  const cached = streamCache.get(sourceId);
  if (!cached) return null;
  const validUntil = Math.min(cached.resolvedAt + CACHE_TTL_MS, cached.expiresAt - 60_000);
  return Date.now() < validUntil ? cached : null;
}

async function resolveLiveStream(channel: TvChannel): Promise<ResolvedTvStream> {
  const { client, module } = await getYoutubeClient();
  const channelFeed = await client.getChannel(channel.channelId);
  if (!channelFeed.has_live_streams) {
    throw new Error(`${channel.name} does not currently expose a live stream.`);
  }

  const liveFeed = await channelFeed.getLiveStreams();
  const { YTNodes } = module;
  const browse = liveFeed.page.contents?.item();
  const tab = liveFeed.current_tab;
  const grid = tab?.content;
  if (liveFeed.metadata.external_id !== channel.channelId
    || !browse?.is(YTNodes.TwoColumnBrowseResults) || browse.tabs.filter((item) => item.selected).length !== 1
    || !tab?.endpoint.metadata.url?.endsWith("/streams") || tab.endpoint.payload.browseId !== channel.channelId
    || !grid?.is(YTNodes.RichGrid)) {
    throw new Error(`${channel.name} did not return a verified live grid.`);
  }
  const cards = grid.contents.flatMap((item) => {
    const card = item.is(YTNodes.RichItem) ? item.content : undefined;
    return card?.is(YTNodes.LockupView) && card.content_type === "VIDEO" ? [card] : [];
  });
  const idCounts = new Map<string, number>();
  for (const card of cards) idCounts.set(card.content_id, (idCounts.get(card.content_id) ?? 0) + 1);

  for (const candidate of cards.slice(0, MAX_LIVE_CANDIDATES)) {
    const videoId = candidate.content_id;
    const tap = candidate.renderer_context.command_context?.on_tap;
    const ownerParts = candidate.metadata?.metadata?.metadata_rows.flatMap((row) => row.metadata_parts ?? []) ?? [];
    const ownerIds = ownerParts.flatMap((part) => part.text?.runs ?? []).map((run) =>
      "endpoint" in run ? run.endpoint?.payload.browseId : undefined);
    if (!isValidYoutubeVideoId(videoId) || idCounts.get(videoId) !== 1 || (tap && tap.payload.videoId !== videoId)
      || ownerIds.some((owner) => typeof owner === "string" && owner.startsWith("UC") && owner !== channel.channelId)) continue;

    const info = await client.getBasicInfo(videoId, { client: "ANDROID" }).catch(() => null);
    const manifestUrl = info?.streaming_data?.hls_manifest_url;
    const details = info?.basic_info;
    const title = details?.title?.trim();
    if (!info || !manifestUrl || !title || details?.id !== videoId || details.channel_id !== channel.channelId
      || (details.channel?.id !== undefined && details.channel.id !== channel.channelId)
      || details.is_live !== true || details.is_upcoming || details.is_private || details.is_unlisted
      || details.is_post_live_dvr || details.end_timestamp
      || info.playability_status?.status !== "OK" || info.playability_status.error_screen) continue;

    const thumbnails = details.thumbnail ?? [];
    const poster = thumbnails.reduce<(typeof thumbnails)[number] | undefined>((best, item) => {
      if (!best) return item;
      return (item.width ?? 0) * (item.height ?? 0) > (best.width ?? 0) * (best.height ?? 0) ? item : best;
    }, undefined);
    const resolvedAt = Date.now();
    const expiresAt = info.streaming_data?.expires?.getTime() ?? resolvedAt + CACHE_TTL_MS;

    return {
      provider: "youtube",
      sourceId: channel.id,
      videoId,
      title,
      isLive: true,
      manifestUrl,
      watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
      posterUrl: poster?.url,
      resolvedAt,
      expiresAt,
    };
  }

  throw new Error(`${channel.name} does not currently have a playable public live stream.`);
}

async function resolveUncached(channel: TvChannel): Promise<ResolvedTvStream> {
  try {
    return await resolveLiveStream(channel);
  } catch (liveError) {
    try {
      return asResolvedTvStream(await resolveYoutubeLivePage(channel));
    } catch {
      throw liveError;
    }
  }
}

export function resolveTvStream(
  channel: TvChannel,
  options?: { force?: boolean },
): Promise<ResolvedTvStream> {
  if (!options?.force) {
    const cached = usableCachedStream(channel.id);
    if (cached) return Promise.resolve(cached);
    const active = activeResolutions.get(channel.id);
    if (active) return active;
  }

  const resolution = resolveUncached(channel)
    .then((stream) => {
      if (activeResolutions.get(channel.id) === resolution) streamCache.set(channel.id, stream);
      return stream;
    })
    .finally(() => {
      if (activeResolutions.get(channel.id) === resolution) {
        activeResolutions.delete(channel.id);
      }
    });
  activeResolutions.set(channel.id, resolution);
  return resolution;
}

export function resetTvStreams(): void {
  streamCache.clear();
  activeResolutions.clear();
  clientPromise = null;
}
