import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Notice, PaneStatusBody, Tabs, usePaneFooter } from "gloomberb/components";
import { useCapabilityInvoker, usePaneSettingValue, usePaneTitle, useShortcut } from "gloomberb/react";
import { colors } from "gloomberb/theme";
import type { PaneProps } from "gloomberb/types/plugin";
import { Box, ImageSurface, MediaSurface, Text, useRendererHost, useUiHost, type MediaSurfaceHandle } from "gloomberb/ui";
import { getTvChannel, TV_CHANNELS, type TvChannelId } from "./channels";
import type { ResolvedLiveStream } from "./types";
import { buildYoutubeLiveEmbedUrl, isYoutubeEmbedUrl } from "./youtube-embed";
import { TV_STREAM_CAPABILITY_ID } from "./capability";

type PlaybackState = "idle" | "loading" | "playing" | "paused" | "error";

/** Re-resolve this long before expiry so playback never starts on a dead URL. */
const MANIFEST_SAFETY_MARGIN_MS = 60_000;

function isPlayableNow(stream: ResolvedLiveStream | null): stream is ResolvedLiveStream {
  return !!stream && Date.now() < stream.expiresAt - MANIFEST_SAFETY_MARGIN_MS;
}

function activeWebOrigin(): string | undefined {
  const location = (globalThis as { window?: { location?: { protocol?: string; origin?: string } } }).window?.location;
  if (!location?.protocol || !location.origin) return undefined;
  return /^https?:$/.test(location.protocol) ? location.origin : undefined;
}

function webMediaSource(stream: ResolvedLiveStream): string {
  if (!isYoutubeEmbedUrl(stream.manifestUrl)) return stream.manifestUrl;
  const origin = activeWebOrigin();
  // Autoplay requires starting muted; unmuting afterwards goes through the
  // iframe postMessage API so the URL (and therefore the player) stays stable.
  return buildYoutubeLiveEmbedUrl(stream.videoId, {
    muted: true,
    origin,
    widgetReferrer: origin,
  });
}

