import { expect, mock, spyOn, test } from "bun:test";
import { Innertube, YT } from "youtubei.js";
import { TV_CHANNELS } from "./channels";
import { channelGrid, liveLockup, page, playerResponse, replayCard, youtubePages } from "./youtube-fixtures";
import { resetTvStreams, resolveTvStream } from "./youtube-stream";

const [channel, other] = TV_CHANNELS;
const candidateId = "abcdefghijk";
const validId = "xyzXYZ-_123";
const replayId = "zyxwvutsrqp";
const manifestUrl = "https://example.test/live.m3u8";
const actions = {} as ConstructorParameters<typeof YT.Channel>[0];

function info(player: object) {
  return new YT.VideoInfo([{ success: true, status_code: 200, data: {
    ...player, streamingData: { hlsManifestUrl: manifestUrl, expiresInSeconds: "1800", formats: [], adaptiveFormats: [] },
  } }], actions, "fixture");
}

async function withResolver(
  browse: object,
  lookup: (id: string) => YT.VideoInfo,
  check: (getInfo: ReturnType<typeof mock<(id: string, options: { client: string }) => Promise<YT.VideoInfo>>>) => Promise<void>,
  fetchPage = youtubePages(),
) {
  const getInfo = mock(async (id: string, _options: { client: string }) => lookup(id));
  const feed = new YT.Channel(actions, { success: true, status_code: 200, data: browse });
  const create = spyOn(Innertube, "create").mockResolvedValue({
    getChannel: async () => feed,
    getBasicInfo: getInfo,
  } as unknown as Innertube);
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchPage);
  resetTvStreams();
  try {
    await check(getInfo);
  } finally {
    resetTvStreams();
    fetchSpy.mockRestore();
    create.mockRestore();
  }
}

for (const [index, source] of TV_CHANNELS.entries()) {
  test(`${source.name} skips another publisher's HLS and caches the verified candidate`, async () => {
    const foreign = TV_CHANNELS[(index + 1) % TV_CHANNELS.length]!;
    await withResolver(channelGrid(source.channelId, "streams", [liveLockup(candidateId, "Foreign"), liveLockup(validId, "Not the player title")]),
      (id) => info(playerResponse(id, id === candidateId ? foreign.channelId : source.channelId, { title: "Verified player title" })),
      async (getInfo) => {
        const stream = await resolveTvStream(source);
        expect(stream).toMatchObject({ videoId: validId, sourceId: source.id, manifestUrl, isLive: true, title: "Verified player title" });
        expect(await resolveTvStream(source)).toBe(stream);
        expect(getInfo.mock.calls).toEqual([[candidateId, { client: "ANDROID" }], [validId, { client: "ANDROID" }]]);
      });
  });
}

for (const [name, player] of [
  ["missing canonical owner", playerResponse(candidateId, undefined)],
  ["a substituted video ID", playerResponse(validId, channel.channelId)],
  ["a missing video ID", playerResponse(candidateId, channel.channelId, { videoId: undefined })],
  ["a missing title", playerResponse(candidateId, channel.channelId, { title: undefined })],
  ["conflicting canonical owners", { ...playerResponse(candidateId, channel.channelId), microformat: { playerMicroformatRenderer: { externalChannelId: other.channelId } } }],
  ["an ended live broadcast", { ...playerResponse(candidateId, channel.channelId), microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { endTimestamp: "2026-01-01T12:00:00Z" } } } }],
  ["an upcoming broadcast", playerResponse(candidateId, channel.channelId, { isUpcoming: true })],
  ["a missing live flag", playerResponse(candidateId, channel.channelId, { isLive: undefined })],
  ["login required", { ...playerResponse(candidateId, channel.channelId), playabilityStatus: { status: "LOGIN_REQUIRED" } }],
  ["no player data", {}],
] as const) {
  test(`HLS with ${name} is not selected`, async () => {
    const browse = channelGrid(channel.channelId, "streams", [liveLockup(candidateId, "Unverified")]);
    await withResolver(browse, () => info(player), async () => {
      await expect(resolveTvStream(channel)).rejects.toThrow();
    });
  });
}

test("the HLS scan ignores shelf recommendations and only probes six grid candidates", async () => {
  const ids = Array.from({ length: 7 }, (_, index) => `abcdefghij${index}`);
  const browse = channelGrid(channel.channelId, "streams", []);
  browse.contents.twoColumnBrowseResultsRenderer.tabs[0]!.tabRenderer.content.richGridRenderer.contents.push(
    { richItemRenderer: { content: { richShelfRenderer: { contents: [liveLockup(validId, "Recommended")] } } } },
    ...ids.map((id) => ({ richItemRenderer: { content: liveLockup(id, "Grid candidate") } })),
  );
  await withResolver(browse, (id) => info(playerResponse(id, channel.channelId, { isLive: id === validId })), async (getInfo) => {
    await expect(resolveTvStream(channel)).rejects.toThrow();
    expect(getInfo.mock.calls.map(([id]) => id)).toEqual(ids.slice(0, 6));
  });
});

test("conflicting HLS grid entries for the same ID are not probed", async () => {
  const browse = channelGrid(channel.channelId, "streams", [liveLockup(candidateId, "Own candidate"), liveLockup(candidateId, "Other owner", other.channelId)]);
  await withResolver(browse, () => info(playerResponse(candidateId, channel.channelId)), async (getInfo) => {
    await expect(resolveTvStream(channel)).rejects.toThrow();
    expect(getInfo).not.toHaveBeenCalled();
  });
});

test("when HLS has no verified live, TV falls back to a verified embed replay", async () => {
  const browse = channelGrid(channel.channelId, "streams", [liveLockup(candidateId, "Unverified")]);
  const fetchPage = youtubePages({}, { html: page({ data: channelGrid(channel.channelId, "videos", [replayCard(replayId, "Own replay", "2 days ago")]) }) });
  await withResolver(browse, () => info(playerResponse(candidateId, other.channelId)), async () => {
    expect(await resolveTvStream(channel)).toMatchObject({ videoId: replayId, title: "Own replay", isLive: false, publishedText: "2 days ago" });
  }, fetchPage);
});
