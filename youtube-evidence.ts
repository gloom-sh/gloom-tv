type JsonObject = Record<string, unknown>;

interface VerifiedVideo {
  videoId: string;
  title: string;
  isLive: boolean;
  publishedText?: string;
}

export function isValidYoutubeVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{11}$/.test(value);
}

export function youtubePageUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || !value) return;
  try {
    const url = new URL(value, "https://www.youtube.com");
    if (url.protocol === "https:" && ["www.youtube.com", "youtube.com"].includes(url.hostname) && !url.port) return url;
  } catch {
    return undefined;
  }
}

function channelIdInUrl(url: URL | undefined): string | undefined {
  return url?.pathname.startsWith("/channel/") ? url.pathname.split("/")[2] : undefined;
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function field(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((parent, key) => object(parent)?.[key], value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function text(value: unknown): string | undefined {
  return string(value) ?? string(field(value, "simpleText")) ?? string(field(value, "content"))
    ?? string(list(field(value, "runs")).map((run) => typeof field(run, "text") === "string" ? field(run, "text") : "").join(""));
}

function readJsonObject(script: string, start: number): JsonObject | undefined {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < script.length; index++) {
    const char = script[index];
    if (quoted && char === "\\") index++;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === "{") depth++;
    else if (!quoted && char === "}" && --depth === 0) {
      try {
        return object(JSON.parse(script.slice(start, index + 1)));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function initialJson(html: string, key: "ytInitialData" | "ytInitialPlayerResponse"): JsonObject | undefined {
  const assignment = new RegExp(`^\\s*(?:(?:var|let|const)\\s+${key}|window\\[["']${key}["']\\]|window\\.${key}|${key})\\s*=\\s*(?=\\{)`);
  let found: JsonObject | undefined;
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (!script) continue;
    const prefix = assignment.exec(script);
    if (!prefix) continue;
    if (found) return undefined;
    found = readJsonObject(script, prefix[0].length);
    if (!found) return undefined;
  }
  return found;
}

export function findWatchLive(html: string, url: URL, channelId: string): VerifiedVideo | undefined {
  const [videoId, ...extraIds] = url.searchParams.getAll("v");
  if (extraIds.length || !isValidYoutubeVideoId(videoId)) return;
  const player = initialJson(html, "ytInitialPlayerResponse");
  const details = object(player?.videoDetails);
  const playability = object(player?.playabilityStatus);
  const microformat = object(field(player, "microformat", "playerMicroformatRenderer"));
  const broadcast = object(microformat?.liveBroadcastDetails);
  const streamId = field(playability, "liveStreamability", "liveStreamabilityRenderer", "videoId");
  const profileId = channelIdInUrl(youtubePageUrl(microformat?.ownerProfileUrl));
  const liveFlags = [details?.isLive, broadcast?.isLiveNow].filter((flag) => flag !== undefined);
  const title = string(details?.title);
  if (details?.videoId !== videoId || details.channelId !== channelId || !title
    || !liveFlags.length || liveFlags.some((flag) => flag !== true) || broadcast?.endTimestamp
    || details.isUpcoming === true || details.isPrivate === true || details.isPostLiveDvr === true || microformat?.isUnlisted === true
    || playability?.status !== "OK" || playability.playableInEmbed !== true || playability.errorScreen
    || (streamId !== undefined && streamId !== videoId)
    || (microformat?.externalChannelId !== undefined && microformat.externalChannelId !== channelId)
    || (profileId !== undefined && profileId !== channelId)) return;
  return { videoId, title, isLive: true };
}

const PUBLISHED_LABEL = /^(?:\d+\s+\w+\s+ago|Streamed\b.+|Premiered\b.+)$/i;
const DURATION = /^\d+(?::\d{2}){1,2}$/;

function channelGridCards(data: JsonObject | undefined, channelId: string, isLive: boolean): unknown[] {
  if (field(data, "metadata", "channelMetadataRenderer", "externalId") !== channelId
    || list(data?.alerts).some((alert) => field(alert, "alertRenderer", "type") === "ERROR")) return [];
  const headerId = field(data, "header", "c4TabbedHeaderRenderer", "channelId");
  if (headerId !== undefined && headerId !== channelId) return [];
  const tabs = list(field(data, "contents", "twoColumnBrowseResultsRenderer", "tabs"));
  const [tab, ...otherTabs] = tabs.map((tab) => object(field(tab, "tabRenderer"))).filter((tab) => tab?.selected === true);
  const tabUrl = youtubePageUrl(field(tab, "endpoint", "commandMetadata", "webCommandMetadata", "url"));
  const tabChannelId = channelIdInUrl(tabUrl);
  if (otherTabs.length || field(tab, "endpoint", "browseEndpoint", "browseId") !== channelId || !tabUrl
    || (tabChannelId !== undefined && tabChannelId !== channelId)
    || !(isLive ? /\/(?:streams|live)\/?$/ : /\/videos\/?$/).test(tabUrl.pathname)) return [];

  const richGrid = field(tab, "content", "richGridRenderer");
  if (richGrid) return list(field(richGrid, "contents")).map((item) => field(item, "richItemRenderer", "content"));
  const directGrid = field(tab, "content", "gridRenderer");
  if (directGrid) return list(field(directGrid, "items"));
  const sections = list(field(tab, "content", "sectionListRenderer", "contents"));
  const grids = sections.flatMap((section) => list(field(section, "itemSectionRenderer", "contents")))
    .map((item) => field(item, "gridRenderer")).filter(Boolean);
  return grids.length === 1 ? list(field(grids[0], "items")) : [];
}

function verifyCard(card: JsonObject, videoId: string, channelId: string, isLive: boolean): VerifiedVideo | undefined {
  const lockup = card.contentId !== undefined;
  const metadata = field(card, "metadata", "lockupMetadataViewModel");
  const title = text(lockup ? field(metadata, "title") : card.title);
  const tap = field(card, "rendererContext", "commandContext", "onTap", "innertubeCommand");
  const endpoint = lockup ? tap : card.navigationEndpoint;
  const status = field(card.playabilityStatus, "status");
  if (!title || field(endpoint, "watchEndpoint", "videoId") !== videoId
    || (card.videoId !== undefined && card.videoId !== videoId)
    || (lockup && card.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO")
    || (status !== undefined && status !== "OK")
    || card.isPlayable === false || card.playableInEmbed === false || card.isPrivate === true
    || card.isUpcoming === true || card.upcomingEventData) return;

  const rows = list(field(metadata, "metadata", "contentMetadataViewModel", "metadataRows"));
  const parts = rows.flatMap((row) => list(field(row, "metadataParts"))).map((part) => field(part, "text"));
  const ownerIds = [card.channelId, card.ownerChannelId,
    ...[card.ownerText, card.shortBylineText, card.longBylineText].flatMap((byline) => list(field(byline, "runs"))
      .map((run) => field(run, "navigationEndpoint", "browseEndpoint", "browseId"))),
    ...parts.flatMap((part) => list(field(part, "commandRuns")).map((run) =>
      field(run, "onTap", "innertubeCommand", "browseEndpoint", "browseId"))).filter((id) => typeof id === "string" && id.startsWith("UC")),
  ];
  if (ownerIds.some((ownerId) => ownerId !== undefined && ownerId !== channelId)) return;

  const badges = list(card.badges).map((badge) => field(badge, "metadataBadgeRenderer"));
  const stamps = list(card.thumbnailOverlays).map((overlay) => field(overlay, "thumbnailOverlayTimeStatusRenderer"));
  const overlays = list(field(card, "contentImage", "thumbnailViewModel", "overlays"));
  const thumbnailBadges = overlays.flatMap((overlay) => list(field(overlay, "thumbnailOverlayBadgeViewModel", "thumbnailBadges")))
    .map((badge) => field(badge, "thumbnailBadgeViewModel"));
  const styles = [...badges, ...stamps].map((badge) => field(badge, "style"))
    .concat(thumbnailBadges.map((badge) => field(badge, "badgeStyle")));
  const labels = [text(card.publishedTimeText), ...parts.map(text)].filter((label): label is string => !!label);
  if (styles.some((style) => typeof style === "string" && /UPCOMING|MEMBERS_ONLY|UNAVAILABLE|PRIVATE/.test(style))
    || labels.some((label) => /^Scheduled\b/i.test(label))) return;

  const live = styles.some((style) => style === "LIVE" || style === "BADGE_STYLE_TYPE_LIVE_NOW" || style === "THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE");
  const dates = [...new Set(labels.filter((label) => PUBLISHED_LABEL.test(label)))];
  const replay = dates.length > 0 || [text(card.lengthText), ...[...stamps, ...thumbnailBadges].map((badge) => text(field(badge, "text")))]
    .some((duration) => duration && DURATION.test(duration));
  if (dates.length > 1 || (isLive ? !live || replay : live || !replay)) return;
  return { videoId, title, isLive, publishedText: dates[0] };
}

export function findGridVideo(html: string, url: URL, channelId: string, isLive: boolean): VerifiedVideo | undefined {
  const pageChannelId = channelIdInUrl(url);
  if (pageChannelId !== undefined && pageChannelId !== channelId) return;
  const videos = new Map<string, VerifiedVideo | undefined>();
  for (const item of channelGridCards(initialJson(html, "ytInitialData"), channelId, isLive)) {
    const card = object(field(item, "lockupViewModel") ?? field(item, "videoRenderer") ?? field(item, "gridVideoRenderer"));
    const videoId = card?.contentId ?? card?.videoId;
    if (card && isValidYoutubeVideoId(videoId)) {
      videos.set(videoId, videos.has(videoId) ? undefined : verifyCard(card, videoId, channelId, isLive));
    }
  }
  return [...videos.values()].find((video) => video !== undefined);
}
