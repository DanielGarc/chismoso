"use strict";
// Live video players. Every player takes an AbortSignal: once aborted it never
// touches the <video> again and releases its connection, so a slow start can't
// take over a video element that has moved on (to another camera or to
// recordings).

const abortError = () => Object.assign(new Error("cancelled"), { name: "AbortError" });
const checkAbort = (signal) => { if (signal?.aborted) throw abortError(); };

// WebRTC: the SDP offer/answer goes through the Rust backend (which holds the
// Frigate login); media then flows directly from go2rtc (port 8555).
const WebRTC = (() => {
  const invoke = (...a) => window.__TAURI__.core.invoke(...a);
  const active = new Set(); // open peer connections, for the load meter

  const supported = () => typeof RTCPeerConnection === "function";

  // Wait until ICE gathering finishes (we send one complete offer, no trickle).
  function gathered(pc, ms = 2000) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { pc.removeEventListener("icegatheringstatechange", check); resolve(); };
      const check = () => pc.iceGatheringState === "complete" && done();
      pc.addEventListener("icegatheringstatechange", check);
      setTimeout(done, ms);
    });
  }

  async function play(video, stream, { signal, timeoutMs = 12000 } = {}) {
    if (!supported()) throw new Error("This system's web view has no WebRTC support.");
    checkAbort(signal);
    const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    active.add(pc);
    const media = new MediaStream();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      active.delete(pc);
      try { pc.close(); } catch (_) {}
      if (video.srcObject === media) video.srcObject = null;
    };
    signal?.addEventListener("abort", close, { once: true });

    try {
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.ontrack = (e) => media.addTrack(e.track);

      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      checkAbort(signal);
      const answer = await invoke("webrtc_answer", { stream, sdp: pc.localDescription.sdp });
      checkAbort(signal);
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      checkAbort(signal);

      video.srcObject = media;
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(
          "No video arrived. Check that Frigate's WebRTC port (8555) is reachable and go2rtc's webrtc candidates include this machine's network.")), timeoutMs);
        const finish = (fn) => (arg) => { clearTimeout(t); fn(arg); };
        video.addEventListener("loadeddata", finish(resolve), { once: true });
        signal?.addEventListener("abort", finish(() => reject(abortError())), { once: true });
        pc.addEventListener("connectionstatechange", () => {
          if (pc.connectionState === "failed") finish(reject)(new Error("WebRTC connection failed (port 8555 blocked?)."));
        });
        video.play().catch(() => {});
      });
      return { pc, close };
    } catch (e) {
      close();
      throw e;
    }
  }

  // Bytes received over all open WebRTC connections (for the load meter).
  async function bytesReceived() {
    let total = 0;
    for (const pc of active) {
      try {
        (await pc.getStats()).forEach((r) => { if (r.type === "inbound-rtp") total += r.bytesReceived || 0; });
      } catch (_) {}
    }
    return total;
  }

  return { play, supported, bytesReceived, count: () => active.size };
})();

