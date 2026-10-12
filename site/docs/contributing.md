---
title: Contributing
description: How the code fits together, the one-codebase rules for desktop and mobile, the checks to run, and how to send a change.
---

Contributions are welcome: bug reports, fixes, documentation, testing on hardware we don't have, and especially testing on phones. Start with an [issue]({{issues}}) for anything bigger than a small fix, so we can agree on the approach first.

## Ground rules

- **Lightweight first.** Small binary, few dependencies, no background work when nothing is on screen. A new crate or a new polling loop needs a good reason.
- **One codebase for desktop and mobile.** See below.
- **Plain words in the interface.** Error messages are sentences a non-technical person can act on.

## How it fits together

```text
ui/                    the interface (plain HTML/CSS/JS, no build step)
  platform.js          what this device can do; compact (phone) layout switch
  app.js               screens: sign-in, live grid and camera view, exports, load, settings
  webrtc.js            WebRTC and MSE live players, and the fallback order
  timeline.js          the zoomable recordings bar (canvas)
  playback.js          recordings player and multi-camera sync
src-tauri/src/
  lib.rs               the app, shared by desktop and mobile
  main.rs              desktop entry: command-line mode, then the window
  commands.rs          everything the UI can call
  platform/            desktop.rs and mobile.rs (the only OS-specific code)
  frigate.rs           Frigate API client
  jobs.rs              export pipeline: queue → render → download → clean up
  mse.rs, notify.rs    live MSE stream; alert watcher
  media.rs, tls.rs     local media server; certificate checks and pinning
  cli.rs               command-line mode (desktop only)
dev/                   mock Frigate server, cross-platform lint script
docs/PLATFORMS.md      the desktop/mobile contract and feature matrix
site/                  this website
```

Sign-in and certificates live in Rust; the web view never talks to Frigate directly.

## One codebase, every platform

The app ships on desktop today and builds for Android and iOS from the same code. `docs/PLATFORMS.md` is the contract that keeps it that way; read it before adding a feature. In short:

1. **OS-specific code lives only in `src-tauri/src/platform/`**, in `desktop.rs` *and* `mobile.rs`, with the same function signatures on both sides. The side that can't do something returns a clear "isn't available on this device yet" error instead of failing to compile.
2. **The interface asks for capabilities, not platforms.** It checks `Platform.has("…")` or `data-needs="…"`, never the user agent. A new capability gets a flag in `platform::Features`.
3. **Layout keys off `html[data-compact]`** (phones, and desktop windows under 700 px), touch tweaks off `html.touch`. Anything hover reveals must also work with a tap.
4. **Platform-only crates** go in target-specific sections of `Cargo.toml`. Prefer pure-Rust crates; anything needing CMake or system libraries makes building for phones painful.

## Before you send a change

Run these from the repository root:

```sh
cd src-tauri && cargo test                    # unit tests
sh dev/cross-check.sh                         # clippy, warnings as errors: Linux, Windows, Android
for f in ui/*.js; do node --check "$f"; done  # UI scripts parse
```

`dev/cross-check.sh` type-checks Linux, Windows and Android from one Linux machine without their SDKs. It needs `clang`, `llvm-ar` and `rustup target add x86_64-pc-windows-msvc aarch64-linux-android`.

**CI** (`.github/workflows/check.yml`) runs the same checks on every push and adds macOS and iOS, which need a Mac.

Test against `dev/mock_frigate.py` (see [Building](building.md#without-cameras)) or your own Frigate. To see the phone layout, make the window narrower than 700 px.

## Improving these docs

The website and docs live in `site/` in the same repository. Each docs page is a Markdown file in `site/docs/`, and every page has an **Edit this page on GitHub** link at the bottom. `site/README.md` explains how to build the site locally and add a page.

## Reporting bugs

[Open an issue]({{issues}}) with steps to reproduce and the text from **server menu → About → Copy version info**. For security problems, see [Reporting a security problem](privacy-and-security.md#reporting-a-security-problem).
