---
title: Roadmap
description: Where Chismoso is headed — what's being worked on, what's next, ideas under consideration, and what's deliberately left out.
---

Chismoso stays small on purpose: a fast, friendly window onto **your own Frigate server**. No cloud, no account, no subscription. Frigate does the recording and the detecting; Chismoso makes it pleasant to watch, search and share.

This page is a direction, not a promise. Things move around as people use the app. If something here matters to you, or is missing, [open an issue]({{issues}}) or give an existing one a 👍. That's how priorities get set.

## Recently shipped

- **Views** (0.7): tabs above the grid that you arrange by dragging cameras, with zoom and online/offline status on every camera.
- **Faster start** (0.7): the app opens straight onto your cameras, and every picture shows at once.
- **PTZ** (0.7): move, zoom and recall presets on cameras Frigate controls over ONVIF.
- **Sharing** (0.6): share or copy clips and snapshots, and make smaller files for chat.
- **Themes, updates from inside the app, keep me signed in** (0.4–0.5).

## Now

### Performance
Keep it quick on modest computers and big camera walls.
- Every change that could slow loading is measured before and after.
- Sharper zoom: switch a camera to its full-quality stream when you zoom in on it, and back when you zoom out.
- Fewer connections and less CPU with many cameras on screen.

### Phone apps
Android first, then iOS, from the same code as the desktop app (see [Phone apps](phones.md)). Notifications in the background come later, because phones need push notifications for that.

### Easier to install
Flathub for Linux and the Microsoft Store for Windows, so updates come through your usual app store. winget and Homebrew are small additions after that.

## Next

### Several servers
Sign in to more than one Frigate (home, a cabin, a parent's house) and switch between them from the server menu. Later: views that mix cameras from different servers, and one notification feed for all of them.

### Detection zones and tuning, explained
Setting up zones, masks and detection settings in Frigate's config is powerful but hard to get right. The plan:
- **Draw** zones and motion masks right on the live picture.
- **See what Frigate sees** while you tune: the live picture with Frigate's boxes, zones and masks drawn on it, so a change shows its effect.
- **Plain-language help** next to each setting (threshold, minimum size, how long an object must stay), with sensible starting values and why.
- **Review before saving**: a side-by-side of the config change, then save and restart Frigate.

### More PTZ
Manage presets, run patrol tours between them, and switch Frigate's autotracking on and off.

## Ideas under consideration

These come from what people like in commercial systems such as UniFi Protect and Nx Witness, and they'd be small to build because Frigate already does the hard part. Tell us which you'd use.

- **Search by what happened**: filter the timeline and alerts by person, car, animal, package or zone.
- **Alert feed**: a scrolling list of recent alerts with pictures, across all cameras.
- **Names and plates**: show who or what Frigate recognized (face recognition and license plates in Frigate 0.16+), like "Maria at the front door".
- **Motion on the timeline**: a light activity bar showing when there was motion, even without an alert.
- **View tours**: cycle through your views every few seconds, for a wall-mounted screen.
- **Pop-out windows**: put a view or a single camera in its own window, on a second monitor or always on top.
- **Smarter notifications**: quiet hours, and alerts only for certain cameras, objects or zones.
- **Camera offline alerts**: a notification when a camera stops sending video.
- **Bookmarks**: mark a moment with a note and come back to it later.
- **Two-way talk**: speak through a doorbell or camera speaker (go2rtc supports it).

## Not planned

- **A cloud service or account.** Reach your server from outside with a VPN such as WireGuard or Tailscale; see [Away from home](live-video-setup.md#away-from-home).
- **Recording or detecting in the app.** That's Frigate's job, and it does it well.
- **A full Frigate admin console.** Chismoso keeps simple, guided tools for the common tasks; everything else stays in Frigate's own settings and config.