// MSE live view: go2rtc sends fragmented MP4 over a WebSocket that the Rust
// side opens; segments arrive here as raw bytes and are fed to MediaSource.
const MSE = (() => {
  const { invoke, Channel } = window.__TAURI__.core;
  const MS = window.ManagedMediaSource || window.MediaSource;
  const CODECS = ["avc1.640029", "avc1.64002A", "avc1.640033", "hvc1.1.6.L153.B0", "mp4a.40.2", "mp4a.40.5", "flac", "opus"];

  const supported = () => !!MS;

  async function play(video, stream, { signal, timeoutMs = 15000 } = {}) {
    if (!MS) throw new Error("This system's web view can't play live MP4 either.");
    checkAbort(signal);
    const ms = new MS();
    const url = URL.createObjectURL(ms);
    let sb = null, queue = [], id = null, closed = false, failure = null, onFail = null;

    const close = () => {
      if (closed) return;
      closed = true;
      if (id !== null) invoke("mse_stop", { id }).catch(() => {});
      try { if (ms.readyState === "open") ms.endOfStream(); } catch (_) {}
      URL.revokeObjectURL(url);
      if (video.src === url) { video.removeAttribute("src"); video.load(); }
    };
    signal?.addEventListener("abort", () => { close(); onFail?.(abortError()); }, { once: true });
    const fail = (e) => { failure = e; onFail?.(e); };

    video.srcObject = null;
    video.disableRemotePlayback = true;
    video.src = url;
    await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
    if (closed) throw abortError();

    const codecs = CODECS.filter((c) => MS.isTypeSupported(`video/mp4; codecs="${c}"`)).join();

    const pump = () => {
      if (!sb || sb.updating || closed || !queue.length) return;
      try {
        const b = sb.buffered;
        if (b.length && video.currentTime - b.start(0) > 30) { // keep memory bounded
          sb.remove(b.start(0), video.currentTime - 10);
          return;
        }
        let chunk;
        if (queue.length === 1) chunk = queue.shift();
        else {
          const parts = queue.splice(0), n = parts.reduce((a, p) => a + p.byteLength, 0);
          chunk = new Uint8Array(n);
          let o = 0;
          for (const p of parts) { chunk.set(p, o); o += p.byteLength; }
        }
        sb.appendBuffer(chunk);
      } catch (e) { fail(e); }
    };

    const onUpdate = () => {
      const b = sb.buffered;
      if (b.length) {
        const end = b.end(b.length - 1);
        if (end - video.currentTime > 2) video.currentTime = end - 0.5; // stay near live
        if (video.paused) video.play().catch(() => {});
      }
      pump();
    };

    const ch = new Channel();
    ch.onmessage = (msg) => {
      if (closed) return;
      if (msg instanceof ArrayBuffer) { queue.push(new Uint8Array(msg)); pump(); return; }
      if (Array.isArray(msg)) { queue.push(new Uint8Array(msg)); pump(); return; }
      if (typeof msg === "string") { try { msg = JSON.parse(msg); } catch (_) { return; } }
      if (msg.type === "mse") {
        try {
          sb = ms.addSourceBuffer(msg.value);
          sb.mode = "segments";
          sb.addEventListener("updateend", onUpdate);
          pump();
        } catch (e) { fail(new Error(`Unsupported video format (${msg.value}).`)); }
      } else if (msg.type === "error") {
        fail(new Error(msg.value));
      }
    };

    try {
      id = await invoke("mse_start", { stream, codecs, onEvent: ch });
      if (closed) { invoke("mse_stop", { id }).catch(() => {}); throw abortError(); }
      await new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        const t = setTimeout(() => reject(new Error("No video arrived over the MSE stream.")), timeoutMs);
        onFail = (e) => { clearTimeout(t); reject(e); };
        video.addEventListener("loadeddata", () => { clearTimeout(t); onFail = null; resolve(); }, { once: true });
        video.play().catch(() => {});
      });
    } catch (e) { close(); throw e; }

    const handle = { kind: "mse", close, onDrop: null };
    onFail = (e) => { if (e.name !== "AbortError") handle.onDrop?.(e); };
    return handle;
  }

  return { play, supported };
})();

// Tries WebRTC, then MSE. Resolves with { kind, close, onDrop }.
// Rejects with an AbortError (name === "AbortError") if `signal` fires first.
const Live = {
  async play(video, stream, { signal } = {}) {
    let firstError = null;
    if (WebRTC.supported()) {
      try {
        const h = await WebRTC.play(video, stream, { signal });
        const handle = { kind: "webrtc", close: h.close, onDrop: null };
        h.pc.addEventListener("connectionstatechange", () => {
          if (["failed", "disconnected"].includes(h.pc.connectionState)) handle.onDrop?.(new Error("WebRTC connection dropped."));
        });
        return handle;
      } catch (e) {
        if (e.name === "AbortError") throw e;
        firstError = e;
      }
    }
    if (MSE.supported()) {
      try { return await MSE.play(video, stream, { signal }); }
      catch (e) {
        if (e.name === "AbortError") throw e;
        throw firstError ? new Error(`${firstError.message} MSE fallback: ${e.message}`) : e;
      }
    }
    throw firstError || new Error("No live video support in this web view.");
  },
  supported: () => WebRTC.supported() || MSE.supported(),
};
