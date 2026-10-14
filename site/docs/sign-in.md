---
title: Signing in to Frigate
nav: Sign in
description: Connect Chismoso to your Frigate server on port 8971 or 5000, and trust Frigate's own certificate safely.
---

When Chismoso starts, it asks for your Frigate address and account. There are two ways in, the same two that Frigate's own web page offers.

## Choose a port

| Address | Username | When to use it |
|---|---|---|
| `https://your-frigate:8971` | Your Frigate user | The normal choice. Encrypted and needs a login. |
| `http://your-frigate:5000` | Leave empty | Frigate's internal port, with no login. Only on a network you fully trust. |

You can type the address with or without `https://`: an address ending in `:8971` is treated as HTTPS, anything else as plain HTTP. A trailing `/api` is ignored.

> [!WARNING]
> Port 5000 has no password and no encryption: anyone who can reach it can watch your cameras and change Frigate's settings. Don't expose it beyond your home network.

## Frigate's own certificate

Out of the box, Frigate on port 8971 uses a **self-signed certificate**: one it made itself, which no certificate authority vouches for. Browsers show a warning for it, and so does Chismoso, but it gives you a safe way through:

1. Press **Connect**. Chismoso says the server uses its own certificate and offers **Trust and connect**.
2. Chismoso remembers that exact certificate (its SHA-256 fingerprint). This is called **pinning**.
3. Every later connection must present the same certificate. If it ever changes, Chismoso stops and warns you instead of connecting.

A changed certificate is expected if you reinstalled Frigate or renewed its certificate; choose **Trust the new certificate**. If you didn't change anything, don't trust it: someone on the network may be intercepting the connection.

If your Frigate has a certificate from a real authority (for example Let's Encrypt behind a reverse proxy), there's nothing to trust: it's checked against your system's trusted certificates, like a browser would, and you go straight in.

## Admins and viewers

Frigate accounts have a role, and Chismoso follows it:

- **Admin** accounts can do everything, including the camera switches (detect, record, snapshots) and editing `config.yml`.
- **Viewer** accounts can watch live, play recordings, and make clips and timelapses. Admin-only controls are shown but disabled.

## What's remembered

Chismoso remembers the address, username, the "trust this certificate" choice and the pinned fingerprint, so next time you only type your password. **Your password is never stored.** See [Privacy & security](privacy-and-security.md) for the full list.

The sign-in fields are labelled for password managers, so Bitwarden, 1Password and the like can recognise them. On phones their autofill should offer to fill them; on a computer, copy and paste from your password manager works everywhere.

When your Frigate session expires, Chismoso takes you back to the sign-in screen with the details filled in.

To switch servers or sign out, open the **server menu** (the server's name at the top right) and choose **Sign out**.

## Keep me signed in

Tick **Keep me signed in** and Chismoso signs in by itself the next time it opens, without your password. It does this by keeping Frigate's *session pass* (the token Frigate gives the app after you sign in), **not your password**:

- The pass is saved in Chismoso's own data folder, readable only by your user account.
- To open faster, Chismoso remembers your last server's camera list (names and streams only) and shows it right away while it checks your pass with Frigate. Cameras added or removed since then appear or disappear a moment later. If the pass has expired or the server can't be reached, you're taken back to this screen with a message.
- Frigate renews it while you use the app, so using it regularly keeps you signed in. If it expires (you haven't opened the app for a while), you sign in once more.
- How long a pass lasts is set in Frigate, with `session_length` under `auth` in its config (in seconds; the default is 86400, one day). A longer value means fewer sign-ins:

  ```yaml
  auth:
    session_length: 2592000   # 30 days
  ```

- **Sign out** in the server menu deletes the pass immediately. Unticking the box and signing in also removes it.
- If the server is offline when Chismoso starts, the sign-in screen says so; press **Connect** to try the saved pass again.
- A saved pass only works on that Frigate server and only until it expires; it can't reveal your password. If you think one was copied off your computer, have Frigate sign everyone out by changing its JWT secret (see Frigate's authentication docs).

## If it doesn't connect

Chismoso says in plain words what went wrong: the name doesn't resolve, the server refused the connection, it didn't answer in time, or the certificate changed. [Troubleshooting](troubleshooting.md#cant-reach-frigate) explains each message.
