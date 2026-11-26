import type { ResolvedLiveStream } from "./types";
import { buildYoutubeLiveEmbedUrl, isYoutubeEmbedUrl } from "./youtube-embed";

const INCOMPATIBLE_CODECS = "manifestIncompatibleCodecsError";

export function isIncompatibleCodecError(message: string | null): boolean {
  return message === INCOMPATIBLE_CODECS || message?.endsWith(`: ${INCOMPATIBLE_CODECS}`) === true;
}

export function desktopPlaybackFailure(message: string | null, watchUrl: string) {
  return {
    message: isIncompatibleCodecError(message)
      ? "This desktop app doesn't support the video format for this stream."
      : "This stream couldn't play in the desktop app.",
    open: { label: "Open in browser", url: watchUrl },
  };
}

export function desktopMediaSource(stream: ResolvedLiveStream, origin?: string): string {
  if (!isYoutubeEmbedUrl(stream.manifestUrl)) return stream.manifestUrl;
  return buildYoutubeLiveEmbedUrl(stream.videoId, { muted: true, origin, widgetReferrer: origin });
}
