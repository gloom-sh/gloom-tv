import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Notice, PaneStatusBody, Tabs, usePaneFooter, usePaneHeaderTabs } from "gloomberb/components";
import { useCapabilityInvoker, usePaneSettingValue, usePaneTitle, useShortcut } from "gloomberb/react";
import { colors } from "gloomberb/theme";
import type { PaneProps } from "gloomberb/types/plugin";
import { Box, ImageSurface, MediaSurface, Text, useRendererHost, useUiHost, type MediaSurfaceHandle } from "gloomberb/ui";
import { getTvChannel, TV_CHANNELS, type TvChannelId } from "./channels";
import type { ResolvedLiveStream } from "./types";
import { isYoutubeEmbedUrl } from "./youtube-embed";
import { desktopMediaSource, desktopPlaybackFailure, isIncompatibleCodecError } from "./desktop-playback";
import { TV_STREAM_CAPABILITY_ID } from "./capability";

type PlaybackState = "idle" | "loading" | "playing" | "paused" | "error";
type LoadMode = "initial" | "refresh" | "retry";

const INITIAL_MEDIA: {
  stream: ResolvedLiveStream | null;
  attempt: number;
  playbackError: string | null;
  playbackState: PlaybackState;
} = { stream: null, attempt: 0, playbackError: null, playbackState: "idle" };

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

