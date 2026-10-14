---
title: Frequently asked questions
nav: FAQ
description: Short answers to the questions people ask most about Chismoso.
---

## About the project

### Is this an official Frigate app?

No. Chismoso is an independent, open-source client. It isn't affiliated with, endorsed by or supported by the Frigate project. It talks to your Frigate server through the same interface Frigate's own web page uses. Please report Chismoso problems [to Chismoso]({{issues}}), not to Frigate.

### What does "Chismoso" mean?

It's Spanish slang for a nosy person: the neighbor who knows everything that happens on the street. For an app whose whole job is watching your cameras, it seemed fitting.

### Is it free?

Yes. It's free to download and use, and the source code is on [GitHub]({{gh}}).

### Why not just use Frigate's web page?

You can, and it's excellent. Chismoso is for when you want a dedicated app: a window that remembers your views, native notifications without a broker, a timeline built for scrubbing through days of footage, timelapses of several cameras at once, and keyboard control, in a small download.

### Why is it so small?

It's built with Rust and Tauri 2 and uses the web view that's already part of your operating system (WebView2 on Windows, WebKit on macOS and Linux) instead of bundling a whole browser like Electron apps do. Video plays in that same web view, so there's no video library to ship either.

## Compatibility

### Which Frigate versions does it work with?

Live view, exports and settings work with current Frigate versions. **Playing recordings needs Frigate 0.17 or newer.** With older versions, timelapses are limited to 25×.

### Does it work without a Frigate login?

Yes: connect to the internal port 5000 and leave the username empty. Only do this on a network you trust. See [Signing in](sign-in.md#choose-a-port).

### My Frigate uses a self-signed certificate. Will it work?

Yes. Trust it once and Chismoso pins it, warning you if it ever changes. See [Frigate's own certificate](sign-in.md#frigates-own-certificate).

### Can I use it away from home?

Yes, over a VPN or any route that reaches your Frigate server. Live video will usually use MSE rather than WebRTC remotely, which works fine. See [Away from home](live-video-setup.md#away-from-home).

### Does it work with several Frigate servers?

One at a time. **Sign out** from the server menu and sign in to another. Pinned certificates and load history are kept per server.

### Is there an Android or iOS app?

Not yet. They're built from the same code and coming later. See [Phone apps](phones.md).

### Can I talk through my doorbell or move a PTZ camera?

Not yet. Two-way audio and PTZ controls are on the list of things that aren't included yet.

## Privacy

### Is my password stored?

No, never. Only the address, username and your certificate choice are remembered. If you tick **Keep me signed in**, Chismoso also keeps Frigate's session pass so it can sign in by itself, but still not your password. See [Keep me signed in](sign-in.md#keep-me-signed-in).

### Does the app send anything anywhere?

Only to your Frigate server, plus a check of GitHub releases for updates. No analytics, no account. See [Privacy and security](privacy-and-security.md).

## Installing

### macOS says the app "can't be opened" or "is damaged".

The Mac builds aren't notarized yet. Right-click the app, choose **Open**, and confirm. If it says "damaged", run `xattr -dr com.apple.quarantine "/Applications/Chismoso.app"` once. See [macOS](install.md#macos).

### Windows shows a SmartScreen warning.

The installer isn't code-signed yet. Choose **More info**, then **Run anyway**. See [Windows](install.md#windows).

### Which Mac build do I need?

Apple menu → **About This Mac**. "Chip" means Apple Silicon; "Processor" means Intel.

## Using it

### Why does the grid show pictures instead of video?

The grid shows live video unless **Settings → Appearance → Live video in the grid** is off (handy on a slow connection). A camera whose video can't start (see [Live video setup](live-video-setup.md)) shows refreshed pictures instead. See [Live view](live-view.md#live-video-or-pictures).

### Why does a tile say 5 fps when my camera does 25?

It doesn't: that's Frigate's *detect* stream rate, shown on hover. The number in the tile's corner is what you're actually getting. See [Frame rates](live-video-setup.md#frame-rates).

### Why do only four cameras play during grid playback?

Each one pulls a full-resolution recording from Frigate, so Chismoso plays four at once and shows stills for the rest. Click a still to make it play. See [Grid playback](playback.md#grid-playback).

### Where do my exports go?

To a **Chismoso Exports** folder in your Videos folder, unless you choose another. See [Where files go](clips-and-timelapses.md#where-files-go).

### Can I change Frigate's config from the app?

Yes, with an admin account: **Settings → Configuration**. See [Settings](settings.md#configuration-editor).
