import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Notice, PaneStatusBody, Tabs, usePaneFooter, usePaneHeaderTabs } from "gloomberb/components";
import { useCapabilityInvoker, usePaneSettingValue, usePaneTitle, useShortcut } from "gloomberb/react";
import { colors } from "gloomberb/theme";
import type { PaneProps } from "gloomberb/types/plugin";
import { Box, ImageSurface, MediaSurface, Text, useRendererHost, useUiHost, type MediaSurfaceHandle } from "gloomberb/ui";
import { getTvChannel, TV_CHANNELS, type TvChannelId } from "./channels";
import type { ResolvedLiveStream } from "./types";
import { TV_STREAM_CAPABILITY_ID } from "./capability";
import { CompatibleVideo } from "./compatible-video";
import { chooseDesktopPlayback, desktopPlaybackSupport, selectDesktopSource, type PlaybackState } from "./playback";

/** Re-resolve this long before expiry so playback never starts on a dead URL. */
const MANIFEST_SAFETY_MARGIN_MS = 60_000;
const DESKTOP_PLAYBACK_ERROR = "This stream can't play in the desktop app. Open it in your browser to watch.";

function isPlayableNow(stream: ResolvedLiveStream | null): stream is ResolvedLiveStream {
  return !!stream && Date.now() < stream.expiresAt - MANIFEST_SAFETY_MARGIN_MS;
}

