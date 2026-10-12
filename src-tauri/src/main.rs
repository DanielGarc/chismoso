// No console window behind the app on Windows release builds.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod about;
mod cli;
mod frigate;
mod jobs;
mod media;
mod metrics;
mod mse;
mod notify;
mod tls;

use frigate::{Camera, CameraGroup, ExportInfo, ExportMode, Frigate, ReviewItem};
use jobs::{JobSpec, Update};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct AppState {
    /// Shared with the local media server.
    client: Arc<Mutex<Option<Frigate>>>,
    media_base: Mutex<String>,
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
struct ConnectInfo {
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
#[tauri::command]
async fn connect(
    state: State<'_, AppState>,
    url: String,
    user: String,
    password: String,
    self_signed: bool,
    pinned: Option<String>,
) -> CmdResult<ConnectInfo> {
    let (c, info) = blocking(move || {
        let trust = tls::Trust { self_signed, pinned, ..Default::default() };
        let c = Frigate::connect(&url, &user, &password, trust)?;
        let (cameras, groups) = c.overview()?;
        let info = ConnectInfo {
            base_url: c.base_url().to_string(),
            version: c.version().unwrap_or_else(|_| "unknown".into()),
            role: c.role(),
            cameras,
            groups,
            cert_fingerprint: if self_signed { c.cert_fingerprint() } else { None },
        };
        Ok((c, info))
    })
    .await?;
    if let Some(w) = state.watcher.lock().unwrap().take() {
        w.stop();
    }
    let old = state.client.lock().unwrap().replace(c);
    retire(old);
    Ok(info)
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>) {
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
async fn camera_toggle(state: State<'_, AppState>, camera: String, feature: String, on: bool) -> CmdResult<()> {
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
async fn review_items(state: State<'_, AppState>, cameras: Vec<String>, after: f64, before: f64) -> CmdResult<Vec<ReviewItem>> {
    let c = client(&state)?;
    blocking(move || c.review_items(&cameras, after, before)).await
}

/// Applies notification settings and starts or stops the watcher. The watcher
/// also runs (without notifying) whenever the UI wants live timeline updates.
#[tauri::command]
fn set_notifications(app: AppHandle, state: State<'_, AppState>, settings: notify::Settings) -> CmdResult<()> {
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
fn app_info() -> about::Info {
    about::info()
}

/// Hardware or software video decoding on this computer (Load screen).
#[tauri::command]
fn video_decoding() -> about::Decoding {
    about::decoding()
}

/// Page-side diagnostics, printed only by debug builds.
#[tauri::command]
fn debug_log(msg: String) {
    if cfg!(debug_assertions) {
        eprintln!("[ui] {msg}");
    }
}

#[tauri::command]
fn test_notification(app: AppHandle) -> CmdResult<()> {
    notify::test(&app)
}

/// What this app has asked of Frigate so far (the UI turns it into rates).
#[tauri::command]
fn app_load() -> metrics::Snapshot {
    metrics::snapshot()
}

/// Viewers per go2rtc stream on the server (everyone, not only this app).
#[tauri::command]
async fn go2rtc_viewers(state: State<'_, AppState>) -> CmdResult<Vec<(String, usize)>> {
    let c = client(&state)?;
    blocking(move || c.go2rtc_viewers()).await
}

#[tauri::command]
async fn cameras(state: State<'_, AppState>) -> CmdResult<Vec<Camera>> {
    let c = client(&state)?;
    blocking(move || c.cameras()).await
}

// ── live view ───────────────────────────────────────────────────────────

#[tauri::command]
async fn webrtc_answer(state: State<'_, AppState>, stream: String, sdp: String) -> CmdResult<String> {
    let c = client(&state)?;
    blocking(move || c.webrtc_answer(&stream, &sdp)).await
}

/// Starts an MSE live stream; control messages (JSON) and video segments
/// (raw bytes) arrive on `on_event`. Stop it with `mse_stop`.
#[tauri::command]
fn mse_start(app: AppHandle, state: State<'_, AppState>, stream: String, codecs: String, on_event: Channel<InvokeResponseBody>) -> CmdResult<u64> {
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
fn mse_stop(state: State<'_, AppState>, id: u64) {
    if let Some(stop) = state.mse.lock().unwrap().remove(&id) {
        stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn stats(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let c = client(&state)?;
    blocking(move || c.stats()).await
}

// ── settings ────────────────────────────────────────────────────────────

#[tauri::command]
async fn config_raw(state: State<'_, AppState>) -> CmdResult<String> {
    let c = client(&state)?;
    blocking(move || c.config_raw()).await
}

#[tauri::command]
async fn config_save(state: State<'_, AppState>, yaml: String, restart: bool) -> CmdResult<String> {
    let c = client(&state)?;
    blocking(move || c.config_save(&yaml, restart)).await
}

#[tauri::command]
async fn restart_frigate(state: State<'_, AppState>) -> CmdResult<()> {
    let c = client(&state)?;
    blocking(move || c.restart()).await
}

// ── exports & timelapses ────────────────────────────────────────────────

#[tauri::command]
async fn list_exports(state: State<'_, AppState>) -> CmdResult<Vec<ExportInfo>> {
    let c = client(&state)?;
    blocking(move || c.list_exports()).await
}

#[tauri::command]
async fn delete_export(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let c = client(&state)?;
    blocking(move || c.delete_export(&id)).await
}

#[derive(Deserialize)]
struct ExportRequest {
    cameras: Vec<String>,
    start: i64,
    end: i64,
    realtime: bool,
    speed: f32,
    fps: u32,
    keyframes_only: bool,
    out_dir: String,
    delete_after: bool,
}

#[derive(Serialize, Clone)]
struct JobEvent {
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
fn start_exports(app: AppHandle, state: State<'_, AppState>, req: ExportRequest) -> CmdResult<Vec<u64>> {
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
fn download_export(app: AppHandle, state: State<'_, AppState>, video_path: String, out_dir: String) -> CmdResult<u64> {
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
fn default_output_dir() -> String {
    dirs::video_dir()
        .or_else(dirs::download_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Frigate Exports")
        .display()
        .to_string()
}

/// Opens a folder, an .mp4 file, or the connected Frigate's web page with the
/// OS default app. Nothing else, so the UI can't be used to launch programs.
#[tauri::command]
fn open_path(state: State<'_, AppState>, path: String, reveal: bool) -> CmdResult<()> {
    let target: std::ffi::OsString = if path.starts_with("http://") || path.starts_with("https://") {
        let base = state.client.lock().unwrap().as_ref().map(|c| c.base_url().to_string());
        if base.as_deref() != Some(path.trim_end_matches('/')) {
            return Err("Only the connected Frigate server can be opened.".into());
        }
        path.into()
    } else {
        let mut p = PathBuf::from(&path);
        if reveal {
            p = p.parent().map(|d| d.to_path_buf()).unwrap_or(p);
        } else if !p.exists() && p.extension().is_none() {
            // the output folder may not exist yet
            let _ = std::fs::create_dir_all(&p);
        }
        let is_mp4 = p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
        if !p.is_dir() && !is_mp4 {
            return Err(format!("Can't open {}.", p.display()));
        }
        p.into_os_string()
    };
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(&target).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&target).spawn();
    r.map(|_| ()).map_err(|e| format!("Couldn't open it: {e}"))
}

// ── recordings ──────────────────────────────────────────────────────────

/// Continuous recorded stretches in a range, for drawing the timeline.
/// Segments closer than `gap` seconds are merged, so a whole day is a
/// handful of spans instead of ~8,600 rows. Several cameras are fetched in
/// parallel and drawn as one bar (time covered by any of them).
#[tauri::command]
async fn recording_spans(state: State<'_, AppState>, cameras: Vec<String>, after: f64, before: f64) -> CmdResult<Vec<[f64; 2]>> {
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
        if rows.is_empty() {
            if let Some(e) = first_err {
                return Err(e);
            }
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
async fn recording_segments(state: State<'_, AppState>, camera: String, after: f64, before: f64) -> CmdResult<Vec<[f64; 3]>> {
    let c = client(&state)?;
    blocking(move || c.recordings(&camera, after, before)).await
}

#[tauri::command]
async fn recording_summary(state: State<'_, AppState>, camera: String, timezone: String) -> CmdResult<serde_json::Value> {
    let c = client(&state)?;
    blocking(move || c.recordings_summary(&camera, &timezone)).await
}

/// Base URL of the local media server (snapshots, export videos).
#[tauri::command]
fn media_base(state: State<'_, AppState>) -> String {
    state.media_base.lock().unwrap().clone()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() && !args[0].starts_with("-psn") {
        attach_console();
        std::process::exit(cli::run(args));
    }

    // Windows: notifications (and the taskbar) show this app's name and icon.
    #[cfg(windows)]
    notify::windows::register(about::IDENTIFIER, about::NAME);

    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let state = app.state::<AppState>();
            let server = media::start(state.client.clone())?;
            *state.media_base.lock().unwrap() = server.base;
            #[cfg(target_os = "linux")]
            if let Some(w) = app.get_webview_window("main") {
                // WebKitGTK ships with WebRTC switched off.
                let _ = w.with_webview(|wv| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    let view = wv.inner();
                    if let Some(s) = view.settings() {
                        if !s.enables_webrtc() {
                            s.set_enable_webrtc(true);
                            s.set_enable_media_stream(true);
                            s.set_media_playback_requires_user_gesture(false);
                            // The page was already created without WebRTC; reload so it gets RTCPeerConnection.
                            view.reload();
                        }
                    }
                });
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            cameras,
            webrtc_answer,
            mse_start,
            mse_stop,
            stats,
            config_raw,
            config_save,
            restart_frigate,
            list_exports,
            delete_export,
            start_exports,
            download_export,
            default_output_dir,
            open_path,
            media_base,
            recording_spans,
            recording_segments,
            recording_summary,
            review_items,
            app_info,
            video_decoding,
            debug_log,
            camera_toggle,
            app_load,
            go2rtc_viewers,
            set_notifications,
            test_notification,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Frigate Desktop");
}

/// Release builds on Windows have no console; reattach to the terminal that
/// launched us so command-line mode can print.
#[cfg(target_os = "windows")]
fn attach_console() {
    unsafe extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }
    unsafe {
        AttachConsole(u32::MAX);
    }
}

#[cfg(not(target_os = "windows"))]
fn attach_console() {}
