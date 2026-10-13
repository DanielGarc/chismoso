// Themes: built-in palettes (themes.css) plus one custom theme.
//
// Loaded in <head>, before the page is drawn, so the saved theme applies
// without a flash. A custom theme is a built-in "base" plus up to four colours
// (accent, background, panels, text); every other token is derived from those
// so a handful of picks still gives a consistent palette. Custom themes can be
// copied and pasted as a small JSON snippet to share them.
// Settings → Appearance is wired up in app.js.
"use strict";
const Theme = (() => {
  const BUILT_IN = { dark: "Dark", light: "Light", black: "Black" };
  const KEYS = ["accent", "bg", "panel", "text"];
  const root = document.documentElement;
  const sysLight = matchMedia("(prefers-color-scheme: light)");
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} },
  };

  // ── colour helpers (#rrggbb only) ──
  const HEX = /^#[0-9a-f]{6}$/i;
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lum = (h) => { const [r, g, b] = rgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
  // computed tokens can come back as #rgb / #rrggbbaa; normalise to #rrggbb
  const norm = (v) => {
    v = (v || "").trim();
    if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("");
    if (/^#[0-9a-f]{8}$/i.test(v)) return v.slice(0, 7);
    return HEX.test(v) ? v.toLowerCase() : null;
  };

  function loadCustom() {
    try {
      const t = JSON.parse(store.get("customTheme") || "null");
      return t && typeof t === "object" ? sanitize(t) : null;
    } catch (_) { return null; }
  }
  // Only known keys and plain #rrggbb colours survive (pasted text is untrusted).
  function sanitize(t) {
    const out = { base: BUILT_IN[t.base] ? t.base : "dark", name: String(t.name || "Custom").slice(0, 40) };
    for (const k of KEYS) if (HEX.test(t[k] || "")) out[k] = t[k].toLowerCase();
    return out;
  }

  const DERIVED = ["--accent", "--accent-2", "--accent-hover", "--focus-ring", "--tl-rec", "--tl-sel", "--sel-bg", "--sel-text",
    "--info-bg", "--info-line", "--info-text", "--glow", "--bg", "--inset", "--sunken", "--bar-2", "--tl-bg", "--tl-future",
    "--panel", "--panel-2", "--bar-1", "--tl-track", "--text", "--muted", "--faint", "--tl-text", "--tl-day",
    "--line", "--line-strong", "--row-line", "--tl-tick", "--chart-base", "--rate-track", "--rate-tick", "--switch-off"];

  function applyCustom(t) {
    root.dataset.theme = t.base;
    for (const p of DERIVED) root.style.removeProperty(p);
    const cs = getComputedStyle(root);
    const base = (p) => norm(cs.getPropertyValue(p)) || "#808080";
    const light = t.base === "light";
    const bg = t.bg || base("--bg"), panel = t.panel || base("--panel"), text = t.text || base("--text"), accent = t.accent || base("--accent");
    const ink = light ? "#000000" : "#ffffff";
    const v = {};
    if (t.accent) {
      Object.assign(v, {
        "--accent": accent,
        "--accent-2": light ? mix(accent, "#000000", 0.15) : mix(accent, "#ffffff", 0.25),
        "--accent-hover": mix(accent, "#000000", 0.12),
        "--focus-ring": accent + "55",
        "--tl-rec": mix(accent, "#000000", 0.1),
        "--tl-sel": light ? accent : mix(accent, "#ffffff", 0.25),
        "--sel-text": light ? mix(accent, "#000000", 0.5) : mix(accent, "#ffffff", 0.8),
        "--info-text": light ? mix(accent, "#000000", 0.5) : mix(accent, "#ffffff", 0.7),
      });
    }
    if (t.accent || t.bg || t.panel) {
      Object.assign(v, {
        "--sel-bg": mix(panel, accent, 0.22), "--info-bg": mix(bg, accent, 0.14),
        "--info-line": mix(bg, accent, 0.4), "--glow": mix(bg, accent, 0.18),
      });
    }
    if (t.bg) {
      Object.assign(v, {
        "--bg": bg, "--inset": mix(bg, "#000000", light ? 0.04 : 0.2), "--sunken": mix(bg, panel, 0.3),
        "--bar-2": mix(bg, panel, 0.4), "--tl-bg": mix(bg, "#000000", light ? 0.02 : 0.1), "--tl-future": mix(bg, panel, 0.2),
      });
    }
    if (t.panel) Object.assign(v, { "--panel": panel, "--panel-2": mix(panel, ink, 0.05), "--bar-1": panel, "--tl-track": mix(panel, ink, 0.04) });
    if (t.text) Object.assign(v, { "--text": text, "--tl-day": mix(text, bg, 0.12) });
    if (t.text || t.bg) Object.assign(v, { "--muted": mix(text, bg, 0.38), "--faint": mix(text, bg, 0.62), "--tl-text": mix(text, bg, 0.38) });
    if (t.text || t.panel) {
      Object.assign(v, {
        "--line": mix(panel, text, 0.14), "--line-strong": mix(panel, text, 0.26), "--row-line": mix(panel, text, 0.08),
        "--tl-tick": mix(panel, text, 0.1), "--chart-base": mix(panel, text, 0.14), "--rate-track": mix(panel, text, 0.14),
        "--rate-tick": mix(panel, text, 0.26), "--switch-off": mix(panel, text, 0.26),
      });
    }
    for (const [k, val] of Object.entries(v)) root.style.setProperty(k, val);
  }

  function apply() {
    const id = Theme.current();
    for (const p of DERIVED) root.style.removeProperty(p);
    if (id === "custom") applyCustom(loadCustom() || { base: "dark" });
    else root.dataset.theme = id === "system" ? (sysLight.matches ? "light" : "dark") : id;
    document.dispatchEvent(new Event("themechange"));
  }

  const Theme = {
    builtIn: BUILT_IN,
    keys: KEYS,
    current() { const t = store.get("theme"); return t === "system" || t === "custom" || BUILT_IN[t] ? t : "dark"; },
    set(id) { store.set("theme", id === "dark" ? null : id); apply(); },
    custom() { return loadCustom() || { base: "dark", name: "Custom" }; },
    // The colours a custom theme starts from: its own picks, else the base's.
    resolved(t) {
      const probe = { ...t };
      applyCustom({ base: t.base });                 // base colours only, to read them
      const cs = getComputedStyle(root);
      const out = {};
      const css = { accent: "--accent", bg: "--bg", panel: "--panel", text: "--text" };
      for (const k of KEYS) out[k] = probe[k] || norm(cs.getPropertyValue(css[k])) || "#808080";
      apply();                                       // back to what's selected
      return out;
    },
    saveCustom(t) { store.set("customTheme", JSON.stringify(sanitize(t))); store.set("theme", "custom"); apply(); },
    exportCustom() { return JSON.stringify({ "chismoso-theme": 1, ...Theme.custom() }); },
    importCustom(text) {
      let t;
      try { t = JSON.parse(String(text).trim()); } catch (_) { throw new Error("That isn't a theme. Paste the text from “Copy theme”."); }
      if (!t || typeof t !== "object" || !("chismoso-theme" in t)) throw new Error("That isn't a Chismoso theme.");
      Theme.saveCustom(t);
      return Theme.custom();
    },
    contrast(a, b) { const x = lum(a) + 0.05, y = lum(b) + 0.05; return x > y ? x / y : y / x; },
    apply,
  };
  sysLight.addEventListener("change", () => { if (Theme.current() === "system") apply(); });
  apply();
  return Theme;
})();
