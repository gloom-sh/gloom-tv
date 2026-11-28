import { mock } from "bun:test";

export function playerResponse(videoId: string, channelId: string | undefined, details = {}) {
  return {
    playabilityStatus: { status: "OK", playableInEmbed: true },
    videoDetails: { videoId, channelId, isLive: true, title: "Own live", ...details },
  };
}

function watchEndpoint(videoId: string) {
  return { watchEndpoint: { videoId } };
}

function byline(channelId: string | undefined) {
  return channelId ? { runs: [{ text: "Publisher", navigationEndpoint: { browseEndpoint: { browseId: channelId } } }] } : undefined;
}

export function replayCard(videoId: string, title: string, label?: string, owner?: string) {
  return { videoRenderer: {
    videoId, title: { runs: [{ text: title }] }, navigationEndpoint: watchEndpoint(videoId),
    lengthText: { simpleText: "12:34" }, publishedTimeText: label && { simpleText: label }, ownerText: byline(owner),
  } };
}

export function liveLockup(videoId: string, title: string, owner?: string, replayLabel?: string) {
  return { lockupViewModel: {
    contentId: videoId, contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
    rendererContext: { commandContext: { onTap: { innertubeCommand: watchEndpoint(videoId) } } },
    contentImage: { thumbnailViewModel: { image: { sources: [] }, overlays: [{ thumbnailOverlayBadgeViewModel: {
      thumbnailBadges: [{ thumbnailBadgeViewModel: { badgeStyle: replayLabel ? "THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT" : "THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE", text: replayLabel ? "12:34" : "LIVE" } }],
    } }] } },
    metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: {
      metadataRows: [
        ...(owner ? [{ metadataParts: [{ text: { content: "Publisher", commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: owner } } } }] } }] }] : []),
        { metadataParts: [{ text: { content: "718 views" } }, ...(replayLabel ? [{ text: { content: replayLabel } }] : [])] },
      ],
    } } } },
  } };
}

export function channelGrid(channelId: string | undefined, tab: "streams" | "videos", cards: object[]) {
  return {
    metadata: { channelMetadataRenderer: { externalId: channelId, title: "Publisher" } },
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: {
      selected: true, title: tab === "streams" ? "Live" : "Videos",
      endpoint: { browseEndpoint: { browseId: channelId }, commandMetadata: { webCommandMetadata: { url: `/@publisher/${tab}` } } },
      content: { richGridRenderer: { contents: cards.map((content) => ({ richItemRenderer: { content } })) } },
    } }] } },
  };
}

export function page({ player, data }: { player?: object; data?: object }) {
  return `<title>Generic document title - YouTube</title>${player ? `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>` : ""}${data ? `<script>window["ytInitialData"] = ${JSON.stringify(data)};</script>` : ""}`;
}

export function youtubePages(...pages: { html?: string; url?: string; status?: number }[]) {
  const fetchPage = mock(async (...[request]: Parameters<typeof fetch>) => {
    const { html = "", url = String(request), status = 200 } = pages.shift() ?? {};
    return Object.defineProperty(new Response(html, { status }), "url", { value: url });
  });
  return Object.assign(fetchPage, { preconnect: fetch.preconnect });
}
