import type { PluginCapability } from "gloomberb/capabilities";
import { TV_CHANNELS, type TvChannel } from "./channels";
import type { ResolvedLiveStream } from "./types";

export const TV_STREAM_CAPABILITY_ID = "tv.stream";
type StreamResolver = (channel: TvChannel, options: { force: boolean }) => Promise<ResolvedLiveStream>;

/** Native resolution is invoked through the same capability API on every renderer. */
export function createTvStreamCapability(resolve: StreamResolver): PluginCapability {
  return {
    id: TV_STREAM_CAPABILITY_ID,
    kind: "plugin-service",
    name: "TV streams",
    operations: {
      resolve: {
        kind: "query",
        rendererSafe: true,
        input: {
          parse(value: unknown) {
            const input = value as { sourceId?: unknown; force?: unknown } | null;
            const channel = TV_CHANNELS.find(({ id }) => id === input?.sourceId);
            if (!channel) throw new Error("Unknown TV channel.");
            if (input?.force !== undefined && typeof input.force !== "boolean") throw new Error("force must be a boolean.");
            return { channel, force: input?.force === true };
          },
        },
        handler: ({ channel, force }) => resolve(channel, { force }),
      },
    },
  };
}
