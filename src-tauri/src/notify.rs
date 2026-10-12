//! Native desktop notifications for Frigate alerts and detections.
//!
//! A background thread keeps one WebSocket open to Frigate's /ws (the same
//! messages as MQTT, no broker needed) and listens for "reviews". New review
//! items that match the user's settings become OS notifications; every review
//! change is also forwarded to the page so open timelines update live.
//! Reconnects with backoff; stops on disconnect.

use crate::frigate::Frigate;
use crate::mse;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;
use tungstenite::Message;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Settings {
    pub enabled: bool,
    /// Also notify for detections, not only alerts.
    pub detections: bool,
    /// Cameras to notify for; empty means all.
    pub cameras: Vec<String>,
    /// Minimum seconds between notifications for the same camera.
    pub cooldown: u64,
}

/// A review change, forwarded to the page.
#[derive(Clone, Serialize)]
struct ReviewEvent {
    kind: String,
    camera: String,
    id: String,
    severity: String,
}

pub struct Watcher {
    stop: Arc<AtomicBool>,
}

impl Watcher {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub fn start(app: AppHandle, client: Frigate, settings: Arc<Mutex<Settings>>) -> Watcher {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || {
        let mut backoff = 5;
        let mut last_sent: HashMap<String, Instant> = HashMap::new();
        let mut notified: Vec<String> = Vec::new(); // review ids already shown
        while !flag.load(Ordering::Relaxed) {
            match mse::connect(&client, "/ws") {
                Ok(mut ws) => {
                    backoff = 5;
                    mse::set_read_timeout(&ws, Duration::from_secs(1));
                    loop {
                        if flag.load(Ordering::Relaxed) {
                            let _ = ws.close(None);
                            let _ = ws.flush();
                            return;
                        }
                        match ws.read() {
                            Ok(Message::Text(t)) => handle(&app, &t, &settings, &mut last_sent, &mut notified),
                            Ok(Message::Close(_)) => break,
                            Ok(_) => {}
                            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                            Err(_) => break,
                        }
                    }
                }
                Err(e) if format!("{e}").starts_with("session-expired") => return,
                Err(_) => {}
            }
            // wait before reconnecting, but notice a stop request quickly
            for _ in 0..backoff {
                if flag.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            backoff = (backoff * 2).min(60);
        }
    });
    Watcher { stop }
}

fn handle(app: &AppHandle, text: &str, settings: &Mutex<Settings>, last_sent: &mut HashMap<String, Instant>, notified: &mut Vec<String>) {
    let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
    if msg["topic"] != "reviews" {
        return;
    }
    // the payload is itself JSON, usually as a string
    let payload = match &msg["payload"] {
        Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        v => v.clone(),
    };
    let kind = payload["type"].as_str().unwrap_or("").to_string();
    let after = &payload["after"];
    let (Some(camera), Some(id)) = (after["camera"].as_str(), after["id"].as_str()) else { return };
    let severity = after["severity"].as_str().unwrap_or("detection").to_string();
    let _ = app.emit("frigate-review", ReviewEvent { kind: kind.clone(), camera: camera.into(), id: id.into(), severity: severity.clone() });

    let s = settings.lock().unwrap().clone();
    if !s.enabled || kind == "end" || notified.iter().any(|n| n == id) {
        return;
    }
    if severity != "alert" && !s.detections {
        return; // an "update" that upgrades a detection to an alert still gets through
    }
    if !s.cameras.is_empty() && !s.cameras.iter().any(|c| c == camera) {
        return;
    }
    let now = Instant::now();
    if last_sent.get(camera).is_some_and(|t| now.duration_since(*t) < Duration::from_secs(s.cooldown.max(5))) {
        return;
    }
    last_sent.insert(camera.to_string(), now);
    notified.push(id.to_string());
    if notified.len() > 500 {
        notified.drain(..250);
    }

    let mut labels: Vec<String> = ["objects", "audio", "sub_labels"]
        .iter()
        .flat_map(|k| after["data"][*k].as_array().into_iter().flatten())
        .filter_map(|x| x.as_str().map(|l| l.replace('_', " ")))
        .collect();
    labels.sort();
    labels.dedup();
    let what = if labels.is_empty() { "Activity".to_string() } else { capitalize(&labels.join(", ")) };
    let cam = capitalize(&camera.replace('_', " "));
    let title = if severity == "alert" { format!("{what} at {cam}") } else { format!("Detection: {what}") };
    let body = if severity == "alert" { "New alert. Open Frigate Desktop to watch.".to_string() } else { format!("{cam} saw {}", what.to_lowercase()) };
    let _ = show(app, &title, &body);
}

pub fn test(app: &AppHandle) -> Result<(), String> {
    show(app, "Notifications are on", "You'll get a notification like this when Frigate raises an alert.")
}

/// One native notification. On Windows we send it ourselves: the plugin falls
/// back to PowerShell's identity (name and icon) unless the app was installed
/// with a Start-menu shortcut, so a portable or self-built .exe would show
/// "Windows PowerShell". See `windows::register`.
fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        notify_rust::Notification::new()
            .summary(title)
            .body(body)
            .app_id(windows::APP_ID.get().map(String::as_str).unwrap_or_default())
            .show()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
    }
}

/// Gives the app its own identity for Windows notifications, however it was
/// installed (or not): registers our AppUserModelID for this user with a
/// display name and icon, and claims that ID for this process so toasts and
/// the taskbar agree. The installers' Start-menu shortcut uses the same ID.
#[cfg(windows)]
pub mod windows {
    use std::sync::OnceLock;
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    pub static APP_ID: OnceLock<String> = OnceLock::new();
    const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");

    pub fn register(app_id: &str, name: &str) {
        let _ = APP_ID.set(app_id.to_string());
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

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}
