//! Version information, the same for the window (About) and the CLI (--version).

use serde::Serialize;

/// Display name. The product name is still being decided; change it here
/// and in tauri.conf.json (productName).
pub const NAME: &str = "Frigate Desktop";
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
