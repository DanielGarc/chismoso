//! Version information, the same for the window (About) and the CLI (--version).

use serde::Serialize;

/// Display name. To rename the app, change it here and `productName` in
/// tauri.conf.json (the identifier there is the install identity: changing it
/// makes a new app on phones and loses saved settings).
pub const NAME: &str = "Chismoso";
/// Bundle identifier from tauri.conf.json (also the Windows AppUserModelID).
pub const IDENTIFIER: &str = env!("APP_IDENTIFIER");
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("BUILD_COMMIT");
pub const BUILT: &str = env!("BUILD_DATE");
/// Where people download the app; offered when an in-app update fails.
pub const DOWNLOAD_PAGE: &str = "https://chismoso.caprichosos.org/download.html";

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
    pub download_page: &'static str,
    /// What this platform can do; the UI shows or hides features by these.
    pub features: crate::platform::Features,
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
        download_page: DOWNLOAD_PAGE,
        features: crate::platform::features(),
    }
}

/// e.g. "Chismoso 0.1.0 (1a2b3c4d, built 2026-10-11, linux x86_64)"
pub fn line() -> String {
    let i = info();
    let commit = if i.commit.is_empty() { String::new() } else { format!("{}, ", i.commit) };
    let debug = if i.debug { ", debug build" } else { "" };
    format!("{} {} ({commit}built {}, {} {}{debug})", i.name, i.version, i.built, i.os, i.arch)
}
