---
title: Settings
description: Frigate's system stats, themes, camera switches, and the config.yml editor with save and save & restart.
---

The **Settings** tab has a card for each of these. Notifications have [their own page](notifications.md), and updates are on the [Updates page](updates.md).

## System

A quick health check of your Frigate server:

- Frigate's **version** and **uptime**.
- **Detector** speed for each detector, in milliseconds per inference.
- **Recordings disk** usage.
- **GPU** use, when Frigate reports it.

It refreshes on its own every ten seconds; press **Refresh** to update it right away.

## Appearance

Pick a **theme**: **Dark** (the default), **Light**, **Black** (pure black, nice on OLED screens), or **Match my system**, which follows your computer's light or dark mode.

**TV mode** makes the focus outline and text bigger and lets a remote's arrow keys move around the screen. *On TVs only* (the default) turns it on by itself on Android TV; *Always* suits a wall-mounted screen. See [Android TV](phones.md#android-tv).

**Custom** lets you make your own. Start from Dark, Light or Black, then pick any of four colours: **Accent** (buttons, links, the timeline), **Background**, **Panels** and **Text**. The rest of the palette (borders, muted text, highlights) is worked out from those, and changes show up as you pick. If the text gets hard to read, a note says so. **Reset colors** goes back to the starting theme.

To share a theme, press **Copy theme** and send the text to someone. They choose **Custom → Paste a theme…**, paste it and press **Use this theme**.

Themes are saved on this computer and don't change anything on your Frigate server.

## Camera switches

Every camera with its **Detect**, **Record** and **Snapshots** switches, the same ones as in the [camera view](camera-view.md#camera-switches).

- Switches apply **right away** and last **until Frigate restarts**.
- To make a change permanent, change `config.yml` (below).
- They need an **admin** account.

## Configuration editor

Frigate's whole `config.yml`, editable in place. It needs an **admin** account; viewers see a note instead.

| Button | What it does |
|---|---|
| **Reload** | Throws away your edits and loads the file from Frigate again |
| **Save** | Saves the file. Frigate checks it first and refuses a config it can't use |
| **Save & restart** | Saves, then restarts Frigate so the changes take effect |
| **Restart Frigate** | Restarts without saving |

<kbd>Tab</kbd> indents with two spaces, YAML-style, and <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd>+<kbd>S</kbd>) saves.

> [!WARNING]
> Most config changes only take effect after a restart. While Frigate restarts, live video and recordings pause for every client, not just this one, so pick a quiet moment.

## About

Not on this tab, but close: **server menu → About** shows the app's version, the git commit it was built from, the build date, your operating system and the web view version. **Copy version info** puts all of it on the clipboard, ready to paste into a bug report. See [Updates](updates.md).
