---
title: Installing Chismoso
nav: Install
description: Download and install Chismoso on Windows, macOS or Linux, and get past the first-launch warnings.
---

Chismoso is a single small download (under 10 MB) with no other software to install first. Get the right file from the [download page](../download.html), which picks your system automatically, or from the [GitHub releases page]({{releases}}).

## What you need

- **A Frigate server** you can reach from this computer, on your network or over a VPN. Live view and exports work with current Frigate versions; **recordings playback needs Frigate 0.17 or newer**.
- **A Frigate account** if you connect on port 8971 (the normal, authenticated port). See [Signing in](sign-in.md).
- **Windows 10 or 11** (64-bit), **macOS 11 or newer** (Apple Silicon or Intel), or a **64-bit Linux** desktop with WebKitGTK 4.1 (for example Ubuntu 22.04 or newer).

## Windows

1. Download the **Installer (.exe)**. There's also an **MSI package** for managed or scripted installs.
2. Run it. Windows may show a blue **Windows protected your PC** (SmartScreen) message, because the installer isn't code-signed yet. Choose **More info**, then **Run anyway**.
3. Start **Chismoso** from the Start menu.

Chismoso uses WebView2, the web view that's already part of Windows 10 and 11, so there's nothing else to install.

## macOS

There are two builds. Pick the one for your Mac:

| Build | For |
|---|---|
| **Apple Silicon** (`aarch64.dmg`) | Macs with an M1, M2, M3 or newer chip |
| **Intel** (`x64.dmg`) | Older Macs with an Intel processor |

Not sure? Apple menu → **About This Mac**: a **Chip** line means Apple Silicon, a **Processor** line means Intel.

1. Open the `.dmg` and drag **Chismoso** into **Applications**.
2. The first time, **right-click** (or Control-click) Chismoso in Applications and choose **Open**, then **Open** again. macOS asks because the app isn't notarized by Apple yet. You only need to do this once.

> [!TIP]
> If macOS says the app "is damaged and can't be opened", it's the same quarantine check being stricter. Run this once in Terminal, then open the app normally:
>
> ```sh
> xattr -dr com.apple.quarantine "/Applications/Chismoso.app"
> ```

To get notifications, allow them when asked, or later in **System Settings → Notifications → Chismoso**.

## Linux

Pick the package for your distribution:

| Package | For | Install |
|---|---|---|
| `.deb` | Debian, Ubuntu, Mint, Pop!_OS | `sudo apt install ./Chismoso_*_amd64.deb` |
| `.rpm` | Fedora, openSUSE, RHEL | `sudo dnf install ./Chismoso-*.x86_64.rpm` |
| `.AppImage` | Any distribution | `chmod +x Chismoso_*.AppImage` and run it |

The `.deb` and `.rpm` packages pull in the GStreamer plugins that video playback needs. If you use the AppImage and recordings or live MSE video stay black, install them yourself:

```sh
# Debian / Ubuntu
sudo apt install gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav
# Fedora (gstreamer1-libav comes from RPM Fusion)
sudo dnf install gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-libav
```

### Hardware video decoding

On Linux the web view decodes video through GStreamer, which uses the processor unless a hardware plugin is installed. With several cameras playing, hardware decoding cuts CPU use a lot. The [Load screen](load.md#this-computer) tells you which one you have. To add it:

- **Intel or AMD graphics:** `gstreamer1.0-plugins-bad` (its `va` plugin) or `gstreamer1.0-vaapi`
- **NVIDIA:** `gstreamer1.0-plugins-bad` (its `nvcodec` plugin)

Restart Chismoso afterwards.

> [!NOTE]
> On Linux, live video uses MSE rather than WebRTC, because WebKitGTK doesn't support WebRTC. It works over the same HTTPS port as everything else, so there's nothing to configure. See [Getting the best live video](live-video-setup.md).

## Updating and uninstalling

Chismoso checks GitHub for new versions and offers to update. You can also install a newer download over the old one; your settings are kept. See [Updates](updates.md).

To uninstall, use your system's usual way: **Settings → Apps** on Windows, drag to the Trash on macOS, or your package manager on Linux (`sudo apt remove chismoso`, `sudo dnf remove chismoso`). For the AppImage, delete the file.

## Next

[Sign in to your Frigate server](sign-in.md).
