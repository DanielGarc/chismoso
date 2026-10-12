"use strict";
// Recorded-video playback without a video library.
//
// Frigate (0.17+) serves any time range as HLS with fragmented-MP4 segments
// (/vod/<camera>/start/<s>/end/<e>/master.m3u8). We read the playlist and feed
// the segments to MediaSource ourselves, which keeps the app tiny.
//
// Frigate's playlist joins recording segments back to back and drops gaps, so
// media time is not wall-clock time. Each window starts exactly on a recording
// segment boundary, and the segment list maps media time <-> wall time.
//
// Reverse playback: browsers can't play backwards, so the video is paused and
// stepped back on a timer (each step shows the nearest decodable frame), with
// earlier segments fetched ahead of the playhead.

const STEP_MS = 100;
const REV_CRAWL = 0.1;
const IS_WEBKITGTK = /Linux/.test(navigator.userAgent) && !/Chrome|Android/.test(navigator.userAgent);
const dbg = (...a) => { try { window.__TAURI__.core.invoke("debug_log", { msg: a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ") }); } catch (_) {} };

class VodPlayer {
  constructor(video, { media, invoke }) {
    this.video = video;
    this.media = media;   // path -> URL on the local media server
    this.invoke = invoke;
    this.gen = 0;         // bumps on every open/seek; stale loops exit
    this.rate = 1;        // negative = reverse
    this.ahead = 30;      // seconds of playback to buffer (times the speed)
    this.stepMs = STEP_MS; // reverse: how often to show a new frame
    this.stopped = false; // paused by the user (or the sync group)
    this.onEnd = null;    // forward: the window has played out
    this.onStart = null;  // reverse: reached the start of the window
    this.onError = null;
  }

  // Start playing `camera` at wall-clock time `ts` (seconds). If `ts` falls in
  // a gap, plays from the next recording (or, with `back`, the previous one,
  // ending at `ts`). Resolves with the actual start time, or null if a newer
  // open/close superseded this one.
  async open(camera, ts, { back = false, windowSecs = 1800 } = {}) {
    this.close();
    const gen = ++this.gen;
    const now = Date.now() / 1000;
    const after = back ? ts - windowSecs : ts - 15;
    const before = back ? ts + 15 : Math.min(now, ts + windowSecs);
    const rows = await this.invoke("recording_segments", { camera, after, before });
    if (gen !== this.gen) return null;
    const sel = back ? rows.filter((r) => r[0] < ts - 0.05) : rows.slice(Math.max(0, rows.findIndex((r) => r[1] > ts + 0.05)));
    if (!sel.length || (!back && !(sel[0][1] > ts + 0.05))) throw new Error(back ? "No earlier recordings." : "No recordings after this point.");

    let cum = 0;
    // Built locally and only published once the player is ready, so a second
    // click while this one loads can't use a half-built window.
    const map = sel.map(([s, e, d]) => { const m = { wall: s, end: e, media: cum, dur: d }; cum += d; return m; });
    const winStart = sel[0][0], winEnd = sel[sel.length - 1][1];

    const base = `/vod/${encodeURIComponent(camera)}/start/${winStart.toFixed(3)}/end/${winEnd.toFixed(3)}/`;
    const master = await this.text(base + "master.m3u8");
    const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim();
    const codecs = (/CODECS="([^"]+)"/.exec(master) || [])[1] || "avc1.640028";
    const playlistPath = variant ? base + variant : base + "index.m3u8";
    const playlist = await this.text(playlistPath);
    if (gen !== this.gen) return null;
    const segs = parsePlaylist(playlist, playlistPath);
    if (!segs.length) throw new Error("Frigate returned an empty playlist for this range.");

    const MS = window.ManagedMediaSource || window.MediaSource;
    if (!MS) throw new Error("This system's web view can't play recordings.");
    this.ms = new MS();
    this.url = URL.createObjectURL(this.ms);
    this.video.srcObject = null;
    this.video.disableRemotePlayback = true;
    this.video.src = this.url;
    await new Promise((r) => this.ms.addEventListener("sourceopen", r, { once: true }));
    if (gen !== this.gen) return null;

    let mime = `video/mp4; codecs="${codecs}"`;
    if (!MS.isTypeSupported(mime)) mime = `video/mp4; codecs="${codecs.split(",")[0]}"`; // drop audio if unsupported
    this.sb = this.ms.addSourceBuffer(mime);
    this.sb.mode = "segments";
    this.ms.duration = segs.reduce((a, s) => a + s.dur, 0);
    Object.assign(this, { map, segs, camera, winStart, winEnd });

    const lastSeg = map[map.length - 1];
    const startWall = back ? Math.min(ts, lastSeg.wall + lastSeg.dur - 1) : Math.max(ts, winStart); // a frame clear of the very end: seeks to the last instant can hang
    this.stopped = false;
    await this.seekMedia(this.mediaAt(startWall));
    this.applyRate();
    return startWall;
  }

  // Wall-clock time of the current frame.
  wallTime() {
    const t = this.pendingSeek ?? this.video.currentTime;
    const m = this.map;
    if (!m?.length) return null;
    let lo = 0, hi = m.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (m[mid].media <= t) lo = mid; else hi = mid - 1; }
    return m[lo].wall + Math.min(t - m[lo].media, m[lo].dur);
  }

  // Media time for a wall-clock time (snaps forward across gaps).
  mediaAt(ts) {
    for (const s of this.map) {
      if (ts < s.wall) return s.media;
      if (ts < s.wall + s.dur) return s.media + (ts - s.wall);
    }
    const last = this.map[this.map.length - 1];
    return last.media + last.dur;
  }

  // True if the wall time is inside the loaded window.
  covers(ts) { return !!(this.sb && this.map) && ts >= this.winStart && ts < this.winEnd; }
  // True if there is footage at that wall time (not a gap) in the window.
  has(ts) { return !!this.map?.some((s) => ts >= s.wall - 0.5 && ts < s.wall + s.dur + 0.5); }

  async seekWall(ts) { return this.seekMedia(this.mediaAt(ts)); }

  async seekMedia(t) {
    if (!this.sb || !this.segs) return;
    const gen = ++this.gen;
    await this.idle();
    if (gen !== this.gen) return;
    try {
      if (this.sb.buffered.length) { this.sb.remove(0, Infinity); await this.idle(); }
    } catch (_) {}
    this.loaded = new Set();  // indexes of segments in the buffer
    this.lastMap = null;
    this.atEdge = false;
    t = Math.max(0, Math.min(t, this.ms.duration - 0.05));
    // Before the first media is in, some engines (WebKitGTK) accept the seek
    // but never finish it. Hold it until there's data to land on.
    if (this.video.readyState === 0) this.pendingSeek = t;
    else { this.pendingSeek = null; this.video.currentTime = t; }
    this.seekAt = performance.now();
    this.loop(gen);
  }

  get paused() { return this.stopped; }
  play() { this.stopped = false; this.applyRate(); }
  pause() { this.stopped = true; this.applyRate(); }
  setRate(r) { this.rate = r || 1; this.applyRate(); }

  applyRate() {
    const v = this.video;
    clearInterval(this.revTimer); this.revTimer = null;
    if (!this.sb) return;
    if (this.rate > 0) {
      if (this.wasMuted != null) { v.muted = this.wasMuted; this.wasMuted = null; }
      v.playbackRate = this.rate;
      if (this.stopped) v.pause(); else v.play().catch(() => {});
    } else if (this.stopped) {
      v.pause();
    } else {
      // Reverse: keep the video crawling forward (engines handle seeks on a
      // playing video far better than on a paused one) and step it back on
      // a timer, faster than it crawls.
      if (this.wasMuted == null) { this.wasMuted = v.muted; v.muted = true; }
      v.playbackRate = REV_CRAWL;
      v.play().catch(() => {});
      this.lastStep = performance.now();
      this.revTimer = setInterval(() => this.stepBack(), this.stepMs);
    }
  }

  close() {
    this.gen++;
    clearInterval(this.revTimer); this.revTimer = null;
    if (this.url) {
      try { if (this.ms?.readyState === "open") this.ms.endOfStream(); } catch (_) {}
      URL.revokeObjectURL(this.url);
      if (this.video.src === this.url) { this.video.removeAttribute("src"); this.video.load(); }
    }
    this.url = this.ms = this.sb = this.map = this.segs = null;
  }

  // ── internals ──
  segAt(t) {
    let lo = 0, hi = this.segs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.segs[mid].start <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  bufferedAt(t) {
    const b = this.sb?.buffered;
    if (!b) return null;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.05 && t <= b.end(i) + 0.05) return [b.start(i), b.end(i)];
    return null;
  }

  // Nearest playable time at or just before t (segment edges can leave
  // small holes between what the playlist promises and what was decoded).
  snapBack(t) {
    const b = this.sb?.buffered;
    if (!b) return null;
    let best = null;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) && t <= b.end(i)) return t;
      if (b.end(i) <= t && b.end(i) > t - 2) best = b.end(i) - 0.05;
    }
    return best;
  }

  unstick() {
    const v = this.video;
    if (this.unsticking) return;
    this.unsticking = true;
    this.seekAt = performance.now();
    dbg("unstick", this.camera, v.currentTime.toFixed(2), "readyState", v.readyState);
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener("playing", done);
      this.unsticking = false;
      this.seekAt = performance.now();
      if (this.stopped) v.pause();
    };
    const timer = setTimeout(done, 3000);
    if (v.readyState < 2) {
      // No frame decoded yet: a paused pipeline may never produce one.
      v.addEventListener("playing", done, { once: true });
      v.play().catch(() => {});
    } else {
      const t = this.snapBack(v.currentTime) ?? v.currentTime;
      v.addEventListener("seeked", done, { once: true });
      v.currentTime = Math.max(0, t - 0.04);
    }
  }

  stepBack() {
    const v = this.video, now = performance.now();
    const dt = Math.min(0.3, (now - this.lastStep) / 1000);
    this.lastStep = now;
    if (!this.sb || this.stopped || this.pendingSeek != null) return;
    if (v.seeking) {
      // A seek into a hole never finishes; land on the nearest frame instead.
      // Some engines (WebKitGTK) also never finish a seek on a paused video
      // that has shown no frame yet: play it for a moment to get one.
      if (now - (this.seekAt || now) > 600) this.unstick();
      return;
    }
    if (v.readyState < 2) return; // last step's frame isn't decoded yet: don't pile up seeks
    const target = v.currentTime + (this.rate - REV_CRAWL) * dt; // rate < 0; undo the crawl too
    if (target <= 0.02) {
      if (this.loaded?.has(0)) {
        v.currentTime = 0;
        if (!this.atEdge) { this.atEdge = true; this.onStart?.(this.winStart); }
      }
      return;
    }
    const t = this.snapBack(target); // otherwise wait for the loop to fetch it
    if (t != null && t < v.currentTime) { v.currentTime = t; this.seekAt = now; }
  }

  async loop(gen) {
    const v = this.video;
    while (gen === this.gen && this.sb) {
      try {
        const ct = this.pendingSeek ?? v.currentTime, rev = this.rate < 0, reach = this.ahead * Math.max(1, Math.abs(this.rate));
        if (await this.trim(ct, gen)) continue;
        const cur = this.segAt(ct);
        let want = -1;
        if (!rev) {
          for (let i = cur; i < this.segs.length && this.segs[i].start < ct + reach; i++) if (!this.loaded.has(i)) { want = i; break; }
        } else {
          for (let i = cur; i >= 0 && this.segs[i].start + this.segs[i].dur > ct - reach; i--) if (!this.loaded.has(i)) { want = i; break; }
        }
        if (want >= 0) {
          const seg = this.segs[want];
          if (seg.map && seg.map !== this.lastMap) {
            await this.append(await this.bytes(seg.map), gen);
            this.lastMap = seg.map;
          }
          await this.append(await this.bytes(seg.uri), gen);
          if (gen === this.gen) {
            this.loaded.add(want);
            if (this.pendingSeek != null && this.bufferedAt(this.pendingSeek)) {
              v.currentTime = this.pendingSeek;
              this.pendingSeek = null;
              this.seekAt = performance.now();
            }
          }
          continue;
        }
        const last = this.segs.length - 1;
        const range = this.bufferedAt(ct);
        if (!rev && !this.stopped && this.loaded.has(last) && (!range || range[1] - ct < 0.4) && ct > 0) {
          if (gen === this.gen && !this.atEdge) { this.atEdge = true; this.onEnd?.(this.winEnd); }
          return;
        }
      } catch (e) {
        if (gen === this.gen && this.onError) this.onError(e);
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Bound memory: keep about a minute either side of the playhead, cut on
  // segment boundaries so the "loaded" bookkeeping stays exact.
  async trim(ct, gen) {
    const b = this.sb.buffered;
    if (!b.length) return false;
    const keep = 60 * Math.max(1, Math.abs(this.rate) / 2);
    if (ct - b.start(0) > keep + 30) {
      const i = this.segAt(ct - keep), cut = this.segs[i].start;
      if (cut <= b.start(0) + 0.1) return false;
      this.sb.remove(0, cut);
      await this.idle();
      for (const k of [...this.loaded]) if (k < i) this.loaded.delete(k);
      return gen === this.gen;
    }
    if (b.end(b.length - 1) - ct > keep + 30) {
      const i = this.segAt(ct + keep), cut = this.segs[i].start + this.segs[i].dur;
      if (cut >= b.end(b.length - 1) - 0.1 || cut >= this.ms.duration) return false;
      this.sb.remove(cut, Infinity);
      await this.idle();
      for (const k of [...this.loaded]) if (k > i) this.loaded.delete(k);
      return gen === this.gen;
    }
    return false;
  }

  append(buf, gen) {
    return new Promise((resolve, reject) => {
      if (gen !== this.gen || !this.sb) return resolve();
      const done = () => { this.sb?.removeEventListener("error", fail); resolve(); };
      const fail = () => reject(new Error("The recording couldn't be decoded."));
      this.sb.addEventListener("updateend", done, { once: true });
      this.sb.addEventListener("error", fail, { once: true });
      this.sb.appendBuffer(buf);
    });
  }

  idle() {
    return new Promise((r) => {
      if (!this.sb || !this.sb.updating) return r();
      this.sb.addEventListener("updateend", () => r(), { once: true });
    });
  }

  async text(path) {
    const res = await fetch(this.media(path));
    if (!res.ok) throw new Error(`Frigate returned ${res.status} for the recording playlist.`);
    return res.text();
  }

  async bytes(path) {
    const res = await fetch(this.media(path));
    if (!res.ok) throw new Error(`Frigate returned ${res.status} for a recording segment.`);
    return res.arrayBuffer();
  }
}

// Plays the same moment on several cameras (or just one) and keeps them
// together. One camera with footage drives the clock; the others follow it,
// pause through their own gaps, and load new windows as the clock moves on.
class SyncPlayback {
  constructor({ media, invoke }) {
    this.media = media; this.invoke = invoke;
    this.players = [];
    this.rate = 1;
    this.stopped = false;
    this.master = null;
    this.t = null;          // last known clock (wall time)
    this.gen = 0;
    this.onStatus = null;   // (player, text|null) for per-camera overlays
    this.onLive = null;     // caught up with the present
    this.onError = null;    // nothing playable at all
  }

  // [{ name, video }]. Replaces the current set.
  setCameras(list) {
    this.close();
    this.players = list.map(({ name, video }) => {
      const p = { name, video, vod: new VodPlayer(video, { media: this.media, invoke: this.invoke }), state: "idle", busy: false, seekedAt: 0 };
      p.vod.ahead = list.length > 1 ? 15 : 30; // several cameras: buffer less each
      // ...and decode fewer frames backwards (WebKitGTK's GStreamer pipelines need more room)
      p.vod.stepMs = list.length > 1 ? Math.min(IS_WEBKITGTK ? 800 : 400, (IS_WEBKITGTK ? 250 : 100) + 50 * list.length) : STEP_MS;
      p.vod.onEnd = (end) => this.windowDone(p, end, false);
      p.vod.onStart = (start) => this.windowDone(p, start, true);
      p.vod.onError = (e) => this.status(p, "error", e.message || String(e));
      return p;
    });
  }

  get active() { return this.players.length > 0 && this.t != null; }
  get paused() { return this.stopped; }
  get back() { return this.rate < 0; }

  // Opens every camera at `ts`. Resolves with the time playback starts at.
  async open(ts) {
    const gen = ++this.gen;
    this.master = null;
    this.t = ts;
    this.stopped = false;
    const back = this.back;
    const results = await Promise.all(this.players.map((p) => this.openOne(p, ts, gen)));
    if (gen !== this.gen) return null;
    const starts = results.filter((r) => r != null);
    if (!starts.length) {
      const err = this.players.find((p) => p.msg)?.msg || (back ? "No earlier recordings." : "No recordings after this point.");
      this.t = null;
      throw new Error(err);
    }
    // Everyone starts together at the first moment any camera has footage.
    const start = back ? Math.max(...starts) : Math.min(...starts);
    this.t = start;
    for (const p of this.players) if (p.state === "ok" && Math.abs(p.vod.wallTime() - start) > 1) this.hold(p);
    return start;
  }

  async openOne(p, ts, gen) {
    p.busy = true;
    try {
      const s = await p.vod.open(p.name, ts, { back: this.back });
      if (gen !== this.gen || s == null) return null;
      p.vod.setRate(this.rate);
      if (this.stopped) p.vod.pause();
      this.status(p, "ok");
      return p.vod.wallTime() ?? s; // where it actually landed (the playlist can be shorter than the index)
    } catch (e) {
      if (gen === this.gen) this.status(p, "none", e.message || String(e));
      return null;
    } finally { p.busy = false; }
  }

  hold(p) { p.vod.pause(); this.status(p, "gap", "No recording at this time"); }

  status(p, state, msg = null) { p.state = state; p.msg = msg; this.onStatus?.(p, state === "ok" ? null : msg); }

  clock() {
    const ok = (p) => p.state === "ok" && !p.busy && p.vod.covers(p.vod.wallTime() ?? -1);
    const moving = (p) => ok(p) && p.video.readyState >= 2 && !p.video.seeking;
    // Prefer a camera whose video is actually advancing to drive the clock.
    if (!this.master || !moving(this.master)) this.master = this.players.find(moving) || (this.master && ok(this.master) ? this.master : this.players.find(ok)) || null;
    if (this.master) this.t = this.master.vod.wallTime();
    return this.t;
  }

  // Called a few times a second: keep followers aligned with the clock.
  tick() {
    if (!this.players.length || this.t == null) return;
    const gen = this.gen;
    const t = this.clock();
    if (!this.master) return this.stalled(gen);
    const tol = 1.5 + 0.25 * Math.abs(this.rate);
    const now = performance.now();
    for (const p of this.players) {
      if (p === this.master || p.busy) continue;
      const v = p.vod;
      if (v.covers(t)) {
        if (!v.has(t)) { if (p.state !== "gap") this.hold(p); continue; }
        if (p.state !== "ok") { this.status(p, "ok"); v.seekWall(t); if (!this.stopped) v.play(); p.seekedAt = now; continue; }
        const wt = v.wallTime();
        if (wt != null && Math.abs(wt - t) > tol && now - p.seekedAt > 2000) { v.seekWall(t); p.seekedAt = now; }
      } else if (now - p.seekedAt > 3000) {
        // Outside this camera's loaded window: load the right one.
        p.seekedAt = now;
        this.openOne(p, t, gen).then((s) => {
          if (s == null || gen !== this.gen) return;
          if (Math.abs(s - (this.t ?? s)) > tol) this.hold(p);
        });
      }
    }
  }

  // Nobody has footage at the clock: jump to the nearest moment someone does.
  stalled(gen) {
    if (this.jumping || this.players.some((p) => p.busy)) return;
    const ahead = this.players.filter((p) => p.state === "gap" || p.state === "ok").map((p) => p.vod.wallTime()).filter((x) => x != null);
    const target = ahead.length ? (this.back ? Math.max(...ahead.filter((x) => x <= this.t + 1), -Infinity) : Math.min(...ahead.filter((x) => x >= this.t - 1), Infinity)) : null;
    this.jumping = true;
    const go = Number.isFinite(target) ? target : this.t + (this.back ? -0.1 : 0.1);
    if (!this.back && go > Date.now() / 1000 - 30) { this.jumping = false; return this.onLive?.(); }
    this.open(go).catch((e) => { if (gen === this.gen || this.gen === gen + 1) this.onError?.(e); }).finally(() => { this.jumping = false; });
  }

  windowDone(p, edge, back) {
    if (!back && edge > Date.now() / 1000 - 30 && p === this.master) return this.onLive?.();
    // Load this camera's next (or previous) window; it rejoins via tick().
    const gen = this.gen;
    this.openOne(p, back ? edge : edge + 0.01, gen).then((s) => {
      if (s == null || gen !== this.gen) return;
      if (p !== this.master && this.t != null && Math.abs(s - this.t) > 1.5 * Math.max(1, Math.abs(this.rate))) this.hold(p);
    });
  }

  covers(ts) { return this.players.length > 0 && this.players.every((p) => p.state !== "ok" || p.vod.covers(ts)) && this.players.some((p) => p.vod.covers(ts) && p.vod.has(ts)); }

  async seek(ts) {
    if (!this.covers(ts)) return this.open(ts);
    this.t = ts;
    for (const p of this.players) {
      if (!p.vod.covers(ts)) continue;
      if (p.vod.has(ts)) { this.status(p, "ok"); p.vod.seekWall(ts); if (!this.stopped) p.vod.play(); p.seekedAt = performance.now(); }
      else this.hold(p);
    }
    this.master = null;
    return ts;
  }

  // Direction changes reload: windows only extend one way from where they opened.
  setRate(r) {
    const flipped = (r < 0) !== (this.rate < 0);
    this.rate = r;
    for (const p of this.players) p.vod.setRate(r);
    return flipped;
  }

  play() { this.stopped = false; for (const p of this.players) if (p.state === "ok") p.vod.play(); }
  pause() { this.stopped = true; for (const p of this.players) p.vod.pause(); }

  close() {
    this.gen++;
    for (const p of this.players) { p.vod.close(); this.onStatus?.(p, null); }
    this.t = null;
    this.master = null;
  }
}

// Minimal HLS media-playlist parser: segment URIs, durations and EXT-X-MAP.
function parsePlaylist(text, playlistPath) {
  const dir = playlistPath.slice(0, playlistPath.lastIndexOf("/") + 1);
  const abs = (u) => (u.startsWith("/") ? u : dir + u);
  const segs = [];
  let dur = 0, map = null, t = 0;
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) dur = parseFloat(line.slice(8));
    else if (line.startsWith("#EXT-X-MAP:")) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) map = abs(m[1]);
    } else if (!line.startsWith("#")) {
      segs.push({ uri: abs(line), dur, start: t, map });
      t += dur;
    }
  }
  return segs;
}
