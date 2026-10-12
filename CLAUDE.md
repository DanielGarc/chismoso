# Working on this repo

A lightweight client for Frigate NVR: Rust + Tauri 2, plain HTML/CSS/JS UI
(no framework, no bundler). Desktop today; Android and iOS from the same code.

## Ground rules

- **Lightweight first.** Small binary, few dependencies, no background work
  when nothing is visible. Justify any new crate or polling loop.
- **One codebase for desktop and mobile.** Follow `docs/PLATFORMS.md`:
  - OS-specific Rust goes only in `src-tauri/src/platform/{desktop,mobile}.rs`,
    with the same function signatures on both sides.
  - The UI checks capabilities (`Platform.has("…")`, `data-needs="…"`), never
    the OS or user agent. New capability → add it to `platform::Features`.
  - Layout: `html[data-compact]` for phones and narrow windows, `html.touch`
    for touch. Hover may reveal, but tap/click must do the action.
  - Platform-only crates go in target-specific `Cargo.toml` sections. Avoid
    crates that need CMake or system libraries.
- Commands the UI calls live in `src-tauri/src/commands.rs` and are registered
  in `lib.rs`. `main.rs` is the desktop entry point only.
- Errors shown to users: plain sentences, no jargon. Rust error strings may
  start with a code (`session-expired:`, `certificate-changed:`) the UI maps.

## Before you commit

```sh
cd src-tauri && cargo test
sh dev/cross-check.sh                         # clippy -D warnings: Linux, Windows, Android
for f in ui/*.js; do node --check "$f"; done
```

CI (`.github/workflows/check.yml`) repeats these and adds macOS and iOS.

## Testing without cameras

`dev/mock_frigate.py` imitates Frigate (login, live WebRTC/MSE, recordings
with gaps, review items, /ws pushes, exports, config). Set it up with
`sh dev/make-mock-media.sh`, then `python3 dev/mock_frigate.py` (or `--tls`
for HTTPS + login admin/password). `GET /debug/review?camera=doorbell` pushes
a live alert; `GET /debug/requests` lists what the app asked for.

## Naming and versions

The product name is a working title: change `NAME` in `src-tauri/src/about.rs`
and `productName` in `tauri.conf.json`. The version is only in
`src-tauri/Cargo.toml`.
