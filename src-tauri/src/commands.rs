//! Every command the UI can call. Platform-neutral: anything that differs
//! between desktop and mobile goes through `crate::platform`.

use crate::frigate::{Camera, CameraGroup, ExportInfo, ExportMode, Frigate, ReviewItem};
use crate::jobs::{self, JobSpec, Update};
use crate::{about, metrics, mse, notify, platform, session, tls};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct AppState {
    /// Shared with the local media server.
    pub(crate) client: Arc<Mutex<Option<Frigate>>>,
    pub(crate) media_base: Mutex<String>,
    next_job: AtomicU64,
    /// Running MSE live streams: id -> stop flag.
    mse: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    /// Notification settings (shared with the watcher thread) and the watcher.
    notify: Arc<Mutex<notify::Settings>>,
    watcher: Mutex<Option<notify::Watcher>>,
}

type CmdResult<T> = Result<T, String>;

/// Runs blocking network work off the async runtime. The client is moved in
/// and dropped there too, which the blocking HTTP client requires.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || f().map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

fn client(state: &State<'_, AppState>) -> CmdResult<Frigate> {
    state.client.lock().unwrap().clone().ok_or_else(|| "Not connected to Frigate.".to_string())
}

/// Drops a client on a plain thread (never inside the async runtime).
fn retire(old: Option<Frigate>) {
    if let Some(c) = old {
        std::thread::spawn(move || drop(c));
    }
}

// ── connection ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub(crate) struct ConnectInfo {
    base_url: String,
    version: String,
    role: String,
    cameras: Vec<Camera>,
    groups: Vec<CameraGroup>,
    /// SHA-256 of the server certificate, when trusting a self-signed one.
    cert_fingerprint: Option<String>,
}

/// `self_signed`: trust a certificate the OS doesn't, pinned to `pinned`
/// (the fingerprint trusted last time) or, on first use, to whatever the
/// server presents. The UI stores the returned fingerprint.
///
/// `keep`: remember the session token (not the password) so the next start
/// signs in by itself; see session.rs. Unchecked, any kept session is removed.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    user: String,
    password: String,
    self_signed: bool,
    pinned: Option<String>,
    keep: bool,
) -> CmdResult<ConnectInfo> {
    let dir = session_dir(&app);
    let (c, info) = blocking(move || {
        let trust = tls::Trust { self_signed, pinned, ..Default::default() };
        let mut c = Frigate::connect(&url, &user, &password, trust)?;
        let info = overview_info(&c, self_signed)?;
        match (keep, c.token(), &dir) {
            (true, Some(token), Some(dir)) => {
                let saved = session::Saved {
                    url: info.base_url.clone(),
                    user: user.trim().to_string(),
                    token,
                    self_signed,
                    pinned: info.cert_fingerprint.clone(),
                };
                if let Err(e) = session::save(dir, &saved) {
                    eprintln!("couldn't keep the session: {e}");
                }
                keep_current(&mut c, dir.clone(), saved);
            }
            (_, _, Some(dir)) => session::clear(dir),
            _ => {}
        }
        Ok((c, info))
    })
    .await?;
    install_client(&state, c);
    Ok(info)
}

/// Signs in with the session kept by "Keep me signed in", if there is one.
/// Ok(None): nothing kept. An expired session is forgotten and reported as
/// `session-expired:`; other failures (server offline, certificate changed)
/// keep it so the next try can still use it.
#[tauri::command]
pub(crate) async fn resume(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<KeptSession>> {
    let Some(dir) = session_dir(&app) else { return Ok(None) };
    let Some(saved) = session::load(&dir) else { return Ok(None) };
    let (c, info) = blocking(move || {
        let trust = tls::Trust { self_signed: saved.self_signed, pinned: saved.pinned.clone(), ..Default::default() };
        let mut c = match Frigate::resume(&saved.url, &saved.token, trust) {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("{e:#}");
                if msg.starts_with("session-expired:") {
                    session::clear(&dir);
                    anyhow::bail!("session-expired: Your saved sign-in has expired. Sign in again to continue.");
                }
                return Err(e);
            }
        };
        let info = overview_info(&c, saved.self_signed)?;
        let kept = KeptSession { url: saved.url.clone(), user: saved.user.clone(), info };
        keep_current(&mut c, dir, saved);
        Ok((c, kept))
    })
    .await?;
    install_client(&state, c);
    Ok(Some(info))
}

#[derive(Serialize)]
pub(crate) struct KeptSession {
    url: String,
    user: String,
    info: ConnectInfo,
}

