---
title: Playback and speed
nav: Playback & speed
description: Play recordings of one camera or a whole grid in sync, from −16× in reverse to 16×, with J, K and L.
---

Click the [timeline](timeline.md) and recordings start playing from that moment. In the camera view that's one camera; in the grid it's every camera in the layout, kept in step.

## Grid playback

When you click the bar under the grid, all cameras in the layout play from the same moment and stay in sync with each other.

- A camera with **no footage** at that moment says so, and joins in when its footage starts.
- **At most four cameras play video at once**, because each pulls a full-resolution recording from Frigate. The others show a still from the recordings every few seconds. Click one to make it play.
- **Click a tile** while playing back to open that camera at the same moment. **← All cameras** takes the whole grid back to that moment.
- Press <kbd>Esc</kbd>, or **● Live**, to return to live view.

Playing back a whole grid fetches several recordings at once, so it asks more of Frigate than a single camera. The [Load screen](load.md) shows how much.

## Controls

| Control | What it does |
|---|---|
| **▶ / ❚❚**, <kbd>Space</kbd> or <kbd>K</kbd> | Play and pause |
| **⟲ 10** / **10 ⟳**, <kbd>←</kbd> / <kbd>→</kbd> | Back or forward 10 seconds |
| **Speed slider** | From −16× to 16×. Double-click it for 1× |
| <kbd>J</kbd> / <kbd>L</kbd> | One speed step slower / faster |
| <kbd>[</kbd> / <kbd>]</kbd> | Previous / next alert or detection |
| **● Live** | Back to the live stream |

## Speed, forwards and backwards

The speed slider has nine steps, with normal speed in the middle:

**−16×  −8×  −4×  −2×  1×  2×  4×  8×  16×**

Steps to the left of 1× play **backwards**. <kbd>J</kbd> and <kbd>L</kbd> move one step at a time, like in a video editor: from 1×, pressing <kbd>J</kbd> goes to −2× and plays in reverse. Pressing <kbd>J</kbd> while watching live starts reverse playback from right now — handy for "what just happened?".

> [!NOTE]
> Video players can't play backwards, so reverse playback steps the picture back several times a second and fetches earlier footage ahead of it. It's smoothest on Windows and macOS. On Linux, reverse playback of a large grid can stutter; one camera at a time works best.

## How it works

Playback uses Frigate's own HLS stream (fragmented MP4), fed straight into the system web view's video player. There's no extra video library in the app, which is part of why it's so small.
