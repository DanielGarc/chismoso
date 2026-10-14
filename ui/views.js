"use strict";
// Views: the tabs above the live grid. A view is a named wall of cameras laid
// out on a 12×12 grid that always fills the window, so a 1×1 cell has the
// window's shape and a camera spanning 12/k cells in both directions shows a
// k×k layout. Cameras are dropped anywhere, moved, swapped and resized in
// whole cells. This file is only the layout logic (no page access), so it can
// be checked with Node: `node ui/views.js --test`.
//
//   view = { id, name, auto, items: [{ cam, x, y, w, h }] }   (cells, 0-based)
//   auto: true while the view still shows "every camera, arranged for you";
//   it follows the server's camera list until it's edited by hand.
const Views = (() => {
  const N = 12; // cells across and down

  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const inside = (r) => r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= N && r.y + r.h <= N;
  // Is the rectangle free (ignoring item `skip`)?
  const fits = (view, r, skip = -1) => inside(r) && view.items.every((it, i) => i === skip || !overlaps(it, r));
  const itemAt = (view, x, y) => view.items.findIndex((it) => x >= it.x && x < it.x + it.w && y >= it.y && y < it.y + it.h);

  // Side of the square layout that shows n cameras (1, 2×2, 3×3, 4×4, 6×6, 12×12).
  function side(n) {
    for (const k of [1, 2, 3, 4, 6, 12]) if (k * k >= n) return k;
    return 12;
  }

  // Every camera in a k×k layout, in order (at most 144).
  function arrange(cams) {
    const k = side(cams.length), s = N / k;
    return cams.slice(0, N * N).map((cam, i) => ({ cam, x: (i % k) * s, y: Math.floor(i / k) * s, w: s, h: s }));
  }

  // Where a camera dropped on cell (x, y) goes: the biggest square (up to the
  // view's usual tile size) that contains that cell and is free. null: no room.
  function dropRect(view, x, y, size = defaultSize(view)) {
    for (let s = size; s >= 1; s--) {
      // anchor so the square covers (x, y), preferring the cell at its top-left
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) {
          const r = { x: x - dx, y: y - dy, w: s, h: s };
          if (fits(view, r)) return r;
        }
      }
    }
    return null;
  }
  // The size new cameras get: that of the smallest square already there, else 4 (a 3×3 cell).
  function defaultSize(view) {
    const sq = view.items.map((it) => Math.min(it.w, it.h));
    return sq.length ? Math.max(1, Math.min(...sq)) : 4;
  }

  // Drop camera `cam` on cell (x, y). On another camera: replaces it there.
  // Returns the new view, or null if there's no room.
  function drop(view, cam, x, y) {
    const items = view.items.filter((it) => it.cam !== cam); // already in the view: move it
    const v = { ...view, auto: false, items };
    const hit = itemAt(v, x, y);
    if (hit >= 0) {
      v.items = items.map((it, i) => (i === hit ? { ...it, cam } : it));
      return v;
    }
    const r = dropRect(v, x, y);
    return r ? { ...v, items: [...items, { cam, ...r }] } : null;
  }

  // Move item i so that its top-left lands on (x, y). Onto another camera:
  // the two swap places (each keeps the other's spot and size).
  function move(view, i, x, y, px = x, py = y) {
    const it = view.items[i];
    const hit = itemAt(view, px, py);
    if (hit >= 0 && hit !== i) {
      const items = view.items.map((o, j) => (j === i ? { ...o, cam: view.items[hit].cam } : j === hit ? { ...o, cam: it.cam } : o));
      return { ...view, auto: false, items };
    }
    const r = { ...it, x: Math.max(0, Math.min(N - it.w, x)), y: Math.max(0, Math.min(N - it.h, y)) };
    if (!fits(view, r, i)) return null;
    return { ...view, auto: false, items: view.items.map((o, j) => (j === i ? r : o)) };
  }

  // Resize item i to w×h cells (from its top-left), as far as there's room.
  function resize(view, i, w, h) {
    const it = view.items[i];
    w = Math.max(1, Math.min(N - it.x, w));
    h = Math.max(1, Math.min(N - it.y, h));
    // the biggest size up to w×h that's free (ties: the one closest to what was asked)
    let best = null;
    for (let ww = w; ww >= 1; ww--) {
      for (let hh = h; hh >= 1; hh--) {
        if (!fits(view, { ...it, w: ww, h: hh }, i)) continue;
        const score = ww * hh * 100 - Math.abs(w - ww - (h - hh));
        if (!best || score > best.score) best = { w: ww, h: hh, score };
        break; // smaller hh for this ww only loses area
      }
    }
    if (!best) return null;
    return { ...view, auto: false, items: view.items.map((o, j) => (j === i ? { ...o, w: best.w, h: best.h } : o)) };
  }

  const remove = (view, i) => ({ ...view, auto: false, items: view.items.filter((_, j) => j !== i) });

  // Fill the free space with cameras not in the view yet, at the usual size.
  function fill(view, cams) {
    let v = { ...view, auto: false };
    for (const cam of cams.filter((c) => !v.items.some((it) => it.cam === c))) {
      let placed = null;
      for (let y = 0; y < N && !placed; y++) {
        for (let x = 0; x < N && !placed; x++) {
          if (itemAt(v, x, y) >= 0) continue;
          const r = dropRect(v, x, y);
          if (r) placed = { cam, ...r };
        }
      }
      if (!placed) break;
      v = { ...v, items: [...v.items, placed] };
    }
    return v;
  }

  // Reading order (rows, then columns): the order phones show them in.
  const ordered = (view) => [...view.items].sort((a, b) => a.y - b.y || a.x - b.x);

  // An "every camera" view follows the server's list; other views drop
  // cameras the server no longer has.
  function sync(view, cams) {
    if (view.auto) return { ...view, items: arrange(cams) };
    const known = new Set(cams);
    return { ...view, items: view.items.filter((it) => known.has(it.cam)) };
  }

  // Views to start with. Layouts from earlier versions (a list of cameras)
  // become views; otherwise one view with every camera.
  function initial(cams, oldLayouts = [], newId = () => Math.random().toString(36).slice(2, 10)) {
    const known = new Set(cams);
    const views = oldLayouts
      .map((l) => ({ id: newId(), name: String(l.name || "View").slice(0, 40), auto: false,
        items: arrange((l.cameras || []).filter((c) => known.has(c))) }))
      .filter((v) => v.items.length);
    return [{ id: newId(), name: "All cameras", auto: true, items: arrange(cams) }, ...views];
  }

  // Stored views come from local storage: keep only well-formed ones.
  function clean(views) {
    if (!Array.isArray(views)) return null;
    const int = (n) => Number.isInteger(n);
    const out = views
      .filter((v) => v && typeof v.id === "string" && Array.isArray(v.items))
      .map((v) => {
        const view = { id: v.id, name: String(v.name || "View").slice(0, 40), auto: !!v.auto, items: [] };
        for (const it of v.items) {
          const r = { cam: String(it?.cam || ""), x: it?.x, y: it?.y, w: it?.w, h: it?.h };
          if (r.cam && [r.x, r.y, r.w, r.h].every(int) && fits(view, r)) view.items.push(r);
        }
        return view;
      });
    return out.length ? out : null;
  }

  return { N, side, arrange, dropRect, defaultSize, drop, move, resize, remove, fill, ordered, sync, initial, clean, itemAt, fits };
})();

