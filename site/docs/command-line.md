---
title: Command line
description: Make timelapses and clips from scripts and scheduled jobs with Chismoso's command-line mode. Every option, with examples.
---

The desktop app doubles as a command-line tool. Give it any arguments and, instead of opening a window, it runs the same export engine as the [Timelapse tab](clips-and-timelapses.md): connect, queue the exports on Frigate, wait for them to render, download them, and optionally delete the server copies.

It's handy for scheduled jobs, like a daily timelapse of every camera.

> [!NOTE]
> The examples run `chismoso`. Use the path to the app's executable on your system: on Windows the `.exe` in the install folder (run it from a terminal, such as PowerShell); on macOS the binary inside `Chismoso.app/Contents/MacOS/`; on Linux the installed binary, or the AppImage. Command-line mode is desktop-only.

## Quick examples

List the cameras:

```sh
chismoso --url https://frigate.local:8971 --user admin --insecure --list-cameras
```

A 1440× timelapse of yesterday for two cameras, removing the server copies afterwards:

```sh
FRIGATE_PASSWORD=... chismoso --url https://frigate.local:8971 --user admin --insecure \
  --camera pool --camera north_outside \
  --start "2026-10-10 00:00" --end "2026-10-11 00:00" \
  --speed 1440 --out ~/Videos/Frigate --delete-after
```

A real-time clip of every camera for ten minutes:

```sh
chismoso --url http://frigate.local:5000 --camera all \
  --start "2026-10-10 18:30" --end "2026-10-10 18:40" --realtime
```

## All options

```text
chismoso --url URL [options] --camera NAME --start TIME --end TIME
```

### Connection

| Option | What it does |
|---|---|
| `--url URL` | Frigate address, e.g. `https://frigate.local:8971` or `http://host:5000` |
| `--user NAME` | Frigate username. Leave it out for port 5000 / auth disabled |
| `--password PASS` | Password. Better: set the `FRIGATE_PASSWORD` environment variable |
| `--insecure` | Accept a self-signed certificate, and print its fingerprint |
| `--pin FINGERPRINT` | With `--insecure`: only accept this exact certificate (SHA-256) |

### What to export

| Option | What it does |
|---|---|
| `--camera NAME` | Camera name. Repeat it for several, or use `all` |
| `--start TIME` | Start, as `YYYY-MM-DD HH:MM` in local time |
| `--end TIME` | End, as `YYYY-MM-DD HH:MM` in local time |
| `--speed N` | Timelapse speed (default 60). `1440` is one day per minute |
| `--fps N` | Timelapse frame rate (default 30) |
| `--smooth` | Decode every frame (slower). By default, speeds of 60× and up decode only keyframes, which is many times faster |
| `--realtime` | Export at normal speed instead of a timelapse |
| `--out DIR` | Where to save (default: the current folder) |
| `--delete-after` | Delete the server copy once downloaded |

### Other

| Option | What it does |
|---|---|
| `--list-cameras` | Print camera names (and display names) and exit |
| `--list-exports` | Print the exports stored on the server and exit |
| `-V`, `--version` | Print the version, commit and build date, and exit |
| `-h`, `--help` | Show the help |

Camera names are Frigate's internal names (`front_door`), not display names. `--list-cameras` prints both. An unknown name stops the run and lists the valid ones.

## Certificates

With `--insecure`, Chismoso accepts Frigate's self-signed certificate and prints a note like:

```text
note: trusting certificate 3A:F1:…:9C
      pass --pin 3A:F1:…:9C to require this exact certificate
```

Add `--pin` with that fingerprint to your script, and the run refuses to connect if the certificate ever changes. That's the command-line version of the app's [certificate pinning](sign-in.md#frigates-own-certificate).

## Output and exit codes

Each camera renders in parallel and prints one line per stage, with rendering progress in 10% steps:

```text
[pool] Queued on Frigate…
[pool] Rendering 40%
[pool] Downloading
[pool] saved /home/me/Videos/Frigate/pool_2026-10-10.mp4
```

| Exit code | Meaning |
|---|---|
| `0` | Every export succeeded |
| `1` | At least one export failed |
| `2` | A usage or connection error (bad option, can't reach Frigate, wrong password) |

## Scheduling

**Linux and macOS** (cron): a timelapse of yesterday, every morning at 6:

```sh
0 6 * * * FRIGATE_PASSWORD=secret chismoso --url https://frigate.local:8971 --user admin --insecure --pin 3A:F1:…:9C --camera all --start "$(date -d yesterday +\%F) 00:00" --end "$(date +\%F) 00:00" --speed 1440 --out /srv/timelapses --delete-after
```

(On macOS, use `date -v-1d +%F` for yesterday's date.)

**Windows:** create a task in **Task Scheduler** that runs the `.exe` with the same arguments, and set `FRIGATE_PASSWORD` as a user environment variable rather than putting the password in the task.
