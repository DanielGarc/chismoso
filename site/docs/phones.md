---
title: Android, Android TV and iOS
nav: Phones and TVs
description: Chismoso on phones, tablets and Android TV — same codebase, test builds for Android today, and a TV mode for the remote.
---

Chismoso for **Android**, **Android TV** and **iOS** comes from the same code as the desktop app. It isn't in the app stores yet. Android test builds can be installed by hand today (see below); the [download page](../download.html#phones) will offer the store versions the moment there are any.

## Same app, same code

The phone apps aren't a separate project. They're built from exactly the same code as the desktop app, with a layout that adapts to small, touch screens. You can see that layout today on desktop: make the window narrower than about 700 pixels.

So the phone apps have the same features: the live grid, the camera view, the zoomable timeline (pinch to zoom), synchronized playback, clips and timelapses, the Load screen and Settings.

## Android TV

The same Android app installs on Android TV and Google TV (Chromecast with Google TV, Nvidia Shield, TV boxes, and TVs with Google TV built in). It shows up in the TV's app row, and opens in **TV mode**:

- **The remote moves around the screen.** The arrow buttons go to whatever is next in that direction: camera tiles, view tabs, buttons. **OK** opens the camera or presses the button. **Back** goes back one step (closes the camera, then the screen you're on), and quits from the camera wall.
- **The focus is easy to see** from the couch: a thick outline, and bigger text.
- **In a camera view**, move down to the timeline: **← →** go back and forward 10 seconds and **OK** plays or pauses. The play/pause, rewind and fast-forward buttons on remotes that have them work everywhere in the camera view.
- **The screen stays on**, so a camera wall isn't replaced by the TV's screensaver.
- **No drag and drop.** Arranging views needs a mouse or a finger, so on a TV the views are *All cameras* plus one per camera group in Frigate, including groups you add there later.

Typing the server address and password with a remote is slow, so on a TV *Keep me signed in* starts out ticked. You type them once.

### TV mode anywhere

TV mode isn't only for TVs. **Settings → Appearance → TV mode** turns it on (*Always*) on any computer, which suits a wall-mounted screen driven by a keyboard or a presentation remote, or off (*Never*) on a TV with a mouse. The default, *On TVs only*, picks it by itself.

## Installing an Android test build

Each [development build]({{gh}}/releases/tag/dev) includes an Android APK (`Chismoso_…_android.apk`) that works on phones, tablets and Android TV, with 64-bit and 32-bit ARM processors.

- **Phone or tablet:** open the APK on the device and allow installing from your browser or file manager when asked.
- **TV:** the easiest way is a sideloading app such as *Downloader* (enter the APK's link), or `adb install Chismoso_…_android.apk` from a computer with the TV's developer options and network debugging turned on.

If the file name ends in `-test-key.apk`, it was signed with a temporary key: uninstall the previous build before installing the next one.

## What differs from desktop

| | Desktop | Phones | Android TV |
|---|---|---|---|
| Notifications while the app is open | ✓ | ✓ (asks permission) | ✓ |
| Notifications in the background | ✓ (the app keeps running) | Not yet. Phones suspend apps in the background; this needs push notifications | Not yet |
| Arranging views | Drag and drop | Drag and drop | Views come from Frigate's camera groups |
| Exports | Saved to a folder you choose | Saved in the app's own files | Saved in the app's own files |
| Command line | ✓ | — | — |
| Recordings playback on iPhone | — | iOS 17.1 or newer at first | — |

## Where things stand

Android builds come with every development build; they haven't had wide testing on real devices yet, so reports are welcome. The iOS build compiles in continuous integration. Progress is tracked in the repository's `docs/PLATFORMS.md`.

Want to help test? Watch the [repository]({{gh}}) or see [Contributing](contributing.md).
