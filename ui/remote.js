"use strict";
// Remote control: in TV mode (<html class="tv">, see platform.js) the arrow
// keys move to whatever is nearest on screen in that direction (buttons,
// camera tiles, fields), and OK presses it. A TV's D-pad sends arrow keys
// and Enter, so this is all a remote needs. Back is handled in app.js.
//
// Fields keep the arrows they use: left/right move the caret in a text box,
// change a slider, or move the timeline (anything with data-arrows="x");
// up/down move between a text area's lines until the first or last one.
// Dialogs and open menus keep the focus inside.
//
// Elements that act like buttons but aren't (camera tiles: role="button"
// tabindex="0") are pressed with Enter or Space everywhere, not only on TVs.
const Remote = (() => {
  const on = () => document.documentElement.classList.contains("tv");
  const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const DIRS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

  function usable(el) {
    if (el.disabled || el.closest("[hidden], [inert], .menu[hidden]")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.pointerEvents !== "none" && cs.opacity !== "0";
  }

  // Where focus may go: the open dialog, else an open menu, else the page.
  function scope() {
    const dialogs = [...document.querySelectorAll("dialog[open]")];
    if (dialogs.length) return dialogs.at(-1);
    const menu = [...document.querySelectorAll(".menu:not([hidden])")].find((m) => m.getBoundingClientRect().width);
    return menu || document;
  }
  const candidates = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(usable);

  // The nearest candidate in direction `dir` from rectangle `a`. Things in
  // line with it (overlapping across the direction) come first; among those,
  // the closest, then the one best lined up with it (same start edge, or same
  // centre). Only when nothing is in line, the nearest one off to the side.
  function nearest(a, dir, list, skip) {
    const horiz = dir === "left" || dir === "right";
    let best = null, bestScore = Infinity;
    for (const el of list) {
      if (el === skip || el.contains(skip) || skip?.contains(el)) continue;
      const b = el.getBoundingClientRect();
      const ahead = { right: b.left + b.right - a.left - a.right, left: a.left + a.right - b.left - b.right,
        down: b.top + b.bottom - a.top - a.bottom, up: a.top + a.bottom - b.top - b.bottom }[dir];
      if (ahead <= 2) continue;
      const gap = Math.max(0, { right: b.left - a.right, left: a.left - b.right, down: b.top - a.bottom, up: a.top - b.bottom }[dir]);
      const side = horiz ? Math.max(0, b.top - a.bottom, a.top - b.bottom) : Math.max(0, b.left - a.right, a.left - b.right);
      const align = horiz
        ? Math.min(Math.abs(b.top - a.top), Math.abs(b.top + b.bottom - a.top - a.bottom) / 2)
        : Math.min(Math.abs(b.left - a.left), Math.abs(b.left + b.right - a.left - a.right) / 2);
      const score = (side > 0 ? 1e6 : 0) + gap + side * 3 + align * 0.1;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  // Nothing focused yet: a camera tile if there is one, else the first thing.
  function first(root) {
    const list = candidates(root);
    return list.find((el) => el.matches(".tile")) || list[0] || null;
  }

  function go(el) {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // Keys this element uses itself, so they don't move the focus.
  function ownsKey(el, dir) {
    if (!el || el === document.body) return false;
    const horiz = dir === "left" || dir === "right";
    if (el.dataset?.arrows === "x" && horiz) return true;
    if (el.tagName === "TEXTAREA") {
      if (horiz || el.selectionStart !== el.selectionEnd) return true;
      // leave from the first line going up, or the last going down
      const v = el.value, at = el.selectionStart;
      return dir === "up" ? v.lastIndexOf("\n", at - 1) >= 0 : v.indexOf("\n", at) >= 0;
    }
    if (el.tagName === "INPUT") {
      const t = el.type;
      if (t === "checkbox" || t === "radio" || t === "button" || t === "submit") return false;
      if (t === "range") return horiz;
      if (!horiz) return false;
      // text: leave the field once the caret is at that end
      try {
        const end = dir === "left" ? 0 : el.value.length;
        return !(el.selectionStart === el.selectionEnd && el.selectionStart === end);
      } catch (_) { return true; } // date and number fields
    }
    return false;
  }

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    // Buttons that aren't <button>: Enter / Space presses them (everywhere).
    if ((e.key === "Enter" || e.key === " ") && t?.matches?.('[role="button"][tabindex]') && t === document.activeElement && !e.repeat) {
      e.preventDefault();
      t.click();
      return;
    }
    if (!on() || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
    const dir = DIRS[e.key];
    if (!dir) return;
    const cur = document.activeElement;
    if (ownsKey(cur, dir)) return;
    const root = scope();
    const inside = cur && cur !== document.body && root.contains(cur) && usable(cur);
    const next = inside ? nearest(cur.getBoundingClientRect(), dir, candidates(root), cur) : first(root);
    e.preventDefault();
    e.stopImmediatePropagation(); // the arrows don't also seek or pan
    if (next) go(next);
  }, true);

  return {
    get on() { return on(); },
    // Put the focus somewhere sensible after the screen changed.
    focus(el) { if (on() && el && usable(el)) go(el); },
  };
})();
