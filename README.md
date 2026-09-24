# TV for Gloomberb

Live Bloomberg, CNBC, and Yahoo Finance television alongside your market research. When a channel is off air, TV falls back to its latest public video and shows its publication label.

## Install

This plugin requires Gloomberb 0.15.0 for title-bar tabs ([Gloomberb #1091](https://github.com/gloom-sh/gloomberb/pull/1091)). That host release is pending; released 0.14.x is not supported.

```sh
gloomberb install gloom-sh/gloom-tv
```

Open `TV` in the command bar. Existing Gloomberb installations restore this plugin once during the migration. Saved TV panes and their selected channels keep working because their pane and template IDs remain unchanged. A previously disabled TV/Macro plugin is not re-enabled, and deliberate removals are respected.

## Playback

- Desktop: embedded video with playback and mute controls. The channels sit as tabs in the pane title bar.
- Terminal: Kitty-compatible video output through `mpv`, started with `p` or the `[p]lay` action in the pane footer. Install `mpv` with Kitty support; `yt-dlp` is not required. Playback never starts on its own here, because the player takes the terminal over for as long as it runs. The app resumes when playback exits.
- Hosted web: external plugins are not loaded by the hosted Gloomberb app.

Press `1`, `2`, or `3` to change channels, `r` to refresh, `p` to play/pause, `m` to mute/unmute, and `o` to open the channel in your browser. The footer actions and channel tabs also support the mouse. When a stream cannot be resolved, or the desktop player cannot play it, the pane shows the reason with a Try again button.

Public stream availability depends on YouTube, the channel, your location, and consent requirements. Stream URLs are refreshed before expiry; playback failures trigger one recovery attempt per video.

## Development

```sh
bun install
# Link a checkout containing the new host API, as the plugin installer does:
ln -s /path/to/gloomberb node_modules/gloomberb
ln -s /path/to/gloomberb/node_modules/react node_modules/react
bun run typecheck
bun test
```

`index.ts` is the native entry: it registers the `tv.stream` capability and owns stream resolution. `index.browser.ts` exports the same pane UI and invokes that capability in the desktop backend. Browser bundles do not carry `youtubei.js`, native code, or a second React instance.

The pane uses only Gloomberb's public UI, component, runtime, and capability APIs. YouTube resolution stays in this repository; the host supplies generic media playback.
