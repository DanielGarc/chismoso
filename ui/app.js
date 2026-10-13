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
    state.info = await invoke("connect", {
      url: prefs.url, user: prefs.user, password: $("#f-pass").value,
      selfSigned, pinned: selfSigned ? prefs.pins[prefs.url] ?? null : null, keep: prefs.keep,
    });
    if (state.info.cert_fingerprint) { prefs.pins[prefs.url] = state.info.cert_fingerprint; savePrefs(); }
    $("#f-pass").value = "";
    enterApp();
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
// "Keep me signed in": the backend saved Frigate's session token (never the
// password). On start, try it before showing the sign-in form.
async function resumeSession() {
  const btn = $("#login-btn"), err = $("#login-error");
  btn.disabled = true; btn.textContent = "Signing in…"; err.hidden = true;
  try {
    const kept = await invoke("resume");
    if (!kept) return false;
    prefs.url = kept.url; prefs.user = kept.user; savePrefs();
    $("#f-url").value = kept.url; $("#f-user").value = kept.user;
    state.info = kept.info;
    enterApp();
    return true;
  } catch (e) {
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
if (prefs.keep) resumeSession();

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
  $("#menu-meta").textContent = `Frigate ${i.version} · ${prefs.user || "internal port"} (${i.role})`;
  $("#tabs").hidden = false;
  $("#server-wrap").hidden = false;
  if (!prefs.outDir) { prefs.outDir = await invoke("default_output_dir"); savePrefs(); }
  setupExportsForm();
  setupNotifications();
  fillLayoutPicker();
  buildGrid();
  pollStats();
  clearInterval(state.statsTimer);
  state.statsTimer = setInterval(pollStats, 10000);
  startLoadRecorder();
  showView("live");
}

async function leave(message) {
  closeMenu();
  closeFocus(true); endGridRec(); stopGrid();
  timeline?.clearCache();
  clearInterval(state.statsTimer); clearInterval(state.snapTimer); clearInterval(state.loadTimer); stopLoadRecorder();
  await invoke("disconnect").catch(() => {});
  state.info = null; state.stats = null; state.cfgOriginal = ""; cfg.value = "";
  $("#tabs").hidden = true;
  $("#server-wrap").hidden = true;
  $("#live-tools").hidden = true;
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
  $("#live-tools").hidden = v !== "live" || !!state.focus;
  if (v === "live") { if (!state.focus) startGrid(); }
  else { endGridRec(); stopGrid(); closeFocus(true); }
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

// ══ Layouts (which cameras the grid shows) ══════════════════════════
const isAdmin = () => state.info?.role === "admin";
function camByName(name) { return state.info.cameras.find((c) => c.name === name); }

// Cameras for the current layout, in order.
function layoutCameras() {
  const all = state.info.cameras;
  const known = (names) => names.map(camByName).filter(Boolean);
  if (prefs.layout.startsWith("g:")) {
    const g = state.info.groups.find((x) => x.name === prefs.layout.slice(2));
    if (g) return known(g.cameras);
  } else if (prefs.layout.startsWith("m:")) {
    const l = prefs.layouts.find((x) => x.id === prefs.layout.slice(2));
    if (l) return known(l.cameras);
  }
  return all;
}

function fillLayoutPicker() {
  const sel = $("#layout");
  const opt = (value, label) => h("option", { value, selected: prefs.layout === value }, label);
  const groups = state.info.groups.length
    ? h("optgroup", { label: "Frigate camera groups" }, state.info.groups.map((g) => opt("g:" + g.name, prettyName(g.name)))) : null;
  const mine = prefs.layouts.length
    ? h("optgroup", { label: "My layouts" }, prefs.layouts.map((l) => opt("m:" + l.id, l.name))) : null;
  sel.replaceChildren(opt("all", "All cameras"), groups, mine);
  if (sel.value !== prefs.layout) { prefs.layout = "all"; sel.value = "all"; }
}
const prettyName = (s) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

$("#layout").addEventListener("change", (e) => {
  prefs.layout = e.target.value;
  const mine = prefs.layouts.find((l) => "m:" + l.id === prefs.layout);
  if (mine && mine.cols != null) prefs.cols = mine.cols;
  savePrefs();
  stopGrid(); buildGrid(); startGrid();
});

// ── layout editor ──
let layDraft = null; // { id|null, name, order: [names], on: Set, cols }
$("#layout-edit").addEventListener("click", () => {
  const mine = prefs.layouts.find((l) => "m:" + l.id === prefs.layout);
  openLayoutDraft(mine || null);
  $("#layout-dlg").showModal();
});
function openLayoutDraft(l) {
  const names = state.info.cameras.map((c) => c.name);
  if (l) {
    const order = [...l.cameras.filter((n) => names.includes(n)), ...names.filter((n) => !l.cameras.includes(n))];
    layDraft = { id: l.id, name: l.name, order, on: new Set(l.cameras), cols: l.cols ?? 0 };
  } else {
    const shown = layoutCameras().map((c) => c.name);
    const order = [...shown, ...names.filter((n) => !shown.includes(n))];
    layDraft = { id: null, name: "", order, on: new Set(shown), cols: prefs.cols };
  }
  $("#lay-pick").replaceChildren(h("option", { value: "" }, "New layout"),
    ...prefs.layouts.map((x) => h("option", { value: x.id, selected: x.id === layDraft.id }, x.name)));
  $("#lay-name").value = layDraft.name;
  $("#lay-cols").value = String(layDraft.cols || 0);
  $("#lay-delete").hidden = !layDraft.id;
  $("#lay-note").textContent = state.info.groups.length
    ? "Frigate camera groups come from config.yml (camera_groups) and show in the layout list as they are." : "";
  renderLayoutCams();
}
function renderLayoutCams() {
  const ul = $("#lay-cams");
  ul.replaceChildren(...layDraft.order.map((name, i) => {
    const cam = camByName(name);
    const cb = h("input", { type: "checkbox", checked: layDraft.on.has(name) });
    cb.addEventListener("change", () => { cb.checked ? layDraft.on.add(name) : layDraft.on.delete(name); });
    const move = (d) => () => {
      const j = i + d;
      if (j < 0 || j >= layDraft.order.length) return;
      [layDraft.order[i], layDraft.order[j]] = [layDraft.order[j], layDraft.order[i]];
      renderLayoutCams();
    };
    return h("li", {}, h("label", { class: "check" }, cb, cam?.friendly_name || name),
      h("span", { class: "grow" }),
      h("button", { type: "button", class: "btn icon slim", title: "Move up", onclick: move(-1), disabled: i === 0 }, "↑"),
      h("button", { type: "button", class: "btn icon slim", title: "Move down", onclick: move(1), disabled: i === layDraft.order.length - 1 }, "↓"));
  }));
}
$("#lay-pick").addEventListener("change", (e) => openLayoutDraft(prefs.layouts.find((l) => l.id === e.target.value) || null));
$("#lay-new").addEventListener("click", () => { openLayoutDraft(null); $("#lay-pick").value = ""; $("#lay-name").focus(); });
$("#lay-save").addEventListener("click", () => {
  const name = $("#lay-name").value.trim();
  if (!name) { $("#lay-name").focus(); return toast("Give the layout a name.", true); }
  const cameras = layDraft.order.filter((n) => layDraft.on.has(n));
  if (!cameras.length) return toast("Pick at least one camera.", true);
  const cols = +$("#lay-cols").value;
  if (layDraft.id) Object.assign(prefs.layouts.find((l) => l.id === layDraft.id), { name, cameras, cols });
  else prefs.layouts.push({ id: Date.now().toString(36), name, cameras, cols });
  const saved = layDraft.id || prefs.layouts[prefs.layouts.length - 1].id;
  prefs.layout = "m:" + saved;
  prefs.cols = cols;
  savePrefs();
  $("#layout-dlg").close();
  fillLayoutPicker(); stopGrid(); buildGrid(); startGrid();
});
$("#lay-delete").addEventListener("click", async () => {
  if (!layDraft.id || !(await ask(`Delete the layout "${layDraft.name}"?`, "Delete", true))) return;
  prefs.layouts = prefs.layouts.filter((l) => l.id !== layDraft.id);
  if (prefs.layout === "m:" + layDraft.id) prefs.layout = "all";
  savePrefs();
  $("#layout-dlg").close();
  fillLayoutPicker(); stopGrid(); buildGrid(); startGrid();
});

// ══ Live: grid ══════════════════════════════════════════════════════
// Tiles scrolled out of view don't stream or fetch snapshots.
const tileObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const entry = [...state.tiles].find(([, t]) => t.el === e.target);
    if (!entry) continue;
    const [name, t] = entry;
    t.visible = e.isIntersecting;
    if (!t.visible && t.rtc && !state.focus) { t.ctrl?.abort(); t.ctrl = null; t.rtc.close(); t.rtc = null; t.video.hidden = true; t.img.hidden = false; }
    else if (t.visible && !state.focus && !state.gridRec && state.view === "live" && prefs.gridLive && Live.supported() && !sleptLive) startTileVideo(name, t);
  }
}, { root: $("#grid"), threshold: 0.05 });

