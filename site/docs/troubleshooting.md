---
title: Troubleshooting
description: Fixes for connection errors, black or slow live video, recordings that won't play, missing notifications, and first-launch warnings.
---

Find the symptom below. If nothing here helps, [open an issue]({{issues}}) and include the text from **server menu → About → Copy version info**.

## Can't reach Frigate

Chismoso turns network errors into plain sentences. Here's what each one means and what to try.

| Message | What it means | Try |
|---|---|---|
| **Couldn't find *host*: the name doesn't resolve on this network** | The name (like `frigate.local`) doesn't lead anywhere from where you are | If it only works at home, connect to your home Wi-Fi or VPN. Or use the server's IP address |
| ***host* refused the connection. Check the port.** | Something answered, but nothing is listening on that port | Check the port: `8971` for HTTPS with login, `5000` for the internal port. Check Frigate is running |
| ***host* didn't answer in time** | Nothing answered at all | A firewall, the wrong IP, or a network that can't reach the server. Try opening the same address in a browser |
| **Couldn't set up a secure connection with *host*** | The encrypted connection failed | Often HTTPS on a plain-HTTP port (or the reverse). Use `https://…:8971` or `http://…:5000` |
| **Can't reach *host*. Check the address and port.** | Some other connection failure | Check the address for typos |
| **Access denied (403)** | Your account isn't allowed to do that | Some actions need an admin account |
| **Your Frigate session expired** | Frigate signed you out (for example after a restart or a password change) | Sign in again; your details are filled in |

### Certificate messages

- **"This server uses its own certificate"** is normal for Frigate on port 8971. Choose **Trust and connect**. See [Frigate's own certificate](sign-in.md#frigates-own-certificate).
- **"asks for a client certificate"** means the address goes through a reverse proxy or gateway that wants a certificate from your device (mutual TLS). Chismoso can't send one yet. Use Frigate's own address instead (usually `https://<server>:8971`), or ask whoever runs the server.
- **"The certificate is trusted now, but the secure connection still failed"** means trusting wasn't the problem: the message after it says what was. Servers behind proxies or VPN gateways are the usual cause; try Frigate's own address (port 8971).
- **"Warning: this server's certificate changed"** means it's not the certificate you trusted before. If you reinstalled Frigate or renewed its certificate, choose **Trust the new certificate**. If you didn't, don't: someone may be intercepting the connection.

## Live video

### The badge says MSE on Windows or macOS, not WebRTC

WebRTC couldn't connect, so Chismoso fell back to MSE. It still works, with a little more delay. To get WebRTC, port **8555** (TCP and UDP) must be reachable from your computer, and go2rtc must know the Frigate host's LAN address in `go2rtc.webrtc.candidates`. See [Setting up WebRTC](live-video-setup.md#setting-up-webrtc).

### Linux never uses WebRTC

That's expected. WebKitGTK, the web view on Linux, has no WebRTC support, so Chismoso uses MSE, which needs no setup. See [Why Linux uses MSE](live-video-setup.md#why-linux-uses-mse).

### A camera only shows snapshots (1 fps)

Both WebRTC and MSE failed for that camera. Check that the camera works live in Frigate's own web page. If it does there but not here, check go2rtc has a stream for the camera with the same name, and that nothing between you and Frigate blocks WebSockets.

### The grid shows still pictures

That's the default. Tick **Live grid** in the toolbar. See [Snapshots or live video](live-view.md#snapshots-or-live-video).

### Live video stopped after I minimized the window

On purpose: streams close 30 seconds after the window is hidden, to spare your server, and reopen when you come back.

## Recordings

### Clicking the timeline doesn't play anything

Recordings playback needs **Frigate 0.17 or newer**. Check your version in **server menu** (it's in the header) or under **Settings → System**.

### Recordings are black on Linux

The web view needs GStreamer plugins to play video. The `.deb` and `.rpm` packages install them; with the AppImage, install them yourself. See [Linux](install.md#linux).

### Playback is choppy or uses a lot of CPU on Linux

Without a hardware plugin, GStreamer decodes video on the processor. The [Load screen](load.md#this-computer) says which you have and what to install. Reverse playback of a large grid can also stutter on Linux; one camera at a time works best.

### Only four cameras play in the grid

By design. Each playing camera pulls a full-resolution recording. The others show a still every few seconds; click one to make it play.

### There's a gap in the bar

Dark gaps are times with no footage on Frigate: the camera was off, recording was disabled, or footage has been deleted by your retention settings.

## Clips and timelapses

### The timelapse looks jumpy

You're probably using **Fast** below 60×. Switch to **Smooth**. See [Fast or Smooth](clips-and-timelapses.md#fast-or-smooth).

### Only 25× is available

Your Frigate is older than 0.17, which only supports 25× timelapses.

### Exports wait a long time before rendering

Frigate renders `record.export.max_concurrent` exports at once (3 by default). The rest wait in the queue, and the progress list says so. Raise the limit if your server can take it.

### "Saved, but couldn't delete the server copy"

The video downloaded fine, but Frigate refused to delete its copy (often a viewer account, or Frigate restarting). Delete it from **On the server** later.

## Notifications

### No notifications appear

1. Check **Settings → Notifications → Notify me about new alerts** is ticked, and the cameras you care about are picked (none picked means all).
2. Press **Send a test notification**.
3. If the test doesn't appear, your system is blocking them: on macOS, **System Settings → Notifications → Chismoso**; on Windows, **Settings → System → Notifications** and Focus; on Linux, your desktop's notification settings.
4. Notifications only arrive while Chismoso is running.

### Too many notifications

Raise the cooldown (**At most one per camera every…**), untick **Also detections**, or pick fewer cameras.

### Windows notifications say "Windows PowerShell"

Start Chismoso normally once (not from a script); it registers its name and icon for notifications at startup.

## Installing and starting

### macOS: "can't be opened" or "is damaged"

The Mac builds aren't notarized yet. Right-click → **Open**, or run `xattr -dr com.apple.quarantine "/Applications/Chismoso.app"`. See [macOS](install.md#macos).

### Windows: "Windows protected your PC"

SmartScreen doesn't recognize unsigned installers. **More info** → **Run anyway**.

## Settings

### The switches or config editor are greyed out

They need an **admin** account. The server menu shows which role you're signed in with.

### Saving the config fails

Frigate checks the file before saving and refuses one it can't load. The message says what's wrong; fix it and save again, or press **Reload** to start over.

## Reporting a bug

[Open an issue]({{issues}}) with:

- what you did, what you expected and what happened,
- the text from **server menu → About → Copy version info**,
- your Frigate version (in the server menu header),
- for live video problems, the badge text (`Live · WebRTC`, `Live · MSE`, `Snapshots`).
