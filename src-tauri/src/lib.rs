//! The app, shared by desktop and mobile. `main.rs` (desktop) and the
//! mobile entry point both call `run()`.
//!
//! Layout:
//! * Core (no platform code): frigate, jobs, media, metrics, mse, notify (the
//!   alert watcher), tls, about.
//! * `commands`: what the UI calls.
//! * `platform`: everything that differs by OS or form factor. If you need a
//!   `#[cfg(...)]`, it belongs there.

pub mod about;
#[cfg(desktop)]
pub mod cli;
mod commands;
pub mod frigate;
pub mod jobs;
mod media;
pub mod metrics;
mod mse;
mod notify;
pub mod platform;
pub mod tls;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tls::init();
    platform::init();
    let builder = platform::plugins(tauri::Builder::default());
    builder
        .manage(commands::AppState::default())
        .setup(|app| {
            let state = app.state::<commands::AppState>();
            let server = media::start(state.client.clone())?;
            *state.media_base.lock().unwrap() = server.base;
            platform::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::disconnect,
            commands::cameras,
            commands::webrtc_answer,
            commands::mse_start,
            commands::mse_stop,
            commands::stats,
            commands::config_raw,
            commands::config_save,
            commands::restart_frigate,
            commands::list_exports,
            commands::delete_export,
            commands::start_exports,
            commands::download_export,
            commands::default_output_dir,
            commands::open_path,
            commands::media_base,
            commands::recording_spans,
            commands::recording_segments,
            commands::recording_summary,
            commands::review_items,
            commands::app_info,
            commands::check_update,
            commands::install_update,
            commands::video_decoding,
            commands::debug_log,
            commands::camera_toggle,
            commands::app_load,
            commands::go2rtc_viewers,
            commands::set_notifications,
            commands::test_notification,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
