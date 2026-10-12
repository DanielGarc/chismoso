---
title: Privacy and security
nav: Privacy & security
description: What Chismoso stores on your computer, who it talks to, how certificate pinning works, and how the local media server is locked down.
---

Chismoso is built to sit between you and your Frigate server and nothing else. There's no account, no cloud service and no analytics.

## Who the app talks to

- **Your Frigate server**, at the address you entered. Everything goes there: sign-in, cameras, live video, recordings, exports, settings.
- **GitHub**, to check for new versions of the app (see [Updates](updates.md)).

That's the whole list. Video from your cameras goes from Frigate to your screen and nowhere else.

## What's stored on your computer

| Stored | Where | Why |
|---|---|---|
| Frigate address and username | App preferences | So you don't retype them |
| "Trust this certificate" choice and the pinned fingerprint | App preferences | Certificate pinning (below) |
| Your layouts, grid columns, "Live grid" choice | App preferences | So the app looks the way you left it |
| Export settings (speed, frame rate, folder, cameras) | App preferences | So the Timelapse tab remembers |
| Notification settings | App preferences | — |
| 24-hour load trends, per server | App local storage | The [Load screen](load.md) |
| Exported videos | Your chosen folder | That's what you asked for |

**Your password is never stored.** While you're signed in, Chismoso holds Frigate's session token in memory; it's gone when you quit or disconnect.

## Certificate pinning

Frigate on port 8971 normally uses a self-signed certificate that your computer can't verify. Rather than ignoring the problem (as "accept any certificate" options do), Chismoso **pins** the certificate the first time you trust it:

1. It records the certificate's SHA-256 fingerprint.
2. Every later connection, including the WebSocket used for notifications and live MSE video, must present exactly that certificate.
3. If it changes, Chismoso refuses to connect and tells you, with a clear explanation. You decide whether to trust the new one.

Servers with a certificate from a real authority are checked against your operating system's trusted certificates, like a browser does.

All of this happens in Chismoso's Rust core; the web view that draws the interface never talks to Frigate directly.

## The local media server

Snapshots, thumbnails, recordings and exported videos are played by the system web view, which works best with plain HTTP. So Chismoso runs a tiny media server inside the app:

- It listens only on **127.0.0.1** (this computer), on a **random port**.
- Every URL starts with a **random secret** made when the app starts, so other programs on the computer can't use it.
- It forwards **media paths only** (snapshots, thumbnails, recordings, exports) to Frigate, never the general API.
- It only answers the app's own pages.

## Live video

- **WebRTC:** the handshake goes through Chismoso's Rust core and Frigate's normal port; the video itself flows directly from Frigate's go2rtc to the app on port 8555.
- **MSE:** Chismoso opens go2rtc's stream over Frigate's normal (encrypted) port and passes the video to the page.

## Port 5000

Frigate's internal port 5000 has no login and no encryption. Chismoso supports it because it's convenient on a trusted home network, but anyone who can reach that port can see and change everything. Prefer port 8971.

## Reporting a security problem

If you find a security issue, please don't open a public issue. Contact the maintainers privately through GitHub's **Report a vulnerability** button on the [repository's Security tab]({{gh}}/security).
