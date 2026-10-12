//! Desktop (Windows, macOS, Linux).

use super::{Decoding, Features};
use std::path::PathBuf;
use tauri::{AppHandle, Builder, Runtime};

pub const FEATURES: Features = Features {
    form: "desktop",
    window_controls: true,
    window_fullscreen: true,
    open_files: true,
    choose_folder: true,
    keyboard: true,
    background_alerts: true,
};

/// Before the window exists.
pub fn init() {
    // Windows: notifications (and the taskbar) show this app's name and icon.
    #[cfg(windows)]
    windows::register(crate::about::IDENTIFIER, crate::about::NAME);
}

pub fn plugins<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
}

/// Once the window exists.
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            // WebKitGTK ships with WebRTC switched off.
            let _ = w.with_webview(|wv| {
                use webkit2gtk::{SettingsExt, WebViewExt};
                let view = wv.inner();
                if let Some(s) = view.settings()
                    && !s.enables_webrtc() {
                        s.set_enable_webrtc(true);
                        s.set_enable_media_stream(true);
                        s.set_media_playback_requires_user_gesture(false);
                        // The page was already created without WebRTC; reload so it gets RTCPeerConnection.
                        view.reload();
                    }
            });
        }
    }
    let _ = app;
    Ok(())
}

/// One native notification, with an optional picture (a file path). Sent with
/// notify-rust directly (what Tauri's notification plugin uses underneath):
/// the plugin can't attach images, and on Windows falls back to PowerShell's
/// identity unless the app was installed.
pub fn notify(_app: &AppHandle, title: &str, body: &str, image: Option<&str>) -> Result<(), String> {
    let mut n = notify_rust::Notification::new();
    n.summary(title).body(body).appname(crate::about::NAME);
    if let Some(path) = image {
        n.image_path(path);
    }
    #[cfg(windows)]
    n.app_id(crate::about::IDENTIFIER);
    #[cfg(target_os = "macos")]
    {
        // Notifications belong to the app bundle; a bare binary (cargo run)
        // borrows Terminal's, as the plugin did.
        static APP: std::sync::Once = std::sync::Once::new();
        APP.call_once(|| {
            let bundled = std::env::current_exe().is_ok_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS"));
            let _ = notify_rust::set_application(if bundled { crate::about::IDENTIFIER } else { "com.apple.Terminal" });
        });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    n.auto_icon(); // the binary's name, which is the icon name the .deb/.rpm installs
    n.show().map(|_| ()).map_err(|e| e.to_string())
}

pub fn default_output_dir(_app: &AppHandle) -> String {
    dirs::video_dir()
        .or_else(dirs::download_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Frigate Exports")
        .display()
        .to_string()
}

/// Opens a folder, an .mp4 file, or the connected Frigate's web page
/// (`connected`) with the OS default app. Nothing else, so the UI can't be
/// used to launch programs.
pub fn open_path(path: &str, reveal: bool, connected: Option<&str>) -> Result<(), String> {
    let target: std::ffi::OsString = if path.starts_with("http://") || path.starts_with("https://") {
        if connected != Some(path.trim_end_matches('/')) {
            return Err("Only the connected Frigate server can be opened.".into());
        }
        path.into()
    } else {
        let mut p = PathBuf::from(path);
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

pub fn decoding() -> Decoding {
    #[cfg(target_os = "linux")]
    {
        linux_decoding()
    }
    #[cfg(target_os = "windows")]
    {
        Decoding { hardware: Some(true), detail: "WebView2 (Edge) uses the graphics card when it can".into(), hint: None }
    }
    #[cfg(target_os = "macos")]
    {
        Decoding { hardware: Some(true), detail: "WebKit uses VideoToolbox (hardware)".into(), hint: None }
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Decoding { hardware: None, detail: "Unknown on this system".into(), hint: None }
    }
}

/// WebKitGTK plays video through GStreamer, which decodes in software unless
/// a hardware plugin is installed and a GPU render node is available.
#[cfg(target_os = "linux")]
fn linux_decoding() -> Decoding {
    use std::path::Path;
    let mut dirs: Vec<String> = std::env::var("GST_PLUGIN_PATH").map(|v| v.split(':').map(String::from).collect()).unwrap_or_default();
    for d in [
        "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
        "/usr/lib/aarch64-linux-gnu/gstreamer-1.0",
        "/usr/lib64/gstreamer-1.0",
        "/usr/lib/gstreamer-1.0",
        "/usr/local/lib/gstreamer-1.0",
    ] {
        dirs.push(d.into());
    }
    let plugins = [
        ("libgstva.so", "VA-API (gst-plugins-bad va)"),
        ("libgstvaapi.so", "VA-API (gstreamer-vaapi)"),
        ("libgstnvcodec.so", "NVIDIA NVDEC"),
        ("libgstv4l2codecs.so", "V4L2 stateless (ARM boards)"),
    ];
    let found: Vec<&str> = plugins.iter().filter(|(f, _)| dirs.iter().any(|d| Path::new(d).join(f).exists())).map(|(_, n)| *n).collect();
    let gpu = Path::new("/dev/dri/renderD128").exists();
    match (found.is_empty(), gpu) {
        (false, true) => Decoding { hardware: Some(true), detail: format!("GStreamer hardware decoding: {}", found.join(", ")), hint: None },
        (false, false) => Decoding {
            hardware: None,
            detail: format!("Hardware plugin installed ({}) but no GPU render device (/dev/dri) was found", found.join(", ")),
            hint: Some("Check your graphics driver, or that this user can open /dev/dri/renderD128 (the 'render' group).".into()),
        },
        (true, _) => Decoding {
            hardware: Some(false),
            detail: "Software decoding (no GStreamer hardware plugin found)".into(),
            hint: Some("Install hardware decoding to cut CPU use a lot: Intel/AMD → gstreamer1.0-plugins-bad (va) or gstreamer1.0-vaapi; NVIDIA → gstreamer1.0-plugins-bad (nvcodec). Then restart the app.".into()),
        },
    }
}

/// Gives the app its own identity for Windows notifications, however it was
/// installed (or not): registers our AppUserModelID for this user with a
/// display name and icon, and claims that ID for this process so toasts and
/// the taskbar agree. The installers' Start-menu shortcut uses the same ID.
#[cfg(windows)]
pub mod windows {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    const ICON: &[u8] = include_bytes!("../../icons/128x128@2x.png");

    pub fn register(app_id: &str, name: &str) {
        let wide: Vec<u16> = app_id.encode_utf16().chain(Some(0)).collect();
        // Must happen before the first window opens.
        unsafe { windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
        if let Err(e) = write_registration(app_id, name) {
            eprintln!("couldn't register for notifications: {e}");
        }
    }

    fn write_registration(app_id: &str, name: &str) -> std::io::Result<()> {
        let dir = dirs::data_local_dir().ok_or_else(|| std::io::Error::other("no local app data folder"))?.join(app_id);
        std::fs::create_dir_all(&dir)?;
        let icon = dir.join("notification-icon.png");
        if std::fs::read(&icon).ok().as_deref() != Some(ICON) {
            std::fs::write(&icon, ICON)?;
        }
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!(r"Software\Classes\AppUserModelId\{app_id}"))?;
        key.set_value("DisplayName", &name)?;
        key.set_value("IconUri", &icon.to_string_lossy().to_string())?;
        Ok(())
    }
}

