---
title: Live view
description: The live camera grid — layouts, camera groups, columns, substreams, and how Chismoso picks between WebRTC, MSE and snapshots.
---

The **Live** tab opens on a grid of your cameras. Each tile shows the camera's name, a status dot, and what you're actually seeing in the corner: `WebRTC · 25 fps`, `MSE · 15 fps`, `snapshot`, or `recording` during playback.

## Snapshots or live video

By default the grid shows **snapshots**, refreshed every couple of seconds. They're light on your server and on your network, which matters with many cameras.

Tick **Live grid** in the toolbar to stream every tile as live video instead. Your choice is remembered.

Either way, tiles you've scrolled out of view don't stream or fetch snapshots, and live streams close 30 seconds after you minimize or hide the window. They reopen when you come back.

## How live video is delivered

Chismoso tries three methods in order, so something always shows:

| Method | When it's used | What it needs |
|---|---|---|
| **WebRTC** | Windows and macOS, first choice | Port 8555 reachable, and go2rtc's WebRTC candidates set. [Setup](live-video-setup.md) |
| **MSE** | Linux, or when WebRTC fails | Nothing extra. It runs over the same port as the app |
| **Snapshots** | Last resort | Nothing. About one frame per second |

The frame rate on each tile is **measured from the video itself**. It isn't Frigate's `camera_fps`, which is the rate of the *detect* stream (often 5 fps) and doesn't limit live view. Hover the rate to see Frigate's number.

## Layouts and camera groups

The **layout** picker at the top of the Live tab chooses which cameras are in the grid:

- **All cameras**, in Frigate's order.
- **Frigate camera groups**: any `camera_groups` defined in your Frigate config appear as they are. To change them, edit the config.
- **My layouts**: your own selections, kept on this computer.

To make a layout, press the pencil button next to the picker, give it a name, tick the cameras you want and use the arrows to put them in order, then **Save**. The same dialog edits or deletes an existing layout.

**Auto / 1 / 2 / 3 / 4** sets the number of columns. **Auto** fits the grid to the window.

## Substreams

If a camera has more than one stream listed under `live.streams` in Frigate's config (typically a low-resolution substream next to the main one), the grid uses the second stream to save bandwidth. The [camera view](camera-view.md) lets you switch between them.

```yaml
cameras:
  front_door:
    live:
      streams:
        Main: front_door
        Sub: front_door_sub   # used by the grid
```

## Opening a camera

Click a tile to open the camera full size. If the tile was already playing the same stream over WebRTC, the connection is reused, so the picture appears instantly, and handed back when you return to the grid with **← All cameras** or <kbd>Esc</kbd>.
