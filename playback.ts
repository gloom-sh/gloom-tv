import type { ResolvedLiveStream } from "./types";
import { buildYoutubeLiveEmbedUrl, isValidYoutubeVideoId, isYoutubeEmbedUrl } from "./youtube-embed";

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "error";
export type PlaybackMode = "hls" | "compatible" | "unavailable";

export function desktopPlaybackSupport(
  video: Pick<HTMLVideoElement, "canPlayType">,
  mediaSource?: Pick<typeof MediaSource, "isTypeSupported">,
) {
  return {
    hls: !!video.canPlayType("application/vnd.apple.mpegurl") || !!(
      mediaSource?.isTypeSupported('video/mp4; codecs="avc1.42C00B"') &&
      mediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')
    ),
    compatible: !!video.canPlayType('video/webm; codecs="vp8, opus"'),
  };
}

export function chooseDesktopPlayback(support: ReturnType<typeof desktopPlaybackSupport> | null, preferCompatible = false): PlaybackMode {
  if (support?.hls && !preferCompatible) return "hls";
  return support?.compatible ? "compatible" : "unavailable";
}

export function selectDesktopSource(stream: ResolvedLiveStream, mode: PlaybackMode, origin?: string) {
  if (mode === "compatible") {
    return stream.compatibleUrl ? { kind: "compatible" as const, src: stream.compatibleUrl } : null;
  }
  if (mode === "unavailable") return null;
  if (!isYoutubeEmbedUrl(stream.manifestUrl)) return { kind: "hls" as const, src: stream.manifestUrl };
  if (!origin || !/^https?:\/\//.test(origin) || !isValidYoutubeVideoId(stream.videoId)) return null;
  return { kind: "embed" as const, src: buildYoutubeLiveEmbedUrl(stream.videoId, { origin }) };
}
