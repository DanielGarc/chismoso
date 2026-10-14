"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
};

// Snapshots, thumbnails and videos come from the app's private local media
// server, which forwards to Frigate with your login (see media.rs).
let MEDIA = "";
const media = (path) => MEDIA + path;

// ── remembered preferences (never the password) ────────────────────
const prefs = Object.assign({
  url: "https://frigate.local:8971", user: "admin", selfSigned: false, pins: {}, keep: false,
  cols: 0, gridLive: false, outDir: "", mode: "timelapse", speed: 60, fps: 30,
  deleteAfter: false, smallShare: false, selected: [], layout: "all", layouts: [],
}, JSON.parse(localStorage.getItem("prefs") || "{}"));
if ("insecure" in prefs) { prefs.selfSigned = !!prefs.insecure; delete prefs.insecure; } // older versions
const savePrefs = () => localStorage.setItem("prefs", JSON.stringify(prefs));

// Start-up timing: milliseconds since the page started, for each step up to
// every tile showing a picture (and video, with a live grid). Sent once per
// sign-in to the backend, which prints it only when CHISMOSO_TIMING is set
// (dev/bench-startup.sh); otherwise it's ignored.
const Timing = {
  t: {}, sent: false,
  mark(k) { if (!(k in this.t)) this.t[k] = Math.round(performance.now()); },
  tile(kind, name) { this.mark(`${kind}:${name}`); this.check(); },
  check() {
    if (this.sent || !state.tiles.size) return;
    const names = [...state.tiles.keys()];
    const pic = names.every((n) => `img:${n}` in this.t || `vid:${n}` in this.t);
    if (pic) this.mark("all_pictures");
    const live = !(prefs.gridLive && Live.supported()) || names.every((n) => `vid:${n}` in this.t || `novid:${n}` in this.t);
    if (this.busy || !(pic && live && "overview" in this.t)) return; // after the server's answer, which may change the grid
    if (this.then === "focus_back") return this.focusBack();
    this.send();
  },
  // Benchmark step: open the first camera, come back, and time until every
  // tile plays again (streams kept warm should make that immediate).
  async focusBack() {
    this.then = null; this.busy = true;
    const first = [...state.tiles.keys()][0];
    await openFocus(first);
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = performance.now();
    closeFocus(false);
    const playing = () => [...state.tiles].every(([n, t]) => (t.rtc && !t.video.hidden) || `novid:${n}` in this.t);
    while (!playing() && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 20));
    this.t.back_to_grid_live = Math.round(performance.now() - t0);
    this.busy = false;
    this.send();
  },
  send() {
    if (this.sent) return;
    this.sent = true;
    invoke("timing_report", { marks: { ...this.t, tiles: state.tiles.size, grid_live: !!prefs.gridLive } }).catch(() => {});
  },
};
Timing.mark("app_js");

const state = {
  info: null,         // { base_url, version, role, cameras, groups }
  stats: null,
  view: "live",
  tiles: new Map(),   // camera -> { el, img, video, dot, fps, rtc, ctrl }
  focus: null,        // { cam, streamIdx, rtc, liveCtrl, timer, mode }
  gridRec: false,     // the grid is playing recordings (all cameras in sync)
  jobs: new Map(),    // job id -> job record (see addBatch)
  pendingJobEvents: new Map(), // events that arrived before their job was registered
  snapTimer: null,
  statsTimer: null,
  cfgOriginal: "",
};

function toast(msg, bad = false, ms = 4000) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// In-app yes/no dialog (the native confirm dialog isn't available in every OS webview).
function ask(message, okLabel = "OK", danger = false) {
  return new Promise((resolve) => {
    const d = $("#ask");
    $("#ask-msg").textContent = message;
    const ok = $("#ask-ok");
    ok.textContent = okLabel;
    ok.className = "btn " + (danger ? "danger" : "primary");
    const finish = (v) => { d.close(); resolve(v); };
    ok.onclick = () => finish(true);
    $("#ask-cancel").onclick = () => finish(false);
    d.oncancel = (e) => { e.preventDefault(); finish(false); };
    d.showModal();
    ok.focus();
  });
}

// Errors from Rust may start with a machine-readable code ("code: message").
const ERR_CODE = /^(session-expired|certificate-untrusted|certificate-changed|update-failed):\s*/;
const errCode = (e) => (ERR_CODE.exec(typeof e === "string" ? e : e?.message || "") || [])[1];
const errText = (e) => (typeof e === "string" ? e : e?.message || String(e)).replace(ERR_CODE, "");

// invoke() for anything that needs the session: an expired login sends you
// back to the sign-in screen instead of failing silently everywhere.
async function call(cmd, args) {
  try { return await invoke(cmd, args); }
  catch (e) {
    if (errCode(e) === "session-expired" && state.info) sessionExpired();
    throw e;
  }
}

// ══ Login ═══════════════════════════════════════════════════════════
$("#f-url").value = prefs.url;
$("#f-user").value = prefs.user;
$("#f-keep").checked = !!prefs.keep;
($("#f-url").value ? $("#f-pass") : $("#f-url")).focus();

async function connect({ trustNew = false } = {}) {
  // Signed in with "Keep me signed in" but the server was offline at start?
  // Connect with an empty password retries the kept session.
  if (!trustNew && !$("#f-pass").value && prefs.keep && $("#f-url").value.trim() === prefs.url && $("#f-user").value.trim() === prefs.user) {
    if (await resumeSession()) return;
  }
  const btn = $("#login-btn"), err = $("#login-error");
  btn.disabled = true; btn.textContent = "Connecting…"; err.hidden = true; $("#cert-box").hidden = true; btn.hidden = false;
  prefs.url = $("#f-url").value.trim();
  prefs.user = $("#f-user").value.trim();
  prefs.keep = $("#f-keep").checked;
  // A server's own (self-signed) certificate is trusted per address: once you
  // accept it, its fingerprint is pinned and checked on every connection.
  if (trustNew) { delete prefs.pins[prefs.url]; prefs.trusted = { ...prefs.trusted, [prefs.url]: true }; }
  const selfSigned = !!(prefs.trusted?.[prefs.url] || prefs.pins[prefs.url] || (prefs.selfSigned && !prefs.trusted));
  savePrefs();
  try {
    Timing.mark("signin_start");
    const signed = await invoke("connect", {
      url: prefs.url, user: prefs.user, password: $("#f-pass").value,
      selfSigned, pinned: selfSigned ? prefs.pins[prefs.url] ?? null : null, keep: prefs.keep,
    });
    Timing.mark("signed_in");
    if (signed.cert_fingerprint) { prefs.pins[prefs.url] = signed.cert_fingerprint; savePrefs(); }
    $("#f-pass").value = "";
    await openSession(signed.base_url);
  } catch (e) {
    const code = errCode(e);
    if (trustNew && code === "certificate-untrusted") {
      // Trusting didn't help, so asking again would loop: show what went wrong.
      err.textContent = "The certificate is trusted now, but the secure connection still failed. If this server is behind a reverse proxy or a VPN gateway, try Frigate's own address (port 8971). " + errText(e);
      err.hidden = false;
    } else if (code === "certificate-untrusted" || code === "certificate-changed") {
      // Offer to trust (or re-trust) the certificate, and say clearly what that means.
      $("#cert-msg").textContent = code === "certificate-changed"
        ? "Warning: this server's certificate changed since you last connected. If you reinstalled Frigate or renewed its certificate, that's expected. Otherwise, someone may be intercepting the connection."
        : "This server uses its own certificate (normal for Frigate on port 8971). Trust it on this device? It's remembered, and you'll be warned if it ever changes.";
      $("#cert-trust").textContent = code === "certificate-changed" ? "Trust the new certificate" : "Trust and connect";
      $("#cert-trust").className = "btn " + (code === "certificate-changed" ? "danger" : "primary");
      $("#cert-box").hidden = false;
      $("#login-btn").hidden = true; // one clear choice: trust, or edit the address
    } else {
      err.textContent = errText(e); err.hidden = false;
    }
  } finally {
    btn.disabled = false; btn.textContent = "Connect";
  }
}
// The last server's cameras, kept so the next start can show them before the
// server answers (only one server, and nothing secret: names and streams).
const infoCache = {
  get(url) {
    try { const c = JSON.parse(localStorage.getItem("serverInfo") || "null"); return c?.url === url ? c.info : null; }
    catch (_) { return null; }
  },
  set(url, info) {
    try { localStorage.setItem("serverInfo", JSON.stringify({ url, info: { ...info, cert_fingerprint: null } })); } catch (_) {}
  },
};

// Signed in (password or kept session). With a camera list remembered for
// this server, the app opens on it at once (pictures and streams start
// loading) while the server is asked for the current list, version and role;
// any camera added or removed since then is picked up when that answers.
// Without one, it waits for the answer. Errors before the app opens go to the
// caller (the sign-in form); after, they lead back to the sign-in screen.
async function openSession(url) {
  const fresh = invoke("overview");
  const cached = infoCache.get(url);
  if (!cached) {
    const info = await fresh;
    Timing.mark("overview");
    state.info = info; infoCache.set(url, info);
    enterApp();
    return;
  }
  state.info = cached;
  enterApp();
  document.body.classList.add("syncing"); // a thin line under the top bar until the server answers
  try {
    applyOverview(await fresh, url);
  } catch (e) {
    if (!state.info) return; // signed out meanwhile
    const expired = errCode(e) === "session-expired";
    leave(expired ? errText(e) : `Couldn't load your cameras: ${errText(e)}`, { forget: false });
  } finally {
    document.body.classList.remove("syncing");
  }
}

function applyOverview(info, url) {
  Timing.mark("overview");
  const old = state.info;
  state.info = info; infoCache.set(url, info);
  setMenuMeta();
  const key = (i) => JSON.stringify([i.cameras, i.groups]);
  if (key(old) !== key(info)) { // cameras added, removed or changed
    ensureViews(); renderTabs(); buildGrid(); startGrid();
  }
  Timing.check();
}

// "Keep me signed in": the backend saved Frigate's session token (never the
// password). On start, try it before showing the sign-in form.
async function resumeSession() {
  const btn = $("#login-btn"), err = $("#login-error");
  btn.disabled = true; btn.textContent = "Signing in…"; err.hidden = true;
  try {
    Timing.mark("signin_start");
    const kept = await invoke("resume");
    if (!kept) { delete Timing.t.signin_start; document.body.classList.remove("booting"); return false; }
    Timing.mark("signed_in");
    prefs.url = kept.url; prefs.user = kept.user; savePrefs();
    $("#f-url").value = kept.url; $("#f-user").value = kept.user;
    await openSession(kept.base_url);
    return true;
  } catch (e) {
    document.body.classList.remove("booting");
    err.textContent = errCode(e) === "session-expired"
      ? errText(e)
      : `Couldn't sign in with your saved session: ${errText(e)} Press Connect to try again, or enter your password.`;
    err.hidden = false;
    $("#f-pass").focus();
    return true; // handled (message shown)
  } finally {
    btn.disabled = false; btn.textContent = "Connect";
  }
}
// Signs in with the session "Keep me signed in" saved, if there is one.
// While the kept session is looked up (a few milliseconds) the sign-in form
// stays hidden, so a signed-in start goes straight to the cameras.
setTimeout(() => document.body.classList.remove("booting"), 4000); // never stuck hidden
// A benchmark run can start with settings and stored data of its choosing.
invoke("bench_prefs").catch(() => null).then((p) => {
  if (p) {
    for (const [k, v] of Object.entries(p._storage || {})) store.set(k, v);
    delete p._storage;
    Timing.then = p._then; delete p._then;
    Object.assign(prefs, p);
  }
  resumeSession();
});

$("#login-form").addEventListener("input", () => { $("#cert-box").hidden = true; $("#login-btn").hidden = false; });
$("#login-form").addEventListener("submit", (ev) => { ev.preventDefault(); connect(); });
$("#cert-trust").addEventListener("click", () => connect({ trustNew: true }));

async function enterApp() {
  MEDIA = await invoke("media_base");
  state.cfgOriginal = ""; cfg.value = ""; state.stats = null; // nothing carries over from another server
  $("#login").hidden = true;
  $("#shell").hidden = false;
  const i = state.info;
  const host = i.base_url.replace(/^https?:\/\//, "");
  const hostname = host.replace(/:\d+$/, "");
  // "frigate-vm.example.org" -> "frigate-vm"; IP addresses stay whole
  $("#server-name").textContent = /^[\d.]+$|^\[/.test(hostname) ? hostname : hostname.split(".")[0];
  $("#server-chip").title = host;
  $("#menu-host").textContent = host;
  setMenuMeta();
  $("#tabs").hidden = false;
  $("#server-wrap").hidden = false;
  if (!prefs.outDir) { prefs.outDir = await invoke("default_output_dir"); savePrefs(); }
  setupExportsForm();
  setupNotifications();
  ensureViews();
  renderTabs();
  $("#s-grid-live").checked = prefs.gridLive;
  buildGrid();
  Timing.mark("grid");
  setTimeout(() => Timing.send(), 30000); // report even if some cameras never show up
  pollStats();
  clearInterval(state.statsTimer);
  state.statsTimer = setInterval(pollStats, 10000);
  startLoadRecorder();
  showView("live");
}

function setMenuMeta() {
  const i = state.info;
  $("#menu-meta").textContent = `Frigate ${i.version} · ${prefs.user || "internal port"} (${i.role})`;
}

// Back to the sign-in screen. `forget: false` keeps a kept session (the server
// couldn't be reached; Connect tries it again).
async function leave(message, { forget = true } = {}) {
  Timing.mark("left"); Timing.t.left_message = message || ""; Timing.send();
  closeMenu();
  closeFocus(true); endGridRec(); stopGrid();
  timeline?.clearCache();
  clearInterval(state.statsTimer); clearInterval(state.snapTimer); clearInterval(state.loadTimer); stopLoadRecorder();
  await invoke("disconnect", { forget }).catch(() => {});
  state.info = null; state.stats = null; state.cfgOriginal = ""; cfg.value = "";
  $("#tabs").hidden = true;
  $("#server-wrap").hidden = true;
  if (state.arranging) { state.arranging = false; document.body.classList.remove("arranging"); $("#arrange-bar").hidden = true; }
  resetZoom();
  $("#shell").hidden = true;
  $("#login").hidden = false;
  if (message) { $("#login-error").textContent = message; $("#login-error").hidden = false; }
  $("#f-pass").focus();
}
$("#logout").addEventListener("click", () => leave());
function sessionExpired() { leave("Your Frigate session expired. Sign in again to continue."); }

// ══ App bar: tabs, server menu, window controls ═════════════════════
const appWindow = () => window.__TAURI__.window.getCurrentWindow();
const isMac = /Mac/.test(navigator.platform || navigator.userAgent);
// macOS keeps its own traffic-light buttons in the bar; elsewhere we draw them.
document.body.classList.toggle("mac", isMac);
$("#win-min").addEventListener("click", () => appWindow().minimize());
$("#win-max").addEventListener("click", () => appWindow().toggleMaximize());
$("#win-close").addEventListener("click", () => appWindow().close());

$$(".tab[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

function showView(v) {
  state.view = v;
  $$(".tab[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  for (const id of ["live", "exports", "load", "settings"]) $("#view-" + id).hidden = id !== v;
  if (v === "live") { if (!state.focus) startGrid(); }
  else { endGridRec(); closeFocus(true); parkGrid(); }
  if (v === "exports") refreshExports();
  clearInterval(state.loadTimer);
  if (v === "settings") loadSettings();
  if (v === "load") showLoad();
}

function closeMenu() { $("#server-menu").hidden = true; $("#server-chip").setAttribute("aria-expanded", "false"); }
$("#server-chip").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("#server-menu").hidden;
  $("#server-menu").hidden = !open;
  $("#server-chip").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => { if (!e.target.closest("#server-menu")) closeMenu(); });
$("#menu-open-web").addEventListener("click", () => { closeMenu(); invoke("open_path", { path: state.info.base_url, reveal: false }).catch((e) => toast(errText(e), true)); });
$("#menu-full").addEventListener("click", () => { closeMenu(); toggleWindowFullscreen(); });
async function toggleWindowFullscreen() { const w = appWindow(); await w.setFullscreen(!(await w.isFullscreen())); }

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
  if (e.key === "F11") { e.preventDefault(); toggleWindowFullscreen(); }
  if (!state.info || !(e.ctrlKey || e.metaKey)) return;
  const v = { 1: "live", 2: "exports", 3: "load", 4: "settings" }[e.key];
  if (v) { e.preventDefault(); showView(v); }
});

// Don't poll or redraw while the window is hidden or minimised.
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !state.info) return;
  pollStats();
  if (state.view === "live" && !state.focus && !state.gridRec) refreshSnapshots();
});

