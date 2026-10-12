---
title: Updates and version info
nav: Updates
description: How Chismoso updates itself from GitHub releases, how to update by hand, and where to find your version for bug reports.
---

## Automatic updates

On Windows, macOS and Linux, Chismoso checks the project's [GitHub releases]({{releases}}) a few seconds after it starts (at most once a day). When there's a newer version, a bar at the top of the window says so: **Update and restart** downloads it, checks its signature, installs it and reopens the app. **Later** hides the bar until the next check. You can also check any time from **About → Check for updates**.

Your settings, layouts and pinned certificates are kept. Nothing is installed without you clicking, and the check only asks GitHub which version is newest; it doesn't send anything about you or your cameras.

Every update is signed, and the app refuses one whose signature doesn't match, so a tampered download can't be installed.

On Linux, self-update works for the AppImage. If you installed the `.deb` or `.rpm`, update with your package manager or install the new package (below).

Phones will update through their app stores once the [phone apps](phones.md) are out.

## Updating by hand

Download the latest version from the [download page](../download.html) and install it over the old one:

- **Windows:** run the new installer.
- **macOS:** drag the new app into Applications and replace the old one.
- **Linux:** install the new `.deb` or `.rpm` the same way as the first time (your package manager upgrades it), or replace the AppImage file.

## Release notes

Every version's changes are listed on the [releases page]({{releases}}). The download page shows the latest version number and date, with a link to its notes.

## Which version do I have?

Open the **server menu** (the server's name, top right) → **About**. It shows:

- the version, and whether it's a debug build,
- the git commit it was built from and the build date,
- your operating system and processor,
- the Tauri and web view versions.

**Copy version info** puts all of that on the clipboard. Please paste it into any [bug report]({{issues}}): it answers most of the first questions.

The version is also on the sign-in screen, and `chismoso --version` prints it on the [command line](command-line.md), e.g.:

```text
Chismoso 0.1.0 (1a2b3c4d, built 2026-10-11, linux x86_64)
```
