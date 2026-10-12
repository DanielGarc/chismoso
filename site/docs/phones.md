---
title: Android and iOS
nav: Phone apps
description: The state of Chismoso on phones and tablets — same codebase, first release coming later.
---

Chismoso for **Android** and **iOS** is coming. It isn't in the app stores yet, and there's no phone release to download today. The [download page](../download.html#phones) will offer it the moment there is.

## Same app, same code

The phone apps aren't a separate project. They're built from exactly the same code as the desktop app, with a layout that adapts to small, touch screens. You can see that layout today on desktop: make the window narrower than about 700 pixels.

So the phone apps will have the same features: the live grid, the camera view, the zoomable timeline (pinch to zoom), synchronized playback, clips and timelapses, the Load screen and Settings.

## What will differ

| | Desktop | Phones |
|---|---|---|
| Notifications while the app is open | ✓ | ✓ (asks permission) |
| Notifications in the background | ✓ (the app keeps running) | Not at first. Phones suspend apps in the background; this needs push notifications, which aren't set up yet |
| Exports | Saved to a folder you choose | Saved in the app's own files |
| Command line | ✓ | — |
| Recordings playback on iPhone | — | iOS 17.1 or newer at first |

## Where things stand

The Android build compiles and produces a test APK; the iOS build compiles in continuous integration. Neither has been through proper testing on real devices yet. Progress is tracked in the repository's `docs/PLATFORMS.md`.

Want to try an early build, or help test? Watch the [repository]({{gh}}) or see [Contributing](contributing.md).