// Minimised or hidden for 30 s: close live streams (snapshots already pause).
// They come back when the window does. Saves bandwidth and go2rtc's work.
let sleptLive = false, hiddenSince = null;
// The page's visibility covers hidden tabs and most minimising; some Linux
// window managers don't report it, so also ask the window itself.
async function checkHidden() {
  if (!state.info) return;
  let minimized = false;
  try { minimized = await appWindow().isMinimized(); } catch (_) {}
  const hidden = document.hidden || minimized;
  if (!hidden) { hiddenSince = null; if (sleptLive) wakeLive(); return; }
  hiddenSince ??= Date.now();
  if (!sleptLive && Date.now() - hiddenSince >= 30000) sleepLive();
}
setInterval(checkHidden, 5000);
document.addEventListener("visibilitychange", checkHidden);
function sleepLive() {
  if (!state.info || state.view !== "live") return;
  if (state.focus) {
    if (state.focus.mode === "live" && state.focus.rtc) { stopLive(state.focus); sleptLive = "focus"; }
  } else if (!state.gridRec && [...state.tiles.values()].some((t) => t.rtc || t.ctrl)) {
    for (const t of state.tiles.values()) { t.ctrl?.abort(); t.ctrl = null; if (t.rtc) { t.rtc.close(); t.rtc = null; } t.video.hidden = true; t.img.hidden = false; }
    sleptLive = "grid";
  }
}
function wakeLive() {
  const was = sleptLive;
  sleptLive = false;
  if (!state.info || state.view !== "live") return;
  if (was === "focus" && state.focus?.mode === "live") startLive();
  else if (was === "grid" && !state.focus && !state.gridRec) startGrid();
}

// ══ Views: the tabs above the grid (layout logic in views.js) ═══════
const isAdmin = () => state.info?.role === "admin";
function camByName(name) { return state.info.cameras.find((c) => c.name === name); }
const prettyName = (s) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Views are kept per device in prefs.views; prefs.view is the open one.
// Called whenever the server's camera list arrives or changes.
function ensureViews() {
  const cams = state.info.cameras.map((c) => c.name);
  let views = Views.clean(prefs.views);
  if (!views) {
    // First start with views: Frigate's camera groups and earlier layouts
    // become views (tabs), and the grid
    // shows live video by default (streams now stay connected while the app is open).
    const groups = (state.info.groups || []).map((g) => ({ name: prettyName(g.name), cameras: g.cameras }));
    views = Views.initial(cams, [...groups, ...(prefs.layouts || [])], newId);
    if (prefs.views === undefined) prefs.gridLive = true;
  }
  prefs.views = views.map((v) => Views.sync(v, cams));
  if (!prefs.views.some((v) => v.id === prefs.view)) prefs.view = prefs.views[0].id;
  savePrefs();
}
const currentView = () => prefs.views.find((v) => v.id === prefs.view) || prefs.views[0];

// Cameras for the current view, in reading order.
function layoutCameras() {
  return Views.ordered(currentView()).map((it) => camByName(it.cam)).filter(Boolean);
}

function renderTabs() {
  const dots = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>';
  $("#vtabs").replaceChildren(...prefs.views.map((v) => {
    const on = v.id === prefs.view;
    // The options button sits beside the tab's own button (a button can't hold another).
    const tab = h("div", { class: "vtab" + (on ? " on" : ""), "data-id": v.id },
      h("button", { class: "vtab-main", role: "tab", "aria-selected": String(on), title: on ? "Double-click to rename" : "",
        onclick: () => switchView(v.id), ondblclick: () => renameView(v.id) },
      h("span", { class: "vname" }, v.name), h("span", { class: "cnt" }, String(v.items.length))));
    if (on) {
      const more = h("button", { class: "vmore", "aria-label": `Options for ${v.name}`, title: "Options",
        onclick: (e) => { e.stopPropagation(); viewMenu(v.id, tab); } });
      more.innerHTML = dots;
      tab.append(more);
    }
    return tab;
  }));
}

function switchView(id) {
  if (id === prefs.view) return;
  if (state.arranging) endArrange();
  prefs.view = id; savePrefs();
  resetZoom();
  renderTabs();
  if (state.focus) closeFocus(true);
  buildGrid(); startGrid();
}

// Saves a changed view and redraws (cameras that stay keep their streams).
function commitView(v, { undo = true } = {}) {
  const i = prefs.views.findIndex((x) => x.id === v.id);
  if (undo && state.arranging) { state.undo.push(prefs.views[i]); $("#arr-undo").disabled = false; }
  prefs.views[i] = v; savePrefs();
  renderTabs(); buildGrid(); startGrid();
}

function addView() {
  const n = prefs.views.length + 1;
  const v = { id: newId(), name: `View ${n}`, auto: false, items: [] };
  prefs.views.push(v);
  prefs.view = v.id; savePrefs();
  resetZoom(); renderTabs(); buildGrid(); startGrid();
  renameView(v.id);
}
$("#vadd").addEventListener("click", addView);

function renameView(id) {
  const v = prefs.views.find((x) => x.id === id);
  const tab = $(`#vtabs [data-id="${id}"]`);
  if (!v || !tab || tab.querySelector("input")) return;
  const input = h("input", { class: "vrename", value: v.name, maxlength: "40", "aria-label": "View name" });
  const nameEl = tab.querySelector(".vname");
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name) { v.name = name; savePrefs(); }
    renderTabs();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
}

function viewMenu(id, anchor) {
  closeViewMenu();
  const v = prefs.views.find((x) => x.id === id);
  const item = (label, fn, cls) => h("button", { role: "menuitem", class: cls || "", onclick: () => { closeViewMenu(); fn(); } }, label);
  const menu = h("div", { class: "menu vmenu", id: "vmenu", role: "menu" },
    item("Rename", () => renameView(id)),
    item("Duplicate", () => {
      const copy = { ...structuredClone(v), id: newId(), name: `${v.name} copy`.slice(0, 40), auto: false };
      prefs.views.splice(prefs.views.indexOf(v) + 1, 0, copy);
      prefs.view = copy.id; savePrefs(); renderTabs(); buildGrid(); startGrid();
    }),
    item("Arrange cameras", () => startArrange()),
    prefs.views.length > 1 ? h("div", { class: "menu-sep" }) : null,
    prefs.views.length > 1 ? item("Delete view", async () => {
      if (!(await ask(`Delete the view "${v.name}"? Your cameras aren't affected.`, "Delete", true))) return;
      prefs.views = prefs.views.filter((x) => x.id !== id);
      if (prefs.view === id) prefs.view = prefs.views[0].id;
      savePrefs(); resetZoom(); renderTabs(); buildGrid(); startGrid();
    }, "bad") : null);
  const r = anchor.getBoundingClientRect(), live = $("#view-live").getBoundingClientRect();
  menu.style.left = `${r.left - live.left}px`;
  menu.style.top = `${r.bottom - live.top + 4}px`;
  $("#view-live").append(menu);
  menu.querySelector("button")?.focus();
}
function closeViewMenu() { $("#vmenu")?.remove(); }
document.addEventListener("click", (e) => { if (!e.target.closest("#vmenu")) closeViewMenu(); });

// ── camera list beside the grid ──
function renderRail() {
  const inView = new Set(currentView().items.map((it) => it.cam));
  $("#rail-list").replaceChildren(...state.info.cameras.map((cam) => {
    const li = h("li", { class: "rail-item" + (inView.has(cam.name) ? " in" : ""), "data-cam": cam.name, title: "Drag onto the grid, or click to open" },
      h("span", { class: "state" }), h("span", { class: "rail-name" }, cam.friendly_name));
    li.addEventListener("pointerdown", (e) => dragStart(e, { cam: cam.name, from: null }));
    li.addEventListener("click", () => { if (!drag.moved) openFocus(cam.name); });
    return li;
  }));
  paintStatus();
}

// Online / connecting / offline for every camera, from Frigate's stats and
// the tiles' own connections. Shown on tiles, in the camera list and above the grid.
function camStatus(name) {
  const s = state.stats?.cameras?.[name];
  const cam = camByName(name);
  const t = state.tiles.get(name);
  if (t?.rtc) return "live"; // video arriving beats any number
  if (cam && cam.enabled === false) return "off";
  if (s && !(s.camera_fps > 0)) return "off";
  if (t && t.ctrl && !t.rtc) return "conn";
  if (s) return "live";
  return "";
}
function paintStatus() {
  if (!state.info) return;
  const count = { live: 0, conn: 0, off: 0 };
  for (const [name, t] of state.tiles) {
    const st = camStatus(name);
    if (st) count[st]++;
    t.el.classList.toggle("connecting", st === "conn" && !t.rtc && !state.gridRec);
    t.el.classList.toggle("offline", st === "off" && !state.gridRec);
  }
  let online = 0;
  for (const li of $$("#rail-list .rail-item")) {
    const st = camStatus(li.dataset.cam);
    li.querySelector(".state").className = "state " + st;
    if (st && st !== "off") online++;
  }
  $("#rail-sum").textContent = state.stats ? `${online} of ${state.info.cameras.length} online` : "";
  const part = (n, cls, label) => n ? h("span", { class: "vs" }, h("span", { class: "state " + cls }), `${n} ${label}`) : null;
  $("#vsum").replaceChildren(...[part(count.live, "live", "live"), part(count.conn, "conn", "connecting"), part(count.off, "off", "offline")].filter(Boolean));
}

// ── arranging: drag, drop, swap, resize ──
const drag = { moved: false };
function cellAt(x, y) {
  const r = $("#wall").getBoundingClientRect();
  if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return null;
  return { x: Math.floor((x - r.left) / r.width * Views.N), y: Math.floor((y - r.top) / r.height * Views.N) };
}
function hint(rect, label) {
  let el = $("#drop-hint");
  if (!rect) { el?.remove(); return; }
  if (!el) { el = h("div", { id: "drop-hint", class: "drop-hint" }); $("#wall").append(el); }
  el.style.gridColumn = `${rect.x + 1} / span ${rect.w}`;
  el.style.gridRow = `${rect.y + 1} / span ${rect.h}`;
  el.textContent = label;
}
const camLabel = (name) => camByName(name)?.friendly_name || name;
// What dropping here would do: { view, rect, label } or null.
function dropResult(cell) {
  if (!cell) return null;
  const v = currentView();
  if (drag.from == null) {
    const next = Views.drop(v, drag.cam, cell.x, cell.y);
    if (!next) return null;
    const it = next.items.find((x) => x.cam === drag.cam);
    const hit = v.items.findIndex((x) => x.cam !== drag.cam && Views.itemAt({ items: [x] }, cell.x, cell.y) === 0);
    return { view: next, rect: it, label: hit >= 0 ? `Replace ${camLabel(v.items[hit].cam)}` : camLabel(drag.cam) };
  }
  const it = v.items[drag.from];
  const next = Views.move(v, drag.from, cell.x - drag.grab.x, cell.y - drag.grab.y, cell.x, cell.y);
  if (!next) return null;
  const hit = Views.itemAt(v, cell.x, cell.y);
  if (hit >= 0 && hit !== drag.from) return { view: next, rect: v.items[hit], label: `Swap with ${camLabel(v.items[hit].cam)}` };
  return { view: next, rect: next.items[drag.from], label: camLabel(it.cam) };
}
function dragStart(e, { cam, from }) {
  if (e.button !== 0 || document.documentElement.hasAttribute("data-compact")) return;
  if (from != null && !state.arranging) return;
  if (e.pointerType === "mouse") e.preventDefault(); // no text selection while dragging
  Object.assign(drag, { cam, from, x0: e.clientX, y0: e.clientY, moved: false, active: true, ghost: null, pointer: e.pointerId, src: e.currentTarget });
  if (from != null) {
    const c = cellAt(e.clientX, e.clientY), it = currentView().items[from];
    drag.grab = c ? { x: c.x - it.x, y: c.y - it.y } : { x: 0, y: 0 };
  }
  e.currentTarget.setPointerCapture?.(e.pointerId);
}
document.addEventListener("pointermove", (e) => {
  if (drag.active && e.pointerId === drag.pointer) {
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      document.body.classList.add("dragging");
      drag.ghost = h("div", { class: "drag-ghost" }, camByName(drag.cam)?.friendly_name || drag.cam);
      document.body.append(drag.ghost);
    }
    drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    const res = dropResult(cellAt(e.clientX, e.clientY));
    hint(res?.rect || null, res?.label || "");
    return;
  }
  if (resizing.active && e.pointerId === resizing.pointer) resizeMove(e);
});
document.addEventListener("pointerup", (e) => {
  if (resizing.active && e.pointerId === resizing.pointer) return resizeEnd();
  if (!drag.active || e.pointerId !== drag.pointer) return;
  drag.active = false;
  document.body.classList.remove("dragging");
  drag.ghost?.remove();
  hint(null);
  if (!drag.moved) return;
  const res = dropResult(cellAt(e.clientX, e.clientY));
  if (res) commitView(res.view);
  setTimeout(() => { drag.moved = false; }, 0); // the click that follows a drag isn't a click
});
document.addEventListener("pointercancel", () => {
  drag.active = false; drag.moved = false; resizing.active = false;
  document.body.classList.remove("dragging"); drag.ghost?.remove(); hint(null);
});

const resizing = { active: false };
function resizeStart(e, i) {
  e.stopPropagation(); e.preventDefault();
  const t = $("#wall").getBoundingClientRect();
  Object.assign(resizing, { active: true, i, pointer: e.pointerId, wall: t, next: null });
  e.currentTarget.setPointerCapture?.(e.pointerId);
}
function resizeMove(e) {
  const v = currentView(), it = v.items[resizing.i], r = resizing.wall;
  const cw = r.width / Views.N, ch = r.height / Views.N;
  const w = Math.ceil((e.clientX - r.left) / cw) - it.x, hh = Math.ceil((e.clientY - r.top) / ch) - it.y;
  const next = Views.resize(v, resizing.i, w, hh);
  if (!next) return;
  resizing.next = next;
  const n = next.items[resizing.i];
  hint(n, `${n.w} × ${n.h}`);
}
function resizeEnd() {
  resizing.active = false;
  hint(null);
  if (resizing.next) commitView(resizing.next);
}

function startArrange() {
  if (state.focus || document.documentElement.hasAttribute("data-compact")) return;
  state.arranging = true; state.undo = [];
  resetZoom();
  document.body.classList.add("arranging");
  $("#arrange-bar").hidden = false; $("#arr-undo").disabled = true;
  buildGrid(); startGrid();
}
function endArrange() {
  state.arranging = false;
  document.body.classList.remove("arranging");
  $("#arrange-bar").hidden = true;
  buildGrid(); startGrid();
}
$("#arrange").addEventListener("click", startArrange);
$("#arr-done").addEventListener("click", endArrange);
$("#arr-undo").addEventListener("click", () => {
  const prev = state.undo.pop();
  if (prev) commitView(prev, { undo: false });
  $("#arr-undo").disabled = !state.undo.length;
});
const fillView = () => commitView(Views.fill(currentView(), state.info.cameras.map((c) => c.name)));
$("#arr-fill").addEventListener("click", fillView);
$("#empty-fill").addEventListener("click", fillView);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.arranging && !e.target.closest("input")) endArrange(); });