// ── checks: node ui/views.js --test ──
if (typeof process !== "undefined" && process.argv?.includes("--test")) {
  const assert = require("node:assert/strict");
  const cams = ["a", "b", "c", "d", "e"];
  // 5 cameras: a 3×3 layout of 4×4 cells
  const all = Views.initial(cams)[0];
  assert.equal(all.items.length, 5);
  assert.deepEqual(all.items[4], { cam: "e", x: 4, y: 4, w: 4, h: 4 });
  assert.equal(Views.side(1), 1); assert.equal(Views.side(4), 2); assert.equal(Views.side(10), 4); assert.equal(Views.side(40), 12);
  // drop into empty space, at the view's usual size
  let v = Views.drop(all, "f", 9, 9);
  assert.deepEqual(v.items.at(-1), { cam: "f", x: 8, y: 8, w: 4, h: 4 });
  assert.equal(v.auto, false);
  // a small gap gets a smaller camera
  const gap = { id: "g", name: "g", items: [{ cam: "a", x: 0, y: 0, w: 12, h: 11 }, { cam: "b", x: 2, y: 11, w: 10, h: 1 }] };
  assert.deepEqual(Views.drop(gap, "c", 0, 11).items.at(-1), { cam: "c", x: 0, y: 11, w: 1, h: 1 });
  // drop on a camera replaces it
  v = Views.drop(all, "z", 1, 1);
  assert.equal(v.items[0].cam, "z"); assert.equal(v.items.length, 5);
  // dropping a camera already in the view moves it (no duplicate)
  v = Views.drop(all, "a", 9, 9);
  assert.equal(v.items.filter((it) => it.cam === "a").length, 1);
  assert.deepEqual(v.items.find((it) => it.cam === "a"), { cam: "a", x: 8, y: 8, w: 4, h: 4 });
  // move onto another camera swaps them
  v = Views.move(all, 0, 4, 0, 5, 1);
  assert.equal(v.items[0].cam, "b"); assert.equal(v.items[1].cam, "a");
  // move into free space; refuse overlap
  v = Views.move(all, 4, 8, 8);
  assert.deepEqual(v.items[4], { cam: "e", x: 8, y: 8, w: 4, h: 4 });
  // resize grows into free space and stops at neighbours
  v = Views.resize(Views.remove(all, 1), 0, 8, 8); // b removed: a can grow right, but d is below
  assert.deepEqual([v.items[0].w, v.items[0].h], [8, 4]);
  v = Views.resize(all, 4, 99, 99); // e (4,4) grows into the free space right and below it
  assert.deepEqual([v.items[4].w, v.items[4].h], [8, 8]);
  v = Views.resize(all, 0, 99, 99); // a is boxed in by b and d
  assert.deepEqual([v.items[0].w, v.items[0].h], [4, 4]);
  // fill adds missing cameras into free cells
  v = Views.fill({ id: "x", name: "x", items: [{ cam: "a", x: 0, y: 0, w: 4, h: 4 }] }, cams);
  assert.equal(v.items.length, 5);
  assert.ok(v.items.every((it, i) => v.items.every((o, j) => i === j || !(it.x < o.x + o.w && o.x < it.x + it.w && it.y < o.y + o.h && o.y < it.y + it.h))));
  // sync: auto views follow the server, others drop removed cameras
  assert.equal(Views.sync(all, ["a", "b"]).items.length, 2);
  assert.equal(Views.sync({ ...all, auto: false }, ["a", "b"]).items.length, 2);
  // old layouts become views; unknown cameras are skipped
  const init = Views.initial(cams, [{ name: "Out", cameras: ["c", "nope", "a"] }]);
  assert.deepEqual(init.map((x) => x.name), ["All cameras", "Out"]);
  assert.deepEqual(init[1].items.map((it) => it.cam), ["c", "a"]);
  // stored data is checked
  assert.equal(Views.clean("junk"), null);
  const cleaned = Views.clean([{ id: "1", name: "x", items: [{ cam: "a", x: 0, y: 0, w: 4, h: 4 }, { cam: "b", x: 2, y: 2, w: 4, h: 4 }, { cam: "c", x: 11, y: 0, w: 4, h: 1 }] }]);
  assert.deepEqual(cleaned[0].items.map((it) => it.cam), ["a"]); // overlap and out-of-bounds dropped
  assert.deepEqual(Views.ordered({ items: [{ cam: "b", x: 4, y: 0 }, { cam: "a", x: 0, y: 0 }, { cam: "c", x: 0, y: 4 }] }).map((it) => it.cam), ["a", "b", "c"]);
  console.log("views: all checks passed");
}
