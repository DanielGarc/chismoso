//! Mobile (Android, iOS). Same API as desktop.rs.
//!
//! Notes for whoever picks this up:
//! * Alerts only arrive while the app is open: the OS suspends background
//!   sockets. Background alerts need push (APNs/FCM) through a relay; see
//!   docs/PLATFORMS.md.
//! * Files (exports) live in the app's documents folder.

use super::{Decoding, Features};
use tauri::{AppHandle, Builder, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

pub const FEATURES: Features = Features {
    form: "mobile",
    window_controls: false,
    window_fullscreen: false,
    open_files: false,
    choose_folder: false,
    keyboard: false,
    background_alerts: false,
};

pub fn init() {}

pub fn plugins<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.plugin(tauri_plugin_notification::init())
}

pub fn setup(_app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

pub fn notify(app: &AppHandle, title: &str, body: &str, image: Option<&str>) -> Result<(), String> {
    // Android 13+ and iOS ask the user once; the first notification triggers it.
    let n = app.notification();
    if !matches!(n.permission_state(), Ok(tauri::plugin::PermissionState::Granted)) {
        let granted = matches!(n.request_permission(), Ok(tauri::plugin::PermissionState::Granted));
        if !granted {
            return Err("Notifications are turned off for this app in the system settings.".into());
        }
    }
    let mut b = app.notification().builder().title(title).body(body);
    if let Some(url) = image.and_then(|p| tauri::Url::from_file_path(p).ok()) {
        b = b.attachment(tauri_plugin_notification::Attachment::new("snapshot", url));
    }
    b.show().map_err(|e| e.to_string())
}

pub fn default_output_dir(app: &AppHandle) -> String {
    app.path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map(|d| d.join("Frigate Exports").display().to_string())
        .unwrap_or_default()
}

pub fn open_path(_path: &str, _reveal: bool, _connected: Option<&str>) -> Result<(), String> {
    Err("Opening files isn't available on this device yet.".into())
}

pub fn decoding() -> Decoding {
    Decoding { hardware: Some(true), detail: "Phones and tablets decode video in hardware".into(), hint: None }
}