// ── zoom: wheel, pinch, buttons; drag to look around when zoomed in ──
const zoom = { z: 1, x: 0, y: 0, dragged: false };
function applyZoom() {
  const g = $("#grid").getBoundingClientRect();
  zoom.z = Math.min(8, Math.max(1, zoom.z));
  zoom.x = Math.min(0, Math.max(g.width - g.width * zoom.z, zoom.x));
  zoom.y = Math.min(0, Math.max(g.height - g.height * zoom.z, zoom.y));
  $("#wall").style.transform = zoom.z > 1.001 ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.z})` : "";
  $("#grid").classList.toggle("zoomed", zoom.z > 1.001);
  $("#zoom-val").textContent = `${Math.round(zoom.z * 100)}%`;
}
// Zoom to z, keeping the point under (cx, cy) where it is.
function zoomAt(z, cx, cy) {
  const g = $("#grid").getBoundingClientRect();
  z = Math.min(8, Math.max(1, z));
  const ox = cx - g.left, oy = cy - g.top, k = z / zoom.z;
  zoom.x = ox - (ox - zoom.x) * k; zoom.y = oy - (oy - zoom.y) * k; zoom.z = z;
  applyZoom();
}
const zoomCenter = (f) => { const g = $("#grid").getBoundingClientRect(); zoomAt(zoom.z * f, g.left + g.width / 2, g.top + g.height / 2); };
function resetZoom() { zoom.z = 1; zoom.x = 0; zoom.y = 0; applyZoom(); }
$("#zoom-in").addEventListener("click", () => zoomCenter(1.5));
$("#zoom-out").addEventListener("click", () => zoomCenter(1 / 1.5));
$("#zoom-fit").addEventListener("click", resetZoom);
window.addEventListener("resize", () => applyZoom());
$("#grid").addEventListener("wheel", (e) => {
  if (state.focus || document.documentElement.hasAttribute("data-compact")) return;
  e.preventDefault();
  // A mouse wheel or a pinch zooms; a touchpad's two-finger scroll looks around.
  const wheel = e.ctrlKey || e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40);
  if (wheel) zoomAt(zoom.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
  else { zoom.x -= e.deltaX; zoom.y -= e.deltaY; applyZoom(); }
}, { passive: false });
const pans = new Map(); // pointers down on the grid (touch can pinch)
$("#grid").addEventListener("pointerdown", (e) => {
  if (state.arranging || state.focus || e.button !== 0 || e.target.closest(".zoomctl, .tile-tools, .view-empty")) return;
  pans.set(e.pointerId, { x: e.clientX, y: e.clientY });
  zoom.dragged = false;
});
$("#grid").addEventListener("pointermove", (e) => {
  const p = pans.get(e.pointerId);
  if (!p) return;
  if (pans.size === 2) { // pinch
    const [a, b] = [...pans.values()];
    const before = Math.hypot(a.x - b.x, a.y - b.y);
    p.x = e.clientX; p.y = e.clientY;
    const after = Math.hypot(a.x - b.x, a.y - b.y);
    if (before > 0) zoomAt(zoom.z * after / before, (a.x + b.x) / 2, (a.y + b.y) / 2);
    zoom.dragged = true;
    return;
  }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  if (zoom.z > 1.001 && (zoom.dragged || Math.hypot(dx, dy) > 4)) {
    if (!zoom.dragged) $("#grid").setPointerCapture?.(e.pointerId);
    zoom.dragged = true;
    zoom.x += dx; zoom.y += dy; p.x = e.clientX; p.y = e.clientY;
    applyZoom();
  }
});
const panEnd = (e) => { pans.delete(e.pointerId); if (zoom.dragged) setTimeout(() => { zoom.dragged = false; }, 0); };
$("#grid").addEventListener("pointerup", panEnd);
$("#grid").addEventListener("pointercancel", panEnd);
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || state.view !== "live" || state.focus || !state.info) return;
  if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomCenter(1.5); }
  else if (e.key === "-") { e.preventDefault(); zoomCenter(1 / 1.5); }
  else if (e.key === "0") { e.preventDefault(); resetZoom(); }
});

$("#s-grid-live").addEventListener("change", (e) => { prefs.gridLive = e.target.checked; savePrefs(); stopGrid(); startGrid(); });

// ══ Live: grid ══════════════════════════════════════════════════════
// Tiles out of sight (zoomed in) don't fetch snapshots; their streams stay up.
const tileObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const entry = [...state.tiles].find(([, t]) => t.el === e.target);
    if (!entry) continue;
    const [name, t] = entry;
    t.visible = e.isIntersecting;
    if (t.visible && !state.focus && !state.gridRec && state.view === "live" && prefs.gridLive && Live.supported() && !sleptLive) startTileVideo(name, t);
  }
}, { root: $("#grid"), threshold: 0.05 });

function makeTile(cam) {
  const img = h("img", { alt: "" });
  const video = h("video", { autoplay: true, playsinline: true, muted: true, hidden: true });
  video.muted = true;
  const fps = h("span", { class: "fps" });
  const dot = h("span", { class: "state" });
  const recMsg = h("span", { class: "rec-msg" });
  const removeBtn = h("button", { class: "tt arr", "aria-label": `Remove ${cam.friendly_name} from this view`, title: "Remove from this view",
    onclick: (e) => { e.stopPropagation(); const v = currentView(); commitView(Views.remove(v, v.items.findIndex((x) => x.cam === cam.name))); } });
  removeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const handle = h("span", { class: "resize", "aria-hidden": "true", title: "Drag to resize" });
  handle.addEventListener("pointerdown", (e) => resizeStart(e, currentView().items.findIndex((x) => x.cam === cam.name)));
  // Clicking a tile opens that camera, at the same moment if we're playing
  // back. A tile parked during grid playback starts playing instead.
  const el = h("div", { class: "tile", "data-cam": cam.name, onclick: () => {
    if (zoom.dragged || drag.moved || state.arranging) return;
    if (state.gridRec && state.parked?.has(cam.name)) return promoteTile(cam.name);
    openFocus(cam.name, 0, state.gridRec && pb.active ? pb.t : null);
  } },
    img, video, h("div", { class: "empty" }, "Loading…"), recMsg,
    h("div", { class: "tile-msg conn-msg" }, h("span", { class: "spin" }), "Connecting…"),
    h("div", { class: "tile-msg off-msg" }, "Offline"),
    h("div", { class: "tile-tools" }, removeBtn),
    h("div", { class: "label" }, dot, cam.friendly_name, fps), handle);
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".tile-tools, .resize")) return;
    const i = currentView().items.findIndex((x) => x.cam === cam.name);
    dragStart(e, { cam: cam.name, from: i });
  });
  return { el, img, video, dot, fps, recMsg, rtc: null, ctrl: null, visible: true };
}

// Builds the current view's tiles. Cameras already on screen keep their tile
// (and stream); tiles of cameras that left wait in `spare` for WARM_MS, so
// switching back and forth between views doesn't reconnect.
function buildGrid() {
  const resume = state.gridRec && pb.active ? pb.t : null;
  endGridRec();
  tileObserver.disconnect();
  const wall = $("#wall");
  const v = currentView();
  const old = new Map([...(state.spare || new Map()), ...state.tiles]);
  state.tiles = new Map();
  for (const it of Views.ordered(v)) {
    const cam = camByName(it.cam);
    if (!cam) continue;
    const t = old.get(cam.name) || makeTile(cam);
    old.delete(cam.name);
    t.el.style.gridColumn = `${it.x + 1} / span ${it.w}`;
    t.el.style.gridRow = `${it.y + 1} / span ${it.h}`;
    t.el.classList.toggle("wide", it.w >= Views.N / 2);
    state.tiles.set(cam.name, t);
  }
  wall.replaceChildren(...[...state.tiles.values()].map((t) => t.el));
  // moving a <video> in the page pauses it: carry on playing
  for (const t of state.tiles.values()) if (t.rtc) t.video.play().catch(() => {});
  for (const t of state.tiles.values()) tileObserver.observe(t.el);
  // the rest: keep warm a while, then close
  state.spare = old;
  clearTimeout(state.spareTimer);
  if ([...old.values()].some((t) => t.rtc || t.ctrl)) {
    state.spareTimer = setTimeout(() => {
      for (const t of state.spare.values()) { t.ctrl?.abort(); t.ctrl = null; if (t.rtc) { t.rtc.close(); t.rtc = null; } }
      state.spare.clear();
    }, WARM_MS);
  }
  $("#view-empty").hidden = state.tiles.size > 0;
  $("#grid").classList.toggle("empty", !state.tiles.size);
  if (state.info) renderRail();
  paintTileStats();
  if (!state.focus) rescope();
  setPlaybackUi();
  if (resume) playAt(resume);
}

// Safe to call repeatedly (tab clicks, shortcuts): already-running tiles are left alone.
function startGrid() {
  if (!state.info || state.focus || state.view !== "live" || state.gridRec) return;
  clearTimeout(state.parkTimer); // back from a camera or another tab: streams kept are reused
  getTimeline();
  startTicker();
  if (prefs.gridLive && Live.supported()) {
    for (const [name, t] of state.tiles) if (t.visible) startTileVideo(name, t);
  }
  refreshSnapshots();
  clearInterval(state.snapTimer);
  state.snapTimer = setInterval(refreshSnapshots, 2000);
  clearInterval(state.fpsTimer);
  state.fpsTimer = setInterval(measureTiles, 2000);
}

// Leaving the grid for a moment (one camera full size, another tab) keeps the
// grid's streams connected, so coming back is instant instead of reconnecting
// every camera. After WARM_MS away they close, like stopGrid().
const WARM_MS = 120e3;
function parkGrid() {
  clearInterval(state.snapTimer);
  clearInterval(state.fpsTimer);
  clearTimeout(state.parkTimer);
  if ([...state.tiles.values()].some((t) => t.rtc || t.ctrl)) state.parkTimer = setTimeout(stopGrid, WARM_MS);
}

function stopGrid() {
  clearInterval(state.snapTimer);
  clearInterval(state.fpsTimer);
  clearTimeout(state.parkTimer);
  for (const t of state.tiles.values()) {
    t.ctrl?.abort(); t.ctrl = null;
    if (t.rtc) { t.rtc.close(); t.rtc = null; }
    t.video.hidden = true; t.img.hidden = false;
  }
}

async function startTileVideo(name, t) {
  if (t.ctrl || t.rtc) return; // already starting or playing
  const ctrl = t.ctrl = new AbortController();
  paintStatus();
  const cam = camByName(name);
  // Prefer a second (usually lower-resolution) stream for the grid when configured.
  const stream = gridStream(cam);
  try {
    const rtc = await Live.play(t.video, stream, { signal: ctrl.signal });
    if (ctrl.signal.aborted) return rtc.close();
    attachTileRtc(t, rtc);
    if (t.video.readyState >= 2) Timing.tile("vid", name);
    else t.video.addEventListener("loadeddata", () => Timing.tile("vid", name), { once: true });
  } catch (_) { Timing.tile("novid", name); /* stays on snapshots */ }
  finally { if (t.ctrl === ctrl && !t.rtc) t.ctrl = null; paintStatus(); }
}

function attachTileRtc(t, rtc) {
  t.rtc = rtc; t.counter = frameCounter(t.video); t.liveFps = null; paintTileStats();
  t.video.hidden = false; t.img.hidden = true;
  t.el.querySelector(".empty").hidden = true;
  rtc.onDrop = () => { // fall back to snapshots instead of freezing
    if (t.rtc !== rtc) return;
    rtc.close(); t.rtc = null; t.ctrl = null;
    t.video.hidden = true; t.img.hidden = false;
  };
}
const gridStream = (cam) => (cam.streams[1] || cam.streams[0])[1];

let snapBusy = false;
async function refreshSnapshots() {
  if (snapBusy || document.hidden || state.view !== "live" || state.focus || state.gridRec) return;
  snapBusy = true;
  await Promise.all([...state.tiles].filter(([, t]) => !t.rtc && t.visible).map(([name, t]) => new Promise((res) => {
    // Ask for the size the tile shows (in steps, so Frigate isn't asked for odd sizes).
    const px = Math.min(1080, Math.max(180, Math.ceil(t.el.clientHeight * (window.devicePixelRatio || 1) / 90) * 90));
    const next = new Image();
    const done = setTimeout(res, 8000); // a hung request must not stall the whole grid
    next.onload = () => { clearTimeout(done); t.img.src = next.src; t.el.querySelector(".empty").hidden = true; Timing.tile("img", name); res(); };
    next.onerror = () => { clearTimeout(done); t.el.querySelector(".empty").textContent = "No image"; res(); };
    next.src = media(`/api/${encodeURIComponent(name)}/latest.jpg?h=${px}&quality=70&t=${Date.now()}`);
  })));
  snapBusy = false;
}

// Tile corner: what you're actually seeing. The frame rate is measured from
// the video element (frames decoded), not Frigate's camera_fps, which is the
// detect stream's rate (often 5) and says nothing about the live view.
function paintTileStats() {
  for (const [name, t] of state.tiles) {
    const s = state.stats?.cameras?.[name];
    const camFps = s?.camera_fps ?? 0;
    t.dot.className = "state " + camStatus(name);
    t.fps.title = s ? `Frigate is receiving ${camFps.toFixed(1)} fps on the detect stream` : "";
    if (state.gridRec) t.fps.textContent = "recording";
    else if (t.rtc) t.fps.textContent = t.liveFps != null ? `${t.rtc.kind === "webrtc" ? "WebRTC" : "MSE"} · ${Math.round(t.liveFps)} fps` : (t.rtc.kind === "webrtc" ? "WebRTC" : "MSE");
    else t.fps.textContent = s ? "snapshot" : "";
  }
  paintStatus();
}

// Frames actually shown per second, from the video element's own counters.
function frameCounter(video) {
  let last = null;
  return () => {
    const q = video.getVideoPlaybackQuality?.();
    if (!q || video.paused || video.hidden) { last = null; return null; }
    const now = performance.now(), frames = q.totalVideoFrames - q.droppedVideoFrames;
    const prev = last;
    last = { now, frames };
    if (!prev || now - prev.now < 500 || frames < prev.frames) return null;
    return (frames - prev.frames) * 1000 / (now - prev.now);
  };
}
function measureTiles() {
  if (document.hidden || state.view !== "live" || state.focus) return;
  for (const t of state.tiles.values()) {
    t.counter ??= frameCounter(t.video);
    const f = t.rtc ? t.counter() : null;
    if (f != null) t.liveFps = f; else if (!t.rtc) t.liveFps = null;
  }
  paintTileStats();
}

async function pollStats() {
  if (document.hidden || !state.info) return;
  try {
    state.stats = await call("stats");
    paintTileStats();
    if (state.view === "settings") renderSystem();
  } catch (_) { /* Frigate restarting or unreachable; keep going */ }
}

// ══ Recordings: one camera (focus) or the whole layout (grid) ═══════
// The playback bar and timeline sit under both views. In the grid they show
// every camera in the layout; clicking the bar plays them all in sync.
const focusVideo = $("#focus-video");
const pb = new SyncPlayback({ media, invoke: call });
let timeline = null;
let playGen = 0;
const SPEEDS = [-16, -8, -4, -2, 1, 2, 4, 8, 16];

const scopeCams = () => (state.focus ? [state.focus.cam] : [...state.tiles.keys()]);
const recMode = () => (state.focus ? state.focus.mode === "rec" : !!state.gridRec);

async function loadSummaries(cams) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const all = await Promise.all(cams.map((camera) => call("recording_summary", { camera, timezone }).catch(() => null)));
  if (cams.length === 1) return all[0];
  const byDay = new Map();
  for (const days of all) for (const d of days || []) {
    const m = byDay.get(d.day) || new Map();
    for (const hr of d.hours || []) m.set(+hr.hour, Math.max(m.get(+hr.hour) || 0, hr.duration || 0));
    byDay.set(d.day, m);
  }
  return [...byDay].map(([day, m]) => ({ day, hours: [...m].map(([hour, duration]) => ({ hour, duration })) }));
}

function getTimeline() {
  if (timeline) return timeline;
  timeline = new Timeline($("#timeline"), {
    loadSpans: (after, before) => call("recording_spans", { cameras: scopeCams(), after, before }),
    loadEvents: (after, before) => call("review_items", { cameras: scopeCams(), after, before }),
    loadSummary: () => loadSummaries(scopeCams()),
    onSeek: (ts) => seekTo(ts),
    onEvent: (ev) => { timeline.follow = true; playAt(ev.start - 3); },
    onSelect: showSelection,
    onHoverEvent: showEventCard,
    onView: showRange,
  });
  return timeline;
}

// The bar now shows other cameras: drop cached days and refetch the view.
function rescope() {
  const tl = getTimeline();
  tl.clearCache();
  clearSelection();
  $("#ev-card").hidden = true;
  tl.setView(tl.start, tl.end);
  const n = scopeCams().length;
  $("#pb-scope").textContent = state.focus ? "" : `${n} camera${n === 1 ? "" : "s"}`;
}

// Point the player at the cameras in view (no-op if already there).
// Grid playback plays at most MAX_PLAYING cameras at once (each one pulls a
// full-resolution recording from Frigate); the rest are "parked" and show a
// still from the recordings every few seconds until clicked.
const MAX_PLAYING = 4;
function ensurePlayers() {
  if (state.focus) {
    const key = "f:" + state.focus.cam;
    if (pb.key === key) return;
    pb.key = key;
    return pb.setCameras([{ name: state.focus.cam, video: focusVideo }]);
  }
  const names = [...state.tiles.keys()];
  if (!state.playing || state.playing.some((n) => !state.tiles.has(n))) {
    const visible = names.filter((n) => state.tiles.get(n).visible);
    state.playing = [...visible, ...names.filter((n) => !visible.includes(n))].slice(0, MAX_PLAYING);
  }
  state.parked = new Set(names.filter((n) => !state.playing.includes(n)));
  const key = "g:" + state.playing.join("|");
  if (pb.key !== key) {
    pb.key = key;
    pb.setCameras(state.playing.map((name) => ({ name, video: state.tiles.get(name).video }))); // clears old overlays
  }
  for (const [name, t] of state.tiles) {
    const parked = state.parked.has(name);
    t.el.classList.toggle("parked", parked);
    t.video.hidden = parked; t.img.hidden = !parked;
    if (parked) { t.recMsg.textContent = `Paused to save bandwidth · ${Platform.tap} to play`; t.stillAt = null; }
  }
}

// Parked tiles: a still from the recordings at the playhead, every few seconds.
function refreshParked(now) {
  if (!state.parked?.size || pb.t == null) return;
  for (const name of state.parked) {
    const t = state.tiles.get(name);
    if (!t?.visible || (t.stillAt && now - t.stillAt < 4000)) continue;
    t.stillAt = now;
    const px = Math.min(720, Math.max(180, Math.ceil(t.el.clientHeight * (window.devicePixelRatio || 1) / 90) * 90));
    const next = new Image();
    next.onload = () => { if (state.parked?.has(name)) t.img.src = next.src; };
    next.src = media(`/api/${encodeURIComponent(name)}/recordings/${pb.t.toFixed(1)}/snapshot.jpg?height=${px}`);
  }
}

// Swap a parked tile in (the longest-playing one makes room).
function promoteTile(name) {
  const at = pb.t ?? Date.now() / 1000 - 60;
  state.playing = [...state.playing.filter((n) => n !== name), name].slice(-MAX_PLAYING);
  playAt(at);
}

pb.onStatus = (p, msg) => {
  if (state.focus) {
    if (p.video !== focusVideo) return;
    $("#focus-msg").textContent = msg || ""; $("#focus-msg").hidden = !msg;
  } else {
    const t = state.tiles.get(p.name);
    if (t && t.video === p.video) t.recMsg.textContent = msg || "";
  }
};
pb.onLive = () => goLive();
pb.onError = (e) => { if (state.focus) { $("#focus-msg").textContent = errText(e); $("#focus-msg").hidden = false; } else toast(errText(e), true); };

async function openFocus(name, streamIdx = 0, at = null) {
  const cam = camByName(name);
  // Same go2rtc stream already playing in the tile? Take that connection
  // instead of opening another (instant, and one less viewer on go2rtc).
  const tile = state.tiles.get(name);
  let handoff = null;
  if (at == null && tile?.rtc?.kind === "webrtc" && tile.rtc.stream === cam.streams[streamIdx][1]) {
    handoff = tile.rtc; tile.rtc = null; tile.ctrl = null;
  }
  endGridRec();
  parkGrid();
  closeFocus(true);
  state.focus = { cam: name, streamIdx, rtc: null, liveCtrl: null, timer: null, mode: "live" };
  $("#grid").hidden = true;
  $("#focus").hidden = false;
  $("#view-live").classList.add("in-focus");
  $("#focus-name").textContent = cam.friendly_name;

  const sel = $("#focus-stream");
  sel.replaceChildren(...cam.streams.map(([label], i) => h("option", { value: i, selected: i === streamIdx }, label)));
  sel.hidden = cam.streams.length < 2;
  sel.onchange = () => { state.focus.streamIdx = +sel.value; if (state.focus.mode === "live") startLive(); };
  renderFocusToggles();
  setupPtz();

  const tl = getTimeline();
  tl.selectMode = false;
  $("#pb-select").classList.remove("on");
  tl.follow = true;
  rescope();
  if (at == null) tl.setSpan(3600);
  $("#pb-date").value = "";
  startTicker();
  // The phone's back button (and a mouse's back button) returns to the grid.
  if (!history.state?.focus) history.pushState({ focus: name }, "");
  if (at != null) return playAt(at);
  await startLive(handoff);
}

function stopLive(f) {
  f.liveCtrl?.abort(); f.liveCtrl = null;
  if (f.rtc) { f.rtc.close(); f.rtc = null; }
  clearInterval(f.timer); f.timer = null;
}

async function startLive(handoff = null) {
  const focus = state.focus;
  if (!focus) { handoff?.close(); return; }
  pb.close(); pb.key = null;
  stopLive(focus);
  focus.mode = "live";
  updatePtz();
  setPlaybackUi();
  const cam = camByName(focus.cam);
  const img = $("#focus-img"), msg = $("#focus-msg"), badge = $("#focus-mode");
  focusVideo.hidden = false; img.hidden = true; msg.hidden = true;
  badge.className = "badge"; badge.textContent = "connecting…";
  const ctrl = focus.liveCtrl = new AbortController();
  try {
    let rtc = handoff;
    if (rtc) rtc.moveTo(focusVideo);
    else rtc = await Live.play(focusVideo, cam.streams[focus.streamIdx][1], { signal: ctrl.signal });
    if (ctrl.signal.aborted) return rtc.close();
    focus.rtc = rtc;
    focus.ticks = 0;
    focus.counter = frameCounter(focusVideo);
    badge.className = "badge ok"; badge.textContent = rtc.kind === "webrtc" ? "Live · WebRTC" : "Live · MSE";
    rtc.onDrop = (e) => {
      if (focus.rtc === rtc) fallbackSnapshots(focus, `Stream interrupted (${errText(e)}). Showing snapshots; press Live to retry.`);
    };
  } catch (e) {
    if (ctrl.signal.aborted || e.name === "AbortError") return;
    fallbackSnapshots(focus, errText(e));
  }
}

// Back to live for whatever is on screen.
function goLive() {
  if (timeline) timeline.follow = true;
  if (state.focus) return startLive();
  if (!state.gridRec) return;
  endGridRec();
  setPlaybackUi();
  startGrid();
}

// Leave grid playback: stop the players and give the tiles back to live view.
function endGridRec() {
  if (!state.gridRec) return;
  state.gridRec = false;
  playGen++;
  pb.close(); pb.key = null;
  state.playing = null; state.parked = null;
  $("#grid").classList.remove("is-rec");
  for (const t of state.tiles.values()) {
    t.recMsg.textContent = "";
    t.el.classList.remove("parked");
    t.video.hidden = true; t.img.hidden = false;
  }
}

// Play recordings from wall-clock time `ts` on the cameras in view.
async function playAt(ts) {
  const focus = state.focus;
  if (focus) {
    stopLive(focus);
    focus.mode = "rec";
    updatePtz();
    $("#focus-img").hidden = true;
    focusVideo.hidden = false;
    $("#focus-mode").className = "badge rec"; $("#focus-mode").textContent = "Loading recording…";
    $("#focus-msg").hidden = true;
  } else {
    if (!state.tiles.size) return;
    if (!state.gridRec) {
      stopGrid();
      state.gridRec = true;
      $("#grid").classList.add("is-rec");
      for (const t of state.tiles.values()) { t.video.hidden = false; t.img.hidden = true; t.el.querySelector(".empty").hidden = true; }
    }
  }
  setPlaybackUi();
  ensurePlayers();
  pb.setRate(playSpeed());
  const gen = ++playGen;
  $("#pb-time").textContent = "Loading recording…";
  try {
    const started = await pb.open(ts);
    if (started == null || gen !== playGen || !recMode()) return;
    if (focus) $("#focus-mode").textContent = pb.back ? "Recording · reverse" : "Recording";
    if (Math.abs(started - ts) > 5) toast(`No footage at that moment. Playing from ${fmtTime(started)}.`);
  } catch (e) {
    if (gen !== playGen) return;
    if (focus && state.focus === focus) {
      $("#focus-mode").textContent = "Recording";
      $("#focus-msg").textContent = errText(e); $("#focus-msg").hidden = false;
    } else toast(errText(e), true);
  }
}

function seekTo(ts) {
  if (!state.focus && !state.tiles.size) return;
  if (ts > Date.now() / 1000 - 8) return goLive();
  if (recMode() && pb.active && pb.covers(ts)) { pb.seek(ts); return; }
  playAt(ts);
}

function setPlaybackUi() {
  const rec = recMode();
  $("#pb").classList.toggle("is-rec", rec);
  $("#pb").classList.toggle("grid", !state.focus);
  $("#pb-live").classList.toggle("on", !rec);
  $("#pb-play").textContent = "❚❚";
}

const fmtTime = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtClock = (ts, secs = true) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(secs ? { second: "2-digit" } : {}) });
const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
const playheadTime = () => (recMode() ? pb.t : null) ?? Date.now() / 1000;

// Keep the players together and the playhead, clock and timeline in step.
function startTicker() {
  clearInterval(state.ticker);
  state.ticker = setInterval(() => {
    if (!state.info || state.view !== "live") return clearInterval(state.ticker);
    if (document.hidden || !timeline) return;
    if (recMode()) {
      pb.tick();
      if (!state.focus) refreshParked(Date.now());
      const wt = pb.t;
      if (wt && pb.active) {
        timeline.setPlayhead(wt, false);
        $("#pb-time").textContent = fmtTime(wt) + (pb.paused ? " · paused" : "");
        $("#stage-time").textContent = state.focus ? fmtTime(wt) : "";
      }
    } else {
      timeline.setPlayhead(null, true);
      $("#pb-time").textContent = "Live";
      const f = state.focus;
      if (f?.rtc && ++f.ticks % 8 === 0) { // every 2 s
        const fps = f.counter();
        if (fps != null) $("#focus-mode").textContent = `Live · ${f.rtc.kind === "webrtc" ? "WebRTC" : "MSE"} · ${Math.round(fps)} fps`;
      }
      $("#stage-time").textContent = "";
    }
  }, 250);
}

// ── timeline header: visible range + zoom ──
function showRange(a, b) {
  const span = b - a;
  const day = (t) => new Date(t * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  $("#tl-range").textContent = span > 86400 * 2
    ? `${day(a)} – ${day(b)}`
    : sameDay(a, b) ? `${day(a)} · ${fmtClock(a, span < 1800)} – ${fmtClock(b, span < 1800)}`
    : `${day(a)} ${fmtClock(a, false)} – ${day(b)} ${fmtClock(b, false)}`;
  $$("#tl-zoom [data-span]").forEach((btn) => btn.classList.toggle("on", Math.abs(Math.log(span / +btn.dataset.span)) < 0.2));
}
$$("#tl-zoom button").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.span) timeline.setSpan(+b.dataset.span);
  else timeline.zoomBy(b.dataset.z === "in" ? 0.5 : 2);
  timeline.emitSelection();
}));

// ── events (alerts / detections) ──
function showEventCard(ev, x) {
  const card = $("#ev-card");
  if (!ev) { card.hidden = true; return; }
  const what = ev.labels.length ? ev.labels.map(prettyName).join(", ") : "Activity";
  const where = !state.focus && ev.camera ? ` · ${camByName(ev.camera)?.friendly_name || prettyName(ev.camera)}` : "";
  $("#ev-title").textContent = `${ev.severity === "alert" ? "Alert" : "Detection"} · ${what}${where}`;
  $("#ev-time").textContent = `${fmtClock(ev.start)}${ev.end ? " · " + human(ev.end - ev.start) : " · ongoing"} — ${Platform.tap} to play`;
  card.className = "ev-card " + ev.severity;
  const img = $("#ev-img");
  img.hidden = !ev.thumb;
  if (ev.thumb) img.src = media(ev.thumb);
  card.hidden = false;
  const wrap = $("#tl-wrap").getBoundingClientRect(), cw = 240;
  card.style.left = `${Math.max(0, Math.min(wrap.width - cw, x - cw / 2))}px`;
}

function jumpEvent(dir) {
  if (!timeline) return;
  const ref = playheadTime();
  const evs = timeline.events();
  const ev = dir < 0 ? [...evs].reverse().find((e) => e.start < ref - 2) : evs.find((e) => e.start > ref + 2);
  if (!ev) return toast(dir < 0 ? "No earlier events in the loaded days. Zoom out or move back to load more." : "No later events.");
  timeline.follow = true;
  playAt(ev.start - 3);
}
$("#ev-prev").addEventListener("click", () => jumpEvent(-1));
$("#ev-next").addEventListener("click", () => jumpEvent(1));

// Frigate tells us (over /ws) when a review item starts or changes: refresh
// today's events on the bar if it's for a camera we're showing.
let reviewPoke = null;
listen("frigate-review", ({ payload }) => {
  if (!timeline || state.view !== "live" || !scopeCams().includes(payload.camera)) return;
  clearTimeout(reviewPoke);
  reviewPoke = setTimeout(() => timeline.refreshToday(), 1500);
});

// ── selection → clip / timelapse ──
function showSelection(sel) {
  const pop = $("#sel-pop");
  if (!sel) { pop.hidden = true; return; }
  const len = sel.b - sel.a;
  const n = scopeCams().length;
  $("#sel-info").textContent = `${sameDay(sel.a, sel.b) ? fmtClock(sel.a) : fmtTime(sel.a)} → ${fmtClock(sel.b)} · ${human(len)}${n > 1 ? ` · ${n} cameras` : ""}`;
  pop.hidden = false;
  const wrap = $("#tl-wrap").getBoundingClientRect(), pw = pop.offsetWidth || 420;
  const mid = (Math.max(0, sel.x0) + Math.min(wrap.width, sel.x1)) / 2;
  pop.style.left = `${Math.max(0, Math.min(wrap.width - pw, mid - pw / 2))}px`;
}
function clearSelection() {
  timeline?.setSelection(null);
  if (timeline) timeline.selectMode = false;
  $("#pb-select").classList.remove("on");
}
$("#pb-select").addEventListener("click", () => {
  timeline.selectMode = !timeline.selectMode;
  $("#pb-select").classList.toggle("on", timeline.selectMode);
  if (timeline.selectMode) toast("Drag across the bar to select a range.");
});
$("#sel-clear").addEventListener("click", clearSelection);
$("#sel-play").addEventListener("click", () => timeline.sel && playAt(timeline.sel.a));
$("#sel-clip").addEventListener("click", async () => {
  const s = timeline.sel, cams = scopeCams();
  if (!s || !cams.length) return;
  const names = cams.map((n) => camByName(n).friendly_name);
  try {
    const ids = await call("start_exports", { req: {
      cameras: cams, start: Math.floor(s.a), end: Math.ceil(s.b), realtime: true, speed: 1, fps: 30,
      keyframes_only: false, small: prefs.smallShare, out_dir: prefs.outDir, delete_after: prefs.deleteAfter,
    } });
    const label = names.length > 1 ? `${names.length} cameras` : names[0];
    const byCam = new Map(cams.map((n, i) => [n, names[i]]));
    addBatch(`Clip · ${label} · ${fmtTime(s.a)} → ${fmtClock(s.b)}`, ids.map((id, i) => [id, byCam.get(cams[i]) || names[i] || "?"]));
    toast(names.length > 1 ? `Saving ${names.length} clips. Progress is on the Timelapse tab.` : "Saving the clip. Progress is on the Timelapse tab.");
    clearSelection();
  } catch (e) { toast(errText(e), true); }
});
$("#sel-tl").addEventListener("click", () => {
  const s = timeline.sel, cams = scopeCams();
  if (!s || !cams.length) return;
  prefs.selected = cams;
  prefs.mode = "timelapse";
  savePrefs();
  $("#t-start").value = toLocalInput(new Date(s.a * 1000));
  $("#t-end").value = toLocalInput(new Date(s.b * 1000));
  setupExportsForm();
  clearSelection();
  showView("exports");
});

// ── transport: live, play/pause, nudge, speed ──
$("#pb-live").addEventListener("click", goLive);
$("#pb-play").addEventListener("click", togglePlay);
function togglePlay() {
  let paused;
  if (recMode()) { if (pb.paused) pb.play(); else pb.pause(); paused = pb.paused; }
  else if (state.focus) { if (focusVideo.paused) focusVideo.play().catch(() => {}); else focusVideo.pause(); paused = focusVideo.paused; }
  else return;
  $("#pb-play").textContent = paused ? "▶" : "❚❚";
}
const nudge = (d) => {
  if (!state.focus && !state.tiles.size) return;
  if (!recMode()) { if (d < 0) playAt(Date.now() / 1000 + d - 2); return; }
  const wt = pb.t;
  if (wt) seekTo(wt + d);
};
$("#pb-back").addEventListener("click", () => nudge(-10));
$("#pb-fwd").addEventListener("click", () => nudge(10));

// Speed slider: 1× in the middle, faster to the right, reverse to the left.
const speedInput = $("#pb-speed");
const playSpeed = () => SPEEDS[+speedInput.value] ?? 1;
function setSpeed(idx) {
  idx = Math.max(0, Math.min(SPEEDS.length - 1, idx));
  speedInput.value = idx;
  const r = SPEEDS[idx];
  $("#pb-speed-val").textContent = r < 0 ? `−${-r}×` : `${r}×`;
  $("#pb-rate").classList.toggle("rev", r < 0);
  pb.setRate(r);
  if (state.focus?.mode === "rec") $("#focus-mode").textContent = r < 0 ? "Recording · reverse" : "Recording";
}
speedInput.addEventListener("input", () => setSpeed(+speedInput.value));
speedInput.addEventListener("dblclick", () => setSpeed(SPEEDS.indexOf(1)));
// From live, stepping the speed left starts playing backwards from now.
function stepSpeed(dir) {
  setSpeed(+speedInput.value + dir);
  if (!recMode() && playSpeed() < 0) playAt(Date.now() / 1000 - 3);
}

$("#pb-date").addEventListener("change", (e) => {
  const v = e.target.value;
  if (!v) return;
  const [y, m, d] = v.split("-").map(Number);
  const start = new Date(y, m - 1, d).getTime() / 1000;
  const end = new Date(y, m - 1, d + 1).getTime() / 1000; // DST-safe "next midnight"
  timeline.follow = true;
  timeline.setView(start, end);
  playAt(start);
});
document.addEventListener("keydown", (e) => {
  if (!state.info || state.view !== "live" || !timeline || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && document.activeElement !== speedInput) return;
  if ($("dialog[open]")) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.shiftKey && ptzKeys[e.key] && ptz.info && state.focus?.mode === "live") return; // PTZ, handled below
  if (k === " " || k === "k") { e.preventDefault(); togglePlay(); }
  else if (k === "ArrowLeft") { e.preventDefault(); nudge(-10); }
  else if (k === "ArrowRight") { e.preventDefault(); nudge(10); }
  else if (k === "j") stepSpeed(-1);
  else if (k === "l") stepSpeed(1);
  else if (k === "[") jumpEvent(-1);
  else if (k === "]") jumpEvent(1);
  else if (k === "+" || k === "=") timeline.zoomBy(0.5);
  else if (k === "-") timeline.zoomBy(2);
  else if (k === "Escape" && (timeline.sel || timeline.selectMode)) { e.stopImmediatePropagation(); clearSelection(); }
  else if (k === "Escape" && !state.focus && state.gridRec) { e.stopImmediatePropagation(); goLive(); }
}, true);

// ── camera switches (detect / record / snapshots) ──
const SWITCHES = [["detect", "Detect"], ["recordings", "Record"], ["snapshots", "Snapshots"]];
async function setSwitch(camName, feature, on) {
  const cam = camByName(camName);
  const before = cam[feature];
  cam[feature] = on;
  renderFocusToggles(); renderCameraSwitches();
  try { await call("camera_toggle", { camera: camName, feature, on }); }
  catch (e) {
    cam[feature] = before;
    renderFocusToggles(); renderCameraSwitches();
    toast(errText(e), true);
  }
}
function switchButton(cam, feature, label, compact = false) {
  const on = !!cam[feature];
  return h("button", {
    "aria-label": `${label} for ${cam.friendly_name}`,
    class: "switch" + (on ? " on" : ""), disabled: !isAdmin(),
    title: isAdmin() ? `${label} is ${on ? "on" : "off"}. Click to turn ${on ? "off" : "on"} (until Frigate restarts).` : "Needs an admin account",
    onclick: (e) => { e.stopPropagation(); setSwitch(cam.name, feature, !on); },
  }, h("i"), compact ? (on ? "On" : "Off") : label);
}
function renderFocusToggles() {
  const box = $("#focus-toggles");
  const cam = state.focus && camByName(state.focus.cam);
  box.replaceChildren(...(cam ? SWITCHES.map(([f, l]) => switchButton(cam, f, l)) : []));
}
function renderCameraSwitches() {
  const box = $("#cam-switches");
  if (!state.info) return;
  box.replaceChildren(h("table", { class: "cams switches" },
    h("thead", {}, h("tr", {}, h("th", {}, "Camera"), SWITCHES.map(([, l]) => h("th", {}, l)))),
    h("tbody", {}, state.info.cameras.map((cam) =>
      h("tr", {}, h("td", {}, cam.friendly_name), SWITCHES.map(([f, l]) => h("td", {}, switchButton(cam, f, l, true))))))));
  if (!isAdmin()) box.append(h("p", { class: "muted small" }, "Changing these needs an admin account."));
}

function fallbackSnapshots(focus, why) {
  stopLive(focus);
  const img = $("#focus-img"), msg = $("#focus-msg"), badge = $("#focus-mode");
  focusVideo.hidden = true; img.hidden = false;
  badge.className = "badge warn"; badge.textContent = "Snapshots · 1 fps";
  msg.textContent = why; msg.hidden = false;
  const tick = () => {
    if (document.hidden) return;
    const next = new Image();
    next.onload = () => (img.src = next.src);
    next.src = media(`/api/${encodeURIComponent(focus.cam)}/latest.jpg?h=1080&t=${Date.now()}`);
  };
  tick();
  focus.timer = setInterval(tick, 1000);
}

function closeFocus(silent) {
  const f = state.focus;
  if (!f) return;
  const resume = f.mode === "rec" && pb.active ? pb.t : null;
  // Going back to a live grid: hand this connection back to the tile if it
  // shows the same stream.
  let giveBack = null;
  const cam = camByName(f.cam), tile = state.tiles.get(f.cam);
  if (!silent && f.mode === "live" && f.rtc?.kind === "webrtc" && tile && prefs.gridLive && f.rtc.stream === gridStream(cam)) {
    giveBack = f.rtc; f.rtc = null;
  }
  stopLive(f);
  pb.close(); pb.key = null;
  clearSelection();
  $("#ev-card").hidden = true;
  ptzStop(); ptz.info = null; ptz.cam = null; $("#ptz").hidden = true;
  state.focus = null;
  focusVideo.srcObject = null;
  $("#focus").hidden = true;
  $("#view-live").classList.remove("in-focus");
  $("#grid").hidden = false;
  if (silent) return;
  // Back to the grid: keep watching the same moment on every camera.
  rescope();
  setPlaybackUi();
  if (giveBack) {
    if (tile.rtc) giveBack.close(); // the tile kept its own connection
    else { giveBack.moveTo(tile.video); attachTileRtc(tile, giveBack); }
  }
  if (resume) playAt(resume); else startGrid();
}

$("#focus-back").addEventListener("click", () => {
  closeFocus(false);
  if (history.state?.focus) history.back(); // drop the entry openFocus added
});
window.addEventListener("popstate", () => { if (state.focus) closeFocus(false); });
$("#focus-mute").addEventListener("click", (e) => {
  focusVideo.muted = !focusVideo.muted;
  e.currentTarget.textContent = focusVideo.muted ? "🔇 Muted" : "🔊 Sound on";
});
$("#focus-full").addEventListener("click", toggleFullscreen);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("dialog[open]")) return;
  if (document.body.classList.contains("theater")) toggleFullscreen();
  else if (state.focus) closeFocus(false);
});

async function toggleFullscreen() {
  const on = !document.body.classList.contains("theater");
  document.body.classList.toggle("theater", on);
  try { await appWindow().setFullscreen(on); } catch (_) {}
}

// ══ Exports & timelapses ════════════════════════════════════════════
const MIN_SPEED = 2, MAX_SPEED = 3600;
const speedToSlider = (s) => Math.round(1000 * Math.log(s / MIN_SPEED) / Math.log(MAX_SPEED / MIN_SPEED));
const sliderToSpeed = (v) => {
  const s = MIN_SPEED * Math.pow(MAX_SPEED / MIN_SPEED, v / 1000);
  return s < 20 ? Math.round(s) : s < 200 ? Math.round(s / 5) * 5 : Math.round(s / 10) * 10;
};

const pad = (n) => String(n).padStart(2, "0");
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fromLocalInput = (s) => { const d = new Date(String(s).trim().replace(" ", "T")); return isNaN(d) ? null : d; };

function human(secs) {
  secs = Math.round(secs);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${pad(secs % 60)}s`;
  if (secs < 86400 * 2) return `${Math.floor(secs / 3600)}h ${pad(Math.floor(secs % 3600 / 60))}m`;
  return `${Math.round(secs / 86400)} days`;
}