export function TvPane({ paneId, focused, width, height }: PaneProps) {
  const isDesktop = useUiHost().kind === "desktop-web";
  const renderer = useRendererHost();
  const capabilities = useCapabilityInvoker();
  const [storedChannelId, setChannelId] = usePaneSettingValue<TvChannelId>("channelId", "bloomberg");
  const channelId = TV_CHANNELS.find(({ id }) => id === storedChannelId)?.id ?? "bloomberg";
  const [stream, setStream] = useState<ResolvedLiveStream | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [muted, setMuted] = useState(true);
  const mediaRef = useRef<MediaSurfaceHandle | null>(null);
  const terminalAutoPlayedRef = useRef<string | null>(null);
  const recoveredStreamRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const channel = getTvChannel(channelId);

  usePaneTitle(`TV: ${channel.name}`);

  const load = useCallback(async (force = false): Promise<ResolvedLiveStream | null> => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setPlaybackError(null);
    setPlaybackState("idle");
    setStream((current) => current?.sourceId === channel.id ? current : null);
    try {
      const nextStream = await capabilities.invokeCapability<ResolvedLiveStream>(TV_STREAM_CAPABILITY_ID, "resolve", { sourceId: channel.id, force });
      if (generation !== generationRef.current) return null;
      setStream(nextStream);
      return nextStream;
    } catch (cause) {
      if (generation !== generationRef.current) return null;
      setStream(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [capabilities, channel]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  // Only the web player consumes a manifest it cannot renew on its own, so it is
  // the only one that needs a timer. An embed URL never expires, and the terminal
  // player owns its URL for the life of the process: re-resolving behind it would
  // burn a YouTube round trip per pane without reaching the running player.
  useEffect(() => {
    if (!stream || !isDesktop || isYoutubeEmbedUrl(stream.manifestUrl)) return;
    const delay = Math.max(5_000, stream.expiresAt - MANIFEST_SAFETY_MARGIN_MS - Date.now());
    const timer = setTimeout(() => {
      void load(true);
    }, delay);
    return () => clearTimeout(timer);
  }, [isDesktop, load, stream]);

  // A dead manifest surfaces as a media error; re-resolve once per stream so a
  // silent expiry recovers without the user pressing anything.
  const handlePlaybackError = useCallback((message: string) => {
    setPlaybackError(message);
    const streamKey = stream ? `${stream.sourceId}:${stream.videoId}` : null;
    if (!streamKey || recoveredStreamRef.current === streamKey) return;
    recoveredStreamRef.current = streamKey;
    void load(true);
  }, [load, stream]);

  const selectChannel = useCallback((nextId: string) => {
    if (TV_CHANNELS.some((item) => item.id === nextId)) {
      setMuted(true);
      setChannelId(nextId as TvChannelId);
    }
  }, [setChannelId]);

  const playInTerminal = useCallback(async () => {
    if (!renderer.playTerminalMedia) return;
    setPlaybackError(null);
    // The URL has to be good at the moment the player starts, because it cannot be
    // handed a new one afterwards. Resolution is cached, so this is usually free.
    const playable = isPlayableNow(stream) ? stream : await load();
    if (!playable) return;
    setPlaybackState("playing");
    try {
      await renderer.playTerminalMedia(playable.manifestUrl, playable.title, { muted });
      setPlaybackState("paused");
    } catch (cause) {
      setPlaybackState("error");
      setPlaybackError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [load, muted, renderer, stream]);

  useEffect(() => {
    if (isDesktop || loading || !stream || stream.sourceId !== channel.id) return;
    const streamKey = `${stream.sourceId}:${stream.videoId}`;
    if (terminalAutoPlayedRef.current === streamKey) return;
    terminalAutoPlayedRef.current = streamKey;
    void playInTerminal();
  }, [channel.id, isDesktop, loading, playInTerminal, stream]);

  // Closing the pane must take the player with it; the media process is not
  // tied to the React tree that started it.
  useEffect(() => () => renderer.stopTerminalMedia?.(), [renderer]);

  const togglePlayback = useCallback(async () => {
    setPlaybackError(null);
    try {
      if (isDesktop) {
        await mediaRef.current?.toggle();
      } else {
        await playInTerminal();
      }
    } catch (cause) {
      setPlaybackState("error");
      setPlaybackError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [isDesktop, playInTerminal]);

  const toggleMute = useCallback(() => {
    if (isDesktop) {
      const nextMuted = mediaRef.current?.toggleMuted();
      if (typeof nextMuted === "boolean") setMuted(nextMuted);
      return;
    }
    setMuted((current) => !current);
  }, [isDesktop]);

  useShortcut((event) => {
    if (!focused) return;
    const channelIndex = Number(event.name) - 1;
    if (Number.isInteger(channelIndex) && TV_CHANNELS[channelIndex]) {
      event.preventDefault?.();
      selectChannel(TV_CHANNELS[channelIndex]!.id);
      return;
    }
    if (event.name === "r") {
      event.preventDefault?.();
      refresh();
      return;
    }
    if (event.name === "p" && stream) {
      event.preventDefault?.();
      void togglePlayback();
      return;
    }
    if (event.name === "m" && stream) {
      event.preventDefault?.();
      toggleMute();
      return;
    }
    if (event.name === "o") {
      event.preventDefault?.();
      void renderer.openExternal(channel.channelUrl);
    }
  });

  const streamKind = stream?.isLive === false ? "latest replay" : "live";
  const replayDetail = stream?.isLive === false && stream.publishedText ? ` · ${stream.publishedText}` : "";
  const status = loading
    ? `resolving ${channel.name}`
    : error || playbackError
      ? "stream error"
      : playbackState === "playing"
        ? `playing ${streamKind}${replayDetail}`
        : playbackState === "loading"
          ? `buffering ${streamKind}${replayDetail}`
          : stream
            ? `${streamKind}${replayDetail}`
            : "offline";

  usePaneFooter(paneId, () => ({
    info: [{
      id: "tv-status",
      parts: [{
        text: status,
        tone: error || playbackError ? "warning" : playbackState === "playing" ? "positive" : "value",
      }],
    }],
    hints: [
      {
        id: "playback",
        key: "p",
        label: playbackState === "playing" ? "ause" : "lay",
        onPress: () => { void togglePlayback(); },
        disabled: loading || !stream,
      },
      {
        id: "mute",
        key: "m",
        label: muted ? "unmute" : "ute",
        onPress: toggleMute,
        disabled: loading || !stream,
      },
      {
        id: "open",
        key: "o",
        label: "pen",
        onPress: () => { void renderer.openExternal(channel.channelUrl); },
      },
    ],
  }), [channel.channelUrl, error, loading, muted, paneId, playbackError, playbackState, refresh, renderer, status, stream, toggleMute, togglePlayback]);

  const channelTabs = useMemo(() => TV_CHANNELS.map((item, index) => ({
    label: `${index + 1} ${item.name}`,
    value: item.id,
  })), []);
  const mediaHeight = Math.max(6, height - 1);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} paddingX={1}>
        <Tabs
          tabs={channelTabs}
          activeValue={channelId}
          onSelect={selectChannel}
          compact
          variant="bare"
          focused={focused}
        />
      </Box>

      <PaneStatusBody
        loading={loading && !stream}
        error={error ?? (!loading && !stream ? `${channel.name} is offline.` : null)}
        loadingLabel={`Resolving ${channel.name} live stream...`}
        align="center"
        actions={<Button label="Try again" variant="primary" onPress={refresh} />}
      >
      {stream ? isDesktop ? (
        <MediaSurface
          src={webMediaSource(stream)}
          title={stream.title}
          poster={stream.posterUrl}
          autoPlay
          muted={muted}
          mediaHandleRef={mediaRef}
          height={mediaHeight}
          flexGrow={1}
          onPlaybackStateChange={setPlaybackState}
          onMutedChange={setMuted}
          onError={handlePlaybackError}
        >
          <PaneStatusBody error={playbackError ?? "Live video unavailable."} align="center" />
        </MediaSurface>
      ) : (
        <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
          <ImageSurface
            src={stream.posterUrl}
            alt={stream.title}
            objectFit="contain"
            width="100%"
            height={Math.max(5, mediaHeight - 2)}
          >
            <Box flexGrow={1} justifyContent="center" alignItems="center">
              <Text fg={colors.text}>{stream.title}</Text>
              {stream.isLive === false && stream.publishedText ? (
                <Text fg={colors.textMuted}>{stream.publishedText}</Text>
              ) : null}
            </Box>
          </ImageSurface>
          <Button
            label="Play in Kitty"
            shortcut="p"
            variant="primary"
            disabled={!renderer.playTerminalMedia}
            onPress={() => void togglePlayback()}
          />
          {playbackError ? <Notice tone="negative">{playbackError}</Notice> : null}
        </Box>
      ) : null}
      </PaneStatusBody>
    </Box>
  );
}
