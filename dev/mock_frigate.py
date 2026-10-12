#!/usr/bin/env python3
"""A small stand-in for a Frigate server, for developing and testing the app
without real cameras.

    pip install aiohttp aiortc
    python3 dev/mock_frigate.py            # http://127.0.0.1:5055 (no login)
    python3 dev/mock_frigate.py --tls      # https://127.0.0.1:5443, self-signed, login admin / password

It implements the endpoints Frigate Desktop uses: login, config, stats,
snapshots, WebRTC (a real peer streaming a test video), exports with job
progress, config editing and restart.
"""

import argparse
import asyncio
import json
import os
import ssl
import time
from pathlib import Path

from aiohttp import web

HERE = Path(__file__).resolve().parent
MEDIA = HERE / "mock-media"
USER, PASSWORD, TOKEN = "admin", "password", "test-token-123"

CAMERAS = {
    "doorbell": {"friendly_name": "Doorbell", "live": {"streams": {"Doorbell": "doorbell"}}},
    "pool": {"friendly_name": "Pool", "live": {"streams": {"Main": "pool", "Sub": "pool_sub"}}},
    "north_outside": {"friendly_name": "North Outside", "live": {"streams": {}}},
    "garage": {"friendly_name": "Garage", "live": {"streams": {}}},
}

CONFIG_YAML = """mqtt:
  enabled: false

cameras:
  doorbell:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/doorbell
          roles: [record, detect]
  pool:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/pool
          roles: [record, detect]
"""

state = {"exports": {}, "requests": [], "config": CONFIG_YAML, "pcs": set(),
         "switches": {c: {"detect": True, "record": True, "snapshots": c != "garage"} for c in CAMERAS},
         "viewers": {}}
REQUIRE_AUTH = False


def log(kind, **kw):
    state["requests"].append({"kind": kind, **kw})
    print(kind, json.dumps(kw)[:300], flush=True)


@web.middleware
async def auth(request, handler):
    if request.method not in ("GET", "HEAD") and "origin" in request.headers and "x-csrf-token" not in request.headers:
        return web.json_response({"success": False, "message": "Missing CSRF header"}, status=401)
    if REQUIRE_AUTH and request.path not in ("/api/login", "/api/version"):
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return web.json_response({"detail": "Authentication required"}, status=401)
    return await handler(request)


async def login(request):
    if not REQUIRE_AUTH:
        return web.json_response({"message": "Authentication is disabled"}, status=404)
    body = await request.json()
    if body.get("user") == USER and body.get("password") == PASSWORD:
        resp = web.Response(text="")
        resp.headers["Set-Cookie"] = f"frigate_token={TOKEN}; HttpOnly; Max-Age=86400; Path=/"
        return resp
    return web.json_response({"message": "Login failed"}, status=401)


async def version(_):
    return web.Response(text="0.18.0-mock")


async def profile(_):
    return web.json_response({"username": USER, "role": "admin", "allowed_cameras": list(CAMERAS)})


async def config(_):
    cams = {}
    for k, v in CAMERAS.items():
        sw = state["switches"][k]
        cams[k] = {"enabled": True, **v, "detect": {"enabled": sw["detect"]}, "record": {"enabled": sw["record"]},
                   "snapshots": {"enabled": sw["snapshots"]}}
    return web.json_response({"cameras": cams, "camera_groups": {
        "outside": {"cameras": ["north_outside", "pool", "doorbell"], "icon": "LuTree", "order": 1}}})