function buildGrid() {
  const resume = state.gridRec && pb.active ? pb.t : null;
  endGridRec();
  tileObserver.disconnect();
  const grid = $("#grid");
  grid.replaceChildren();
  state.tiles.clear();
  for (const cam of layoutCameras()) {
    const img = h("img", { alt: "" });
    const video = h("video", { autoplay: true, playsinline: true, muted: true, hidden: true });
    video.muted = true;
    const fps = h("span", { class: "fps" });
    const dot = h("span", { class: "state" });
    const recMsg = h("span", { class: "rec-msg" });
    // Clicking a tile opens that camera, at the same moment if we're playing
    // back. A tile parked during grid playback starts playing instead.
    const el = h("div", { class: "tile", onclick: () => {
      if (state.gridRec && state.parked?.has(cam.name)) return promoteTile(cam.name);
      openFocus(cam.name, 0, state.gridRec && pb.active ? pb.t : null);
    } },
      img, video, h("div", { class: "empty" }, "Loading…"), recMsg,
      h("div", { class: "label" }, dot, cam.friendly_name, fps));
    grid.append(el);
    state.tiles.set(cam.name, { el, img, video, dot, fps, recMsg, rtc: null, ctrl: null, visible: true });
    tileObserver.observe(el);
  }
  if (!state.tiles.size) grid.append(h("p", { class: "muted" }, "This layout has no cameras."));
  applyCols();
  paintTileStats();
  if (!state.focus) rescope();
  setPlaybackUi();
  if (resume) playAt(resume);
}

