import { expect, mock, spyOn, test } from "bun:test";
import { Innertube, Session } from "youtubei.js";
import { TV_CHANNELS } from "./channels";
import { channelGrid, liveLockup, page, playerResponse, publicWatch, replayCard, youtubePages } from "./youtube-fixtures";
import { resetTvStreams, resolveTvStream } from "./youtube-stream";

const [channel, other] = TV_CHANNELS;
const candidateId = "abcdefghijk";
const validId = "xyzXYZ-_123";
const replayId = "zyxwvutsrqp";
const manifestUrl = "https://example.test/live.m3u8";
function info(player: object) {
  return {
    ...player, streamingData: { hlsManifestUrl: manifestUrl, expiresInSeconds: "1800", formats: [], adaptiveFormats: [] },
  };
}

async function withResolver(
  browse: ReturnType<typeof channelGrid>,
  lookup: (id: string) => object,
  check: (getInfo: ReturnType<typeof mock<(id: string, options: { client: string }) => object>>) => Promise<void>,
  fetchPage = youtubePages(),
) {
  const getInfo = mock((id: string, _options: { client: string }) => lookup(id));
  const create = spyOn(Innertube, "create").mockImplementation(async (options) =>
    new Innertube(await Session.create({ ...options, fetch: options?.fetch ?? globalThis.fetch, retrieve_player: false, retrieve_innertube_config: false })));
  const tab = browse.contents.twoColumnBrowseResultsRenderer.tabs[0]!.tabRenderer;
  const home = { ...browse, contents: { twoColumnBrowseResultsRenderer: { tabs: [
    { tabRenderer: { title: "Home", selected: true, content: { richGridRenderer: { contents: [] } } } },
    { tabRenderer: { ...tab, selected: false, endpoint: { ...tab.endpoint, browseEndpoint: { ...tab.endpoint.browseEndpoint, params: "fixture-streams-tab" } } } },
  ] } } };
  const transport = async (...[input, init]: Parameters<typeof fetch>) => {
    if (!(input instanceof Request) || input.method !== "POST") return fetchPage(input, init);
    const url = new URL(input.url);
    const payload = JSON.parse(String(init?.body));
    if (url.pathname === "/youtubei/v1/browse") return Response.json(payload.params === "fixture-streams-tab" ? browse : home);
    if (url.pathname === "/youtubei/v1/player") return Response.json(getInfo(payload.videoId, { client: payload.context.client.clientName }));
    throw new Error("Unexpected YouTube request");
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(transport, { preconnect: fetch.preconnect }));
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
  ["an explicit not-live broadcast flag without an end timestamp", { ...playerResponse(candidateId, channel.channelId), microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false } } } }],
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
  const fetchPage = youtubePages({}, { html: page({ data: channelGrid(channel.channelId, "videos", [replayCard(replayId, "Own replay", "2 days ago")]) }) }, publicWatch(replayId, channel.channelId, "Own replay"));
  await withResolver(browse, () => info(playerResponse(candidateId, other.channelId)), async () => {
    expect(await resolveTvStream(channel)).toMatchObject({ videoId: replayId, title: "Own replay", isLive: false, publishedText: "2 days ago" });
  }, fetchPage);
});
