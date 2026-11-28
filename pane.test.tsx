import { expect, mock, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import { Window } from "happy-dom";
import { act, useEffect, useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import { UiHostProvider, type MediaSurfaceHandle, type MediaSurfaceProps } from "gloomberb/ui";
import { TV_CHANNELS, type TvChannelId } from "./channels";
import type { ResolvedLiveStream } from "./types";
import { fallbackTvStream } from "./youtube-embed";

const { createRoot } = createRequire(require.resolve("gloomberb/ui"))("react-dom/client") as typeof import("react-dom/client");
const components = { ...await import("gloomberb/components") };
type ReadFooter = Parameters<typeof components.usePaneFooter>[1];
let readFooter: ReadFooter;
let header: NonNullable<Parameters<typeof components.usePaneHeaderTabs>[0]>;
const resolveStream = mock<(...args: unknown[]) => Promise<ResolvedLiveStream>>();
const capabilityInvoker = { invokeCapability: resolveStream };

mock.module("gloomberb/react", () => ({
  useCapabilityInvoker: () => capabilityInvoker,
  usePaneSettingValue: () => useState("bloomberg"),
  usePaneTitle: () => {},
  useShortcut: () => {},
}));
mock.module("gloomberb/components", () => ({
  ...components,
  usePaneHeaderTabs: (options: typeof header) => { header = options; return true; },
  usePaneFooter: (_id: string, read: ReadFooter) => { readFooter = read; },
}));

const { TvPane } = await import("./pane");
const channel = TV_CHANNELS[0];
const embeddedStream = fallbackTvStream(channel, { videoId: "abcdefghijk", isLive: true });
const embedError = "The embedded player could not play this stream.";

async function withPane(
  results: (ResolvedLiveStream | Error)[],
  check: (qa: {
    players: { src: string | undefined; fail(message?: string): void }[];
    renders: { tab: string | null; src: string | undefined }[];
    click(name: string): Promise<void>;
    findButton(name: string): { click(): void } | undefined;
    control(id: string): Promise<void>;
    select(tab: TvChannelId): Promise<void>;
    status(): string | undefined;
    openExternal: (url: string) => Promise<void>;
  }) => Promise<void>,
) {
  const browser = new Window({ url: "http://localhost" });
  const globals = { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const root = createRoot(browser.document.body as unknown as HTMLElement);
  resolveStream.mockReset();
  let index = 0;
  resolveStream.mockImplementation(async () => {
    const result = results[Math.min(index++, results.length - 1)]!;
    if (result instanceof Error) throw result;
    return { ...result };
  });
  const openExternal = mock(async (_url: string) => {});
  const players: { src: string | undefined; fail(message?: string): void }[] = [];
  const renders: { tab: string | null; src: string | undefined }[] = [];

  type FakePlayerProps = Pick<MediaSurfaceProps, "src" | "muted" | "onPlaybackStateChange" | "onMutedChange" | "onError">
    & { mediaHandleRef?: Ref<MediaSurfaceHandle>; children?: ReactNode };
  function FakePlayer(props: FakePlayerProps) {
    renders.push({ tab: header.activeValue, src: props.src });
    const [failed, setFailed] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [muted, setMuted] = useState(props.muted ?? true);
    useEffect(() => {
      players.push({ src: props.src, fail(message = embedError) {
        setFailed(true);
        props.onPlaybackStateChange?.("error");
        props.onError?.(message);
      } });
      props.onPlaybackStateChange?.("loading");
    }, []);
    useImperativeHandle(props.mediaHandleRef, () => ({
      async play() { props.onPlaybackStateChange?.("playing"); },
      pause() { props.onPlaybackStateChange?.("paused"); },
      async toggle() {
        props.onPlaybackStateChange?.(playing ? "paused" : "playing");
        setPlaying(!playing);
      },
      toggleMuted() {
        setMuted(!muted);
        props.onMutedChange?.(!muted);
        return !muted;
      },
    }));
    return failed ? props.children : <div data-test-player={props.src} />;
  }

  type ProviderProps = Parameters<typeof UiHostProvider>[0];
  const ui = {
    kind: "desktop-web",
    Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Button: ({ label, onPress }: { label: string; onPress(): void }) => <button onClick={onPress}>{label}</button>,
    MediaSurface: FakePlayer,
    SpinnerMark: () => null,
  } as unknown as ProviderProps["ui"];
  const renderer: ProviderProps["renderer"] = { openExternal, requestExit() {}, async copyText() {}, async readText() { return ""; }, notify() {} };
  const findButton = (name: string) => [...browser.document.querySelectorAll("button")].find((button) => button.textContent === name);
  try {
    await act(async () => root.render(<UiHostProvider ui={ui} renderer={renderer}>
      <TvPane paneId="tv-test" paneType="macro-tv" focused width={640} height={360} />
    </UiHostProvider>));
    await check({ players, renders, findButton, openExternal,
      click: async (name) => {
        const button = findButton(name);
        expect(button).toBeDefined();
        await act(async () => button?.click());
      },
      control: async (id) => {
        const hint = readFooter()?.hints?.find((entry) => entry.id === id);
        expect(hint?.disabled).toBe(false);
        await act(async () => hint?.onPress?.());
      },
      select: async (tab) => { await act(async () => header.onSelect(tab)); },
      status: () => readFooter()?.info?.[0]?.parts[0]?.text,
    });
  } finally {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test("Try again remounts the same URL, keeps controls, and restores the error when the retry fails", async () => {
  await withPane([embeddedStream], async ({ players, click, findButton, control, status, openExternal }) => {
    expect(players).toHaveLength(1);
    await act(async () => players[0]!.fail());
    expect(resolveStream).toHaveBeenCalledTimes(2);
    const firstFailure = status();
    await click("Open in browser");
    expect(openExternal).toHaveBeenCalledWith(embeddedStream.watchUrl);

    await click("Try again");
    expect(resolveStream).toHaveBeenCalledTimes(3);
    expect(resolveStream.mock.calls[2]?.[2]).toEqual({ sourceId: channel.id, force: true });
    expect(players).toHaveLength(2);
    expect(players[1]?.src).toBe(players[0]?.src);
    expect(firstFailure).toBe("stream error");
    expect(findButton("Try again")).toBeUndefined();
    expect(status()).toBe("buffering live");
    await control("playback");
    expect(status()).toBe("playing live");
    await control("playback");
    expect(readFooter()?.hints?.find((hint) => hint.id === "playback")?.label).toBe("lay");
    await control("mute");
    expect(readFooter()?.hints?.find((hint) => hint.id === "mute")?.label).toBe("ute");

    await act(async () => players[1]!.fail());
    expect(resolveStream).toHaveBeenCalledTimes(4);
    expect(players).toHaveLength(2);
    expect(status()).toBe("stream error");
    expect(findButton("Open in browser")).toBeDefined();
    expect(findButton("Try again")).toBeDefined();
  });
});

test("switching tabs never renders the old publisher; an empty tab opens its public channel", async () => {
  await withPane([embeddedStream, new Error("No verified video")], async ({ renders, select, click, openExternal }) => {
    expect(renders.some(({ tab }) => tab === channel.id)).toBe(true);
    for (const next of TV_CHANNELS.slice(1)) {
      await select(next.id);
      expect(renders.some(({ tab }) => tab === next.id)).toBe(false);
      await click("Open in browser");
      expect(openExternal).toHaveBeenLastCalledWith(next.channelUrl);
    }
  });
});

test("recovery can adopt a new URL but does not retry a chain of failing video IDs", async () => {
  const replacement = fallbackTvStream(channel, { videoId: "zyxwvutsrqp", isLive: true });
  await withPane([embeddedStream, replacement], async ({ players, status }) => {
    await act(async () => players[0]!.fail());
    expect(players).toHaveLength(2);
    expect(players[1]?.src).not.toBe(players[0]?.src);
    await act(async () => players[1]!.fail());
    expect(resolveStream).toHaveBeenCalledTimes(2);
    expect(status()).toBe("stream error");
  });
});

test("manifest refresh does not reschedule an unchanged expiry or retry unsupported playback", async () => {
  const schedule = spyOn(globalThis, "setTimeout");
  try {
    const manifest = { ...embeddedStream, manifestUrl: "https://example.test/stream.m3u8", expiresAt: Date.now() + 50_000 };
    await withPane([manifest], async ({ players, status }) => {
      const timers = () => schedule.mock.calls.filter(([, delay]) => delay === 5_000);
      expect(timers()).toHaveLength(1);
      await act(async () => timers()[0]![0]());
      expect(resolveStream).toHaveBeenCalledTimes(2);
      expect(players).toHaveLength(1);
      expect(timers()).toHaveLength(1);
      await act(async () => players[0]!.fail("Stream playback failed: manifestIncompatibleCodecsError"));
      expect(resolveStream).toHaveBeenCalledTimes(2);
      expect(status()).toBe("stream error");
    });
  } finally {
    schedule.mockRestore();
  }
});