function setRangeHours(hours) {
  const end = new Date(); end.setSeconds(0, 0);
  $("#t-end").value = toLocalInput(end);
  $("#t-start").value = toLocalInput(new Date(end - hours * 3600e3));
  updateEstimate();
}
function setDay(daysAgo) {
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - daysAgo);
  const end = daysAgo === 0 ? new Date() : new Date(start.getTime() + 86400e3);
  $("#t-start").value = toLocalInput(start);
  $("#t-end").value = toLocalInput(end);
  updateEstimate();
}

// Speeds of 60× and up have plenty of keyframes (cameras send one every
// 1–2 s), so decoding only those looks the same and renders far faster.
const FAST_OK_SPEED = 60;

prefs.lenMode ??= "length";
prefs.targetLen ??= 60;
prefs.render ??= "fast";

function setupExportsForm() {
  const chips = $("#cam-chips");
  const known = new Set(state.info.cameras.map((c) => c.name));
  prefs.selected = prefs.selected.filter((n) => known.has(n));
  chips.replaceChildren(...state.info.cameras.map((c) => {
    const chip = h("button", { class: "chip" + (prefs.selected.includes(c.name) ? " on" : ""), type: "button" }, c.friendly_name);
    chip.dataset.name = c.name;
    chip.addEventListener("click", () => {
      chip.classList.toggle("on");
      prefs.selected = $$(".chip.on", chips).map((el) => el.dataset.name);
      savePrefs(); updateEstimate();
    });
    return chip;
  }));
  if (!$("#t-start").value) setRangeHours(24);
  $("#speed").value = speedToSlider(prefs.speed);
  $("#fps").value = prefs.fps;
  $("#out-dir").value = prefs.outDir;
  $("#delete-after").checked = prefs.deleteAfter;
  $("#small-share").checked = prefs.smallShare;
  setMode(prefs.mode);
}