export function TvPane({ paneId, focused, width, height }: PaneProps) {
  const isDesktop = useUiHost().kind === "desktop-web";
  const desktopSupport = useMemo(() => isDesktop && typeof document !== "undefined"
    ? desktopPlaybackSupport(document.createElement("video"), globalThis.MediaSource)
    : null, [isDesktop]);
  const renderer = useRendererHost();
  const capabilities = useCapabilityInvoker();
  const [storedChannelId, setChannelId] = usePaneSettingValue<TvChannelId>("channelId", "bloomberg");
  const channelId = TV_CHANNELS.find(({ id }) => id === storedChannelId)?.id ?? "bloomberg";
  const [stream, setStream] = useState<ResolvedLiveStream | null>(null);
  const [streamVersion, setStreamVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [preferCompatible, setPreferCompatible] = useState(false);
  const [muted, setMuted] = useState(true);
  const mediaRef = useRef<MediaSurfaceHandle | null>(null);
  const recoveredStreamRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const channel = getTvChannel(channelId);
  const playbackMode = chooseDesktopPlayback(desktopSupport, preferCompatible);
  const webSource = isDesktop && stream ? selectDesktopSource(stream, playbackMode, globalThis.location?.origin) : null;
  const webSourceKind = webSource?.kind;

  // The active channel tab names the channel, so the title stays "TV". Setting
  // it also replaces the "TV: <channel>" title older versions saved in layouts.
  usePaneTitle("TV");

  const load = useCallback(async (force = false): Promise<ResolvedLiveStream | null> => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setPlaybackError(null);
    setPlaybackState("idle");
    setStream((current) => current?.sourceId === channel.id ? current : null);
    try {
      const nextStream = await capabilities.invokeCapability<ResolvedLiveStream>(TV_STREAM_CAPABILITY_ID, "resolve", {
        sourceId: channel.id, force, compatible: playbackMode === "compatible",
      });
      if (generation !== generationRef.current) return null;
      setStream(nextStream);
      setStreamVersion(generation);
      return nextStream;
    } catch (cause) {
      if (generation !== generationRef.current) return null;
      setStream(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [capabilities, channel, playbackMode]);

  const refresh = useCallback(() => {
    recoveredStreamRef.current = null;
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
    if (!stream || !webSourceKind || webSourceKind === "embed") return;
    const delay = Math.max(5_000, stream.expiresAt - MANIFEST_SAFETY_MARGIN_MS - Date.now());
    const timer = setTimeout(() => {
      void load(true);
    }, delay);
    return () => clearTimeout(timer);
  }, [load, stream, webSourceKind]);

  // A dead manifest surfaces as a media error; re-resolve once per stream so a
  // silent expiry recovers without the user pressing anything.
  const handlePlaybackError = useCallback((message?: string) => {
    if (webSourceKind === "hls" && desktopSupport?.compatible && message?.endsWith("manifestIncompatibleCodecsError")) {
      setLoading(true);
      setPreferCompatible(true);
      return;
    }
    const streamKey = stream ? `${stream.sourceId}:${stream.videoId}:${webSourceKind}` : null;
    if (streamKey && recoveredStreamRef.current !== streamKey) {
      recoveredStreamRef.current = streamKey;
      void load(true);
      return;
    }
    setPlaybackState("error");
    setPlaybackError(DESKTOP_PLAYBACK_ERROR);
  }, [desktopSupport, load, stream, webSourceKind]);

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

  // Terminal playback is never automatic. The player is a separate process that
  // takes the whole terminal over, so starting one because a pane happens to be
  // mounted would hijack any session that merely restored this pane from the
  // saved layout, including one nobody is looking at. `p` starts it instead.

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
      setPlaybackError(isDesktop ? DESKTOP_PLAYBACK_ERROR : cause instanceof Error ? cause.message : String(cause));
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
  const desktopError = isDesktop && stream ? playbackError ?? (!loading && !webSource ? DESKTOP_PLAYBACK_ERROR : null) : null;
  const canControlDesktop = !!webSource && !desktopError;
  const status = loading
    ? "resolving"
    : error || desktopError || playbackError
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
        tone: error || desktopError || playbackError ? "warning" : playbackState === "playing" ? "positive" : "value",
      }],
    }],
    hints: [
      {
        id: "playback",
        key: "p",
        label: playbackState === "playing" ? "ause" : "lay",
        onPress: () => { void togglePlayback(); },
        disabled: loading || (isDesktop ? !canControlDesktop : !stream || !renderer.playTerminalMedia),
      },
      {
        id: "mute",
        key: "m",
        label: muted ? "unmute" : "ute",
        onPress: toggleMute,
        disabled: loading || (isDesktop ? !canControlDesktop : !stream),
      },
      {
        id: "open",
        key: "o",
        label: "pen",
        onPress: () => { void renderer.openExternal(channel.channelUrl); },
      },
    ],
  }), [canControlDesktop, channel.channelUrl, desktopError, error, isDesktop, loading, muted, paneId, playbackError, playbackState, renderer, status, stream, toggleMute, togglePlayback]);

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
  const errorActions = <>
    <Button label="Try again" variant="primary" onPress={refresh} />
    {isDesktop && <Button label="Open in browser" onPress={() => { void renderer.openExternal(stream?.watchUrl ?? channel.channelUrl); }} />}
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
        loading={loading && (!stream || (isDesktop && !webSource))}
        error={error ?? desktopError ?? (!loading && !stream ? `${channel.name} is offline.` : null)}
        loadingLabel={`Resolving ${channel.name} live stream...`}
        align="center"
        actions={errorActions}
      >
      {stream && webSource?.kind === "compatible" && (
        <CompatibleVideo
          key={streamVersion}
          src={webSource.src}
          title={stream.title}
          poster={stream.posterUrl}
          muted={muted}
          mediaHandleRef={mediaRef}
          onPlaybackStateChange={setPlaybackState}
          onMutedChange={setMuted}
          onError={handlePlaybackError}
        />
      )}
      {stream && webSource && webSource.kind !== "compatible" && (
        <MediaSurface
          key={streamVersion}
          src={webSource.src}
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
          <PaneStatusBody error={DESKTOP_PLAYBACK_ERROR} align="center" actions={errorActions} />
        </MediaSurface>
      )}
      {stream && !isDesktop && (
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
      )}
      </PaneStatusBody>
    </Box>
  );
}