fn session_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

/// Keeps the saved session current as Frigate renews the token.
fn keep_current(c: &mut Frigate, dir: PathBuf, saved: session::Saved) {
    let saved = Mutex::new(saved);
    c.on_token(Arc::new(move |t: &str| {
        let mut s = saved.lock().unwrap();
        s.token = t.to_string();
        let _ = session::save(&dir, &s);
    }));
}

fn overview_info(c: &Frigate, self_signed: bool) -> anyhow::Result<ConnectInfo> {
    let (cameras, groups) = c.overview()?;
    Ok(ConnectInfo {
        base_url: c.base_url().to_string(),
        version: c.version().unwrap_or_else(|_| "unknown".into()),
        role: c.role(),
        cameras,
        groups,
        cert_fingerprint: if self_signed { c.cert_fingerprint() } else { None },
    })
}

fn install_client(state: &State<'_, AppState>, c: Frigate) {
    if let Some(w) = state.watcher.lock().unwrap().take() {
        w.stop();
    }
    let old = state.client.lock().unwrap().replace(c);
    retire(old);
}

/// Signing out also forgets a kept session.
#[tauri::command]
pub(crate) fn disconnect(app: AppHandle, state: State<'_, AppState>) {
    if let Some(dir) = session_dir(&app) {
        session::clear(&dir);
    }
    if let Some(w) = state.watcher.lock().unwrap().take() {
        w.stop();
    }
    for (_, stop) in state.mse.lock().unwrap().drain() {
        stop.store(true, Ordering::Relaxed);
    }
    let old = state.client.lock().unwrap().take();
    retire(old);
}

/// Switches detection, recording or snapshots for a camera (admin only).
/// Frigate applies it immediately; it lasts until Frigate restarts.
#[tauri::command]
pub(crate) async fn camera_toggle(state: State<'_, AppState>, camera: String, feature: String, on: bool) -> CmdResult<()> {
    if !matches!(feature.as_str(), "detect" | "recordings" | "snapshots") {
        return Err("Unknown setting.".into());
    }
    if camera.contains('/') {
        return Err("Bad camera name.".into());
    }
    let c = client(&state)?;
    blocking(move || mse::send_command(&c, &format!("{camera}/{feature}/set"), if on { "ON" } else { "OFF" })).await
}

#[tauri::command]
pub(crate) async fn review_items(state: State<'_, AppState>, cameras: Vec<String>, after: f64, before: f64) -> CmdResult<Vec<ReviewItem>> {
    let c = client(&state)?;
    blocking(move || c.review_items(&cameras, after, before)).await
}

/// Applies notification settings and starts or stops the watcher. The watcher
/// also runs (without notifying) whenever the UI wants live timeline updates.
#[tauri::command]
pub(crate) fn set_notifications(app: AppHandle, state: State<'_, AppState>, settings: notify::Settings) -> CmdResult<()> {
    *state.notify.lock().unwrap() = settings;
    let mut w = state.watcher.lock().unwrap();
    if w.is_none() {
        let c = client(&state)?;
        *w = Some(notify::start(app, c, state.notify.clone()));
    }
    Ok(())
}

/// Name, version, commit and platform for the About box.
#[tauri::command]
pub(crate) fn app_info() -> about::Info {
    about::info()
}

/// Hardware or software video decoding on this computer (Load screen).
#[tauri::command]
pub(crate) fn video_decoding() -> platform::Decoding {
    platform::decoding()
}

/// Is there a newer release? (desktop; always None on phones)
#[tauri::command]
pub(crate) async fn check_update(app: AppHandle) -> CmdResult<Option<platform::UpdateInfo>> {
    platform::check_update(&app).await
}

/// Installs the update found by check_update, sending progress (0..1) as
/// "update-progress" events, then restarts.
#[tauri::command]
pub(crate) async fn install_update(app: AppHandle) -> CmdResult<()> {
    let events = app.clone();
    platform::install_update(&app, move |p| {
        let _ = events.emit("update-progress", p);
    })
    .await
}

/// Page-side diagnostics, printed only by debug builds.
#[tauri::command]
pub(crate) fn debug_log(msg: String) {
    if cfg!(debug_assertions) {
        eprintln!("[ui] {msg}");
    }
}

#[tauri::command]
pub(crate) fn test_notification(app: AppHandle) -> CmdResult<()> {
    platform::notify(&app, "Notifications are on", "You'll get a notification like this when Frigate raises an alert.", None)
}