const segPick = (sel, attr, val) => $$(`${sel} button`).forEach((b) => b.classList.toggle("on", b.dataset[attr] === String(val)));

$("#cam-all").addEventListener("click", () => { $$("#cam-chips .chip").forEach((c) => c.classList.add("on")); prefs.selected = state.info.cameras.map((c) => c.name); savePrefs(); updateEstimate(); });
$("#cam-none").addEventListener("click", () => { $$("#cam-chips .chip").forEach((c) => c.classList.remove("on")); prefs.selected = []; savePrefs(); updateEstimate(); });
$$("#presets button").forEach((b) => b.addEventListener("click", () => (b.dataset.h ? setRangeHours(+b.dataset.h) : setDay(+b.dataset.day))));
["#t-start", "#t-end"].forEach((s) => $(s).addEventListener("input", updateEstimate));
$$("#mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$$("#len-mode button").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.lm === "speed") { prefs.speed = currentSpeed() || prefs.speed; $("#speed").value = speedToSlider(prefs.speed); }
  prefs.lenMode = b.dataset.lm; savePrefs(); updateEstimate();
}));
$$("#len-presets button").forEach((b) => b.addEventListener("click", () => { prefs.targetLen = +b.dataset.len; savePrefs(); updateEstimate(); }));
$("#speed").addEventListener("input", () => { prefs.speed = sliderToSpeed(+$("#speed").value); savePrefs(); updateEstimate(); });
$$("#speed-presets button").forEach((b) => b.addEventListener("click", () => { prefs.speed = +b.dataset.s; $("#speed").value = speedToSlider(prefs.speed); savePrefs(); updateEstimate(); }));
$$("#render button").forEach((b) => b.addEventListener("click", () => { prefs.render = b.dataset.r; savePrefs(); updateEstimate(); }));
$("#fps").addEventListener("change", () => { prefs.fps = Math.min(60, Math.max(10, +$("#fps").value || 30)); $("#fps").value = prefs.fps; savePrefs(); });
$("#out-dir").addEventListener("change", () => { prefs.outDir = $("#out-dir").value.trim(); savePrefs(); });
$("#delete-after").addEventListener("change", (e) => { prefs.deleteAfter = e.target.checked; savePrefs(); });
$("#small-share").addEventListener("change", (e) => { prefs.smallShare = e.target.checked; savePrefs(); });
$("#open-out").addEventListener("click", () => invoke("open_path", { path: $("#out-dir").value.trim(), reveal: false }).catch((e) => toast(errText(e), true)));

function setMode(mode) {
  prefs.mode = mode; savePrefs();
  segPick("#mode", "mode", mode);
  $("#tl-opts").hidden = mode !== "timelapse";
  updateEstimate();
}

function rangeSecs() {
  const a = fromLocalInput($("#t-start").value), b = fromLocalInput($("#t-end").value);
  return a && b && b > a ? { a, b, span: (b - a) / 1000 } : null;
}

// The speed actually sent to Frigate.
function currentSpeed() {
  const r = rangeSecs();
  if (prefs.lenMode === "speed" || !r) return prefs.speed;
  return Math.max(MIN_SPEED, Math.round(r.span / prefs.targetLen));
}

function updateEstimate() {
  const r = rangeSecs(), n = prefs.selected.length, tl = prefs.mode === "timelapse";
  const go = $("#go"), est = $("#estimate");
  segPick("#len-mode", "lm", prefs.lenMode);
  segPick("#len-presets", "len", prefs.targetLen);
  segPick("#render", "r", prefs.render);
  $("#len-presets").hidden = prefs.lenMode !== "length";
  $("#speed-box").hidden = prefs.lenMode !== "speed";
  $("#speed-out").textContent = `${prefs.speed}×`;
  $$("#speed-presets button").forEach((b) => b.classList.toggle("on", +b.dataset.s === prefs.speed));
  $("#span-out").textContent = r ? human(r.span) : "";

  const speed = currentSpeed();
  const hint = $("#render-hint");
  if (prefs.render === "fast" && speed < FAST_OK_SPEED) {
    hint.className = "hint-line warn";
    hint.textContent = `At ${speed}× motion can look jumpy with keyframes only. Smooth is better for slow speeds.`;
  } else if (prefs.render === "fast") {
    hint.className = "hint-line";
    hint.textContent = "Reads only keyframes. Usually many times quicker, and looks the same at this speed.";
  } else {
    hint.className = "hint-line";
    hint.textContent = "Decodes every frame. Best for slow speeds; long ranges take a while.";
  }

  go.textContent = n === 0 ? "Pick at least one camera"
    : `Create ${n > 1 ? n + " " : ""}${tl ? "timelapse" : "clip"}${n > 1 ? "s" : ""}`;
  if (!r) {
    est.replaceChildren(h("span", { class: "error" }, "Pick a start and end time (end after start)."));
    go.disabled = true;
    return;
  }
  const out = tl ? r.span / speed : r.span;
  est.replaceChildren(
    h("div", { class: "sum-main" }, human(r.span), h("span", { class: "arrow" }, "→"), h("b", {}, human(out))),
    h("div", { class: "sum-sub" }, tl ? `${speed.toLocaleString()}× speed · ${prefs.render === "fast" ? "fast render" : "smooth render"}${n > 1 ? ` · ${n} cameras in parallel` : ""}`
      : `real time · original quality${n > 1 ? ` · ${n} cameras` : ""}`));
  go.disabled = n === 0;
}

