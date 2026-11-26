import { expect, test } from "bun:test";
import { TV_CHANNELS } from "./channels";
import { chooseDesktopPlayback, desktopPlaybackSupport, selectDesktopSource } from "./playback";
import { fallbackTvStream } from "./youtube-embed";

const embed = fallbackTvStream(TV_CHANNELS[0], { videoId: "abcdefghijk" });
const hls = { ...embed, manifestUrl: "https://manifest.googlevideo.com/live.m3u8" };
const compatibleUrl = "http://127.0.0.1:12345/ticket";
const video = ({ nativeHls = false, webm = true } = {}) => ({
  canPlayType: (type: string): CanPlayTypeResult => (
    type === "application/vnd.apple.mpegurl" ? nativeHls : type.includes("video/webm") && webm
  ) ? "probably" : "",
});

test("native HLS and AVC/AAC MSE both retain HLS", () => {
  const native = chooseDesktopPlayback(desktopPlaybackSupport(video({ nativeHls: true })));
  const mse = chooseDesktopPlayback(desktopPlaybackSupport(video(), { isTypeSupported: () => true }));
  expect(native).toBe("hls");
  expect(mse).toBe("hls");
  expect(selectDesktopSource({ ...hls, compatibleUrl }, mse, "views://mainview")).toEqual({ kind: "hls", src: hls.manifestUrl });
});

test("Chromium without either required MSE codec uses WebM even on a custom origin", () => {
  for (const missing of ["avc1", "mp4a"]) {
    const mode = chooseDesktopPlayback(desktopPlaybackSupport(video(), { isTypeSupported: (type) => !type.includes(missing) }));
    expect(mode).toBe("compatible");
    expect(selectDesktopSource({ ...hls, compatibleUrl }, mode, "views://mainview")).toEqual({ kind: "compatible", src: compatibleUrl });
    expect(selectDesktopSource(hls, mode)).toBeNull();
  }
  expect(chooseDesktopPlayback({ hls: true, compatible: true }, true)).toBe("compatible");
  expect(chooseDesktopPlayback(desktopPlaybackSupport(video({ webm: false })))).toBe("unavailable");
});

test("the embed is used only when the parent can identify itself", () => {
  expect(selectDesktopSource(embed, "hls", "views://mainview")).toBeNull();
  expect(selectDesktopSource(embed, "hls", "null")).toBeNull();
  const source = selectDesktopSource(embed, "hls", "https://example.com");
  expect(source?.kind).toBe("embed");
  expect(new URL(source!.src).searchParams.get("origin")).toBe("https://example.com");
});