# ── review items: a detection every ~25 min, an alert every ~2 h ──────
def review_items(after, before):
    out = []
    t = (after // 1500) * 1500
    while t < before:
        if recorded(t) and after <= t < before:
            alert = int(t) % 7200 == 0 or int(t // 1500) % 5 == 0
            labels = ["person"] if alert else (["car"] if int(t // 1500) % 2 else ["dog"])
            out.append({"id": f"rv-{int(t)}", "camera": "", "start_time": t + 120, "end_time": t + 120 + (75 if alert else 40),
                        "severity": "alert" if alert else "detection", "thumb_path": "/media/frigate/clips/review/thumb.jpg",
                        "data": {"objects": labels, "audio": [], "sub_labels": []}})
        t += 1500
    return out


async def review(request):
    after = float(request.query.get("after", time.time() - 86400))
    before = float(request.query.get("before", time.time()))
    cam = request.query.get("cameras", "all")
    cams = [c for c in cam.split(",") if c] or ["all"]
    items = []
    for n, c in enumerate(cams):  # each camera gets its own (shifted) events
        for i in review_items(after - n * 300, before - n * 300):
            i = dict(i, camera=c, id=f"{i['id']}-{c}", start_time=i["start_time"] + n * 300, end_time=i["end_time"] + n * 300)
            if after <= i["start_time"] < before:
                items.append(i)
    log("review", camera=cam, hours=round((before - after) / 3600, 2), items=len(items))
    return web.json_response(items)


# ── /ws: Frigate's MQTT-style socket (runtime switches) ───────────────
WS_CLIENTS = set()


def review_message(camera="doorbell", severity="alert"):
    now = time.time()
    after = {"id": f"live-{int(now)}", "camera": camera, "severity": severity, "start_time": now, "end_time": None,
             "thumb_path": "/media/frigate/clips/review/thumb.jpg",
             "data": {"objects": ["person"], "sub_labels": [], "zones": ["porch"], "audio": [],
                      "detections": [f"{now:.6f}-car", f"{now:.6f}-person"]}}
    return json.dumps({"topic": "reviews", "payload": json.dumps({"type": "new", "before": after, "after": after})})


async def event_json(request):
    eid = request.match_info["id"]
    return web.json_response({"id": eid, "label": "person" if eid.endswith("person") else "car", "camera": "doorbell"})


async def event_snapshot(request):
    log("event_snapshot", id=request.match_info["id"])
    return web.FileResponse(MEDIA / "doorbell.jpg", headers={"Content-Type": "image/jpeg"})


async def debug_review(request):
    msg = review_message(request.query.get("camera", "doorbell"), request.query.get("severity", "alert"))
    for sock in list(WS_CLIENTS):
        await sock.send_str(msg)
    log("debug_review", clients=len(WS_CLIENTS))
    return web.json_response({"sent": len(WS_CLIENTS)})


async def ws(request):
    sock = web.WebSocketResponse()
    await sock.prepare(request)
    WS_CLIENTS.add(sock)
    log("ws_open", clients=len(WS_CLIENTS))
    try:
        await ws_loop(sock)
    finally:
        WS_CLIENTS.discard(sock)
    return sock


async def ws_loop(sock):
    async for msg in sock:
        try:
            m = json.loads(msg.data)
        except Exception:
            continue
        log("ws", topic=m.get("topic"), payload=m.get("payload"))
        parts = (m.get("topic") or "").split("/")
        if len(parts) == 3 and parts[2] == "set" and parts[0] in CAMERAS:
            key = {"recordings": "record"}.get(parts[1], parts[1])
            if key in state["switches"][parts[0]]:
                state["switches"][parts[0]][key] = m.get("payload") == "ON"


async def go2rtc_streams(_):
    out = {}
    for cam, v in CAMERAS.items():
        for s in (v["live"]["streams"].values() or [cam]) or [cam]:
            out[s] = {"producers": [{}], "consumers": [{}] * state["viewers"].get(s, 0)}
        out.setdefault(cam, {"producers": [{}], "consumers": [{}] * state["viewers"].get(cam, 0)})
    return web.json_response(out)


async def stats(_):
    now = time.time()
    return web.json_response({
        "service": {"version": "0.18.0-mock", "uptime": 93784,
                    "storage": {"/media/frigate/recordings": {"total": 1863000.0, "used": 410000.0, "free": 1453000.0}}},
        "detectors": {"onnx": {"inference_speed": 33.4}},
        "gpu_usages": {"nvidia-quadro": {"gpu": "12%", "mem": "40%"}},
        "cpu_usages": {"frigate.full_system": {"cpu": "23.5", "mem": "41.0"}},
        "cameras": {k: {"camera_fps": 5.0 if k != "garage" else 0.0, "process_fps": 5.0, "detection_fps": 1.2 + (now % 3) / 10,
                        "skipped_fps": 0.0} for k in CAMERAS},
    })


async def latest(request):
    cam = request.match_info["camera"]
    log("snapshot", camera=cam, path=request.path, h=request.query.get("h") or request.query.get("height"))
    if cam not in CAMERAS:
        return web.json_response({"success": False, "message": "Camera not found"}, status=404)
    return web.FileResponse(MEDIA / f"{cam}.jpg", headers={"Content-Type": "image/jpeg"})


# ── WebRTC: a real peer that streams the sample video ─────────────────
async def webrtc(request):
    from aiortc import RTCPeerConnection, RTCSessionDescription
    from aiortc.contrib.media import MediaPlayer

    src = request.query.get("src", "")
    offer = await request.json()
    log("webrtc", src=src)
    if src.split("_sub")[0] not in CAMERAS:
        return web.json_response({"error": f"stream not found: {src}"}, status=404)
    pc = RTCPeerConnection()
    state["pcs"].add(pc)

    @pc.on("connectionstatechange")
    async def _():
        print("webrtc state", src, pc.connectionState, flush=True)
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            state["pcs"].discard(pc)

    player = MediaPlayer(str(MEDIA / "sample.mp4"), loop=True)
    await pc.setRemoteDescription(RTCSessionDescription(sdp=offer["sdp"], type=offer["type"]))
    for t in pc.getTransceivers():
        if t.kind == "video":
            t.sender.replaceTrack(player.video)
            t.direction = "sendonly"
    await pc.setLocalDescription(await pc.createAnswer())
    return web.json_response({"type": "answer", "sdp": pc.localDescription.sdp})


# ── MSE: fragmented MP4 over a WebSocket, paced like a live camera ───
def load_fragments():
    import struct
    data = (MEDIA / "live_frag.mp4").read_bytes()
    boxes, i = [], 0
    while i < len(data):
        size, typ = struct.unpack(">I4s", data[i:i + 8])
        boxes.append((typ, data[i:i + size]))
        i += size
    init = b"".join(b for t, b in boxes if t in (b"ftyp", b"moov"))
    frags, cur = [], b""
    for t, b in boxes:
        if t == b"moof":
            cur = b
        elif t == b"mdat" and cur:
            frags.append(cur + b)
            cur = b""
    return init, frags


async def mse_ws(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    src = request.query.get("src", "")
    log("mse", src=src, auth=bool(request.headers.get("Authorization")))
    msg = await ws.receive_json()
    if msg.get("type") != "mse":
        await ws.close()
        return ws
    init, frags = load_fragments()
    state["viewers"][src] = state["viewers"].get(src, 0) + 1
    await ws.send_str(json.dumps({"type": "mse", "value": 'video/mp4; codecs="avc1.42E01F"'}))
    await ws.send_bytes(init)
    try:
        for f in frags:  # 12 frames at 25 fps per fragment
            await ws.send_bytes(f)
            await asyncio.sleep(12 / 25)
    except (ConnectionResetError, RuntimeError):
        pass
    finally:
        state["viewers"][src] = max(0, state["viewers"].get(src, 1) - 1)
    await ws.close()
    return ws


# ── recordings: 10 s segments for the last 7 days, with a few gaps ────
SEG = 10.0


def recorded(t):
    """Is wall time t inside a mock recording? Gaps: 03:00-03:30 every night,
    and 80-70 minutes ago (as if the camera dropped out)."""
    now = time.time()
    if t < now - 7 * 86400 or t > now:
        return False
    lt = time.localtime(t)
    if lt.tm_hour == 3 and lt.tm_min < 30:
        return False
    if now - 80 * 60 <= t < now - 70 * 60:
        return False
    return True


def segments(after, before):
    t = (after // SEG) * SEG
    out = []
    while t < before:
        if recorded(t) and t + SEG <= time.time():
            out.append(t)
        t += SEG
    return out


async def recordings(request):
    cam = request.match_info["camera"]
    after = float(request.query.get("after", time.time() - 3600))
    before = float(request.query.get("before", time.time()))
    log("recordings", camera=cam, hours=round((before - after) / 3600, 2))
    rows = [{"id": f"{cam}-{int(t)}", "start_time": t, "end_time": t + SEG, "duration": SEG,
             "segment_size": 1.2, "motion": 0, "objects": 0, "motion_heatmap": None} for t in segments(after, before)]
    return web.json_response(rows)


async def recordings_summary(request):
    now = time.time()
    days = {}
    t = (now // 3600) * 3600
    while t > now - 7 * 86400:
        lt = time.localtime(t)
        dur = sum(SEG for s in segments(t, t + 3600))
        if dur:
            key = time.strftime("%Y-%m-%d", lt)
            days.setdefault(key, {"day": key, "events": 0, "hours": []})["hours"].append(
                {"hour": time.strftime("%H", lt), "duration": dur, "motion": 0, "objects": 0, "events": 0})
        t -= 3600
    return web.json_response(list(days.values()))


# ── VOD: HLS with fMP4 segments, like Frigate's nginx-vod ─────────────
VOD = MEDIA / "vod"


async def vod(request):
    s, e, f = float(request.match_info["start"]), float(request.match_info["end"]), request.match_info["file"]
    if f == "master.m3u8":
        log("vod", camera=request.match_info["camera"], start=s, end=e)
        body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.4d401e"\nindex-v1.m3u8\n'
        return web.Response(text=body, content_type="application/vnd.apple.mpegurl")
    if f.endswith(".m3u8"):
        n = min(len(segments(s, e)), 180)
        lines = [l for l in (VOD / "index.m3u8").read_text().splitlines()]
        out, count = [], 0
        for l in lines:
            if l.startswith("seg-"):
                if count >= n:
                    continue
                count += 1
            if l.startswith("#EXTINF") and count >= n:
                continue
            out.append(l)
        return web.Response(text="\n".join(out) + "\n", content_type="application/vnd.apple.mpegurl")
    path = VOD / f
    if not path.is_file():
        return web.Response(status=404)
    return web.FileResponse(path, headers={"Content-Type": "video/mp4"})


# ── exports ──────────────────────────────────────────────────────────
def export_row(e):
    return {"id": e["id"], "camera": e["camera"], "name": e["name"], "date": e["created"],
            "video_path": f"/media/frigate/exports/{e['id']}.mp4",
            "thumb_path": "/media/frigate/clips/export/thumb.jpg", "in_progress": e["status"] != "success"}


def export_status(e):
    age = time.time() - e["created"]
    if age < 1.5:
        return "queued", 0
    if age < 5:
        return "running", min(99, (age - 1.5) / 3.5 * 100)
    return "success", 100


async def start_export(request):
    cam = request.match_info["camera"]
    if cam not in CAMERAS:
        return web.json_response({"success": False, "message": f"{cam} is not a valid camera."}, status=404)
    body = await request.json()
    custom = "/custom/" in request.path
    log("export", camera=cam, custom=custom, start=request.match_info["start"], end=request.match_info["end"], body=body)
    eid = f"{cam}_{int(time.time() * 1000) % 1000000}"
    state["exports"][eid] = {"id": eid, "camera": cam, "name": body.get("name") or eid, "created": time.time(), "status": "queued"}
    return web.json_response({"success": True, "message": "Export queued.", "export_id": eid, "status": "queued"}, status=202)


async def job(request):
    e = state["exports"].get(request.match_info["id"])
    if not e:
        return web.json_response({"success": False, "message": "Job not found"}, status=404)
    status, pct = export_status(e)
    e["status"] = status
    out = {"id": e["id"], "status": status, "progress_percent": pct, "error_message": None, "results": None}
    if status == "success":
        out["results"] = {"video_path": export_row(e)["video_path"]}
    return web.json_response(out)


async def exports(_):
    for e in state["exports"].values():
        e["status"] = export_status(e)[0]
    return web.json_response([export_row(e) for e in sorted(state["exports"].values(), key=lambda e: -e["created"])])


async def delete_exports(request):
    body = await request.json()
    log("delete", ids=body.get("ids"))
    for i in body.get("ids", []):
        state["exports"].pop(i, None)
    return web.json_response({"success": True, "message": "Deleted"})


async def export_file(request):
    log("export_file", range=request.headers.get("Range"))
    return web.FileResponse(MEDIA / "sample.mp4", headers={"Content-Type": "video/mp4"})


async def clip_thumb(_):
    return web.FileResponse(MEDIA / "thumb.jpg", headers={"Content-Type": "image/jpeg"})


# ── config ────────────────────────────────────────────────────────────
async def config_raw(_):
    return web.Response(text=json.dumps(state["config"]), content_type="text/plain")


async def config_save(request):
    text = await request.text()
    opt = request.query.get("save_option")
    log("config_save", option=opt, length=len(text))
    if "cameras:" not in text:
        return web.json_response({"success": False, "message": "Your configuration is invalid.\n\nLine 1: cameras - Field required"}, status=400)
    state["config"] = text
    msg = "Config successfully saved, restarting (this can take up to one minute)..." if opt == "restart" else "Config successfully saved."
    return web.json_response({"success": True, "message": msg})


async def restart(_):
    log("restart")
    return web.json_response({"success": True, "message": "Restarting (this can take up to one minute)..."})


async def debug_requests(_):
    return web.json_response(state["requests"])


def main():
    global REQUIRE_AUTH
    ap = argparse.ArgumentParser()
    ap.add_argument("--tls", action="store_true", help="serve HTTPS with a self-signed cert and require login")
    ap.add_argument("--port", type=int)
    a = ap.parse_args()
    REQUIRE_AUTH = a.tls

    app = web.Application(middlewares=[auth])
    r = app.router
    r.add_post("/api/login", login)
    r.add_get("/api/version", version)
    r.add_get("/api/profile", profile)
    r.add_get("/api/config", config)
    r.add_get("/api/config/raw", config_raw)
    r.add_post("/api/config/save", config_save)
    r.add_post("/api/restart", restart)
    r.add_get("/api/stats", stats)
    r.add_post("/api/go2rtc/webrtc", webrtc)
    r.add_get("/live/mse/api/ws", mse_ws)
    r.add_get("/api/exports", exports)
    r.add_post("/api/exports/delete", delete_exports)
    r.add_get("/api/jobs/export/{id}", job)
    r.add_post("/api/export/custom/{camera}/start/{start}/end/{end}", start_export)
    r.add_post("/api/export/{camera}/start/{start}/end/{end}", start_export)
    r.add_get("/api/{camera}/latest.jpg", latest)
    r.add_get("/api/{camera}/recordings", recordings)
    r.add_get("/api/{camera}/recordings/summary", recordings_summary)
    r.add_get("/vod/{camera}/start/{start}/end/{end}/{file}", vod)
    r.add_get("/exports/{file}", export_file)
    r.add_get("/clips/export/{file}", clip_thumb)
    r.add_get("/clips/review/{file}", clip_thumb)
    r.add_get("/api/review", review)
    r.add_get("/ws", ws)
    r.add_get("/api/go2rtc/streams", go2rtc_streams)
    r.add_get("/debug/requests", debug_requests)
    r.add_get("/debug/review", debug_review)
    r.add_get("/api/events/{id}/snapshot.jpg", event_snapshot)
    r.add_get("/api/events/{id}", event_json)
    r.add_get("/api/{camera}/recordings/{t}/snapshot.jpg", latest)

    ctx = None
    if a.tls:
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.load_cert_chain(MEDIA / "cert.pem", MEDIA / "key.pem")
    port = a.port or (5443 if a.tls else 5055)
    print(f"mock Frigate on {'https' if a.tls else 'http'}://127.0.0.1:{port}", flush=True)
    web.run_app(app, host="127.0.0.1", port=port, ssl_context=ctx, print=None)


if __name__ == "__main__":
    main()
