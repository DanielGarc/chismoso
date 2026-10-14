---
title: Updates and version info
nav: Updates
description: How Chismoso updates itself from GitHub releases, how to update by hand, and where to find your version for bug reports.
---

## Automatic updates

On Windows, macOS and Linux, Chismoso asks the project's [GitHub releases]({{releases}}) whether there's a newer version: a few seconds after it starts, and again once a day if you leave it open. It never checks more than about once a day, and not while the window is hidden.

When there's a newer version, a bar at the top of the window says so:

- **What's new** lists what changed.
- **Update and restart** downloads it, checks its signature, installs it and reopens the app. A progress bar shows the download.
- **Later** hides the bar until the next check.
- **Skip this version** hides it until a newer version comes out.

If an update can't be installed, the bar says so and offers **Try again** and **Download from the website**.

Your settings, layouts and pinned certificates are kept. Nothing is installed without you clicking, and the check only asks GitHub which version is newest; it doesn't send anything about you or your cameras. Every update is signed, and the app refuses one whose signature doesn't match, so a tampered download can't be installed.

**Linux:** updates work for the AppImage, `.deb` and `.rpm`. For `.deb` and `.rpm`, Linux asks for your password, because installing a package needs admin rights.

Phones will update through their app stores once the [phone apps](phones.md) are out.

## Update settings

**Settings → Updates** has:

- **Check for updates automatically**, on by default. Turn it off and the app never contacts GitHub on its own.
- **Check now**, which also shows a version you chose to skip.
- **Get development builds**, off by default. Turn it on to try new features before they're released. Development builds are made from work in progress, so they can have bugs. They're numbered like `0.6.3-12`, and a development build still updates to the next real release (`0.6.3`) when it comes out. Turning the setting off keeps the build you have until a newer release arrives.

You can also check from **About → Check for updates**.

## Updating by hand

Download the latest version from the [download page](../download.html) and install it over the old one:

- **Windows:** run the new installer.
- **macOS:** drag the new app into Applications and replace the old one.
- **Linux:** install the new `.deb` or `.rpm` the same way as the first time (your package manager upgrades it), or replace the AppImage file.

## Release notes

Every version's changes are listed on the [releases page]({{releases}}), and the same list appears under **What's new** in the update bar. The download page shows the latest version number and date, with a link to its notes.

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
