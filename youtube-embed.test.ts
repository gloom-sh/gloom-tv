import { expect, test } from "bun:test";
import { TV_CHANNELS } from "./channels";
import { buildYoutubeLiveEmbedUrl, resolveYoutubeLivePage } from "./youtube-embed";
import { channelGrid, liveLockup, page, playerResponse, publicWatch, replayCard, youtubePages } from "./youtube-fixtures";

const [channel, other] = TV_CHANNELS;
const liveId = "abcdefghijk";
const replayId = "zyxwvutsrqp";
const otherId = "xyzXYZ-_123";
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;

test("a 404 on /live still allows a verified replay", async () => {
  const fetchPage = youtubePages({ status: 404 }, {
    html: page({ data: channelGrid(channel.channelId, "videos", [replayCard(replayId, "Grid title", "3 days ago")]) }),
  }, { html: page({ player: playerResponse(replayId, channel.channelId, { isLive: undefined, lengthSeconds: "754", title: "Verified replay" }) }) });
  expect(await resolveYoutubeLivePage(channel, fetchPage)).toMatchObject({ videoId: replayId, title: "Verified replay", isLive: false, publishedText: "3 days ago" });
  expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([
    `https://www.youtube.com/channel/${channel.channelId}/live`, `https://www.youtube.com/channel/${channel.channelId}/videos`, watch(replayId),
  ]);
});

test("skips a replay without affirmative embed permission and uses the next verified replay", async () => {
  const blocked = { ...playerResponse(otherId, channel.channelId, { isLive: false }), playabilityStatus: { status: "OK" } };
  const fetchPage = youtubePages({}, { html: page({ data: channelGrid(channel.channelId, "videos", [
    replayCard(otherId, "Ineligible replay", "1 day ago"), replayCard(replayId, "Grid title", "3 days ago"),
  ]) }) }, { html: page({ player: blocked }) }, {
    html: page({ player: playerResponse(replayId, channel.channelId, { isLive: false, title: "Verified replay" }) }),
  });
  expect(await resolveYoutubeLivePage(channel, fetchPage)).toMatchObject({ videoId: replayId, title: "Verified replay", isLive: false, publishedText: "3 days ago" });
});

test("an owned grid card without a public player is not a playable fallback", async () => {
  const data = channelGrid(channel.channelId, "videos", [replayCard(replayId, "Missing playability", "3 days ago")]);
  await expect(resolveYoutubeLivePage(channel, youtubePages({}, { html: page({ data }) }, {}))).rejects.toThrow();
});

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
    }, publicWatch(replayId, source.channelId, "Own replay"));
    const stream = await resolveYoutubeLivePage(source, fetchPage);
    expect(stream).toMatchObject({ videoId: replayId, isLive: false, title: "Own replay", publishedText: "3 days ago" });
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([
      `https://www.youtube.com/channel/${source.channelId}/live`, `https://www.youtube.com/channel/${source.channelId}/videos`, watch(replayId),
    ]);
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
  ]) }) }, publicWatch(liveId, channel.channelId, "Own live", true));
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
    }) }, publicWatch(replayId, channel.channelId, title)));
    expect(stream).toMatchObject({ videoId: replayId, isLive: false, title });
    expect(stream.publishedText).toBe(label);
  }
});

test("retains the compact date from a modern Videos card with bottom-overlay metadata", async () => {
  const card = liveLockup(replayId, "Grid title", undefined, "8h ago").lockupViewModel;
  const data = channelGrid(channel.channelId, "videos", [{ lockupViewModel: {
    ...card, contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [
      { thumbnailBadgeViewModel: { text: "3:42", badgeStyle: "THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT" } },
    ] } }] } },
  } }]);
  const player = playerResponse(replayId, channel.channelId, { isLive: undefined, isLiveContent: false, lengthSeconds: "221", title: "Verified replay" });
  const stream = await resolveYoutubeLivePage(channel, youtubePages({}, { html: page({ data }) }, { html: page({ player }) }));
  expect(stream).toMatchObject({ videoId: replayId, title: "Verified replay", publishedText: "8h ago", isLive: false });
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
    const fetchPage = youtubePages({ html, url });
    await expect(resolveYoutubeLivePage(channel, fetchPage)).rejects.toThrow();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  }
});

