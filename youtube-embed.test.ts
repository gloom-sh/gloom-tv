import { expect, test } from "bun:test";
import { TV_CHANNELS } from "./channels";
import { buildYoutubeLiveEmbedUrl, resolveYoutubeLivePage } from "./youtube-embed";
import { channelGrid, liveLockup, page, playerResponse, replayCard, youtubePages } from "./youtube-fixtures";

const [channel, other] = TV_CHANNELS;
const liveId = "abcdefghijk";
const replayId = "zyxwvutsrqp";
const otherId = "xyzXYZ-_123";
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;

test("builds exact video embeds, muted by default, with no captions", () => {
  const videoUrl = buildYoutubeLiveEmbedUrl(liveId, { muted: false, origin: "https://example.test" });
  expect(videoUrl).toContain(`/embed/${liveId}?`);
  expect(videoUrl).toContain("mute=0");
  expect(videoUrl).toContain("origin=https%3A%2F%2Fexample.test");
  expect(videoUrl).not.toContain("cc_load_policy");
  expect(buildYoutubeLiveEmbedUrl(liveId)).toContain("mute=1");
  for (const invalid of ["", `/${liveId}`, `${liveId}?x`, `${liveId}\n`]) {
    expect(() => buildYoutubeLiveEmbedUrl(invalid)).toThrow("concrete YouTube video ID");
  }
});

for (const [index, source] of TV_CHANNELS.entries()) {
  test(`${source.name} rejects a redirected watch owned by another publisher`, async () => {
    const foreign = TV_CHANNELS[(index + 1) % TV_CHANNELS.length]!;
    const fetchPage = youtubePages({ html: page({ player: playerResponse(otherId, foreign.channelId) }), url: watch(otherId) }, {
      html: page({ data: channelGrid(source.channelId, "videos", [replayCard(replayId, "Own replay", "3 days ago")]) }),
    });
    const stream = await resolveYoutubeLivePage(source, fetchPage);
    expect(stream).toMatchObject({ videoId: replayId, isLive: false, title: "Own replay", publishedText: "3 days ago" });
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual(["live", "videos"].map((tab) => `https://www.youtube.com/channel/${source.channelId}/${tab}`));
  });
}

test("a verified watch uses only its own title and live state", async () => {
  const fetchPage = youtubePages({ url: watch(liveId), html: page({
    player: playerResponse(liveId, channel.channelId, { title: 'Live "Markets" { update }' }),
    data: { recommendation: liveLockup(otherId, "Not the player") },
  }) });
  expect(await resolveYoutubeLivePage(channel, fetchPage)).toMatchObject({
    videoId: liveId, title: 'Live "Markets" { update }', isLive: true, watchUrl: watch(liveId),
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);
});

test("a watch can prove it is live with its own broadcast details", async () => {
  const player = {
    ...playerResponse(liveId, channel.channelId, { isLive: undefined }),
    microformat: { playerMicroformatRenderer: { externalChannelId: channel.channelId, liveBroadcastDetails: { isLiveNow: true } } },
  };
  expect(await resolveYoutubeLivePage(channel, youtubePages({ html: page({ player }), url: watch(liveId) })))
    .toMatchObject({ videoId: liveId, title: "Own live", isLive: true });
});

for (const [name, player] of [
  ["missing owner", playerResponse(liveId, undefined)],
  ["different player ID", playerResponse(otherId, channel.channelId)],
  ["conflicting owner", { ...playerResponse(liveId, channel.channelId), microformat: { playerMicroformatRenderer: { externalChannelId: other.channelId } } }],
  ["conflicting live state", { ...playerResponse(liveId, channel.channelId), microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false, endTimestamp: "2026-01-01T12:00:00Z" } } } }],
  ["missing live state", playerResponse(liveId, channel.channelId, { isLive: undefined })],
  ["upcoming", playerResponse(liveId, channel.channelId, { isUpcoming: true })],
  ["login required", { ...playerResponse(liveId, channel.channelId), playabilityStatus: { status: "LOGIN_REQUIRED" } }],
  ["embed disabled", { ...playerResponse(liveId, channel.channelId), playabilityStatus: { status: "OK", playableInEmbed: false } }],
  ["no structured player", undefined],
] as const) {
  test(`does not select a watch redirect with ${name}`, async () => {
    await expect(resolveYoutubeLivePage(channel, youtubePages({ url: watch(liveId), html: page({ player }) }))).rejects.toThrow();
  });
}

