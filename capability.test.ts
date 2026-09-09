import { expect, test } from "bun:test";
import { CapabilityRegistry } from "gloomberb/capabilities";
import { createTvStreamCapability, TV_STREAM_CAPABILITY_ID } from "./capability";
import { getTvChannel } from "./channels";
import { fallbackTvStream } from "./youtube-embed";

test("the renderer resolves only known channels through the native capability and forwards refresh", async () => {
  const registry = new CapabilityRegistry();
  const calls: string[] = [];
  const unregister = registry.register("tv", createTvStreamCapability(async (channel, options) => {
    calls.push(`${channel.id}:${options.force}`);
    return fallbackTvStream(channel, { videoId: "abcdefghijk" });
  }));
  const result = await registry.invoke<{ sourceId: string }>(TV_STREAM_CAPABILITY_ID, "resolve", { sourceId: "cnbc", force: true }, { renderer: true });
  expect(result.sourceId).toBe(getTvChannel("cnbc").id);
  expect(calls).toEqual(["cnbc:true"]);
  await expect(registry.invoke(TV_STREAM_CAPABILITY_ID, "resolve", { sourceId: "unknown" }, { renderer: true })).rejects.toThrow("Unknown TV channel");
  await expect(registry.invoke(TV_STREAM_CAPABILITY_ID, "resolve", { sourceId: "cnbc", force: "yes" }, { renderer: true })).rejects.toThrow("boolean");
  unregister();
  await expect(registry.invoke(TV_STREAM_CAPABILITY_ID, "resolve", { sourceId: "cnbc" }, { renderer: true })).rejects.toThrow();
});

test("the desktop entry bundles without the native resolver or duplicate host modules", async () => {
  const result = await Bun.build({ entrypoints: [new URL("./index.browser.ts", import.meta.url).pathname], target: "browser", external: ["gloomberb/*", "react", "react/*"] });
  expect(result.success).toBe(true);
  const bundle = await result.outputs[0]!.text();
  expect(bundle).toContain("tv.stream");
  expect(bundle).not.toContain("Innertube");
  expect(bundle).not.toContain("youtubei.js");
});
