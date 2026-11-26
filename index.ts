import { tvPlugin } from "./plugin";
import { createTvStreamCapability } from "./capability";
import { createCompatibleStreams } from "./compatible-stream";
import { resetTvStreams, resolveTvStream } from "./youtube-stream";

const compatibleStreams = createCompatibleStreams();

export default {
  ...tvPlugin,
  capabilities: [createTvStreamCapability(async (channel, { force, compatible }) => {
    const stream = await resolveTvStream(channel, { force });
    return compatible ? { ...stream, compatibleUrl: compatibleStreams.url(stream) } : stream;
  })],
  dispose() {
    compatibleStreams.dispose();
    resetTvStreams();
  },
};
