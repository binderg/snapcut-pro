<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/snapcut-pro-logo-dark-mode.svg">
    <img alt="SnapCut Pro" src="docs/assets/snapcut-pro-logo.svg" width="520">
  </picture>
</p>

<p align="center">
  <strong>A desktop video editor where you and an AI agent cut the same timeline, live.</strong>
</p>

<p align="center">
  <img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-007dd1">
  <img alt="Built with Tauri and React" src="https://img.shields.io/badge/built%20with-Tauri%20%2B%20React-lightgrey">
  <img alt="Engine: SnapCut Core" src="https://img.shields.io/badge/engine-SnapCut%20Core-d10000">
</p>

<p align="center">
  <a href="#getting-started">Getting started</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#keyboard-shortcuts">Shortcuts</a> ·
  <a href="#editing-with-an-agent">With an agent</a> ·
  <a href="#how-it-works">How it works</a>
</p>

---

SnapCut Pro is the desktop editor for
[SnapCut Core](https://github.com/binderg/snapcut-core), the headless video
engine. It is a CapCut-style app for real footage (talking heads, podcasts,
phone clips, screen recordings): a media bin, a player, a timeline and an
inspector, with the cutting, rendering and undo all done by the engine.

The editor is only a client. Everything it does goes through the same
JSON-RPC API that an AI agent uses from the command line, so an agent can
work on your project while it is open. Its cuts show up on your timeline as
it makes them, and undo knows which edits were yours and which were the
agent's.

> [!NOTE]
> **Status: alpha.** The editor works against SnapCut Core 0.1.0-rc.1 but
> has no installer yet; you run it from source. Windows is where it has been
> used most. See [What is not done yet](#what-is-not-done-yet).

## What it does

**Projects.** Create a project (landscape, vertical, square or 4K, any frame
rate) or open an existing folder. Recent projects are listed on the start
screen.

**Media.** Import video, audio and images, see thumbnails, preview a source
clip in the player, and insert it at the start, the playhead or the end, or
drag it onto the timeline.

**Timeline.** Any number of video and audio tracks, with hide, mute, rename
and reorder. Split, trim (ripple or roll), ripple delete, lift, delete left
or right of the playhead, and unlink audio from video for J and L cuts.
Drag a clip onto another to put it before or after, pushing the rest, or
drag past a neighbour's middle to swap places. Zoom, scroll at the edge
while dragging, and markers.

**Player.** Smooth playback from the engine's rendered chunks, with a render
bar showing what is ready. Move, resize and rotate the selected clip right
in the picture. Full screen.

**Inspector.** Position, scale, rotation, opacity and crop per clip, volume,
and speed as an exact ratio (`3/2`) or a decimal. Keyframed values are
marked.

**Effects and transitions.** Apply the engine's effects to clips. Browse 125
transitions from [gl-transitions](https://gl-transitions.com) with live
preview cards, drop them on cuts, then drag to move or resize them.

**Analyze.** Find silences (with a threshold, minimum length and how much
breath to keep) and scene cuts. They become markers you can review and cut
in one step.

**History.** Every edit with who made it, from you, an agent or a plugin.

**Export.** One button, with the engine's presets (master, YouTube 1080p and
720p, vertical 1080x1920, draft).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play or pause |
| `S` or `Ctrl+B` | Split at the playhead |
| `Q` / `W` | Delete everything left / right of the playhead in the clip |
| `Delete` or `Backspace` | Ripple delete (close the gap) |
| `Shift+Delete` | Lift (leave a gap) |
| `M` | Add a marker |
| `←` / `→` | Back / forward one frame (`Shift`: one second) |
| `Home` / `End` | Go to the start / end |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` or `Ctrl+Shift+Z` | Redo |
| `Esc` | Clear the selection |

On macOS, `Cmd` works in place of `Ctrl`.

## Getting started

You need:

- **SnapCut Core** (the `ve` command). Install it with the one-line
  installer in the [SnapCut Core README](https://github.com/binderg/snapcut-core#install),
  or build it from source. It comes with FFmpeg.
- **Node.js** 20 or newer.
- **Rust** and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
  for your platform (WebView2 on Windows is already there on Windows 11).

Then:

```bash
npm install
npm run tauri dev
```

On the start screen, create a project or open a folder that has a
`project.otio`. The editor finds `ve` in this order: the path you type under
"Engine binary", then `VE_BIN`, then your `PATH`, then a local engine build
(`CARGO_TARGET_DIR`, or `%LOCALAPPDATA%\ve-target` on Windows).

To build an installer for your platform:

```bash
npm run tauri build
```

<details>
<summary>Running in a plain browser</summary>

`npm run dev` serves the UI at `http://localhost:5173`. In a browser it
cannot start the engine for you, so start a project's daemon yourself and
paste its WebSocket URL into the start screen:

```bash
ve --project path/to/my-edit daemon start
```

Picking folders, previewing source files and installing the transitions
pack only work in the desktop app.

</details>

## Editing with an agent

Open the project in SnapCut Pro, then point an agent at the same folder.
SnapCut Core ships a skill for that,
[`skills/video-edit`](https://github.com/binderg/snapcut-core/tree/main/skills/video-edit);
for Claude Code:

```bash
cp -r skills/video-edit ~/.claude/skills/
```

Ask it to "tighten this video" and watch the pauses disappear from your
timeline. Both of you talk to the same per-project engine, so:

- Its edits arrive in the editor as they happen.
- If you both change the project at once, the engine refuses the stale edit
  instead of overwriting, and the editor refreshes and tells you.
- History shows `agent:<name>` next to its edits, and you can undo them
  without losing your own.

## How it works

```
   SnapCut Pro (Tauri + React)        AI agent (ve CLI + skill)
                 \                            /
                  '-- JSON-RPC 2.0 over WebSocket / local socket --'
                                   |
              SnapCut Core daemon (one per project folder)
```

- **The desktop shell** (`src-tauri/`) is small. It runs
  `ve daemon start` for the project and hands the WebSocket URL to the UI,
  creates new projects with `ve init`, lets the player read imported source
  files, and installs the bundled gl-transitions pack on first start.
- **The UI** (`src/`) is React with no state library. It subscribes to the
  engine's `project.changed` events, refetches the project and renders it.
  Every edit is an engine call that carries the revision it was based on.
- **Nothing is edited locally.** Splits, trims, speed and transforms are
  engine methods (`edit.*`, `transition.*`), so a cut made here is exactly
  the cut an agent would make, and it saves as OpenTimelineIO that opens in
  Resolve, Premiere or Avid.

| Path | What is in it |
| --- | --- |
| `src/Connect.tsx` | Start screen: new project, open, recent, engine path |
| `src/Editor.tsx` | Layout, keyboard shortcuts, export |
| `src/Timeline.tsx` | Tracks, clips, drag and drop, trims, transitions on cuts |
| `src/Player.tsx` | Playback from cached chunks, on-canvas transform handles |
| `src/LeftPanel.tsx` | Media, effects, transitions, markers, analyze, history |
| `src/Inspector.tsx` | Clip properties (video, audio, speed) |
| `src/engine.ts`, `src/rpc.ts` | WebSocket JSON-RPC client and project state |
| `src/model.ts` | Turns the OTIO project into tracks and clips for the UI |
| `src-tauri/` | Desktop shell |
| `plugins/` | Editor-only plugins (empty for now) |

## What is not done yet

- No installer or signed builds yet; run it from source.
- Some features the editor needs (thumbnails, render-ahead,
  drag-to-push) are still engine methods under `ui.*`. They will move into
  an editor plugin.
- No text, captions or keyframe editing in the UI yet, although the engine
  supports them (use `ve text`, `ve captions` and `ve transform` meanwhile).
- A stretch of the timeline the engine has not rendered yet waits a second
  or two before it plays.
- Tested mostly on Windows.
- `src-tauri/.cargo/config.toml` points the build folder at a path on the
  author's machine. Change or delete it before building elsewhere.

## Related

- [SnapCut Core](https://github.com/binderg/snapcut-core): the engine, CLI,
  API reference (`skills/ve-core/`) and plugins.
