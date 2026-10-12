---
title: Building from source
nav: Building
description: Build Chismoso yourself on Windows, macOS or Linux, make installers, and try the Android and iOS builds.
---

Chismoso is a Rust application with a plain HTML, CSS and JavaScript interface. There's no Node.js build step for the app: you need Rust and your platform's web view libraries. The repository's README has the authoritative, up-to-date instructions; this page is the overview.

## Get the code

```sh
git clone {{gh}}.git
cd chismoso
```

## Prerequisites

Install [Rust](https://rustup.rs) (stable), then:

| System | Also install |
|---|---|
| **Linux** (Debian/Ubuntu) | `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev`, and for video: `gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav` |
| **Windows** | Visual Studio Build Tools (C++). WebView2 is already part of Windows 10 and 11 |
| **macOS** | Xcode command-line tools |

## Run it

```sh
cd src-tauri
cargo run              # development build
cargo build --release  # optimized binary in src-tauri/target/release/
```

## Make installers

Install the Tauri CLI once, then build from the project root:

```sh
cargo install tauri-cli --version "^2"
cargo tauri build
```

You get the installers for your system: `.exe` and `.msi` on Windows, `.dmg` and `.app` on macOS, `.deb`, `.rpm` and `.AppImage` on Linux.

## Official builds

Releases are built by GitHub Actions (`.github/workflows/release.yml`) on Windows, macOS (Apple Silicon and Intel separately) and Linux. Pushing a version tag such as `v0.1.0` builds every platform and attaches the installers to a draft release. The version number lives only in `src-tauri/Cargo.toml`.

Builds are stamped with the git commit and build date (shown in **About** and by `--version`). Set `SOURCE_DATE_EPOCH` for reproducible build dates.

## Android and iOS

The phone apps build from the same code with the Tauri CLI:

| Platform | One-time setup | Run |
|---|---|---|
| Android | Android Studio (SDK and NDK), `rustup target add aarch64-linux-android` | `cargo tauri android dev` |
| iOS | Xcode, `rustup target add aarch64-apple-ios aarch64-apple-ios-sim` | `cargo tauri ios dev` |

To build a test APK for an Android phone, see "A test APK for Android phones" in `docs/PLATFORMS.md`. Keep your signing keystore out of the repository, and keep using the same one, or updates won't install over the old app.

## Without cameras

You don't need a real Frigate to develop. `dev/mock_frigate.py` is a small stand-in with login, cameras, live WebRTC and MSE, a week of recordings with gaps, exports with progress, and config editing:

```sh
pip install aiohttp aiortc
sh dev/make-mock-media.sh
python3 dev/mock_frigate.py          # http://127.0.0.1:5055, no login
python3 dev/mock_frigate.py --tls    # https://127.0.0.1:5443, self-signed, admin / password
```

## Next

Read [Contributing](contributing.md) before you change anything: it explains the one rule that keeps desktop and mobile working from the same code.