/// What this app has asked of Frigate so far (the UI turns it into rates).
#[tauri::command]
pub(crate) fn app_load() -> metrics::Snapshot {
    metrics::snapshot()
}

/// Viewers per go2rtc stream on the server (everyone, not only this app).
#[tauri::command]
pub(crate) async fn go2rtc_viewers(state: State<'_, AppState>) -> CmdResult<Vec<(String, usize)>> {
    let c = client(&state)?;
    blocking(move || c.go2rtc_viewers()).await
}

#[tauri::command]
pub(crate) async fn cameras(state: State<'_, AppState>) -> CmdResult<Vec<Camera>> {
    let c = client(&state)?;
    blocking(move || c.cameras()).await
}

// ── live view ───────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn webrtc_answer(state: State<'_, AppState>, stream: String, sdp: String) -> CmdResult<String> {
    let c = client(&state)?;
    blocking(move || c.webrtc_answer(&stream, &sdp)).await
}

/// Starts an MSE live stream; control messages (JSON) and video segments
/// (raw bytes) arrive on `on_event`. Stop it with `mse_stop`.
#[tauri::command]
pub(crate) fn mse_start(app: AppHandle, state: State<'_, AppState>, stream: String, codecs: String, on_event: Channel<InvokeResponseBody>) -> CmdResult<u64> {
    let c = client(&state)?;
    let id = state.next_job.fetch_add(1, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    state.mse.lock().unwrap().insert(id, stop.clone());
    std::thread::spawn(move || {
        let r = mse::run(
            &c,
            &stream,
            &codecs,
            stop,
            |text| on_event.send(InvokeResponseBody::Json(text)).is_ok(),
            |bytes| on_event.send(InvokeResponseBody::Raw(bytes)).is_ok(),
        );
        if let Err(e) = r {
            let msg = serde_json::json!({ "type": "error", "value": format!("{e:#}") }).to_string();
            let _ = on_event.send(InvokeResponseBody::Json(msg));
        }
        app.state::<AppState>().mse.lock().unwrap().remove(&id);
    });
    Ok(id)
}

#[tauri::command]
pub(crate) fn mse_stop(state: State<'_, AppState>, id: u64) {
    if let Some(stop) = state.mse.lock().unwrap().remove(&id) {
        stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub(crate) async fn stats(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let c = client(&state)?;
    blocking(move || c.stats()).await
}

// ── settings ────────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn config_raw(state: State<'_, AppState>) -> CmdResult<String> {
    let c = client(&state)?;
    blocking(move || c.config_raw()).await
}

#[tauri::command]
pub(crate) async fn config_save(state: State<'_, AppState>, yaml: String, restart: bool) -> CmdResult<String> {
    let c = client(&state)?;
    blocking(move || c.config_save(&yaml, restart)).await
}

#[tauri::command]
pub(crate) async fn restart_frigate(state: State<'_, AppState>) -> CmdResult<()> {
    let c = client(&state)?;
    blocking(move || c.restart()).await
}

// ── exports & timelapses ────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn list_exports(state: State<'_, AppState>) -> CmdResult<Vec<ExportInfo>> {
    let c = client(&state)?;
    blocking(move || c.list_exports()).await
}

#[tauri::command]
pub(crate) async fn delete_export(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let c = client(&state)?;
    blocking(move || c.delete_export(&id)).await
}

#[derive(Deserialize)]
pub(crate) struct ExportRequest {
    cameras: Vec<String>,
    start: i64,
    end: i64,
    realtime: bool,
    speed: f32,
    fps: u32,
    keyframes_only: bool,
    #[serde(default)]
    small: bool,
    out_dir: String,
    delete_after: bool,
}

#[derive(Serialize, Clone)]
pub(crate) struct JobEvent {
    id: u64,
    state: &'static str, // running | done | failed
    stage: String,
    progress: f32,
    path: Option<String>,
    error: Option<String>,
}

fn emit_update(app: &AppHandle, id: u64, u: Update) {
    let ev = match u {
        Update::Stage(stage, progress) => JobEvent { id, state: "running", stage, progress, path: None, error: None },
        Update::Done(p) => JobEvent { id, state: "done", stage: "Saved".into(), progress: 1.0, path: Some(p.display().to_string()), error: None },
        Update::Failed(e) => JobEvent { id, state: "failed", stage: String::new(), progress: 0.0, path: None, error: Some(e) },
    };
    let _ = app.emit("job", ev);
}

/// Queues one export per camera. Returns the job ids (one per camera, in
/// order); progress arrives as "job" events.
#[tauri::command]
pub(crate) fn start_exports(app: AppHandle, state: State<'_, AppState>, req: ExportRequest) -> CmdResult<Vec<u64>> {
    let c = client(&state)?;
    if req.end <= req.start {
        return Err("End must be after start.".into());
    }
    let mode = if req.realtime { ExportMode::Realtime } else { ExportMode::Timelapse { speed: req.speed, fps: req.fps, keyframes_only: req.keyframes_only } };
    let specs: Vec<(u64, JobSpec)> = req
        .cameras
        .iter()
        .map(|cam| {
            let id = state.next_job.fetch_add(1, Ordering::Relaxed);
            let spec = JobSpec {
                camera: cam.clone(),
                start: req.start,
                end: req.end,
                mode,
                small: req.small,
                out_dir: PathBuf::from(req.out_dir.trim()),
                delete_after_download: req.delete_after,
            };
            (id, spec)
        })
        .collect();
    let ids = specs.iter().map(|(id, _)| *id).collect();
    // Submit every camera at once: Frigate queues them and renders up to
    // record.export.max_concurrent (3 by default) in parallel.
    for (id, spec) in specs {
        let (c, app) = (c.clone(), app.clone());
        std::thread::spawn(move || jobs::run(&c, &spec, &mut |u| emit_update(&app, id, u)));
    }
    std::thread::spawn(move || drop(c));
    Ok(ids)
}

/// Downloads an export that already exists on the server.
#[tauri::command]
pub(crate) fn download_export(app: AppHandle, state: State<'_, AppState>, video_path: String, out_dir: String) -> CmdResult<u64> {
    let c = client(&state)?;
    let id = state.next_job.fetch_add(1, Ordering::Relaxed);
    std::thread::spawn(move || {
        // Never trust the server's file name: strip any path, keep it plain, force .mp4.
        let stem = video_path.rsplit(['/', '\\']).next().unwrap_or("export");
        let stem = jobs::sanitize(stem.trim_end_matches(".mp4"));
        let dest = jobs::unique_path(&PathBuf::from(out_dir.trim()), if stem.is_empty() { "export" } else { &stem }, "mp4");
        let mut last = std::time::Instant::now();
        let r = c.download(&video_path, &dest, |done, total| {
            if last.elapsed().as_millis() > 150 {
                last = std::time::Instant::now();
                let frac = total.map(|t| done as f32 / t.max(1) as f32).unwrap_or(0.0);
                emit_update(&app, id, Update::Stage(format!("Downloading… {:.1} MB", done as f64 / 1e6), frac));
            }
        });
        emit_update(&app, id, match r {
            Ok(p) => Update::Done(p),
            Err(e) => Update::Failed(format!("{e:#}")),
        });
    });
    Ok(id)
}

#[tauri::command]
pub(crate) fn default_output_dir(app: AppHandle) -> String {
    platform::default_output_dir(&app)
}

/// Opens a folder, an .mp4 file, or the connected Frigate's web page with the
/// OS default app. Nothing else, so the UI can't be used to launch programs.
#[tauri::command]
pub(crate) fn open_path(state: State<'_, AppState>, path: String, reveal: bool) -> CmdResult<()> {
    let base = state.client.lock().unwrap().as_ref().map(|c| c.base_url().to_string());
    platform::open_path(&path, reveal, base.as_deref())
}

// ── recordings ──────────────────────────────────────────────────────────

/// Continuous recorded stretches in a range, for drawing the timeline.
/// Segments closer than `gap` seconds are merged, so a whole day is a
/// handful of spans instead of ~8,600 rows. Several cameras are fetched in
/// parallel and drawn as one bar (time covered by any of them).
#[tauri::command]
pub(crate) async fn recording_spans(state: State<'_, AppState>, cameras: Vec<String>, after: f64, before: f64) -> CmdResult<Vec<[f64; 2]>> {
    let c = client(&state)?;
    blocking(move || {
        let per_camera: Vec<anyhow::Result<Vec<[f64; 3]>>> = std::thread::scope(|scope| {
            let handles: Vec<_> = cameras.iter().map(|cam| scope.spawn(|| c.recordings(cam, after, before))).collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(anyhow::anyhow!("lookup failed")))).collect()
        });
        let mut rows: Vec<[f64; 2]> = Vec::new();
        let mut first_err = None;
        for r in per_camera {
            match r {
                Ok(v) => rows.extend(v.into_iter().map(|[s, e, _]| [s, e])),
                Err(e) => first_err = first_err.or(Some(e)),
            }
        }
        if rows.is_empty()
            && let Some(e) = first_err {
                return Err(e);
            }
        rows.sort_by(|a, b| a[0].total_cmp(&b[0]));
        let mut spans: Vec<[f64; 2]> = Vec::new();
        for [s, e] in rows {
            match spans.last_mut() {
                Some(last) if s - last[1] <= 2.0 => last[1] = last[1].max(e),
                _ => spans.push([s, e]),
            }
        }
        Ok(spans)
    })
    .await
}