$("#go").addEventListener("click", async () => {
  const err = $("#export-error"); err.hidden = true;
  const r = rangeSecs();
  if (!r) return;
  prefs.outDir = $("#out-dir").value.trim(); savePrefs();
  const speed = currentSpeed();
  const req = {
    cameras: prefs.selected, start: Math.floor(r.a / 1000), end: Math.floor(r.b / 1000),
    realtime: prefs.mode === "realtime", speed, fps: prefs.fps,
    keyframes_only: prefs.render === "fast", small: prefs.smallShare,
    out_dir: prefs.outDir, delete_after: prefs.deleteAfter,
  };
  const go = $("#go");
  go.disabled = true;
  try {
    const ids = await call("start_exports", { req });
    const fmt = (d) => d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const title = `${req.realtime ? "Real-time clip" : `${speed.toLocaleString()}× timelapse`} · ${fmt(r.a)} → ${fmt(r.b)}`;
    addBatch(title, ids.map((id, i) => [id, camByName(prefs.selected[i])?.friendly_name || prefs.selected[i]]));
  } catch (e) { err.textContent = errText(e); err.hidden = false; }
  finally { go.disabled = false; updateEstimate(); }
});

// ── progress: one card per batch, one row per camera ──
state.batches = [];
const clock = (secs) => { secs = Math.max(0, Math.round(secs)); return secs < 3600 ? `${Math.floor(secs / 60)}:${pad(secs % 60)}` : `${Math.floor(secs / 3600)}:${pad(Math.floor(secs % 3600 / 60))}:${pad(secs % 60)}`; };

function addBatch(title, rows) {
  const bar = h("i");
  const meta = h("span", { class: "batch-meta" });
  const el = h("div", { class: "batch" },
    h("div", { class: "batch-head" }, h("strong", {}, title), meta),
    h("div", { class: "bar thin" }, bar));
  const batch = { el, bar, meta, jobs: [], started: Date.now() };
  for (const [id, name] of rows) {
    const job = {
      id, batch, state: "running", progress: 0, renderStart: 0, ended: 0,
      el: h("div", { class: "job" },
        h("div", { class: "job-line" }, h("span", { class: "job-title" }, name), h("span", { class: "job-time" })),
        h("div", { class: "bar" }, h("i")),
        h("div", { class: "stage-txt" }, "Sending to Frigate…"),
        h("div", { class: "job-actions", hidden: true })),
    };
    batch.jobs.push(job);
    el.append(job.el);
    state.jobs.set(id, job);
  }
  // replay anything that arrived early
  for (const [id] of rows) {
    const q = state.pendingJobEvents.get(id);
    if (q) { state.pendingJobEvents.delete(id); q.forEach(applyJobEvent); }
  }
  state.batches.push(batch);
  $("#jobs").prepend(el);
  $("#jobs-card").hidden = false;
  tickJobs();
}

// Standalone download from the server list: a one-row batch.
function addJob(id, title) { addBatch(title, [[id, "Download"]]); }

listen("job", ({ payload: j }) => {
  applyJobEvent(j);
  // something waiting for this download (Share on a server export)
  const after = state.afterJob?.get(j.id);
  if (after && (j.state === "done" || j.state === "failed")) { state.afterJob.delete(j.id); after(j); }
});

function applyJobEvent(j) {
  const job = state.jobs.get(j.id);
  if (!job) { // can arrive before addBatch registered the job (fast failures)
    const q = state.pendingJobEvents.get(j.id) || [];
    q.push(j);
    state.pendingJobEvents.set(j.id, q);
    return;
  }
  const el = job.el;
  job.state = j.state;
  job.progress = j.progress;
  if (j.state === "running") {
    if (/Rendering/.test(j.stage) && !job.renderStart) job.renderStart = Date.now();
    job.renderFrac = /Rendering/.test(j.stage) ? Math.min(1, j.progress / 0.8) : job.renderFrac;
    $(".stage-txt", el).textContent = j.stage;
  }
  $(".bar > i", el).style.width = `${Math.round(j.progress * 100)}%`;
  if (j.state === "failed") {
    job.ended = Date.now();
    el.classList.add("failed");
    $(".stage-txt", el).textContent = j.error;
    $(".bar", el).hidden = true;
  }
  if (j.state === "done") {
    job.ended = Date.now();
    el.classList.add("done");
    $(".stage-txt", el).textContent = j.path.split(/[\\/]/).pop();
    $(".stage-txt", el).title = j.path;
    $(".bar", el).hidden = true;
    const acts = $(".job-actions", el);
    acts.replaceChildren(...fileActions(j.path, "Play"));
    acts.hidden = !acts.children.length;
    if (state.view === "exports") refreshExports();
  }
  tickJobs();
}

// Elapsed time and a rough time-left estimate, refreshed every second.
function tickJobs() {
  const now = Date.now();
  let active = false;
  for (const b of state.batches) {
    let sum = 0, open = 0;
    for (const job of b.jobs) {
      sum += job.state === "running" ? job.progress : 1;
      const t = $(".job-time", job.el);
      if (job.state === "running") {
        open++;
        const f = job.renderFrac || 0;
        let txt = clock((now - b.started) / 1000);
        if (job.renderStart && f > 0.03 && f < 1) txt += ` · ~${human((now - job.renderStart) / 1000 * (1 - f) / f)} left`;
        t.textContent = txt;
      } else {
        t.textContent = job.state === "done" ? `done in ${clock((job.ended - b.started) / 1000)}` : "";
      }
    }
    b.bar.style.width = `${Math.round(sum / b.jobs.length * 100)}%`;
    const failed = b.jobs.filter((j) => j.state === "failed").length;
    b.meta.textContent = open ? `${b.jobs.length - open} of ${b.jobs.length} done`
      : failed ? `${failed} failed` : `finished in ${clock((Math.max(...b.jobs.map((j) => j.ended)) - b.started) / 1000)}`;
    b.el.classList.toggle("finished", !open);
    active ||= open > 0;
  }
  clearTimeout(tickJobs._t);
  if (active) tickJobs._t = setTimeout(tickJobs, 1000);
}

$("#jobs-clear").addEventListener("click", () => {
  state.batches = state.batches.filter((b) => {
    if (b.jobs.some((j) => j.state === "running")) return true;
    b.el.remove();
    b.jobs.forEach((j) => state.jobs.delete(j.id));
    return false;
  });
  $("#jobs-card").hidden = state.batches.length === 0;
});

$("#exports-refresh").addEventListener("click", refreshExports);

async function refreshExports() {
  const box = $("#server-exports");
  try {
    const list = await call("list_exports");
    if (!list.length) { box.replaceChildren(h("p", { class: "muted" }, "No exports on the server yet.")); return; }
    box.replaceChildren(...list.map(exportCard));
  } catch (e) { box.replaceChildren(h("p", { class: "error" }, errText(e))); }
}

function exportCard(x) {
  const file = x.video_path.split("/").pop();
  const cam = camByName(x.camera);
  const when = x.date ? new Date(x.date * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const thumb = h("div", { class: "thumb", title: x.in_progress ? "Still rendering" : "Play" },
    h("div", { class: "play" }, x.in_progress ? "…" : "▶"));
  if (x.thumb_path) thumb.style.backgroundImage = `url("${media(x.thumb_path.replace(/^\/media\/frigate/, ""))}")`;
  if (!x.in_progress) thumb.addEventListener("click", () => playExport(x.name || file, "/exports/" + encodeURIComponent(file)));
  const card = h("div", { class: "export" },
    thumb,
    h("div", { class: "meta" }, h("strong", { title: x.name }, x.name || file),
      h("span", {}, [cam?.friendly_name || x.camera, when, x.size ? fmtBytes(x.size) : ""].filter(Boolean).join(" · "))),
    h("div", { class: "acts" },
      x.in_progress ? h("span", { class: "muted" }, "Rendering…") : [
        h("button", { class: "link", onclick: () => downloadExport(x) }, "Download"),
        h("button", { class: "link", title: "Download it if needed, then send it", onclick: (ev) => shareExport(x, ev.currentTarget) }, "Share…"),
        h("button", { class: "link danger", onclick: () => deleteExport(x, card) }, "Delete"),
      ]));
  return card;
}

function playExport(title, path) {
  $("#player-title").textContent = title;
  $("#player-video").src = media(path);
  $("#player").showModal();
}
$("#player-close").addEventListener("click", () => $("#player").close());
$("#player").addEventListener("close", () => { const v = $("#player-video"); v.pause(); v.removeAttribute("src"); v.load(); });

const fmtBytes = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

// Share a clip that's still only on the server: use the copy already
// downloaded if there is one, otherwise download it first; then offer the
// share actions (the share menu has to open from a click, so it's a second click).
async function shareExport(x, btn) {
  const name = x.name || x.video_path.split("/").pop();
  const outDir = $("#out-dir").value.trim() || prefs.outDir;
  const local = await invoke("local_export", { videoPath: x.video_path, outDir, size: x.size ?? null }).catch(() => null);
  if (local) { shareToast(`Ready to share: ${name}`, local); return; }
  btn.disabled = true;
  try {
    const id = await call("download_export", { videoPath: x.video_path, outDir });
    addJob(id, "Download · " + name);
    (state.afterJob ||= new Map()).set(id, (j) => {
      btn.disabled = false;
      if (j.state === "done") shareToast(`Ready to share: ${name}`, j.path);
      else toast(`Couldn't download ${name}: ${j.error}`, true);
    });
    toast(`Downloading ${name} to share it…`);
  } catch (e) { btn.disabled = false; toast(errText(e), true); }
}

async function downloadExport(x) {
  try {
    const id = await call("download_export", { videoPath: x.video_path, outDir: $("#out-dir").value.trim() });
    addJob(id, "Download · " + (x.name || x.video_path.split("/").pop()));
  } catch (e) { toast(errText(e), true); }
}

async function deleteExport(x, card) {
  if (!(await ask(`Delete "${x.name || x.id}" from the Frigate server?`, "Delete", true))) return;
  try { await call("delete_export", { id: x.id }); card.remove(); toast("Deleted from the server."); }
  catch (e) { toast(errText(e), true); }
}

// ══ Settings ════════════════════════════════════════════════════════
async function loadSettings() {
  renderSystem();
  pollStats();
  renderCameraSwitches();
  const admin = state.info.role === "admin";
  $("#config-card").hidden = !admin;
  $("#config-noadmin").hidden = admin;
  $("#role-name").textContent = state.info.role;
  if (admin && !state.cfgOriginal) await reloadConfig();
}

function renderSystem() {
  const s = state.stats, box = $("#system");
  if (!s) { box.replaceChildren(h("p", { class: "muted" }, "Loading…")); return; }
  const svc = s.service || {};
  const stat = (k, v, sub) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v, sub ? h("small", {}, " " + sub) : null));
  const items = [stat("Frigate", svc.version || state.info.version), stat("Uptime", svc.uptime ? human(svc.uptime) : "—")];
  for (const [name, d] of Object.entries(s.detectors || {})) {
    items.push(stat(`Detector · ${name}`, d.inference_speed != null ? d.inference_speed.toFixed(1) : "—", "ms"));
  }
  const storage = svc.storage || {};
  const rec = storage["/media/frigate/recordings"] || Object.values(storage)[0];
  if (rec?.total) items.push(stat("Recordings disk", `${Math.round(rec.used / rec.total * 100)}%`, `of ${(rec.total / 1024 / 1024).toFixed(2)} TB`));
  for (const [name, g] of Object.entries(s.gpu_usages || {})) {
    if (g.gpu) items.push(stat(name.replace(/^nvidia-|^intel-/i, "GPU · "), g.gpu, g.mem ? `mem ${g.mem}` : ""));
  }
  const rows = Object.entries(s.cameras || {}).map(([name, c]) =>
    h("tr", {}, h("td", {}, camByName(name)?.friendly_name || name),
      h("td", {}, (c.camera_fps ?? 0).toFixed(1)), h("td", {}, (c.process_fps ?? 0).toFixed(1)),
      h("td", {}, (c.detection_fps ?? 0).toFixed(1)), h("td", {}, (c.skipped_fps ?? 0).toFixed(1))));
  box.replaceChildren(
    h("div", { class: "sys-grid" }, items),
    h("table", { class: "cams" },
      h("thead", {}, h("tr", {}, ["Camera", "Camera fps", "Process fps", "Detect fps", "Skipped fps"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows)));
}
$("#stats-refresh").addEventListener("click", pollStats);

const cfg = $("#cfg"), gutter = $("#cfg-gutter");
function syncGutter() {
  const n = cfg.value.split("\n").length;
  if (gutter.dataset.n != n) { gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n"); gutter.dataset.n = n; }
  gutter.scrollTop = cfg.scrollTop;
  const dirty = cfg.value !== state.cfgOriginal;
  $("#cfg-state").textContent = dirty ? "Unsaved changes" : "No changes";
}
cfg.addEventListener("input", syncGutter);
cfg.addEventListener("scroll", () => (gutter.scrollTop = cfg.scrollTop));
cfg.addEventListener("keydown", (e) => {
  if (e.key === "Tab") { // indent with two spaces, YAML-style
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b } = cfg;
    cfg.setRangeText("  ", a, b, "end");
    syncGutter();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveConfig(false); }
});

async function reloadConfig() {
  try {
    state.cfgOriginal = await call("config_raw");
    cfg.value = state.cfgOriginal;
    syncGutter();
  } catch (e) { showCfgMsg(errText(e), true); }
}

function showCfgMsg(text, bad) {
  const m = $("#cfg-msg");
  m.textContent = text; m.className = "notice" + (bad ? " bad" : ""); m.hidden = false;
}

async function saveConfig(restart) {
  if (restart && !(await ask("Save the configuration and restart Frigate? Cameras will be offline for about a minute.", "Save & restart"))) return;
  const btns = $$("#cfg-save, #cfg-save-restart");
  btns.forEach((b) => (b.disabled = true));
  try {
    const msg = await call("config_save", { yaml: cfg.value, restart });
    state.cfgOriginal = cfg.value;
    syncGutter();
    showCfgMsg(restart ? "Saved. Frigate is restarting; live view comes back on its own in a minute." : msg || "Saved.", false);
  } catch (e) {
    showCfgMsg(errText(e), true);
  } finally { btns.forEach((b) => (b.disabled = false)); }
}

$("#cfg-save").addEventListener("click", () => saveConfig(false));
$("#cfg-save-restart").addEventListener("click", () => saveConfig(true));
$("#cfg-reload").addEventListener("click", async () => {
  if (cfg.value !== state.cfgOriginal && !(await ask("Discard your unsaved changes?", "Discard", true))) return;
  $("#cfg-msg").hidden = true;
  reloadConfig();
});
$("#restart").addEventListener("click", async () => {
  if (!(await ask("Restart Frigate now? Cameras will be offline for about a minute.", "Restart", true))) return;
  try { await call("restart_frigate"); toast("Frigate is restarting…"); }
  catch (e) { toast(errText(e), true); }
});

// ══ Load: what this app asks of Frigate, now and over time ══════════
// Rust counts every request and byte it moves (API, snapshots, videos, MSE
// live); the web view reports WebRTC bytes. A sampler runs while connected
// (cheap: two local calls every 5 s, plus go2rtc's viewer list once a minute,
// every 10 s while the Load screen is open) and keeps per-minute totals for
// 24 hours in local storage, per server.
const LOAD_KEEP_MS = 24 * 3600e3;
const load = { timer: null, key: null, prev: null, recent: [], minutes: [], cur: null, viewers: null, viewersAt: 0, cpu: null, hours: 1 };

function startLoadRecorder() {
  stopLoadRecorder();
  load.key = "load:" + state.info.base_url;
  try { load.minutes = JSON.parse(localStorage.getItem(load.key) || "[]").filter((m) => m.t > Date.now() - LOAD_KEEP_MS); }
  catch (_) { load.minutes = []; }
  Object.assign(load, { prev: null, recent: [], cur: null, viewers: null, viewersAt: 0 });
  load.timer = setInterval(loadTick, 5000);
  loadTick();
}
function stopLoadRecorder() {
  clearInterval(load.timer); load.timer = null;
  closeMinute();
}
function saveLoad() {
  try { localStorage.setItem(load.key, JSON.stringify(load.minutes)); } catch (_) {}
}
function closeMinute() {
  const c = load.cur;
  if (!c || !load.key) return;
  load.minutes.push({ t: c.t, req: c.req, mb: +c.mb.toFixed(3), streams: c.streams, cpu: c.cpuN ? +(c.cpu / c.cpuN).toFixed(1) : null, viewers: c.viewers });
  const cutoff = Date.now() - LOAD_KEEP_MS;
  while (load.minutes.length && load.minutes[0].t < cutoff) load.minutes.shift();
  load.cur = null;
  saveLoad();
}

async function loadTick() {
  if (!state.info) return;
  const now = Date.now();
  const [m, rtc] = await Promise.all([invoke("app_load"), WebRTC.bytesReceived()]);
  if (now - load.viewersAt > (state.view === "load" ? 10000 : 60000)) {
    load.viewersAt = now;
    load.viewers = await call("go2rtc_viewers").catch(() => null);
  }
  const sample = { t: now, req: m.api_requests + m.media_requests, bytes: m.api_bytes + m.media_bytes + m.live_bytes, rtc, m };
  const streams = m.live_streams + WebRTC.count();
  const cpuRaw = state.stats?.cpu_usages?.["frigate.full_system"]?.cpu;
  const cpu = cpuRaw == null ? null : parseFloat(cpuRaw);
  const viewers = load.viewers ? load.viewers.reduce((a, [, n]) => a + n, 0) : null;
  const p = load.prev;
  if (p) {
    const dReq = Math.max(0, sample.req - p.req);
    // WebRTC totals drop when a connection closes; never count that as negative.
    const dBytes = Math.max(0, sample.bytes - p.bytes) + Math.max(0, rtc - p.rtc);
    const minute = Math.floor(now / 60000) * 60000;
    if (load.cur && load.cur.t !== minute) closeMinute();
    const c = load.cur ??= { t: minute, req: 0, mb: 0, streams: 0, cpu: 0, cpuN: 0, viewers: null };
    c.req += dReq; c.mb += dBytes / 1e6;
    c.streams = Math.max(c.streams, streams);
    if (cpu != null && !isNaN(cpu)) { c.cpu += cpu; c.cpuN++; }
    if (viewers != null) c.viewers = Math.max(c.viewers ?? 0, viewers);
    load.recent.push({ t: now, req: dReq, bytes: dBytes });
    while (load.recent.length && now - load.recent[0].t > 60000) load.recent.shift();
  }
  load.prev = sample;
  if (state.view === "load" && !document.hidden) renderLoadNow(m, streams, cpuRaw), renderTrends();
}

function showLoad() {
  renderLoadNow(load.prev?.m, null, state.stats?.cpu_usages?.["frigate.full_system"]?.cpu);
  renderTrends();
  load.viewersAt = 0; // fresh viewer count now
  loadTick();
  invoke("video_decoding").then(renderDecode).catch(() => {});
}

function renderLoadNow(m, streams, cpu) {
  const box = $("#load");
  if (!m) return;
  const stat = (k, v, sub) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v, sub ? h("small", {}, " " + sub) : null));
  const span = load.recent.length ? (Date.now() - load.recent[0].t + 5000) / 60000 : 0;
  const items = [];
  if (span < 0.15) items.push(stat("Requests to Frigate", "…", "measuring"));
  else {
    const req = load.recent.reduce((a, x) => a + x.req, 0) / span;
    const mbMin = load.recent.reduce((a, x) => a + x.bytes, 0) / span / 1e6;
    items.push(stat("Requests to Frigate", Math.round(req), "per min"));
    items.push(stat("Data from Frigate", mbMin < 10 ? mbMin.toFixed(1) : Math.round(mbMin), `MB/min · ${(mbMin * 8 / 60).toFixed(1)} Mbit/s`));
  }
  const open = streams ?? m.live_streams + WebRTC.count();
  items.push(stat("Live streams open", open, `MSE ${m.live_streams} · WebRTC ${WebRTC.count()}`));
  if (cpu != null) items.push(stat("Server CPU", `${cpu}%`, "whole system"));
  const v = load.viewers;
  if (v) items.push(stat("go2rtc viewers", v.reduce((a, [, n]) => a + n, 0), "all clients"));
  const busy = (v || []).filter(([, n]) => n > 0);
  box.replaceChildren(...[
    h("div", { class: "sys-grid" }, items),
    busy.length ? h("p", { class: "muted small" }, "Watching now: ", busy.map(([s, n]) => `${s} (${n})`).join(", ")) : null,
    h("p", { class: "muted small" }, "Requests and data count only this app. Server CPU and go2rtc viewers include every client (Frigate's web UI, Home Assistant, phones)."),
  ].filter(Boolean));
}

