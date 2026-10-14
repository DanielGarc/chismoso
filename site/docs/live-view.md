---
title: Live view
description: The live camera grid — views (tabs), arranging cameras, zoom, camera status, substreams, and how Chismoso picks between WebRTC, MSE and snapshots.
---

The **Live** tab opens on a grid of your cameras. Each tile shows the camera's name, a status dot, and what you're actually seeing in the corner: `WebRTC · 25 fps`, `MSE · 15 fps`, `snapshot`, or `recording` during playback.

## Views

The tabs above the grid are **views**: walls of cameras you arrange yourself, kept on this computer. **All cameras** shows every camera, arranged for you, and follows Frigate's list until you change it. The first time you open this version, Frigate's `camera_groups` and any layouts you made before become views too.

- **+** after the last tab makes a new, empty view. Type its name and press Enter.
- Double-click a tab to rename it. The **⋯** button on the open tab can also duplicate, arrange or delete it.
- The number on each tab is how many cameras it has.

A view always fills the window. Switching between views is instant for cameras that are in both: their video keeps playing.

## Arranging cameras

The list on the left has every camera. Drag one onto the grid to place it: in an empty spot it takes the usual size, and on another camera it replaces it there.

Press **Arrange** (or **⋯ → Arrange cameras**) to change a view:

- Drag a camera to move it. Drop it on another camera to swap the two.
- Pull a camera's blue corner to make it bigger or smaller. It stops where it meets another camera.
- **×** removes a camera from the view (not from Frigate).
- **Add the other cameras** fills the free space with cameras the view doesn't have yet.
- **Undo** steps back, and **Done** (or Esc) finishes.

On a phone, or a window narrower than 700 pixels, views show their cameras two per row, in the order they're arranged, with bigger cameras across the whole width. Arrange views on a larger window.

## Zoom

Look closer at part of the wall without opening a camera:

- Turn the mouse wheel, or pinch on a touchpad or touch screen, to zoom in where the pointer is.
- When zoomed in, drag (or scroll with two fingers) to look around.
- The magnifier on a camera zooms straight to it.
- The buttons in the corner zoom in and out, and **Fit** (or Ctrl+0) shows the whole view again.

Clicking a camera still opens it full size.

## Online, connecting, offline

A coloured dot shows each camera's state, on its tile and in the camera list: green is live, amber is connecting, red is offline (Frigate isn't getting video from it). A camera that's connecting shows its last picture, dimmed, until the video starts. Above the grid, a summary counts how many cameras in the view are in each state, and the list says how many are online in all.

## Live video or pictures

The grid shows **live video**. On a slow connection, turn off **Settings → Appearance → Live video in the grid** and it shows pictures refreshed every couple of seconds instead.

Live streams close 30 seconds after you minimize or hide the window, and reopen when you come back. When you open one camera full size, switch to another tab of the app, or switch views, the grid's streams stay connected for two minutes, so going back is instant; after that they close until you return.

## How live video is delivered

Chismoso tries three methods in order, so something always shows:

| Method | When it's used | What it needs |
|---|---|---|
| **WebRTC** | Windows and macOS, first choice | Port 8555 reachable, and go2rtc's WebRTC candidates set. [Setup](live-video-setup.md) |
| **MSE** | Linux, or when WebRTC fails | Nothing extra. It runs over the same port as the app |
| **Snapshots** | Last resort | Nothing. About one frame per second |

The frame rate on each tile is **measured from the video itself**. It isn't Frigate's `camera_fps`, which is the rate of the *detect* stream (often 5 fps) and doesn't limit live view. Hover the rate to see Frigate's number.

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
