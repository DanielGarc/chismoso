#!/usr/bin/env python3
"""Measures how long Chismoso takes from launch to cameras on screen.

Runs the real app (a release build) against dev/mock_frigate.py with a kept
session ("Keep me signed in"), several times, in a throwaway data folder, and
prints the median of each step. Linux; needs Xvfb (xvfb-run) for a headless run.

    cd src-tauri && cargo build --release && cd ..
    python3 dev/bench_startup.py --latency 40 --stream-start 1200 --runs 7
    python3 dev/bench_startup.py --live      # live video grid instead of pictures

Times are milliseconds since the page started loading (webview start-up is
the separate "process" number). Steps:
  signed_in     the server accepted the saved session and listed the cameras
  grid          tiles on screen
  first_picture / all_pictures   first / every tile showing an image
  all_live      every tile playing video (--live)
"""
import argparse, json, os, shutil, socket, statistics, subprocess, sys, tempfile, time, urllib.request, ssl
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_ID = "org.caprichosos.chismoso"


def wait_port(port, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    sys.exit(f"mock didn't start on port {port}")


def token(port):
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
    req = urllib.request.Request(f"https://127.0.0.1:{port}/api/login", method="POST",
                                 data=json.dumps({"user": "admin", "password": "password"}).encode(),
                                 headers={"Content-Type": "application/json", "X-CSRF-TOKEN": "1"})
    with urllib.request.urlopen(req, context=ctx) as r:
        cookie = r.headers["Set-Cookie"]
    return cookie.split("frigate_token=")[1].split(";")[0]


def one_run(binary, port, tok, prefs, timeout):
    data = Path(tempfile.mkdtemp(prefix="chismoso-bench-"))
    try:
        app_dir = data / APP_ID
        app_dir.mkdir(parents=True)
        (app_dir / "session.json").write_text(json.dumps({
            "url": f"https://127.0.0.1:{port}", "user": "admin", "token": tok, "self_signed": True, "pinned": None}))
        env = dict(os.environ, XDG_DATA_HOME=str(data), XDG_CONFIG_HOME=str(data / "config"),
                   XDG_CACHE_HOME=str(data / "cache"), CHISMOSO_TIMING="exit",
                   CHISMOSO_BENCH_PREFS=json.dumps(prefs))
        cmd = ["xvfb-run", "-a", "-s", "-screen 0 1440x900x24", str(binary)]
        # xvfb-run sends the app's stderr to stdout
        p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            out = p.communicate(timeout=timeout)[0]
        except subprocess.TimeoutExpired:
            p.kill()
            out = p.communicate()[0]
            print("timed out; app output:\n" + out[-1500:], file=sys.stderr)
            return None
        for line in out.splitlines():
            if line.startswith("CHISMOSO_TIMING "):
                return json.loads(line.split(" ", 1)[1])
        print(out[-2000:], file=sys.stderr)
        return None
    finally:
        shutil.rmtree(data, ignore_errors=True)


def steps(r):
    m = r["marks"]
    imgs = [v for k, v in m.items() if k.startswith(("img:", "vid:"))]
    vids = [v for k, v in m.items() if k.startswith("vid:")]
    out = {"process": r["process_ms"], "page_ready": m.get("app_js"), "signed_in": m.get("signed_in"),
           "grid": m.get("grid"), "first_picture": min(imgs) if imgs else None, "all_pictures": m.get("all_pictures")}
    if r["marks"].get("grid_live"):
        out["all_live"] = max(vids) if len(vids) == m.get("tiles") else None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", default=str(ROOT / "src-tauri/target/release/chismoso"))
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--latency", type=int, default=40, help="ms added to every request by the mock")
    ap.add_argument("--stream-start", type=int, default=1200, help="ms before a cold camera stream starts")
    ap.add_argument("--live", action="store_true", help="live video grid")
    ap.add_argument("--port", type=int, default=5543)
    ap.add_argument("--json", help="also write every run here")
    a = ap.parse_args()

    mock = subprocess.Popen([sys.executable, str(ROOT / "dev/mock_frigate.py"), "--tls", "--port", str(a.port),
                             "--latency", str(a.latency), "--stream-start", str(a.stream_start)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_port(a.port)
        tok = token(a.port)
        prefs = {"gridLive": a.live, "keep": True}
        runs = []
        for i in range(a.runs):
            r = one_run(a.binary, a.port, tok, prefs, timeout=60)
            if r is None:
                print(f"run {i + 1}: no timing (app failed or timed out)", file=sys.stderr)
                continue
            s = steps(r)
            runs.append(s)
            print(f"run {i + 1}: " + "  ".join(f"{k}={v}" for k, v in s.items()), flush=True)
            time.sleep(1.5)  # let the mock close streams so the next run starts cold
    finally:
        mock.terminate()
    if not runs:
        sys.exit("no successful runs")
    print(f"\nmedian of {len(runs)} runs (latency {a.latency} ms, stream start {a.stream_start} ms, "
          f"{'live grid' if a.live else 'picture grid'}):")
    for k in runs[0]:
        vals = [r[k] for r in runs if r.get(k) is not None]
        if vals:
            print(f"  {k:<14}{statistics.median(vals):>7.0f} ms")
    if a.json:
        Path(a.json).write_text(json.dumps(runs, indent=1))


if __name__ == "__main__":
    main()