// One small chart per measure (they have different units, so no shared axis).
const TRENDS = [
  { key: "req", title: "Requests to Frigate", unit: "per min", fmt: (v) => Math.round(v) },
  { key: "mb", title: "Data from Frigate", unit: "MB/min", fmt: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) },
  { key: "streams", title: "Live streams open", unit: "", fmt: (v) => Math.round(v), max: true },
  { key: "cpu", title: "Server CPU", unit: "%", fmt: (v) => Math.round(v), ceil: 100 },
  { key: "viewers", title: "go2rtc viewers", unit: "all clients", fmt: (v) => Math.round(v), max: true },
];
$$("#trend-range button").forEach((b) => b.addEventListener("click", () => {
  load.hours = +b.dataset.h;
  $$("#trend-range button").forEach((x) => x.classList.toggle("on", x === b));
  renderTrends();
}));
new ResizeObserver(() => state.view === "load" && renderTrends()).observe($("#trends"));

// Minutes -> buckets (1, 5 or 15 min) of averages (peaks for counts).
function trendSeries(key, useMax, hours) {
  const step = hours <= 1 ? 1 : hours <= 6 ? 5 : 15;
  const end = Date.now(), start = end - hours * 3600e3;
  const buckets = new Map();
  for (const m of load.minutes) {
    if (m.t < start || m[key] == null) continue;
    const b = Math.floor(m.t / (step * 60000)) * step * 60000;
    const e = buckets.get(b) || { t: b, sum: 0, n: 0, max: 0 };
    e.sum += m[key]; e.n++; e.max = Math.max(e.max, m[key]);
    buckets.set(b, e);
  }
  return { step, start, end, pts: [...buckets.values()].sort((p, q) => p.t - q.t).map((e) => ({ t: e.t + step * 30000, v: useMax ? e.max : e.sum / e.n })) };
}

function renderTrends() {
  const box = $("#trends");
  const width = Math.max(240, Math.floor((box.clientWidth - 12) / (box.clientWidth > 760 ? 2 : 1)));
  if (!load.minutes.length) {
    box.replaceChildren(h("p", { class: "muted" }, "Collecting… the first point appears after a minute. History builds up while the app is open."));
    return;
  }
  box.replaceChildren(...TRENDS.map((d) => trendChart(d, trendSeries(d.key, d.max, load.hours), width)));
}

function trendChart(d, { step, start, end, pts }, W) {
  const H = 132, L = 36, R = 10, T = 10, B = 22;
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const peak = pts.reduce((a, p) => Math.max(a, p.v), 0);
  const nice = (v) => { if (v <= 1) return 1; const e = 10 ** Math.floor(Math.log10(v)); return [1, 2, 2.5, 5, 10].map((m) => m * e).find((m) => m >= v); };
  const top = d.ceil && peak > d.ceil * 0.5 ? d.ceil : nice(peak * 1.1);
  const x = (t) => L + (t - start) / (end - start) * (W - L - R);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "trend-svg", role: "img", "aria-label": `${d.title}, last ${load.hours} h` });
  const ticks = [0, top / 2, top].filter((v, i, a) => (!d.max || Number.isInteger(v)) && (i === 0 || d.fmt(v) !== d.fmt(a[i - 1])));
  for (const v of ticks) {
    svg.append(el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v ? "grid" : "base" }));
    const lab = el("text", { x: L - 6, y: y(v) + 4, class: "ax", "text-anchor": "end" }); lab.textContent = d.fmt(v); svg.append(lab);
  }
  const fmtT = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  [[start, "start"], [(start + end) / 2, "middle"], [end, "end"]].forEach(([t, anchor]) => {
    const lab = el("text", { x: x(t), y: H - 6, class: "ax", "text-anchor": anchor }); lab.textContent = t === end ? "now" : fmtT(t); svg.append(lab);
  });
  // Runs of consecutive buckets; a gap (app closed) breaks the line.
  const runs = [];
  for (const p of pts) {
    const last = runs[runs.length - 1];
    if (last && p.t - last[last.length - 1].t <= step * 60000 * 1.5) last.push(p); else runs.push([p]);
  }
  for (const r of runs) {
    const line = r.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    if (r.length > 1) svg.append(el("path", { d: `${line}L${x(r[r.length - 1].t).toFixed(1)},${y(0)}L${x(r[0].t).toFixed(1)},${y(0)}Z`, class: "area" }));
    svg.append(el("path", { d: line, class: "line" }));
    if (r.length === 1) svg.append(el("circle", { cx: x(r[0].t), cy: y(r[0].v), r: 3, class: "dot" }));
  }
  const cross = el("line", { y1: T, y2: H - B, class: "cross", visibility: "hidden" });
  const mark = el("circle", { r: 4, class: "dot hover", visibility: "hidden" });
  svg.append(cross, mark);
  const tip = h("div", { class: "trend-tip", hidden: true });
  svg.addEventListener("pointermove", (e) => {
    if (!pts.length) return;
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left;
    const p = pts.reduce((b, q) => (Math.abs(x(q.t) - mx) < Math.abs(x(b.t) - mx) ? q : b));
    cross.setAttribute("x1", x(p.t)); cross.setAttribute("x2", x(p.t)); cross.setAttribute("visibility", "visible");
    mark.setAttribute("cx", x(p.t)); mark.setAttribute("cy", y(p.v)); mark.setAttribute("visibility", "visible");
    const span = step > 1 ? ` (${step}-min ${d.max ? "peak" : "average"})` : "";
    tip.textContent = `${fmtT(p.t)}${span} · ${d.fmt(p.v)} ${d.unit}`.trim();
    tip.hidden = false;
    tip.style.left = `${Math.min(W - 170, Math.max(0, x(p.t) - 80))}px`;
  });
  svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); mark.setAttribute("visibility", "hidden"); tip.hidden = true; });
  const latest = pts.length ? pts[pts.length - 1].v : null;
  return h("figure", { class: "trend" },
    h("figcaption", {}, h("span", {}, d.title, d.unit ? h("small", {}, " " + d.unit) : null),
      h("span", { class: "muted small" }, latest == null ? "no data" : `now ${d.fmt(latest)} · peak ${d.fmt(peak)}`)),
    h("div", { class: "trend-plot" }, svg, tip));
}

function renderDecode(dec) {
  const label = dec.hardware === true ? "Hardware" : dec.hardware === false ? "Software" : "Unknown";
  $("#decode").replaceChildren(
    h("div", { class: "sys-grid" }, h("div", { class: "stat" }, h("div", { class: "k" }, "Video decoding"),
      h("div", { class: "v" }, label, h("small", {}, " " + dec.detail)))),
    dec.hint ? h("p", { class: "small decode-hint" }, dec.hint) : null,
  );
}

// ══ Notifications ═══════════════════════════════════════════════════
// Frigate's /ws socket is watched from the Rust side (one connection, no
// MQTT broker needed); new alerts become native notifications.
prefs.notify = Object.assign({ enabled: false, detections: false, cameras: [], cooldown: 60, images: "person" }, prefs.notify);

function applyNotify() {
  savePrefs();
  $(".notify").classList.toggle("off", !prefs.notify.enabled);
  return call("set_notifications", { settings: prefs.notify }).catch((e) => toast(errText(e), true));
}

function setupNotifications() {
  const n = prefs.notify;
  const known = new Set(state.info.cameras.map((c) => c.name));
  n.cameras = n.cameras.filter((c) => known.has(c));
  $("#n-enabled").checked = n.enabled;
  $("#n-detections").checked = n.detections;
  $("#n-cooldown").value = String(n.cooldown);
  $("#n-images").value = n.images;
  if ($("#n-cooldown").value !== String(n.cooldown)) { n.cooldown = 60; $("#n-cooldown").value = "60"; }
  const box = $("#n-cams");
  box.replaceChildren(...state.info.cameras.map((c) => {
    const chip = h("button", { class: "chip" + (n.cameras.includes(c.name) ? " on" : ""), type: "button" }, c.friendly_name);
    chip.dataset.name = c.name;
    chip.addEventListener("click", () => {
      chip.classList.toggle("on");
      n.cameras = $$(".chip.on", box).map((el) => el.dataset.name);
      applyNotify();
    });
    return chip;
  }));
  applyNotify(); // also starts the watcher that keeps open timelines current
}
$("#n-enabled").addEventListener("change", (e) => { prefs.notify.enabled = e.target.checked; applyNotify(); });
$("#n-detections").addEventListener("change", (e) => { prefs.notify.detections = e.target.checked; applyNotify(); });
$("#n-images").addEventListener("change", (e) => { prefs.notify.images = e.target.value; applyNotify(); });
$("#n-cooldown").addEventListener("change", (e) => { prefs.notify.cooldown = +e.target.value; applyNotify(); });
$("#n-all").addEventListener("click", () => { $$("#n-cams .chip").forEach((c) => c.classList.add("on")); prefs.notify.cameras = state.info.cameras.map((c) => c.name); applyNotify(); });
$("#n-none").addEventListener("click", () => { $$("#n-cams .chip").forEach((c) => c.classList.remove("on")); prefs.notify.cameras = []; applyNotify(); });
$("#n-test").addEventListener("click", () => call("test_notification").then(() => toast("Sent. If nothing appeared, check your system's notification settings for this app.")).catch((e) => toast(errText(e), true)));

// ══ About / version ═════════════════════════════════════════════════
let appInfo = null;
const versionLine = (i) => `${i.name} ${i.version}${i.commit ? ` (${i.commit})` : ""}`;
Platform.info.then((i) => {
  appInfo = i;
  document.body.classList.toggle("mac", i.os === "macos"); // traffic lights (iPadOS also says "Mac" in the user agent)
  $("#login-ver").textContent = versionLine(i);
  document.title = i.name;
  $$(".app-name").forEach((el) => (el.textContent = i.name)); // one place to rename the app: about.rs
}).catch(() => {});

