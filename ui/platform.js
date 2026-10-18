"use strict";
// What this device can do, in one place. The Rust side reports it
// (src-tauri/src/platform, `Features`); everything in the UI asks
//   Platform.has("open_files")
// instead of checking the OS or screen size. Markup can do the same:
//   <button data-needs="open_files">…</button>   hidden when missing
//   <p data-needs-not="background_alerts">…</p>  shown only when missing
// The layout follows `form` ("desktop" | "mobile") via <html data-form>,
// plus a narrow-screen media query in style.css for small desktop windows.
// TV mode (<html class="tv">): on by itself on a TV (feature "tv"), or by the
// user's choice in Settings ("tvMode": auto | on | off, this device only).

const Platform = (() => {
  const mobileGuess = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  // Until the backend answers (one IPC round trip), assume by user agent.
  let features = {
    form: mobileGuess ? "mobile" : "desktop",
    window_controls: !mobileGuess, window_fullscreen: !mobileGuess, open_files: !mobileGuess,
    choose_folder: !mobileGuess, keyboard: !mobileGuess, background_alerts: !mobileGuess,
  };

  // Compact layout: phones, and desktop windows narrower than a phablet.
  const narrow = matchMedia("(max-width: 700px)");
  narrow.addEventListener?.("change", () => apply());
  const compact = () => features.form === "mobile" || narrow.matches;
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) {} return null; };
  let tvMode = store("tvMode") || "auto";
  const tv = () => tvMode === "on" || (tvMode === "auto" && !!features.tv);

  function apply(root = document) {
    const html = document.documentElement;
    html.dataset.form = features.form;
    html.toggleAttribute("data-compact", compact());
    html.classList.toggle("touch", matchMedia("(pointer: coarse)").matches);
    if (html.classList.contains("tv") !== tv()) {
      html.classList.toggle("tv", tv());
      document.dispatchEvent(new Event("tvmode"));
    }
    for (const [k, v] of Object.entries(features)) if (typeof v === "boolean") html.classList.toggle("no-" + k.replace(/_/g, "-"), !v);
    root.querySelectorAll("[data-needs]").forEach((el) => { el.hidden = !features[el.dataset.needs]; });
    root.querySelectorAll("[data-needs-not]").forEach((el) => { el.hidden = !!features[el.dataset.needsNot]; });
  }

  const info = window.__TAURI__.core.invoke("app_info").then((i) => {
    if (i.features) features = i.features;
    apply();
    return i;
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply());
  else apply();

  return {
    has: (name) => !!features[name],
    get form() { return features.form; },
    get mobile() { return features.form === "mobile"; },
    get compact() { return compact(); },
    // "tap" on touch screens, "click" with a mouse (for instructions in text).
    get tap() { return matchMedia("(pointer: coarse)").matches ? "tap" : "click"; },
    info,        // Promise of the full app_info (name, version, features…)
    apply,       // re-run after adding gated markup dynamically
    get tv() { return tv(); },
    get tvMode() { return tvMode; },
    setTvMode(m) { tvMode = m; store("tvMode", m); apply(); },
  };
})();
