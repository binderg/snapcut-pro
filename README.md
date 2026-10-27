<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/snapcut-pro-logo-dark-mode.svg">
    <img alt="SnapCut Pro" src="docs/assets/snapcut-pro-logo.svg" width="520">
  </picture>
</p>

<p align="center">
  <strong>An early desktop editor for SnapCut Core.</strong>
</p>

<p align="center">
  <img alt="Status: pre-alpha" src="https://img.shields.io/badge/status-pre--alpha-007dd1">
</p>

---

> [!WARNING]
> **Pre-alpha.** This is a bare-bones work in progress, not something to
> edit real projects with. There are no releases or installers, things are
> missing or broken, and anything can change.

SnapCut Pro is a desktop editor (Tauri + React) on top of
[SnapCut Core](https://github.com/binderg/snapcut-core), the headless video
engine. The engine does all the editing, rendering and undo; this app is a
window onto it. Because it talks to the same API an AI agent uses from the
command line, an agent's edits to an open project show up on the timeline
as they happen.

## What works so far

- Create or open a project folder.
- Import media and put it on the timeline.
- Basic timeline editing: split, trim, delete, move, tracks, markers, undo.
- Playback from engine-rendered chunks, with move, scale and rotate in the
  player.
- Transitions on cuts, clip speed and volume.
- Silence and scene detection, and export with the engine's presets.

Most of what the engine can do (text, captions, keyframes, effects
settings) has no UI yet.

## Running it

You need SnapCut Core's `ve` command (see its
[README](https://github.com/binderg/snapcut-core#install)), Node.js 20+,
and Rust with the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev
```

The app looks for `ve` in the "Engine binary" field, then `VE_BIN`, then
your `PATH`.

`src-tauri/.cargo/config.toml` points the build folder at a path on the
author's machine; change or delete it before building elsewhere.

## Related

- [SnapCut Core](https://github.com/binderg/snapcut-core): the engine, CLI
  and API docs.