$("#menu-about").addEventListener("click", () => {
  closeMenu();
  if (!appInfo) return;
  const i = appInfo;
  const rows = [
    ["Version", i.version + (i.debug ? " (debug build)" : "")],
    ["Commit", i.commit || "—"],
    ["Built", i.built],
    ["Platform", `${i.os} ${i.arch}`],
    ["Tauri", i.tauri],
    ["Web view", navigator.userAgent.match(/(Edg|Chrome|Version|AppleWebKit)\/[\d.]+/g)?.join(" ") || "—"],
  ];
  if (state.info) rows.push(["Frigate", `${state.info.version} · ${state.info.base_url}`]);
  $("#about-name").textContent = i.name;
  $("#about-kv").replaceChildren(...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  $("#about").showModal();
});
$("#about-copy").addEventListener("click", async () => {
  const text = $$("#about-kv dt").map((dt) => `${dt.textContent}: ${dt.nextElementSibling.textContent}`).join("\n");
  try { await navigator.clipboard.writeText(`${appInfo.name}\n${text}`); toast("Copied."); }
  catch (_) { toast("Couldn't reach the clipboard; select the text instead.", true); }
});
window.addEventListener("beforeunload", () => closeMinute());

// ══ PTZ (pan / tilt / zoom) ═════════════════════════════════════════
// For cameras Frigate controls over ONVIF. Hold an arrow (button, or
// Shift+arrow key) to move, release to stop; presets jump; double-click the
// picture to centre the camera there (when the camera supports it). Only
// while watching live: moving the camera means nothing for a recording.
const ptz = { cam: null, info: null, moving: null };
const ptzKeys = { ArrowUp: "MOVE_UP", ArrowDown: "MOVE_DOWN", ArrowLeft: "MOVE_LEFT", ArrowRight: "MOVE_RIGHT", "+": "ZOOM_IN", "=": "ZOOM_IN", "_": "ZOOM_OUT", "-": "ZOOM_OUT" };

async function setupPtz() {
  const f = state.focus;
  ptzStop();
  ptz.info = null; ptz.cam = f?.cam ?? null;
  $("#ptz").hidden = true;
  if (!f) return;
  let info;
  try { info = await call("ptz_info", { camera: f.cam }); } catch (_) { return; }
  if (state.focus !== f || !(info.pan_tilt || info.zoom)) return;
  ptz.info = info;
  $("#ptz-pad").hidden = !info.pan_tilt;
  $("#ptz-zoom").hidden = !info.zoom;
  const sel = $("#ptz-preset");
  sel.replaceChildren(h("option", { value: "" }, "Presets"), ...info.presets.map((p) => h("option", { value: p }, p)));
  sel.hidden = !info.presets.length;
  $("#stage").title = info.click_to_move ? "Double-click to point the camera here" : "";
  updatePtz();
}
function updatePtz() {
  const on = !!(ptz.info && state.focus?.mode === "live");
  if (!on) ptzStop();
  $("#ptz").hidden = !on;
}
function ptzSend(command) {
  if (!ptz.cam) return;
  invoke("ptz", { camera: ptz.cam, command }).catch((e) => toast(errText(e), true));
}
function ptzStart(command) {
  if (ptz.moving === command) return;
  ptz.moving = command;
  ptzSend(command);
}
function ptzStop() {
  if (!ptz.moving) return;
  ptz.moving = null;
  ptzSend("STOP");
}
for (const b of $$("#ptz [data-ptz]")) {
  b.addEventListener("pointerdown", (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); ptzStart(b.dataset.ptz); });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(ev, ptzStop);
  b.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); ptzStart(b.dataset.ptz); } });
  b.addEventListener("keyup", (e) => { if (e.key === "Enter" || e.key === " ") ptzStop(); });
}
document.addEventListener("keydown", (e) => {
  if (!e.shiftKey || !ptzKeys[e.key] || !ptz.info || state.focus?.mode !== "live" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || $("dialog[open]")) return;
  e.preventDefault();
  if (!e.repeat) ptzStart(ptzKeys[e.key]);
});
document.addEventListener("keyup", (e) => { if (ptz.moving && (ptzKeys[e.key] || e.key === "Shift")) ptzStop(); });
window.addEventListener("blur", ptzStop);
document.addEventListener("visibilitychange", () => { if (document.hidden) ptzStop(); });
$("#ptz-preset").addEventListener("change", (e) => {
  if (e.target.value) ptzSend("preset_" + e.target.value);
  e.target.value = "";
});
// Double-click: centre the camera on that spot (pan right / tilt up positive).
$("#stage").addEventListener("dblclick", (e) => {
  if (!ptz.info?.click_to_move || state.focus?.mode !== "live" || e.target.closest(".ptz")) return;
  const el = focusVideo.hidden ? $("#focus-img") : focusVideo;
  const r = el.getBoundingClientRect();
  // the picture is letterboxed inside the element (object-fit: contain)
  const iw = el.videoWidth || el.naturalWidth || r.width, ih = el.videoHeight || el.naturalHeight || r.height;
  const s = Math.min(r.width / iw, r.height / ih), w = iw * s, hgt = ih * s;
  const nx = (e.clientX - (r.left + (r.width - w) / 2)) / w, ny = (e.clientY - (r.top + (r.height - hgt) / 2)) / hgt;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
  const c = (v) => Math.max(-1, Math.min(1, v)).toFixed(3);
  ptzSend(`MOVE_RELATIVE_${c((nx - 0.5) * 2)}_${c((0.5 - ny) * 2)}`);
});

// ══ Sharing ═════════════════════════════════════════════════════════
// Finished clips, timelapses and snapshots: the system share menu (macOS,
// Windows), Copy (paste the file into a chat or an email), open, show in folder.
async function shareFile(path, btn) {
  const r = btn.getBoundingClientRect();
  try { await invoke("share_files", { paths: [path], anchor: { x: r.left, y: r.top, w: r.width, h: r.height } }); }
  catch (e) { toast(errText(e), true); }
}
async function copyFile(path) {
  try { await invoke("copy_files", { paths: [path] }); toast("Copied. Paste it into a chat or an email."); }
  catch (e) { toast(errText(e), true, 7000); }
}
function fileActions(path, openLabel = "Open") {
  const b = (label, fn, title) => {
    const el = h("button", { class: "link", title: title || "" }, label);
    el.addEventListener("click", () => fn(el));
    return el;
  };
  return [
    Platform.has("share_sheet") && b("Share…", (el) => shareFile(path, el), "Send with Mail, Messages, AirDrop, WhatsApp…"),
    Platform.has("copy_files") && b("Copy", () => copyFile(path), "Copy the file, then paste it into a chat or an email"),
    Platform.has("open_files") && b(openLabel, () => invoke("open_path", { path, reveal: false }).catch((e) => toast(errText(e), true))),
    Platform.has("open_files") && b("Show in folder", () => invoke("open_path", { path, reveal: true }).catch((e) => toast(errText(e), true))),
  ].filter(Boolean);
}
// A toast that stays until dismissed, with the file's actions.
function shareToast(text, path) {
  $("#share-toast-text").textContent = text;
  $("#share-toast-acts").replaceChildren(...fileActions(path));
  $("#share-toast").hidden = false;
  clearTimeout(shareToast._t);
  shareToast._t = setTimeout(() => { $("#share-toast").hidden = true; }, 20000);
}
$("#share-toast-close").addEventListener("click", () => { $("#share-toast").hidden = true; });

$("#focus-snap").addEventListener("click", async () => {
  const f = state.focus;
  if (!f) return;
  const btn = $("#focus-snap");
  btn.disabled = true;
  try {
    if (!prefs.outDir) { prefs.outDir = await invoke("default_output_dir"); savePrefs(); }
    const at = f.mode === "rec" ? playheadTime() : null;
    const path = await call("save_snapshot", { camera: f.cam, at, outDir: prefs.outDir });
    shareToast(`Saved ${path.split(/[\\/]/).pop()}`, path);
  } catch (e) { toast(errText(e), true); }
  finally { btn.disabled = false; }
});

// ══ Appearance (themes) ═════════════════════════════════════════════
// theme.js applies the saved theme before the page draws; this is just the
// Settings card. Custom colours preview live as you pick them.
function renderThemeUi() {
  const id = Theme.current();
  $("#t-theme").value = id;
  $("#t-custom").hidden = id !== "custom";
  if (id !== "custom") return;
  const t = Theme.custom();
  $("#t-base").value = t.base;
  const r = Theme.resolved(t);
  for (const k of Theme.keys) $(`#t-${k}`).value = r[k];
  const low = Math.min(Theme.contrast(r.text, r.bg), Theme.contrast(r.text, r.panel));
  $("#t-contrast").hidden = low >= 4.5;
  $("#t-contrast").textContent = "Text may be hard to read on this background. Try a lighter or darker text colour.";
}
$("#t-theme").addEventListener("change", (e) => {
  const id = e.target.value;
  if (id === "custom" && !localStorage.getItem("customTheme")) {
    // start the custom theme from whatever is on screen now
    Theme.saveCustom({ base: document.documentElement.dataset.theme || "dark", name: "Custom" });
  } else Theme.set(id);
  renderThemeUi();
});
$("#t-base").addEventListener("change", (e) => { Theme.saveCustom({ ...Theme.custom(), base: e.target.value }); renderThemeUi(); });
for (const k of Theme.keys) {
  $(`#t-${k}`).addEventListener("input", (e) => {
    Theme.saveCustom({ ...Theme.custom(), [k]: e.target.value });
    const r = Theme.resolved(Theme.custom());
    $("#t-contrast").hidden = Math.min(Theme.contrast(r.text, r.bg), Theme.contrast(r.text, r.panel)) >= 4.5;
  });
}
$("#t-reset").addEventListener("click", () => {
  const t = Theme.custom();
  Theme.saveCustom({ base: t.base, name: t.name });
  renderThemeUi();
});
$("#t-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(Theme.exportCustom()); toast("Theme copied. Anyone can paste it in Settings → Appearance."); }
  catch (_) { toast("Couldn't reach the clipboard.", true); }
});
$("#t-paste-open").addEventListener("click", () => {
  const open = $("#t-paste").hidden;
  $("#t-paste").hidden = !open;
  $("#t-paste-open").setAttribute("aria-expanded", String(open));
  $("#t-paste-err").textContent = "";
  if (open) $("#t-paste-text").focus();
});
$("#t-paste-apply").addEventListener("click", () => {
  try {
    const t = Theme.importCustom($("#t-paste-text").value);
    $("#t-paste").hidden = true;
    $("#t-paste-text").value = "";
    renderThemeUi();
    toast(`Using “${t.name}”.`);
  } catch (e) { $("#t-paste-err").textContent = e.message; }
});
renderThemeUi();

// ══ Updates (desktop) ═══════════════════════════════════════════════
// Releases on GitHub carry a signed latest.json; the backend checks it and
// verifies the download's signature before installing. With automatic checks
// on, the app asks GitHub at most once every 20 hours: shortly after start,
// and again while it stays open (an hourly look at the clock, no network
// unless a check is due, and never while the window is hidden). Nothing
// installs without a click. Settings → Updates turns checks off or runs one.
const UPDATE_EVERY = 20 * 3600e3;
const updateUi = { info: null, busy: false, checkedAt: 0 };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} },
};
const autoUpdates = () => store.get("updateAuto") !== "0";
const devUpdates = () => store.get("updateDev") === "1";
const askForUpdate = () => invoke("check_update", { dev: devUpdates() });

async function checkForUpdate({ manual = false } = {}) {
  if (!Platform.has("self_update") || updateUi.busy) return null;
  $("#u-status").textContent = "Checking…";
  try {
    const info = await askForUpdate();
    updateUi.info = info;
    updateUi.checkedAt = Date.now();
    store.set("updateCheckedAt", String(updateUi.checkedAt));
    const skipped = info && store.get("updateSkip") === info.version;
    if (info && (manual || !skipped)) showUpdateBar(info);
    else if (manual) toast("You're on the latest version.");
    const msg = !info ? "You're on the latest version."
      : skipped && !manual ? `Version ${info.version} is available (you chose to skip it).`
      : `Version ${info.version} is available.`;
    $("#about-update").textContent = msg;
    $("#u-status").textContent = `${msg} Checked just now.`;
    return info;
  } catch (e) {
    $("#u-status").textContent = "Couldn't reach GitHub to check for updates.";
    if (manual) toast(`Couldn't check for updates: ${errText(e)}`, true);
    return null;
  }
}

// Release notes arrive as Markdown-ish text ("- Fixed this"); show them as a
// short plain list, never as HTML.
function noteLines(notes) {
  const lines = String(notes || "").split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/[*_`#]/g, "").trim())
    .filter((l) => l && !/^(full changelog|what's changed)/i.test(l));
  return lines.length > 8 ? [...lines.slice(0, 8), `…and ${lines.length - 8} more`] : lines;
}

function showUpdateBar(info) {
  const name = appInfo?.name || "Chismoso";
  $("#update-text").textContent = `${name} ${info.version} is ready (you have ${info.current}).`;
  $("#update-text").title = "";
  const notes = noteLines(info.notes);
  $("#update-notes").replaceChildren(...notes.map((l) => h("li", {}, l)));
  $("#update-whatsnew").hidden = !notes.length;
  setNotesOpen(false);
  $("#update-go").textContent = "Update and restart";
  $("#update-go").disabled = false;
  $("#update-go").title = info.needs_password ? "Linux will ask for your password to install it." : "";
  $("#update-web").hidden = true;
  $("#update-skip").hidden = false;
  $("#update-progress").hidden = true;
  $("#update-bar").hidden = false;
}
function setNotesOpen(open) {
  $("#update-notes").hidden = !open;
  $("#update-whatsnew").setAttribute("aria-expanded", String(open));
  $("#update-whatsnew").textContent = open ? "Hide what's new" : "What's new";
}
function setProgress(p) {
  $("#update-progress").hidden = p == null;
  $("#update-progress i").style.width = `${Math.round((p || 0) * 100)}%`;
}

$("#update-whatsnew").addEventListener("click", () => setNotesOpen($("#update-notes").hidden));
$("#update-later").addEventListener("click", () => { $("#update-bar").hidden = true; });
$("#update-skip").addEventListener("click", () => {
  if (updateUi.info) store.set("updateSkip", updateUi.info.version);
  $("#update-bar").hidden = true;
  toast(`Skipped ${updateUi.info?.version || "this version"}. You'll hear about the next one.`);
});
$("#update-web").addEventListener("click", () => {
  invoke("open_path", { path: appInfo.download_page, reveal: false }).catch((e) => toast(errText(e), true));
});
$("#update-go").addEventListener("click", async () => {
  if (updateUi.busy || !updateUi.info) return;
  updateUi.busy = true;
  $("#update-go").disabled = true;
  $("#update-skip").hidden = true;
  $("#update-web").hidden = true;
  const pw = updateUi.info.needs_password ? " Linux will ask for your password to install it." : "";
  $("#update-text").textContent = `Downloading ${updateUi.info.version}…${pw}`;
  setProgress(0);
  try {
    await invoke("install_update"); // the app restarts when this succeeds
    $("#update-text").textContent = "Installed. Restarting…";
  } catch (e) {
    setProgress(null);
    $("#update-text").textContent = "The update didn't install. You can try again, or download it from the website.";
    $("#update-text").title = errText(e);
    $("#update-go").textContent = "Try again";
    $("#update-go").disabled = false;
    $("#update-web").hidden = false;
    $("#update-skip").hidden = false;
    // the pending update was used up; fetch it again (quietly) for the retry
    askForUpdate().then((info) => { updateUi.info = info; if (!info) $("#update-bar").hidden = true; }).catch(() => {});
  } finally { updateUi.busy = false; }
});
listen("update-progress", ({ payload }) => {
  setProgress(payload);
  if (payload >= 1) $("#update-text").textContent = "Installing… Chismoso will restart in a moment.";
});

// Settings → Updates and About
$("#about-check").addEventListener("click", () => checkForUpdate({ manual: true }));
$("#u-check").addEventListener("click", () => checkForUpdate({ manual: true }));
$("#u-auto").addEventListener("change", (e) => {
  store.set("updateAuto", e.target.checked ? null : "0");
  if (e.target.checked) maybeCheckForUpdate();
});
$("#u-dev").addEventListener("change", (e) => {
  store.set("updateDev", e.target.checked ? "1" : null);
  checkForUpdate({ manual: true });
});
function maybeCheckForUpdate() {
  if (!autoUpdates() || document.hidden) return;
  const last = updateUi.checkedAt || +store.get("updateCheckedAt") || 0;
  if (Date.now() - last > UPDATE_EVERY) checkForUpdate();
}
Platform.info.then((i) => {
  if (!Platform.has("self_update")) return;
  $("#u-version").textContent = `You have ${i.version}${i.version.includes("-") ? " (development build)" : ""}`;
  $("#u-auto").checked = autoUpdates();
  $("#u-dev").checked = devUpdates();
  const last = +store.get("updateCheckedAt") || 0;
  if (last) $("#u-status").textContent = `Last checked ${new Date(last).toLocaleString()}.`;
  setTimeout(maybeCheckForUpdate, 8000); // after start-up settles
  setInterval(maybeCheckForUpdate, 3600e3);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) maybeCheckForUpdate(); });
});
