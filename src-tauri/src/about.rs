//! Version information, the same for the window (About) and the CLI (--version).

use serde::Serialize;

/// Display name. The product name is still being decided; change it here
/// and in tauri.conf.json (productName).
pub const NAME: &str = "Frigate Desktop";
/// Bundle identifier from tauri.conf.json (also the Windows AppUserModelID).
#[cfg_attr(not(windows), allow(dead_code))]
pub const IDENTIFIER: &str = env!("APP_IDENTIFIER");
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("BUILD_COMMIT");
pub const BUILT: &str = env!("BUILD_DATE");

#[derive(Serialize)]
pub struct Info {
    pub name: &'static str,
    pub version: &'static str,
    pub commit: &'static str,
    pub built: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    pub tauri: &'static str,
    pub debug: bool,
}

pub fn info() -> Info {
    Info {
        name: NAME,
        version: VERSION,
        commit: COMMIT,
        built: BUILT,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        tauri: tauri::VERSION,
        debug: cfg!(debug_assertions),
    }
}

/// e.g. "Frigate Desktop 0.1.0 (1a2b3c4d, built 2026-10-11, linux x86_64)"
pub fn line() -> String {
    let i = info();
    let commit = if i.commit.is_empty() { String::new() } else { format!("{}, ", i.commit) };
    let debug = if i.debug { ", debug build" } else { "" };
    format!("{} {} ({commit}built {}, {} {}{debug})", i.name, i.version, i.built, i.os, i.arch)
}

/// How this computer decodes video in the web view, for the Load screen.
#[derive(Serialize)]
pub struct Decoding {
    /// Some(true) hardware, Some(false) software only, None unknown.
    pub hardware: Option<bool>,
    pub detail: String,
    /// What to install or change, if anything.
    pub hint: Option<String>,
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