/// Raw segments (start, end, media duration) for playback mapping.
#[tauri::command]
pub(crate) async fn recording_segments(state: State<'_, AppState>, camera: String, after: f64, before: f64) -> CmdResult<Vec<[f64; 3]>> {
    let c = client(&state)?;
    blocking(move || c.recordings(&camera, after, before)).await
}

#[tauri::command]
pub(crate) async fn recording_summary(state: State<'_, AppState>, camera: String, timezone: String) -> CmdResult<serde_json::Value> {
    let c = client(&state)?;
    blocking(move || c.recordings_summary(&camera, &timezone)).await
}

/// Base URL of the local media server (snapshots, export videos).
#[tauri::command]
pub(crate) fn media_base(state: State<'_, AppState>) -> String {
    state.media_base.lock().unwrap().clone()
}


// ── sharing ─────────────────────────────────────────────────────────────

/// Only finished videos and pictures the app made can be shared or copied.
fn shareable(paths: Vec<String>) -> CmdResult<Vec<PathBuf>> {
    if paths.is_empty() || paths.len() > 20 {
        return Err("Pick between 1 and 20 files.".into());
    }
    paths
        .into_iter()
        .map(|p| {
            let p = PathBuf::from(p);
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if p.is_file() && matches!(ext.as_str(), "mp4" | "jpg" | "jpeg" | "png") {
                Ok(p)
            } else {
                Err(format!("Can't share {}: the file isn't there any more.", p.display()))
            }
        })
        .collect()
}