function applyCols() {
  $$("#cols button").forEach((b) => b.classList.toggle("on", +b.dataset.cols === prefs.cols));
  $("#grid").style.gridTemplateColumns = prefs.cols ? `repeat(${prefs.cols}, 1fr)` : "";
}
$$("#cols button").forEach((b) => b.addEventListener("click", () => { prefs.cols = +b.dataset.cols; savePrefs(); applyCols(); }));

$("#grid-live").checked = prefs.gridLive;
$("#grid-live").addEventListener("change", (e) => { prefs.gridLive = e.target.checked; savePrefs(); stopGrid(); startGrid(); });

// Safe to call repeatedly (tab clicks, shortcuts): already-running tiles are left alone.
function startGrid() {
  if (!state.info || state.focus || state.view !== "live" || state.gridRec) return;
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

function stopGrid() {
  clearInterval(state.snapTimer);
  clearInterval(state.fpsTimer);
  for (const t of state.tiles.values()) {
    t.ctrl?.abort(); t.ctrl = null;
    if (t.rtc) { t.rtc.close(); t.rtc = null; }
    t.video.hidden = true; t.img.hidden = false;
  }
}

async function startTileVideo(name, t) {
  if (t.ctrl || t.rtc) return; // already starting or playing
  const ctrl = t.ctrl = new AbortController();
  const cam = camByName(name);
  // Prefer a second (usually lower-resolution) stream for the grid when configured.
  const stream = gridStream(cam);
  try {
    const rtc = await Live.play(t.video, stream, { signal: ctrl.signal });
    if (ctrl.signal.aborted) return rtc.close();
    attachTileRtc(t, rtc);
  } catch (_) { /* stays on snapshots */ }
  finally { if (t.ctrl === ctrl && !t.rtc) t.ctrl = null; }
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
    next.onload = () => { clearTimeout(done); t.img.src = next.src; t.el.querySelector(".empty").hidden = true; res(); };
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
    t.dot.className = "state " + (s ? (camFps > 0 ? "live" : "off") : "");
    t.fps.title = s ? `Frigate is receiving ${camFps.toFixed(1)} fps on the detect stream` : "";
    if (state.gridRec) t.fps.textContent = "recording";
    else if (t.rtc) t.fps.textContent = t.liveFps != null ? `${t.rtc.kind === "webrtc" ? "WebRTC" : "MSE"} · ${Math.round(t.liveFps)} fps` : (t.rtc.kind === "webrtc" ? "WebRTC" : "MSE");
    else t.fps.textContent = s ? "snapshot" : "";
  }
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
  stopGrid();
  closeFocus(true);
  state.focus = { cam: name, streamIdx, rtc: null, liveCtrl: null, timer: null, mode: "live" };
  $("#grid").hidden = true;
  $("#focus").hidden = false;
  $("#live-tools").hidden = true;
  $("#focus-name").textContent = cam.friendly_name;

  const sel = $("#focus-stream");
  sel.replaceChildren(...cam.streams.map(([label], i) => h("option", { value: i, selected: i === streamIdx }, label)));
  sel.hidden = cam.streams.length < 2;
  sel.onchange = () => { state.focus.streamIdx = +sel.value; if (state.focus.mode === "live") startLive(); };
  renderFocusToggles();

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
  state.focus = null;
  focusVideo.srcObject = null;
  $("#focus").hidden = true;
  $("#grid").hidden = false;
  if (silent) return;
  // Back to the grid: keep watching the same moment on every camera.
  $("#live-tools").hidden = false;
  rescope();
  setPlaybackUi();
  if (giveBack) { giveBack.moveTo(tile.video); attachTileRtc(tile, giveBack); }
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

async function checkForUpdate({ manual = false } = {}) {
  if (!Platform.has("self_update") || updateUi.busy) return null;
  $("#u-status").textContent = "Checking…";
  try {
    const info = await invoke("check_update");
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
    invoke("check_update").then((info) => { updateUi.info = info; if (!info) $("#update-bar").hidden = true; }).catch(() => {});
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
function maybeCheckForUpdate() {
  if (!autoUpdates() || document.hidden) return;
  const last = updateUi.checkedAt || +store.get("updateCheckedAt") || 0;
  if (Date.now() - last > UPDATE_EVERY) checkForUpdate();
}
Platform.info.then((i) => {
  if (!Platform.has("self_update")) return;
  $("#u-version").textContent = `You have ${i.version}`;
  $("#u-auto").checked = autoUpdates();
  const last = +store.get("updateCheckedAt") || 0;
  if (last) $("#u-status").textContent = `Last checked ${new Date(last).toLocaleString()}.`;
  setTimeout(maybeCheckForUpdate, 8000); // after start-up settles
  setInterval(maybeCheckForUpdate, 3600e3);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) maybeCheckForUpdate(); });
});
