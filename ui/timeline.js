"use strict";
// Zoomable recordings timeline (weeks down to seconds), drawn on a canvas.
//
//   wheel / pinch       zoom around the pointer        double-click  zoom in
//   drag                pan                            click         play from there
//   shift-drag, or drag in "select" mode               select a range (clip)
//   drag a selection's edge                            adjust it
//
// Three lanes: time labels, events (alerts red, detections amber), recordings.
// Data is loaded lazily and cached per local day:
//   zoomed in  (≤ 3 days visible): exact recorded spans + review events
//   zoomed out (> 3 days visible): Frigate's hourly summary (one request)
// Today is refreshed incrementally (only what's new since the last fetch).

class Timeline {
  constructor(canvas, { loadSpans, loadEvents, loadSummary, onSeek, onEvent, onSelect, onHoverEvent, onView }) {
    Object.assign(this, { loadSpans, loadEvents, loadSummary, onSeek, onEvent, onSelect, onHoverEvent, onView });
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.days = new Map();      // dayStart -> { spans, events, fetchedTo, at, loading }
    this.summary = null;        // { hours: [[start, fraction]], at, loading }
    this.gen = 0;               // bumps on clearCache(); late responses are dropped
    this.playhead = null;
    this.live = true;
    this.follow = true;
    this.hover = null;
    this.sel = null;            // { a, b } selected range, or null
    this.selectMode = false;
    this.readColors();
    const now = Date.now() / 1000;
    this.setView(now - 3600, now + 120);
    this.bind();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  static MIN_SPAN = 20;            // 20 s across the whole bar
  static MAX_SPAN = 86400 * 60;    // 60 days
  static LABEL_H = 18;
  static EVENT_H = 10;

  // ── view ──
  setView(start, end) {
    let span = Math.min(Timeline.MAX_SPAN, Math.max(Timeline.MIN_SPAN, end - start));
    const mid = (start + end) / 2;
    start = mid - span / 2;
    const limit = Date.now() / 1000 + span * 0.15; // don't scroll far into the future
    if (start + span > limit) start = limit - span;
    this.start = start;
    this.end = start + span;
    this.ensureData();
    this.draw();
    this.onView?.(this.start, this.end);
  }

  centerOn(ts, secs = this.end - this.start) { this.setView(ts - secs / 2, ts + secs / 2); }

  // Zoom keeping `anchor` (default: playhead, or now when live) in place.
  zoomBy(factor, anchor) {
    const now = Date.now() / 1000;
    anchor ??= this.live ? now : (this.playhead ?? (this.start + this.end) / 2);
    const span = Math.min(Timeline.MAX_SPAN, Math.max(Timeline.MIN_SPAN, (this.end - this.start) * factor));
    const frac = Math.min(1, Math.max(0, (anchor - this.start) / (this.end - this.start)));
    this.setView(anchor - frac * span, anchor + (1 - frac) * span);
  }

  setSpan(secs) {
    const now = Date.now() / 1000;
    if (this.live) { this.follow = true; this.setView(now - secs * 0.92, now + secs * 0.08); }
    else this.centerOn(this.playhead ?? now, secs);
  }

  setPlayhead(ts, live) {
    this.playhead = ts;
    this.live = live;
    if (live && this.follow) {
      const span = this.end - this.start, now = Date.now() / 1000;
      if (now > this.end - span * 0.08) this.setView(now - span * 0.9, now + span * 0.1);
    } else if (!live && ts && this.follow && (ts < this.start || ts > this.end)) {
      this.centerOn(ts);
    }
    // Called 4×/s; only repaint when the playhead or "now" moved a pixel.
    const key = `${live}|${Math.round(this.x(ts ?? Date.now() / 1000) * 2)}|${this.start}|${this.end}|${this.w}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.draw();
  }

  // Something changed on the server: refetch today now instead of in 30 s.
  refreshToday() {
    const today = this.days.get(this.dayStart(Date.now() / 1000));
    if (today && !today.loading) { today.at = 0; this.ensureData(); }
  }

  clearCache() { this.days.clear(); this.summary = null; this.sel = null; this.gen++; }

  setSelection(sel) {
    this.sel = sel && sel.b - sel.a >= 1 ? { a: Math.min(sel.a, sel.b), b: Math.max(sel.a, sel.b) } : null;
    this.draw();
    this.emitSelection();
  }

  emitSelection() {
    if (!this.onSelect) return;
    if (!this.sel) return this.onSelect(null);
    this.onSelect({ ...this.sel, x0: this.x(this.sel.a), x1: this.x(this.sel.b) });
  }

  // All loaded events, oldest first.
  events() {
    const out = [];
    for (const d of this.days.values()) out.push(...d.events);
    return out.sort((p, q) => p.start - q.start);
  }

  // ── data ──
  dayStart(ts) { const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }
  nextDay(ds) { const d = new Date(ds * 1000); d.setDate(d.getDate() + 1); return d.getTime() / 1000; }

  ensureData() {
    const now = Date.now() / 1000;
    if (this.end - this.start > 86400 * 3) {
      if (!this.summary || (!this.summary.loading && now - this.summary.at > 300)) this.fetchSummary();
      return;
    }
    for (let ds = this.dayStart(this.start); ds < Math.min(this.end, now); ds = this.nextDay(ds)) {
      const d = this.days.get(ds);
      if (!d) { this.fetchDay(ds); continue; }
      const isToday = this.nextDay(ds) > now;
      if (isToday && !d.loading && now - d.at > 30) this.fetchDay(ds, d);
    }
  }

  // Full day the first time; afterwards only what's new (today keeps growing).
  async fetchDay(ds, prev) {
    const gen = this.gen;
    const until = Math.min(this.nextDay(ds), Date.now() / 1000);
    const from = prev ? Math.max(ds, prev.fetchedTo - 120) : ds;
    const entry = prev || { spans: [], events: [], fetchedTo: ds, at: 0 };
    entry.loading = true;
    this.days.set(ds, entry);
    const [spans, events] = await Promise.all([
      this.loadSpans(from, until).catch(() => null),
      this.loadEvents(prev ? from - 3600 : from, until).catch(() => null), // events can still be growing
    ]);
    if (gen !== this.gen) return; // camera changed meanwhile
    if (spans) entry.spans = mergeSpans(prev ? entry.spans : [], spans);
    if (events) {
      const byId = new Map(entry.events.map((e) => [e.id, e]));
      for (const e of events) byId.set(e.id, e);
      entry.events = [...byId.values()].sort((p, q) => p.start - q.start);
    }
    if (spans) entry.fetchedTo = until;
    entry.loading = false;
    entry.at = Date.now() / 1000;
    this.draw();
  }

  async fetchSummary() {
    const gen = this.gen;
    const s = { hours: this.summary?.hours || [], at: Date.now() / 1000, loading: true };
    this.summary = s;
    try {
      const days = await this.loadSummary();
      if (gen !== this.gen) return;
      const hours = [];
      for (const day of days || []) {
        const [y, m, d] = day.day.split("-").map(Number);
        for (const hr of day.hours || []) {
          hours.push([new Date(y, m - 1, d, +hr.hour).getTime() / 1000, Math.min(1, (hr.duration || 0) / 3600)]);
        }
      }
      s.hours = hours;
    } catch (_) {}
    s.loading = false;
    this.draw();
  }

  // ── geometry ──
  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.c.width = Math.round(r.width * dpr);
    this.c.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
    this.emitSelection();
  }
  x(ts) { return (ts - this.start) / (this.end - this.start) * this.w; }
  t(x) { return this.start + x / this.w * (this.end - this.start); }
  get eventsY() { return Timeline.LABEL_H + 2; }
  get trackY() { return this.eventsY + Timeline.EVENT_H + 3; }

  eventAt(x, y) {
    if (y < this.eventsY - 2 || y > this.trackY + 4) return null;
    const tol = 4 * (this.end - this.start) / this.w;
    const t = this.t(x);
    let best = null;
    for (const d of this.days.values()) {
      for (const e of d.events) {
        const end = e.end ?? Date.now() / 1000;
        if (t >= e.start - tol && t <= end + tol && (!best || e.severity === "alert")) best = e;
      }
    }
    return best;
  }

  // ── drawing ──
  readColors() {
    const css = getComputedStyle(this.c);
    const col = (n, f) => css.getPropertyValue(n).trim() || f;
    this.C = {
      bg: col("--tl-bg", "#0a0e15"), track: col("--tl-track", "#141b27"), rec: col("--tl-rec", "#2f6fd6"),
      text: col("--tl-text", "#8b97ab"), tick: col("--tl-tick", "#222c3d"), head: col("--tl-head", "#ef4444"),
      future: col("--tl-future", "#0d1119"), day: col("--tl-day", "#cbd5e1"),
      alert: col("--tl-alert", "#ef4444"), detection: col("--tl-detection", "#f59e0b"), sel: col("--tl-sel", "#60a5fa"),
    };
  }

  draw() {
    if (!this.w) return;
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this.paint());
  }

  paint() {
    const { ctx, w, h, C } = this;
    const now = Date.now() / 1000;
    const labelH = Timeline.LABEL_H, evY = this.eventsY, trackY = this.trackY, trackH = h - trackY - 3;
    const span = this.end - this.start;
    const zoomedOut = span > 86400 * 3;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = C.track; ctx.fillRect(0, trackY, w, trackH);

    // recorded footage
    ctx.fillStyle = C.rec;
    if (zoomedOut) {
      for (const [t0, f] of this.summary?.hours || []) {
        const x0 = this.x(t0), x1 = this.x(t0 + 3600);
        if (x1 < 0 || x0 > w || f <= 0) continue;
        ctx.globalAlpha = 0.35 + 0.65 * f;
        ctx.fillRect(x0, trackY, Math.max(1, x1 - x0), trackH);
      }
      ctx.globalAlpha = 1;
    } else {
      for (const d of this.days.values()) {
        for (const [s, e] of d.spans) {
          if (e < this.start || s > this.end) continue;
          const x0 = Math.max(0, this.x(s)), x1 = Math.min(w, this.x(e));
          ctx.fillRect(x0, trackY, Math.max(1, x1 - x0), trackH);
        }
      }
      // events lane: detections first, alerts on top
      for (const sev of ["detection", "alert"]) {
        ctx.fillStyle = C[sev];
        for (const d of this.days.values()) {
          for (const e of d.events) {
            if (e.severity !== sev) continue;
            const end = e.end ?? now;
            if (end < this.start || e.start > this.end) continue;
            const x0 = Math.max(0, this.x(e.start)), x1 = Math.min(w, this.x(end));
            ctx.fillRect(x0, evY, Math.max(3, x1 - x0), Timeline.EVENT_H);
          }
        }
      }
    }

    // the future is greyed out
    const xn = this.x(now);
    if (xn < w) { ctx.fillStyle = C.future; ctx.fillRect(Math.max(0, xn), evY, w - Math.max(0, xn), h - evY); }

    // ticks and labels (date of the left edge stays pinned)
    ctx.font = "11px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textBaseline = "middle";
    const leftDate = new Date(this.start * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    const lw = ctx.measureText(leftDate).width + 12;
    const step = pickStep(span / w * 90);
    for (let tt = alignTick(this.start, step), n = 0; tt <= this.end && n < 400; tt = nextTick(tt, step), n++) {
      const x = Math.round(this.x(tt)) + 0.5;
      const d = new Date(tt * 1000);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
      ctx.strokeStyle = midnight ? C.day : C.tick;
      ctx.globalAlpha = midnight ? 0.5 : 1;
      ctx.beginPath(); ctx.moveTo(x, labelH - 4); ctx.lineTo(x, h); ctx.stroke();
      ctx.globalAlpha = 1;
      if (x < lw) continue;
      ctx.fillStyle = midnight ? C.day : C.text;
      ctx.fillText(tickLabel(d, step, midnight), x + 4, labelH / 2);
    }
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, lw, labelH);
    ctx.fillStyle = C.day; ctx.fillText(leftDate, 6, labelH / 2);

    // selection
    if (this.sel) {
      const x0 = this.x(this.sel.a), x1 = this.x(this.sel.b);
      ctx.fillStyle = C.sel; ctx.globalAlpha = 0.22;
      ctx.fillRect(x0, evY, x1 - x0, h - evY);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.sel;
      for (const x of [x0, x1]) { ctx.fillRect(Math.round(x) - 1.5, evY - 2, 3, h - evY + 2); }
    }

    // now marker
    if (xn >= 0 && xn <= w) {
      ctx.strokeStyle = C.text; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xn + 0.5, evY); ctx.lineTo(xn + 0.5, h); ctx.stroke();
      ctx.setLineDash([]);
    }

    // playhead
    const ph = this.live ? now : this.playhead;
    if (ph != null) {
      const x = Math.round(this.x(ph)) + 0.5;
      if (x >= 0 && x <= w) {
        ctx.strokeStyle = C.head; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, h); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = C.head;
        ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 6); ctx.fill();
      }
    }

    // hover readout (hidden while an event card is showing)
    if (this.hover != null && !this.dragging && !this.hoverEvent) {
      const x = this.hover, tt = this.t(x);
      const txt = new Date(tt * 1000).toLocaleString([], {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...(span < 7200 ? { second: "2-digit" } : {}),
      });
      ctx.strokeStyle = C.day; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(x + 0.5, evY); ctx.lineTo(x + 0.5, h); ctx.stroke();
      ctx.globalAlpha = 1;
      const tw = ctx.measureText(txt).width + 12;
      const bx = Math.min(w - tw, Math.max(0, x - tw / 2));
      ctx.fillStyle = "#000c"; ctx.fillRect(bx, trackY + trackH / 2 - 9, tw, 18);
      ctx.fillStyle = "#fff"; ctx.fillText(txt, bx + 6, trackY + trackH / 2);
    }
  }

  // ── input ──
  bind() {
    const c = this.c;
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const { x } = pos(e);
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { // trackpad sideways = pan
        this.follow = false;
        const dt = e.deltaX / this.w * (this.end - this.start);
        this.setView(this.start + dt, this.end + dt);
        this.emitSelection();
        return;
      }
      const anchor = this.t(x);
      this.follow = this.live && anchor > Date.now() / 1000 - (this.end - this.start) * 0.1;
      this.zoomBy(Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), anchor);
      this.emitSelection();
    }, { passive: false });

    c.addEventListener("dblclick", (e) => { this.zoomBy(0.4, this.t(pos(e).x)); this.emitSelection(); });

    let down = null; // { x, start, mode: "pan" | "select" | "edge-a" | "edge-b" | "pinch", moved }
    // Touch: two fingers pinch to zoom around their midpoint. Edges of a
    // selection are easier to grab with a finger than a mouse needs.
    const touches = new Map(); // pointerId -> x
    const edge = (e) => (e.pointerType === "touch" ? 18 : 7);
    const pinchState = () => {
      const [a, b] = [...touches.values()];
      return { dist: Math.max(20, Math.abs(a - b)), mid: (a + b) / 2 };
    };
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      const { x } = pos(e);
      if (e.pointerType === "touch") {
        touches.set(e.pointerId, x);
        if (touches.size === 2) {
          const p = pinchState();
          down = { mode: "pinch", moved: true, span: this.end - this.start, dist: p.dist, anchor: this.t(p.mid), frac: p.mid / this.w };
          this.follow = false;
          return;
        }
        if (touches.size > 2) return;
      }
      let mode = this.selectMode || e.shiftKey ? "select" : "pan";
      if (this.sel) {
        if (Math.abs(x - this.x(this.sel.a)) < edge(e)) mode = "edge-a";
        else if (Math.abs(x - this.x(this.sel.b)) < edge(e)) mode = "edge-b";
      }
      down = { x, start: this.start, mode, moved: false, t0: this.t(x) };
      this.dragging = true;
    });
    c.addEventListener("pointermove", (e) => {
      const { x, y } = pos(e);
      if (touches.has(e.pointerId)) touches.set(e.pointerId, x);
      if (down?.mode === "pinch") {
        if (touches.size < 2) return;
        const p = pinchState();
        const span = Math.min(Timeline.MAX_SPAN, Math.max(Timeline.MIN_SPAN, down.span * down.dist / p.dist));
        const start = down.anchor - (p.mid / this.w) * span; // keep the pinched moment under the fingers
        this.setView(start, start + span);
        this.emitSelection();
        return;
      }
      if (e.pointerType !== "touch") this.hover = x;
      if (!down) {
        const ev = this.eventAt(x, y);
        if (ev !== this.hoverEvent) { this.hoverEvent = ev; this.onHoverEvent?.(ev, x); }
        const nearEdge = this.sel && (Math.abs(x - this.x(this.sel.a)) < 7 || Math.abs(x - this.x(this.sel.b)) < 7);
        c.style.cursor = nearEdge ? "ew-resize" : ev ? "pointer" : this.selectMode ? "crosshair" : "";
        return this.draw();
      }
      if (Math.abs(x - down.x) <= 3 && !down.moved) return;
      down.moved = true;
      if (down.mode === "pan") {
        this.follow = false;
        c.style.cursor = "grabbing";
        const span = this.end - this.start;
        const dt = -(x - down.x) / this.w * span;
        this.setView(down.start + dt, down.start + dt + span);
        this.emitSelection();
      } else if (down.mode === "select") {
        this.setSelection({ a: down.t0, b: this.t(x) });
      } else {
        const t = Math.min(this.t(x), Date.now() / 1000);
        const sel = down.mode === "edge-a" ? { a: t, b: this.sel.b } : { a: this.sel.a, b: t };
        this.setSelection(sel);
        if (this.sel && sel.a > sel.b) down.mode = down.mode === "edge-a" ? "edge-b" : "edge-a";
      }
    });
    const up = (e) => {
      touches.delete(e.pointerId);
      if (down?.mode === "pinch") { if (!touches.size) { down = null; this.dragging = false; } return; }
      if (!down) return;
      const d = down;
      down = null;
      this.dragging = false;
      c.style.cursor = "";
      if (d.moved) return;
      const { x, y } = pos(e);
      const ev = this.eventAt(x, y);
      if (ev && this.onEvent) return this.onEvent(ev);
      this.follow = true;
      this.onSeek(this.t(x));
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", (e) => { touches.delete(e.pointerId); down = null; this.dragging = false; c.style.cursor = ""; });
    c.addEventListener("pointerleave", () => {
      this.hover = null;
      if (this.hoverEvent) { this.hoverEvent = null; this.onHoverEvent?.(null); }
      this.draw();
    });
  }
}

// Sorted merge of recorded spans (new ones may overlap the old tail).
function mergeSpans(a, b) {
  const all = [...a, ...b].sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && s[0] - last[1] <= 2) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800];
function pickStep(minSecs) { return TICK_STEPS.find((s) => s >= minSecs) || TICK_STEPS[TICK_STEPS.length - 1]; }

// First tick at or after `t`, aligned to local wall-clock time. Uses the UTC
// offset at that moment, so ticks stay on the hour across DST changes.
function alignTick(t, step) {
  if (step >= 86400) {
    const d = new Date(t * 1000);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() / 1000 < t) d.setDate(d.getDate() + 1);
    return d.getTime() / 1000;
  }
  const offset = -new Date(t * 1000).getTimezoneOffset() * 60;
  return Math.ceil((t + offset) / step) * step - offset;
}

// Next tick: calendar days for day-sized steps (DST days are 23 or 25 h).
function nextTick(t, step) {
  if (step >= 86400) {
    const d = new Date(t * 1000);
    d.setDate(d.getDate() + Math.round(step / 86400));
    return d.getTime() / 1000;
  }
  return alignTick(t + step * 0.999, step);
}

function tickLabel(d, step, midnight) {
  if (midnight || step >= 86400) return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const opts = { hour: "2-digit", minute: "2-digit" };
  if (step < 60) opts.second = "2-digit";
  return d.toLocaleTimeString([], opts);
}