/// The system share menu (macOS, Windows), pointing at the button that opened it.
#[tauri::command]
pub(crate) fn share_files(window: tauri::WebviewWindow, paths: Vec<String>, anchor: platform::Anchor) -> CmdResult<()> {
    platform::share_files(&window, &shareable(paths)?, anchor)
}

/// Files on the clipboard, ready to paste into a chat or an email.
#[tauri::command]
pub(crate) async fn copy_files(paths: Vec<String>) -> CmdResult<()> {
    let paths = shareable(paths)?;
    blocking(move || platform::copy_files(&paths).map_err(anyhow::Error::msg)).await
}

/// Saves a full-size picture from a camera to the exports folder: the live
/// image, or the recording at `at` (seconds since 1970) when playing back.
/// Returns the file's path.
#[tauri::command]
pub(crate) async fn save_snapshot(state: State<'_, AppState>, camera: String, at: Option<f64>, out_dir: String) -> CmdResult<String> {
    if camera.contains('/') || camera.is_empty() {
        return Err("Bad camera name.".into());
    }
    let c = client(&state)?;
    blocking(move || {
        use std::io::Read;
        let cam = crate::frigate::enc(&camera);
        let path = match at {
            Some(t) => format!("/api/{cam}/recordings/{t:.3}/snapshot.jpg"),
            None => format!("/api/{cam}/latest.jpg?quality=95"),
        };
        let mut resp = c.get_quick(&path, 20)?;
        if !resp.status().is_success() {
            anyhow::bail!("Frigate couldn't make a picture from {camera} ({}).", resp.status());
        }
        let mut bytes = Vec::new();
        resp.read_to_end(&mut bytes)?;
        let dir = PathBuf::from(out_dir.trim());
        std::fs::create_dir_all(&dir)?;
        let when = stamp(at);
        let mut file = dir.join(format!("{camera} {when}.jpg"));
        let mut n = 2;
        while file.exists() {
            file = dir.join(format!("{camera} {when} ({n}).jpg"));
            n += 1;
        }
        std::fs::write(&file, bytes)?;
        Ok(file.to_string_lossy().into_owned())
    })
    .await
}

/// "2026-10-12 21-30-05" in local time (file-name safe).
fn stamp(at: Option<f64>) -> String {
    use chrono::{Local, TimeZone};
    let t = at.and_then(|t| Local.timestamp_opt(t as i64, 0).single()).unwrap_or_else(Local::now);
    t.format("%Y-%m-%d %H-%M-%S").to_string()
}
