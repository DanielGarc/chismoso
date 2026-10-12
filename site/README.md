# Chismoso website

The promo site, download page and documentation for Chismoso, served by
GitHub Pages at <https://chismoso.caprichosos.org>.

Plain HTML, CSS and a little JavaScript. Docs are Markdown files turned into
static pages by a small Node script (`build.mjs`) with one dependency,
[`marked`](https://marked.js.org). No framework, no trackers, no external
fonts or CDNs.

## Build and preview

```sh
cd site
npm install
npm run build
```

Then open `dist/index.html` in a browser. Every link is relative, so it works
straight from the file system, from any static server
(`python3 -m http.server -d dist`), or from GitHub Pages.

The build fails on a broken internal link or `#anchor` and on an unknown
`{{token}}`; a docs file that isn't in the sidebar config gets a warning.

## Layout

```
site.config.mjs   THE config: repo, domain, store URLs, docs sidebar order
build.mjs         the build (template, Markdown, search index, link check)
pages/            promo pages: index.html (home), download.html (body only)
docs/             one Markdown file per docs page
assets/           style.css, download.js (download buttons), docs.js (menu + search)
img/              logo, favicons, placeholder illustrations
CNAME             custom domain (dist/CNAME is written from site.config.mjs)
pages-workflow.yml  GitHub Actions workflow to deploy (move to .github/workflows/)
dist/             build output (gitignored)
```

Pages and docs can use these tokens, filled in at build time:
`{{gh}}` (repo URL), `{{releases}}`, `{{latest}}`, `{{issues}}`, `{{repo}}`,
`{{name}}`, `{{domain}}`.

## How the download links work

`assets/download.js` runs on the home and download pages. It:

1. Detects the visitor's OS. On macOS it offers both Apple Silicon and Intel,
   with the likelier one first (Chromium browsers report the CPU; others
   default to Apple Silicon).
2. Calls `https://api.github.com/repos/<repo>/releases/latest` once per browser
   session (cached in `sessionStorage` for 15 minutes; unauthenticated calls
   are limited to 60/hour per IP).
3. Matches the release assets by Tauri's default file names:

   | Build | Pattern |
   |---|---|
   | Windows installer | `*_x64-setup.exe` |
   | Windows MSI | `*_x64_en-US.msi` |
   | macOS Apple Silicon | `*_aarch64.dmg` (or `*_universal.dmg`) |
   | macOS Intel | `*_x64.dmg` (or `*_universal.dmg`) |
   | Debian/Ubuntu | `*_amd64.deb` |
   | Fedora/openSUSE | `*.x86_64.rpm` |
   | AppImage | `*_amd64.AppImage` |
   | Android | `*.apk` |

4. Shows a primary "Download for …" button, the version and release date, and
   every desktop build grouped by OS.

If the API fails (offline, rate-limited), the repo or release doesn't exist
yet, or a build is missing, buttons fall back to the GitHub releases page with
a short "first release coming soon" note. Without JavaScript the static links
in the HTML still work. If you rename build artifacts, update the `re:`
patterns in `DESKTOP` in `assets/download.js`.

To preview another platform, add `?os=windows`, `?os=mac`, `?os=linux`,
`?os=android` or `?os=ios` to the page URL. Note that a draft release isn't
"latest": publish it for the site to pick it up.

## Changing the repository or domain

- **Repository:** change `repo` in `site.config.mjs` and rebuild. Every GitHub
  link, the API URL, issue links and "Edit this page" links come from it.
  (`branch` and `siteDir` there control the "Edit this page" path.)
- **Domain:** change `domain` in `site.config.mjs` (it writes `dist/CNAME`,
  canonical and `og:` URLs) and the line in `CNAME`, update the DNS record (a
  `CNAME` to `<owner>.github.io`), then set the custom domain under the repo's
  *Settings → Pages*.

## Lighting up the phone apps

The download page shows Android and iOS as "Coming soon" until a link exists.
No HTML changes are needed; either:

1. **Attach an APK to a GitHub release.** Any asset ending in `.apk` turns the
   Android card into a "Download APK" button, and Android visitors get it as
   their primary download.
2. **Set a store URL** in `site.config.mjs` → `storeUrls.android` /
   `storeUrls.ios` and rebuild. A store URL wins over an APK. iOS needs this
   (or a TestFlight link), since there's no sideloadable asset.

Once they ship, also update the wording in `pages/download.html`
("Phones and tablets"), `docs/phones.md` and the FAQ.

## Adding a docs page

1. Create `docs/my-page.md` with front matter:

   ```markdown
   ---
   title: My page title
   nav: Short sidebar label   # optional
   description: One sentence, used as the intro and the meta description.
   ---

   ## First section
   ```

   Don't use `# ` headings; the title comes from the front matter. `##` and
   `###` headings get anchors and appear in "On this page".
2. Add `'my-page'` to the right section of `sidebar` in `site.config.mjs`.
   Order there is the sidebar order and the prev/next order.
3. Link to other docs as `other-page.md` or `other-page.md#heading-id`; the
   build turns those into `.html` links and checks they exist.
4. Callouts: start a blockquote with `> [!NOTE]`, `> [!TIP]` or `> [!WARNING]`.
5. `npm run build`. The search index (`assets/search-index.js`) is regenerated
   automatically.

## Placeholder images

`img/placeholder-*.svg` are hand-drawn mock-ups of the app's screens (no real
footage, people or third-party logos). Replace them with real screenshots
when ready: keep the 1200×750 ratio (or update the `width`/`height`
attributes), and keep files small (WebP or optimized PNG).

| File | Shows |
|---|---|
| `placeholder-live-grid.svg` | Live grid with timeline (home hero, tour) |
| `placeholder-camera-view.svg` | One camera, switches, stream picker |
| `placeholder-timeline.svg` | Grid playback, speed slider, selection |
| `placeholder-timelapse.svg` | Timelapse tab with progress |
| `placeholder-notification.svg` | A desktop notification |
| `placeholder-load.svg` | Load screen |

## Deploying

`pages-workflow.yml` is a GitHub Actions workflow. Move it to
`.github/workflows/pages.yml`, then in the repo's *Settings → Pages* set
**Source: GitHub Actions**. It builds and deploys on every push to `main` that
touches `site/**`, and whenever a release is published (so the site's cached
version info refreshes), and can be run by hand.

## Before launch

- Add a license to the repo and name it in the footer (`build.mjs`, the
  `TODO` in the footer).
- Replace the placeholder illustrations with real screenshots.
- Check the "about 10 MB" figure against a real release.
- When the app's updater lands, check `docs/updates.md` matches it.
