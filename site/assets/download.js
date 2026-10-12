/* Chismoso site: download buttons.
 *
 * Plain JS, no dependencies. Finds the visitor's platform, asks the GitHub
 * REST API for the latest release, and fills in:
 *   [data-dl-primary]  the big "Download for <OS>" button(s)
 *   [data-dl-meta]     version · date · size
 *   [data-dl-status]   loading / fallback note, or a link to release notes
 *   [data-dl-groups]   every desktop build, grouped by OS (download page)
 *   [data-mobile=…]    the Android / iOS cards
 *   [data-mac-hint]    "which Mac do I have?" (shown on macOS only)
 * If the API can't be reached, the repo or release doesn't exist yet, or a
 * build is missing, links fall back to the GitHub releases page. The page
 * never breaks, and without JavaScript the static links in the HTML work.
 *
 * Settings come from site.config.mjs; the build replaces the placeholder below.
 *
 * Phones light up on their own, with no HTML change, when EITHER:
 *   - the latest GitHub release has an asset ending in ".apk" (Android), or
 *   - a store URL is set in site.config.mjs → storeUrls.android / .ios.
 * A store URL wins over an .apk. iOS has no sideloadable asset, so it needs
 * a store (or TestFlight) URL. Android visitors then get the Android build as
 * their primary button.
 *
 * Testing: add ?os=windows|mac|linux|android|ios|unknown to the page URL.
 */
