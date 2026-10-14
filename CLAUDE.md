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
- Colours: only `var(--token)` in `ui/style.css`; the values live in `ui/themes.css`
  (dark, light, black; custom themes derive from them in `ui/theme.js`). Video
  overlays may stay fixed black/white. New colour → add a token to every theme.
- Icons: edit `design/icon.svg`, then `sh dev/make-icons.sh` (app, installers,
  Android, website).
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

`dev/mock_frigate.py` imitates Frigate (login, live WebRTC/MSE, a movable PTZ camera, recordings
with gaps, review items, /ws pushes, exports, config). Set it up with
`sh dev/make-mock-media.sh`, then `python3 dev/mock_frigate.py` (or `--tls`
for HTTPS + login admin/password). `GET /debug/review?camera=doorbell` pushes
a live alert; `GET /debug/requests` lists what the app asked for.

## Naming, versions, releases

- The app is **Chismoso**; identifier `org.caprichosos.chismoso` (don't change
  it: it's the install identity, and on phones a new one is a new app).
  Display name: `NAME` in `src-tauri/src/about.rs` and `productName` in
  `tauri.conf.json`.
- The version lives only in `src-tauri/Cargo.toml`. Release with Actions →
  "Bump version and release" (`.github/workflows/bump.yml` →
  `release.yml`): builds every desktop platform, signs updater artifacts,
  publishes the release; installed copies offer the update.
- The website and docs are in `site/` (Markdown in `site/docs/`, built by
  `site/build.mjs`, deployed by `pages.yml`). When a feature changes, update
  its docs page in the same commit.
- The Android project in `src-tauri/gen/android` is generated; after
  regenerating it, run `python3 dev/android-customize.py`.
