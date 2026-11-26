import { tvPlugin } from "./plugin";
import { createTvStreamCapability } from "./capability";
import { resetTvStreams, resolveTvStream } from "./youtube-stream";

export default {
  ...tvPlugin,
  capabilities: [createTvStreamCapability(resolveTvStream)],
  dispose: resetTvStreams,
};
