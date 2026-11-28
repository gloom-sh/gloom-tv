import type { ResolvedLiveStream } from "./types";
import type { TvChannel } from "./channels";
import { findGridVideo, findWatchLive, isValidYoutubeVideoId, youtubePageUrl } from "./youtube-evidence";

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

async function fetchYoutubePage(url: string, fetchImpl: typeof fetch): Promise<{ pageUrl: URL; html: string }> {
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+667",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`YouTube live page is unavailable (${response.status}).`);
  }
  const html = await response.text();
  if (response.url.startsWith("https://consent.youtube.com/") || /Before you continue to YouTube/i.test(html)) {
    throw new Error("YouTube returned a consent page.");
  }
  const pageUrl = youtubePageUrl(response.url);
  if (!pageUrl || !/^\/(?:watch$|channel\/|@|c\/|user\/)/.test(pageUrl.pathname)) {
    throw new Error("YouTube did not return a public channel or watch page.");
  }
  return { pageUrl, html };
}

export async function resolveYoutubeLivePage(
  channel: TvChannel,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedLiveStream> {
  const baseUrl = `https://www.youtube.com/channel/${channel.channelId}`;
  const livePage = await fetchYoutubePage(`${baseUrl}/live`, fetchImpl);
  const live = livePage.pageUrl.pathname === "/watch"
    ? findWatchLive(livePage.html, livePage.pageUrl, channel.channelId)
    : findGridVideo(livePage.html, livePage.pageUrl, channel.channelId, true);
  if (live) return fallbackTvStream(channel, live);

  const videosPage = await fetchYoutubePage(`${baseUrl}/videos`, fetchImpl);
  const replay = videosPage.pageUrl.pathname !== "/watch" && findGridVideo(videosPage.html, videosPage.pageUrl, channel.channelId, false);
  if (replay) return fallbackTvStream(channel, replay);
  throw new Error(`${channel.name} does not currently have a verified public video.`);
}