(function () {
  'use strict';

  var CONFIG = /*CONFIG*/null || { repo: 'caprichosos/chismoso', storeUrls: {} };
  var REPO = CONFIG.repo;
  var STORE = CONFIG.storeUrls || {};

  var GH = 'https://github.com/' + REPO;
  var RELEASES = GH + '/releases/latest';
  var API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var CACHE_KEY = 'chismoso-release:' + REPO;
  var CACHE_MS = 15 * 60 * 1000; // unauthenticated API: 60 requests/hour per IP

  // Desktop builds, matched against Tauri's default bundle file names.
  // A "universal" DMG (if one is ever built) satisfies both Mac entries.
  var DESKTOP = [
    { id: 'win-exe',  os: 'windows', btn: 'Windows',             detail: 'Installer (.exe)',          note: 'Windows 10 and 11, 64-bit', re: /_x64-setup\.exe$/i },
    { id: 'win-msi',  os: 'windows', btn: 'Windows',             detail: 'MSI package (.msi)',        note: 'For managed installs',      re: /_x64_en-US\.msi$/i },
    { id: 'mac-arm',  os: 'mac',     btn: 'Mac (Apple Silicon)', detail: 'Apple Silicon (.dmg)',      note: 'M1 and newer',              re: /_(aarch64|universal)\.dmg$/i },
    { id: 'mac-x64',  os: 'mac',     btn: 'Mac (Intel)',         detail: 'Intel (.dmg)',              note: 'Intel Macs',                re: /_(x64|universal)\.dmg$/i },
    { id: 'deb',      os: 'linux',   btn: 'Linux (.deb)',        detail: 'Debian / Ubuntu (.deb)',    note: 'x86-64',                    re: /_amd64\.deb$/i },
    { id: 'rpm',      os: 'linux',   btn: 'Linux (.rpm)',        detail: 'Fedora / openSUSE (.rpm)',  note: 'x86-64',                    re: /\.x86_64\.rpm$/i },
    { id: 'appimage', os: 'linux',   btn: 'Linux (AppImage)',    detail: 'AppImage',                  note: 'Any distribution, x86-64',  re: /_amd64\.AppImage$/i }
  ];
  var GROUPS = [
    { os: 'windows', name: 'Windows' },
    { os: 'mac', name: 'macOS', sub: 'macOS 11 or newer' },
    { os: 'linux', name: 'Linux' }
  ];
  var MOBILE = [
    { id: 'android', name: 'Android', re: /\.apk$/i, store: STORE.android, assetLabel: 'Download APK',     storeLabel: 'Get it on Google Play' },
    { id: 'ios',     name: 'iOS',     re: null,      store: STORE.ios,     assetLabel: '',                  storeLabel: 'Download on the App Store' }
  ];
  var byId = {};
  DESKTOP.concat(MOBILE).forEach(function (b) { byId[b.id] = b; });

  // ---- Helpers ----------------------------------------------------------------
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function fmtSize(bytes) {
    if (!bytes) return '';
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return d.toISOString().slice(0, 10); }
  }
  function safeUrl(u) { return typeof u === 'string' && /^https:\/\/github\.com\//.test(u) ? u : null; }

  // ---- Platform -----------------------------------------------------------------
  function detectOS() {
    var forced = /[?&]os=(\w+)/.exec(location.search);
    if (forced) return forced[1].toLowerCase();
    var ua = navigator.userAgent || '';
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/android/i.test(ua)) return 'android';
    if (/iphone|ipad|ipod/i.test(ua) || (/mac/i.test(plat) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/win/i.test(plat) || /windows/i.test(ua)) return 'windows';
    if (/mac/i.test(plat) || /mac os x/i.test(ua)) return 'mac';
    if (/linux|x11|cros/i.test(plat + ' ' + ua)) return 'linux';
    return 'unknown';
  }
  var OS = detectOS();

  // Browsers rarely say which Mac CPU they run on. Chromium can, via client
  // hints; otherwise offer Apple Silicon first (every Mac sold since 2023).
  function guessMacArch() {
    var d = navigator.userAgentData;
    if (OS === 'mac' && d && d.getHighEntropyValues) {
      return d.getHighEntropyValues(['architecture']).then(function (v) {
        return v.architecture === 'x86' ? 'x86' : 'arm';
      }, function () { return 'arm'; });
    }
    return Promise.resolve('arm');
  }

  function primaryIds(arch) {
    switch (OS) {
      case 'windows': return ['win-exe'];
      case 'mac': return arch === 'x86' ? ['mac-x64', 'mac-arm'] : ['mac-arm', 'mac-x64'];
      case 'linux': {
        var ua = navigator.userAgent || '';
        if (/ubuntu|debian|mint/i.test(ua)) return ['deb'];
        if (/fedora|red hat|suse/i.test(ua)) return ['rpm'];
        return ['appimage'];
      }
      case 'android': return ['android'];
      case 'ios': return ['ios'];
      default: return [];
    }
  }

  // ---- Release data ---------------------------------------------------------------
  // State: { status: 'loading' | 'ok' | 'none' | 'error', release?: {...} }
  function readCache() {
    try {
      var c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (c && Date.now() - c.t < CACHE_MS) return c.v;
    } catch (e) { /* storage blocked or bad JSON */ }
    return null;
  }
  function writeCache(v) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), v: v })); } catch (e) { /* ignore */ }
  }
  function slim(j) {
    return {
      tag: String(j.tag_name || ''),
      date: j.published_at || j.created_at || '',
      url: safeUrl(j.html_url) || RELEASES,
      assets: (j.assets || []).map(function (a) {
        return { name: String(a.name || ''), url: safeUrl(a.browser_download_url), size: a.size || 0 };
      }).filter(function (a) { return a.url; })
    };
  }
  function loadRelease() {
    if (!window.fetch) return Promise.resolve({ status: 'error' });
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 8000);
    return fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (r.status === 404) return { status: 'none' };        // no repo or no published release yet
        if (!r.ok) return { status: 'error' };                  // rate limit, outage…
        return r.json().then(function (j) { return { status: 'ok', release: slim(j) }; });
      })
      .catch(function () { return { status: 'error' }; })
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (res.status !== 'error') writeCache(res);           // don't cache transient failures
        return res;
      });
  }

  function findAsset(release, build) {
    if (!release || !build.re) return null;
    for (var i = 0; i < release.assets.length; i++) {
      if (build.re.test(release.assets[i].name)) return release.assets[i];
    }
    return null;
  }
  function mobileLink(release, m) {
    if (m.store) return { url: m.store, label: m.storeLabel };
    var a = findAsset(release, m);
    return a ? { url: a.url, label: m.assetLabel, size: a.size } : null;
  }

  // ---- Rendering ----------------------------------------------------------------------
  var DL_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" class="i"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function button(href, label, primary) {
    var a = el('a', { class: 'btn ' + (primary ? 'btn-primary' : 'btn-secondary'), href: href });
    a.innerHTML = DL_ICON;
    a.appendChild(document.createTextNode(label));
    return a;
  }

  function renderPrimary(state, arch) {
    var rel = state.release;
    var fallback = rel ? rel.url : RELEASES;
    var ids = primaryIds(arch);
    var nodes = [];
    var size = '';
    var mobileNote = '';

    if (OS === 'android' || OS === 'ios') {
      var m = byId[OS], link = mobileLink(rel, m);
      if (link) {
        nodes.push(button(link.url, link.label, true));
      } else {
        mobileNote = 'The ' + m.name + ' app is coming soon. Desktop builds are ready now.';
      }
    }
    if (!nodes.length) {
      if (!ids.length || mobileNote) {
        nodes.push(button('#all-platforms', mobileNote ? 'See desktop downloads' : 'Choose your platform', true));
      } else {
        ids.forEach(function (id, i) {
          var b = byId[id], a = findAsset(rel, b);
          nodes.push(button(a ? a.url : fallback, 'Download for ' + b.btn, i === 0));
          if (i === 0 && a) size = fmtSize(a.size);
        });
      }
    }

    var meta = mobileNote;
    if (state.status === 'ok' && rel && !mobileNote) {
      meta = [rel.tag && ('Version ' + rel.tag.replace(/^v/i, '')), rel.date && fmtDate(rel.date), size]
        .filter(Boolean).join(' · ');
    }

    $all('[data-dl-primary]').forEach(function (box) {
      var page = box.getAttribute('data-dl-primary'); // "home" links "#all-platforms" to the download page
      box.textContent = '';
      nodes.forEach(function (n) {
        var c = n.cloneNode(true);
        if (page && c.getAttribute('href') === '#all-platforms') c.setAttribute('href', page + '#all-platforms');
        box.appendChild(c);
      });
    });
    $all('[data-dl-meta]').forEach(function (p) { p.textContent = meta; });
    $all('[data-mac-hint]').forEach(function (p) { p.hidden = OS !== 'mac'; });

    var status = '';
    if (state.status === 'loading') status = 'Checking GitHub for the latest release…';
    else if (state.status === 'none') status = 'The first release is coming soon. Until then the buttons open the GitHub releases page; watch the repository to hear when it lands.';
    else if (state.status === 'error') status = 'Couldn’t check GitHub for the latest release just now, so the buttons open the releases page. (If it’s empty, the first release is coming soon.)';
    $all('[data-dl-status]').forEach(function (p) {
      p.textContent = status;
      p.classList.toggle('is-note', state.status === 'none' || state.status === 'error');
      if (state.status === 'ok' && rel) {
        p.appendChild(el('a', { href: rel.url }, 'Release notes'));
      }
    });
  }

  function renderGroups(state, arch) {
    var rel = state.release, fallback = rel ? rel.url : RELEASES;
    var current = primaryIds(arch);
    $all('[data-dl-groups]').forEach(function (box) {
      box.textContent = '';
      GROUPS.forEach(function (g) {
        var card = el('section', { class: 'pf-card' + (g.os === OS ? ' is-current' : ''), 'aria-labelledby': 'pf-' + g.os });
        var head = el('div', { class: 'pf-head' });
        head.appendChild(el('h3', { id: 'pf-' + g.os }, g.name));
        if (g.os === OS) head.appendChild(el('span', { class: 'pill' }, 'Your system'));
        card.appendChild(head);
        if (g.sub) card.appendChild(el('p', { class: 'pf-sub' }, g.sub));
        var ul = el('ul', { class: 'pf-list' });
        DESKTOP.forEach(function (b) {
          if (b.os !== g.os) return;
          var a = findAsset(rel, b);
          var li = el('li', current.indexOf(b.id) !== -1 ? { class: 'is-current' } : null);
          var label = el('span', { class: 'pf-label' });
          label.appendChild(el('span', { class: 'pf-name' }, b.detail));
          label.appendChild(el('span', { class: 'pf-note' }, b.note + (a && a.size ? ' · ' + fmtSize(a.size) : '')));
          li.appendChild(label);
          li.appendChild(a
            ? el('a', { class: 'btn btn-small', href: a.url, 'aria-label': 'Download ' + g.name + ' ' + b.detail }, 'Download')
            : el('a', { class: 'btn btn-small btn-ghost', href: fallback, 'aria-label': g.name + ' ' + b.detail + ' on GitHub releases' }, 'Releases page'));
          ul.appendChild(li);
        });
        card.appendChild(ul);
        box.appendChild(card);
      });
    });
  }

  function renderMobile(state) {
    MOBILE.forEach(function (m) {
      var link = mobileLink(state.release, m);
      $all('[data-mobile="' + m.id + '"]').forEach(function (card) {
        var slot = card.querySelector('[data-mobile-action]');
        if (!slot) return;
        slot.textContent = '';
        card.classList.toggle('is-soon', !link);
        if (link) {
          slot.appendChild(el('a', { class: 'btn btn-small', href: link.url }, link.label + (link.size ? ' · ' + fmtSize(link.size) : '')));
        } else {
          slot.appendChild(el('span', { class: 'pill pill-soon' }, 'Coming soon'));
        }
      });
    });
  }

  function render(state, arch) {
    renderPrimary(state, arch);
    renderGroups(state, arch);
    renderMobile(state);
  }

  // ---- Start ------------------------------------------------------------------------
  if (!document.querySelector('[data-dl-primary], [data-dl-groups], [data-mobile]')) return;
  guessMacArch().then(function (arch) {
    var cached = readCache();
    render(cached || { status: 'loading' }, arch);
    if (cached) return;
    loadRelease().then(function (state) { render(state, arch); });
  });
})();