export function TvPane({ paneId, focused, width, height }: PaneProps) {
  const isDesktop = useUiHost().kind === "desktop-web";
  const renderer = useRendererHost();
  const capabilities = useCapabilityInvoker();
  const [storedChannelId, setChannelId] = usePaneSettingValue<TvChannelId>("channelId", "bloomberg");
  const channelId = TV_CHANNELS.find(({ id }) => id === storedChannelId)?.id ?? "bloomberg";
  const [media, setMedia] = useState(INITIAL_MEDIA);
  const { stream, attempt, playbackError, playbackState } = media;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const mediaRef = useRef<MediaSurfaceHandle | null>(null);
  const recoveredRef = useRef(false);
  const generationRef = useRef(0);
  const channel = getTvChannel(channelId);

  // The active channel tab names the channel, so the title stays "TV". Setting
  // it also replaces the "TV: <channel>" title older versions saved in layouts.
  usePaneTitle("TV");

  const setPlaybackState = useCallback((playbackState: PlaybackState) => {
    setMedia((current) => current.playbackState === playbackState ? current : { ...current, playbackState });
  }, []);

  const setPlaybackError = useCallback((playbackError: string | null) => {
    setMedia((current) => current.playbackError === playbackError ? current : { ...current, playbackError });
  }, []);

  const load = useCallback(async (mode: LoadMode = "initial"): Promise<ResolvedLiveStream | null> => {
    const generation = ++generationRef.current;
    if (mode !== "refresh") recoveredRef.current = false;
    setLoading(true);
    setError(null);
    setMedia((current) => mode !== "retry" && current.stream?.sourceId === channel.id
      ? current
      : { ...INITIAL_MEDIA, attempt: current.attempt + 1 });
    try {
      const nextStream = await capabilities.invokeCapability<ResolvedLiveStream>(TV_STREAM_CAPABILITY_ID, "resolve", {
        sourceId: channel.id, force: mode !== "initial",
      });
      if (generation !== generationRef.current) return null;
      setMedia((current) => current.stream?.manifestUrl === nextStream.manifestUrl && current.stream.sourceId === nextStream.sourceId
        ? { ...current, stream: nextStream }
        : { ...INITIAL_MEDIA, attempt: current.attempt, stream: nextStream });
      return nextStream;
    } catch (cause) {
      if (generation !== generationRef.current) return null;
      setMedia((current) => ({ ...INITIAL_MEDIA, attempt: current.attempt }));
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [capabilities, channel]);

  const retry = useCallback(() => {
    void load("retry");
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
  const manifestUrl = stream?.manifestUrl;
  const expiresAt = stream?.expiresAt;
  useEffect(() => {
    if (!manifestUrl || !expiresAt || !isDesktop || playbackError || isYoutubeEmbedUrl(manifestUrl)) return;
    const delay = Math.max(5_000, expiresAt - MANIFEST_SAFETY_MARGIN_MS - Date.now());
    const timer = setTimeout(() => {
      void load("refresh");
    }, delay);
    return () => clearTimeout(timer);
  }, [expiresAt, isDesktop, load, manifestUrl, playbackError]);

  // A dead manifest can recover with a fresh URL. A channel visit or a manual
  // retry gets one automatic resolution, even if successive failures change IDs.
  const handlePlaybackError = useCallback((message: string) => {
    setPlaybackError(message);
    if (!manifestUrl || isIncompatibleCodecError(message) || recoveredRef.current) return;
    recoveredRef.current = true;
    void load("refresh");
  }, [load, manifestUrl, setPlaybackError]);

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
  }, [load, muted, renderer, setPlaybackError, setPlaybackState, stream]);

  // Terminal playback is never automatic. The player is a separate process that
  // takes the whole terminal over, so starting one because a pane happens to be
  // mounted would hijack any session that merely restored this pane from the
  // saved layout, including one nobody is looking at. `p` starts it instead.

  // Closing the pane must take the player with it; the media process is not
  // tied to the React tree that started it.
  useEffect(() => () => renderer.stopTerminalMedia?.(), [renderer]);

  const togglePlayback = useCallback(async () => {
    try {
      if (isDesktop) {
        if (playbackError || playbackState === "error") retry();
        else await mediaRef.current?.toggle();
      } else {
        await playInTerminal();
      }
    } catch (cause) {
      setPlaybackState("error");
      setPlaybackError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [isDesktop, playbackError, playbackState, playInTerminal, retry, setPlaybackError, setPlaybackState]);

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
      if (!stream || playbackError || playbackState === "error") retry();
      else void load("refresh");
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
  const failed = !!error || !!playbackError || playbackState === "error";
  const status = loading
    ? "resolving"
    : failed
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
        tone: failed ? "warning" : playbackState === "playing" ? "positive" : "value",
      }],
    }],
    hints: [
      {
        id: "playback",
        key: "p",
        label: playbackState === "playing" ? "ause" : "lay",
        onPress: () => { void togglePlayback(); },
        disabled: loading || !stream || (!isDesktop && !renderer.playTerminalMedia),
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
  }), [channel.channelUrl, failed, isDesktop, loading, muted, paneId, playbackState, renderer, status, stream, toggleMute, togglePlayback]);

  const channelTabs = useMemo(() => TV_CHANNELS.map((item, index) => ({
    label: `${index + 1} ${item.name}`,
    value: item.id,
  })), []);
  // The pane's only partition: on the desktop the chrome draws it in the title
  // bar, which gives the video the row the strip used to take.
  const tabsInHeader = usePaneHeaderTabs({
    tabs: channelTabs,
    activeValue: channelId,
    onSelect: selectChannel,
    focused,
  });
  const mediaHeight = Math.max(6, height - (tabsInHeader ? 0 : 1));
  const retryAction = <Button label="Try again" variant="primary" onPress={retry} />;
  const desktopFailure = desktopPlaybackFailure(playbackError, stream?.watchUrl ?? channel.channelUrl);
  const desktopErrorActions = <>
    <Button label={desktopFailure.open.label} variant="primary" onPress={() => { void renderer.openExternal(desktopFailure.open.url); }} />
    <Button label="Try again" onPress={retry} />
  </>;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {!tabsInHeader && (
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
      )}

      <PaneStatusBody
        loading={loading && !stream}
        error={error ?? (!loading && !stream ? `${channel.name} is offline.` : null)}
        loadingLabel={`Resolving ${channel.name} live stream...`}
        align="center"
        actions={isDesktop ? desktopErrorActions : retryAction}
      >
      {stream ? isDesktop ? (
        <MediaSurface
          key={`${attempt}:${stream.manifestUrl}`}
          src={desktopMediaSource(stream, activeWebOrigin())}
          title={stream.title}
          poster={stream.posterUrl}
          autoPlay
          muted={muted}
          mediaHandleRef={mediaRef}
          flexGrow={1}
          flexBasis={0}
          minHeight={0}
          onPlaybackStateChange={setPlaybackState}
          onMutedChange={setMuted}
          onError={handlePlaybackError}
        >
          <PaneStatusBody error={desktopFailure.message} align="center" actions={desktopErrorActions} />
        </MediaSurface>
      ) : (
        <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
          <ImageSurface
            src={stream.posterUrl}
            alt={stream.title}
            objectFit="contain"
            width="100%"
            height={Math.max(5, mediaHeight - (playbackError ? 2 : 0))}
          >
            <Box flexGrow={1} justifyContent="center" alignItems="center">
              <Text fg={colors.text}>{stream.title}</Text>
              {stream.isLive === false && stream.publishedText ? (
                <Text fg={colors.textMuted}>{stream.publishedText}</Text>
              ) : null}
            </Box>
          </ImageSurface>
          {playbackError ? <Notice tone="negative">{playbackError}</Notice> : null}
        </Box>
      ) : null}
      </PaneStatusBody>
    </Box>
  );
}
