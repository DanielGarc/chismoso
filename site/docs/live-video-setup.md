---
title: Getting the best live video
nav: Live video setup
description: Set up Frigate's go2rtc for WebRTC (port 8555 and candidates), and understand when Chismoso uses MSE or snapshots instead.
---

Chismoso shows live video in one of three ways and picks the best one that works, so you always see *something*. With a little setup on the Frigate side you'll get the fastest one, WebRTC, wherever it's available.

## The three methods

| Method | Delay | When it's used | Needs |
|---|---|---|---|
| **WebRTC** | Lowest (well under a second) | Windows and macOS | Port 8555 and go2rtc candidates (below) |
| **MSE** | Low (about a second) | Linux, or when WebRTC fails | Nothing extra |
| **Snapshots** | About 1 fps | When neither works | Nothing |

The badge in the camera view (`Live · WebRTC`, `Live · MSE`, `Snapshots · 1 fps`) and the corner of each grid tile tell you which one you're getting.

## Setting up WebRTC

WebRTC video flows straight from Frigate's built-in go2rtc to Chismoso. Only the setup handshake goes through Frigate's normal port. For the video itself to arrive, two things must be true.

### 1. Port 8555 is reachable

go2rtc sends WebRTC video on port **8555**, over **both TCP and UDP**. If Frigate runs in Docker, publish both:

```yaml
# docker-compose.yml
services:
  frigate:
    ports:
      - "8971:8971"
      - "8555:8555/tcp"
      - "8555:8555/udp"
```

Also allow 8555 through any firewall between this computer and the Frigate host.

### 2. go2rtc knows its own address

Inside Docker, go2rtc can't tell which address your computer should use to reach it. Tell it in Frigate's config, with the Frigate host's LAN IP:

```yaml
go2rtc:
  webrtc:
    candidates:
      - 192.168.1.169:8555   # your Frigate host's LAN IP
      - stun:8555
```

Restart Frigate after changing it. Open a camera in Chismoso: the badge should now say `Live · WebRTC`.

## Why Linux uses MSE

On Linux, Chismoso uses the system's WebKitGTK web view, which doesn't support WebRTC. So it goes straight to **MSE**: Chismoso opens go2rtc's MSE stream over Frigate's normal HTTPS port and hands the video to the web view. There's nothing to set up, and the delay is usually around a second.

For smooth video with many cameras on Linux, install [hardware decoding](install.md#hardware-video-decoding).

## Away from home

Over a VPN or a remote connection, WebRTC's UDP port is often blocked or unreachable. That's fine: Chismoso falls back to MSE, which only needs the same port you signed in with. If WebRTC takes a while to give up on a slow connection, the badge will switch over on its own.

## Grid tiles vs the camera view

- The grid shows **snapshots** until you tick **Live grid**. See [Live view](live-view.md#snapshots-or-live-video).
- The grid prefers a camera's **substream** (the second entry in `live.streams`); the camera view lets you choose. See [Substreams](live-view.md#substreams).

## Frame rates

The fps shown on a tile is measured from the video you're receiving. Frigate's own `camera_fps` (shown when you hover) is the rate of the **detect** stream, often just 5 fps, and has nothing to do with how smooth live view is.