test("ignores live badges outside the candidate and selects a verified live grid card", async () => {
  const fetchPage = youtubePages({ html: page({ data: channelGrid(channel.channelId, "streams", [
    replayCard(replayId, "Not live", "Streamed 2 days ago"),
    liveLockup(otherId, "Other owner", other.channelId),
    liveLockup(liveId, "Own live"),
  ]) }) });
  expect(await resolveYoutubeLivePage(channel, fetchPage)).toMatchObject({ videoId: liveId, isLive: true, title: "Own live" });
});

test("conflicting player responses do not select a watch ID", async () => {
  const html = page({ player: playerResponse(liveId, channel.channelId) }) + page({ player: playerResponse(liveId, other.channelId) });
  await expect(resolveYoutubeLivePage(channel, youtubePages({ url: watch(liveId), html }))).rejects.toThrow();
});

test("replay title and optional date stay within the selected card in either grid format", async () => {
  const modernReplay = liveLockup(replayId, "Own modern replay", undefined, "Streamed 1 day ago");
  for (const [card, title, label] of [
    [replayCard(replayId, "Own legacy replay"), "Own legacy replay", undefined],
    [modernReplay, "Own modern replay", "Streamed 1 day ago"],
  ] as const) {
    const stream = await resolveYoutubeLivePage(channel, youtubePages({ html: page({}) }, { html: page({
      data: channelGrid(channel.channelId, "videos", [card, replayCard(otherId, "Neighbour", "5 months ago")]),
    }) }));
    expect(stream).toMatchObject({ videoId: replayId, isLive: false, title });
    expect(stream.publishedText).toBe(label);
  }
});

for (const [name, data] of [
  ["missing canonical grid owner", channelGrid(undefined, "videos", [replayCard(replayId, "Unverified")])],
  ["foreign grid owner", channelGrid(other.channelId, "videos", [replayCard(replayId, "Unverified")])],
  ["conflicting cards for one ID", channelGrid(channel.channelId, "videos", [replayCard(replayId, "Own replay"), replayCard(replayId, "Other replay", undefined, other.channelId)])],
  ["missing classification", channelGrid(channel.channelId, "videos", [{ videoRenderer: { videoId: replayId, title: { simpleText: "Unknown" }, navigationEndpoint: { watchEndpoint: { videoId: replayId } } } }])],
  ["conflicting watch endpoint", channelGrid(channel.channelId, "videos", [{ videoRenderer: { ...replayCard(replayId, "Wrong ID").videoRenderer, navigationEndpoint: { watchEndpoint: { videoId: otherId } } } }])],
  ["unavailable replay", channelGrid(channel.channelId, "videos", [{ videoRenderer: { ...replayCard(replayId, "Unavailable").videoRenderer, isPlayable: false } }])],
  ["conflicting live and replay metadata", channelGrid(channel.channelId, "videos", [{ videoRenderer: { ...replayCard(replayId, "Ambiguous").videoRenderer, badges: [{ metadataBadgeRenderer: { style: "BADGE_STYLE_TYPE_LIVE_NOW" } }] } }])],
  ["recommendations only", { ...channelGrid(channel.channelId, "videos", []), secondaryContents: replayCard(replayId, "Recommended", "3 days ago") }],
  ["scheduled only", channelGrid(channel.channelId, "videos", [replayCard(replayId, "Upcoming", "Scheduled for tomorrow")])],
  ["no data", undefined],
] as const) {
  test(`returns empty with ${name}`, async () => {
    await expect(resolveYoutubeLivePage(channel, youtubePages({ html: page({}) }, { html: page({ data }) }))).rejects.toThrow();
  });
}

test("rejects unavailable, consent and sign-in pages", async () => {
  await expect(resolveYoutubeLivePage(channel, youtubePages({ status: 503 }))).rejects.toThrow("unavailable (503)");
  const html = page({ player: playerResponse(liveId, channel.channelId) });
  for (const url of ["https://consent.youtube.com/m", "https://accounts.google.com/signin", "https://www.youtube.com/signin"]) {
    await expect(resolveYoutubeLivePage(channel, youtubePages({ html, url }))).rejects.toThrow();
  }
});
