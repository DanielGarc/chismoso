---
title: Settings
description: Frigate's system stats, camera switches, and the config.yml editor with save and save & restart.
---

The **Settings** tab has four cards. Notifications have [their own page](notifications.md).

## System

A quick health check of your Frigate server:

- Frigate's **version** and **uptime**.
- **Detector** speed for each detector, in milliseconds per inference.
- **Recordings disk** usage.
- **GPU** use, when Frigate reports it.

It refreshes on its own every ten seconds; press **Refresh** to update it right away.

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
