import { expect, test } from "bun:test";
import { TV_CHANNELS } from "./channels";
import { desktopMediaSource, desktopPlaybackFailure, isIncompatibleCodecError } from "./desktop-playback";
import { fallbackTvStream } from "./youtube-embed";

const embed = fallbackTvStream(TV_CHANNELS[0], { videoId: "abcdefghijk" });

test("a resolved HLS source goes to the host unchanged", () => {
  const manifestUrl = "https://manifest.googlevideo.com/live.m3u8";
  const stream = { ...embed, manifestUrl };
  expect(desktopMediaSource(stream)).toBe(manifestUrl);
  expect(desktopMediaSource(stream, "https://example.com")).toBe(manifestUrl);
});

test("a resolved embed remains available with or without an HTTP origin", () => {
  expect(desktopMediaSource(embed)).toBe(embed.manifestUrl);
  const src = new URL(desktopMediaSource(embed, "https://example.com"));
  expect(src.pathname).toBe("/embed/abcdefghijk");
  expect(src.searchParams.get("mute")).toBe("1");
  expect(src.searchParams.get("origin")).toBe("https://example.com");
});

test("an incompatible manifest offers a direct watch link without exposing the raw error", () => {
  const error = "Stream playback failed: manifestIncompatibleCodecsError";
  expect(isIncompatibleCodecError(error)).toBe(true);
  expect(desktopPlaybackFailure(error, embed.watchUrl)).toEqual({
    message: "This desktop app doesn't support the video format for this stream.",
    open: { label: "Open in browser", url: "https://www.youtube.com/watch?v=abcdefghijk" },
  });
});

test("other media failures remain eligible for recovery without exposing internal details", () => {
  const error = "Stream playback failed: manifestLoadError";
  expect(isIncompatibleCodecError(error)).toBe(false);
  expect(desktopPlaybackFailure(error, embed.watchUrl).message).toBe("This stream couldn't play in the desktop app.");
});
