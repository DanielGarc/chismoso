//! Everything that differs between platforms lives here, behind one small
//! API that both `desktop.rs` and `mobile.rs` implement with the same
//! signatures. Core code and commands call `platform::…` and never use
//! `#[cfg(...)]` themselves.
//!
//! Adding something platform-specific: add the function to BOTH files (a
//! clear "not available" error on the side that can't do it), and if the UI
//! should hide a control, add a flag to `Features` and check it in the UI
//! (`Platform.has("…")` in ui/platform.js).

use serde::Serialize;

#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
pub use desktop::*;

#[cfg(mobile)]
mod mobile;
#[cfg(mobile)]
pub use mobile::*;

/// What this build can do. Sent to the UI with the app info; the UI shows or
/// hides features by these flags, never by sniffing the OS.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct Features {
    /// "desktop" or "mobile": picks the layout.
    pub form: &'static str,
    /// Our own minimise / maximise / close buttons (frameless window).
    pub window_controls: bool,
    /// Full-screen the window (F11).
    pub window_fullscreen: bool,
    /// Open folders and files in the OS file manager / player.
    pub open_files: bool,
    /// Let the user pick where exports are saved.
    pub choose_folder: bool,
    /// Keyboard shortcuts are worth showing.
    pub keyboard: bool,
    /// Alerts arrive while the app is in the background. Desktop: yes, the
    /// app keeps running. Mobile: no, the OS suspends it (needs push).
    pub background_alerts: bool,
    /// The app can update itself from GitHub releases (phones use stores).
    pub self_update: bool,
    /// The system share menu for files (macOS share picker, Windows Share).
    pub share_sheet: bool,
    /// Put files on the clipboard, to paste into chats and email.
    pub copy_files: bool,
    /// A TV: driven with a remote's arrow keys from across the room. The UI
    /// turns on TV mode (big focus outline, no drag and drop) unless the
    /// user picked otherwise. Android TV sets CHISMOSO_TV in MainActivity;
    /// anywhere else CHISMOSO_TV=1 forces it (a wall screen, testing).
    pub tv: bool,
}

/// CHISMOSO_TV is set: this is a TV (see `Features::tv`).
pub fn tv_env() -> bool {
    std::env::var_os("CHISMOSO_TV").is_some_and(|v| v != "0" && !v.is_empty())
}

/// A newer release, as offered to the user.
#[derive(Serialize, Clone, Debug)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    /// Installing will ask for the computer's admin password (Linux
    /// .deb/.rpm installs go through the system's package tools).
    pub needs_password: bool,
}

/// How this device decodes video in the web view (Load screen).
#[derive(Serialize, Debug)]
pub struct Decoding {
    /// Some(true) hardware, Some(false) software only, None unknown.
    pub hardware: Option<bool>,
    pub detail: String,
    /// What to install or change, if anything.
    pub hint: Option<String>,
}

/// Where the share menu should point from: the button's rectangle in the
/// page, in CSS pixels (x, y from the top-left, width, height).
#[derive(serde::Deserialize, Clone, Copy, Debug, Default)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
