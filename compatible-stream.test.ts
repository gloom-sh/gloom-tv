import { expect, test } from "bun:test";
import { TV_CHANNELS } from "./channels";
import { createCompatibleStreams, selectHlsVariant } from "./compatible-stream";
import { fallbackTvStream } from "./youtube-embed";

const embed = fallbackTvStream(TV_CHANNELS[0], { videoId: "abcdefghijk" });
const manifestUrl = "https://manifest.googlevideo.com/live.m3u8";
const hls = { ...embed, manifestUrl };

test("the compatible player takes one small rendition instead of opening the whole ladder", () => {
  const master = "#EXTM3U\r\n#EXT-X-STREAM-INF:RESOLUTION=640x360\r\n360.m3u8\r\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\r\n720.m3u8\r\n#EXT-X-STREAM-INF:RESOLUTION=426x240\r\n240.m3u8\r\n";
  expect(selectHlsVariant(master, manifestUrl)).toBe("https://manifest.googlevideo.com/360.m3u8");
  expect(selectHlsVariant("#EXTM3U\n#EXTINF:5,\nsegment.ts", manifestUrl)).toBe(manifestUrl);
});

test("the compatible endpoint is loopback-only, refuses unknown and expired tickets, and closes on dispose", async () => {
  const compatible = createCompatibleStreams("unused-in-this-test");
  try {
    expect(compatible.url(embed)).toBeUndefined();
    expect(createCompatibleStreams(null).url(hls)).toBeUndefined();
    const ticket = new URL(compatible.url(hls)!);
    expect(ticket.hostname).toBe("127.0.0.1");
    expect((await fetch(new URL("/unknown", ticket))).status).toBe(404);
    expect((await fetch(ticket, { method: "POST" })).status).toBe(404);
    const expired = compatible.url({ ...hls, manifestUrl: `${manifestUrl}?expired`, expiresAt: 0 })!;
    expect((await fetch(expired)).status).toBe(404);
    compatible.dispose();
    await expect(fetch(ticket)).rejects.toThrow();
  } finally {
    compatible.dispose();
  }
});