test("watch probes skip mismatched player IDs, owners and live status without using their labels", async () => {
  const wrongOwner = "bcdefghijkl";
  const liveVideo = "defghijklmn";
  const data = channelGrid(channel.channelId, "videos", [otherId, wrongOwner, liveVideo, replayId].map((id) => replayCard(id, "Replay", "3 days ago")));
  const fetchPage = youtubePages({}, { html: page({ data }) }, publicWatch(liveId, channel.channelId, "Wrong video"),
    publicWatch(wrongOwner, other.channelId, "Wrong publisher"), publicWatch(liveVideo, channel.channelId, "Live", true),
    publicWatch(replayId, channel.channelId, "Own replay"));
  expect(await resolveYoutubeLivePage(channel, fetchPage)).toMatchObject({ videoId: replayId, title: "Own replay", isLive: false });
  for (const [, init] of fetchPage.mock.calls.slice(2)) {
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);
  }
});

test("watch probes stop on an interstitial and the request budget is bounded", async () => {
  const cards = Array.from({ length: 8 }, (_, index) => replayCard(`abcdefghij${index}`, "Replay"));
  const videos = { html: page({ data: channelGrid(channel.channelId, "videos", cards) }) };
  const consent = youtubePages({}, videos, { url: "https://consent.youtube.com/m" });
  await expect(resolveYoutubeLivePage(channel, consent)).rejects.toThrow("consent page");
  expect(consent).toHaveBeenCalledTimes(3);
  const forbidden = youtubePages({}, videos, { status: 403 });
  await expect(resolveYoutubeLivePage(channel, forbidden)).rejects.toThrow("unavailable (403)");
  expect(forbidden).toHaveBeenCalledTimes(3);
  const empty = youtubePages({}, videos);
  await expect(resolveYoutubeLivePage(channel, empty)).rejects.toThrow("verified public video");
  expect(empty).toHaveBeenCalledTimes(8);
});

const probeGrid = { html: page({ data: channelGrid(channel.channelId, "videos", [
  replayCard(otherId, "First candidate"), replayCard(replayId, "Eligible candidate"),
]) }) };

for (const stage of ["fetch", "body"] as const) {
  test(`a watch probe that stalls the ${stage} is aborted and the next candidate is checked`, async () => {
    const pages = youtubePages({}, probeGrid, publicWatch(replayId, channel.channelId, "Own replay"));
    const resumeFetch = Promise.withResolvers<void>();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyCanceled = false;
    let signal: AbortSignal | null | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const fetchPage = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const [url, init] = args;
      if (url !== watch(otherId)) return pages(...args);
      signal = init?.signal;
      if (stage === "fetch") {
        await resumeFetch.promise;
        return Object.defineProperty(new Response(""), "url", { value: url });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode("<html>"));
        },
        cancel() { bodyCanceled = true; },
      });
      return Object.defineProperty(new Response(body), "url", { value: url });
    }, { preconnect: fetch.preconnect });
    try {
      await expect(Promise.race([resolveYoutubeLivePage(channel, fetchPage), new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("The stalled watch probe did not advance")), 2800);
      })])).resolves.toMatchObject({ videoId: replayId, title: "Own replay" });
      if (stage === "body") expect(bodyCanceled).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(pages.mock.calls.map(([url]) => url).at(-1)).toBe(watch(replayId));
    } finally {
      clearTimeout(watchdog);
      if (!bodyCanceled) bodyController?.close();
      resumeFetch.resolve();
    }
  });
}

const siteSignInCopy = '<main>Sign in to continue to YouTube</main>';
const ageDenial = {
  status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age", errorScreen: { playerErrorMessageRenderer: {} },
};

function ageDeniedWatch(videoId: string, isLive: boolean) {
  return page({ player: { ...playerResponse(videoId, channel.channelId, { isLive }), playabilityStatus: ageDenial } });
}

for (const [kind, html] of [
  ["sign-in page", '<title>Sign in - YouTube</title><h1>Sign in</h1>'],
  ["sign-in body", '<title>YouTube</title><main><div>Sign in to continue to YouTube</div></main>'],
  ["sign-in body alongside a matching video denial", ageDeniedWatch(otherId, false) + siteSignInCopy],
  ["sign-in body alongside a video-only reason without player details", page({ player: { playabilityStatus: ageDenial } }) + siteSignInCopy],
  ["consent form", '<form action="https://consent.youtube.com/save"><button>Accept all</button></form>'],
  ["anti-bot page", '<h1>Verify you’re human</h1><form id="captcha-form" action="/sorry/index"></form>'],
  ["unscoped login challenge", page({ player: { playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to continue" } } })],
  ["anti-bot reason in a player", page({ player: { ...playerResponse(otherId, channel.channelId), playabilityStatus: {
    status: "LOGIN_REQUIRED", reason: "Sign in to confirm you’re not a bot",
  } } })],
] as const) {
  test(`a 200 ${kind} at the watch URL stops without probing the next candidate`, async () => {
    const fetchPage = youtubePages({}, probeGrid, { html }, publicWatch(replayId, channel.channelId, "Must not be queried"));
    await expect(resolveYoutubeLivePage(channel, fetchPage)).rejects.toThrow("challenge");
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls.at(-1)?.[0]).toBe(watch(otherId));
  });
}

test("a structured denial for the requested video still allows a verified next candidate", async () => {
  const fetchPage = youtubePages({}, probeGrid, { html: ageDeniedWatch(otherId, false) }, publicWatch(replayId, channel.channelId, "Own replay"));
  await expect(resolveYoutubeLivePage(channel, fetchPage)).resolves.toMatchObject({ videoId: replayId, title: "Own replay" });
  expect(fetchPage.mock.calls.slice(2).map(([url]) => url)).toEqual([watch(otherId), watch(replayId)]);
});

for (const [kind, url, html] of [
  ["sign-in page", watch(liveId), '<title>YouTube</title>' + siteSignInCopy],
  ["sign-in page alongside a matching video denial", watch(liveId), ageDeniedWatch(liveId, true) + siteSignInCopy],
  ["anti-bot page with a malformed ID", watch("invalid"), '<h1>Verify you’re human</h1>'],
  ["unscoped login challenge with no ID", "https://www.youtube.com/watch", page({ player: {
    playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Authentication required" },
  } })],
] as const) {
  test(`a /live redirect to a 200 ${kind} stops before requesting /videos`, async () => {
    const fetchPage = youtubePages({ url, html }, probeGrid, publicWatch(otherId, channel.channelId, "Must not be queried"));
    await expect(resolveYoutubeLivePage(channel, fetchPage)).rejects.toThrow("page-wide access challenge");
    expect(fetchPage.mock.calls.map(([request]) => request)).toEqual([`https://www.youtube.com/channel/${channel.channelId}/live`]);
  });
}

test("a /videos redirect to a challenged watch page also hard-stops", async () => {
  const fetchPage = youtubePages({}, { url: watch(replayId), html: '<h1>Verify you’re human</h1>' });
  await expect(resolveYoutubeLivePage(channel, fetchPage)).rejects.toThrow("page-wide access challenge");
  expect(fetchPage).toHaveBeenCalledTimes(2);
});

test("a video-specific denial after a /live redirect still allows a verified replay", async () => {
  const videos = { html: page({ data: channelGrid(channel.channelId, "videos", [replayCard(replayId, "Grid title", "3 days ago")]) }) };
  const fetchPage = youtubePages({ url: watch(liveId), html: ageDeniedWatch(liveId, true) }, videos, publicWatch(replayId, channel.channelId, "Own replay"));
  await expect(resolveYoutubeLivePage(channel, fetchPage)).resolves.toMatchObject({ videoId: replayId, title: "Own replay", isLive: false, publishedText: "3 days ago" });
  expect(fetchPage.mock.calls.map(([request]) => request)).toEqual([
    `https://www.youtube.com/channel/${channel.channelId}/live`, `https://www.youtube.com/channel/${channel.channelId}/videos`, watch(replayId),
  ]);
});

test("normal sign-in navigation, a matching video title and script copy do not stop verification", async () => {
  const title = "Sign in to continue to YouTube";
  const html = page({
    player: playerResponse(liveId, channel.channelId, { title }),
    data: { recommendation: "Verify you're not a bot" },
  }).replace("Generic document title", title) + `<nav><a href="/signin">Sign in</a></nav><h1>${title}</h1>`;
  const fetchPage = youtubePages({ url: watch(liveId), html });
  await expect(resolveYoutubeLivePage(channel, fetchPage)).resolves.toMatchObject({ videoId: liveId, title });
  expect(fetchPage).toHaveBeenCalledTimes(1);
});
