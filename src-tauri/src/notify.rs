//! Native desktop notifications for Frigate alerts and detections.
//!
//! A background thread keeps one WebSocket open to Frigate's /ws (the same
//! messages as MQTT, no broker needed) and listens for "reviews". New review
//! items that match the user's settings become OS notifications; every review
//! change is also forwarded to the page so open timelines update live.
//! Reconnects with backoff; stops on disconnect.

use crate::frigate::Frigate;
use crate::{mse, platform};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
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
    /// Attach a snapshot: "person" (when a person is in it), "all" or "off".
    pub images: String,
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
                            Ok(Message::Text(t)) => handle(&app, &client, &t, &settings, &mut last_sent, &mut notified),
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

fn handle(app: &AppHandle, client: &Frigate, text: &str, settings: &Mutex<Settings>, last_sent: &mut HashMap<String, Instant>, notified: &mut Vec<String>) {
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
    let body = if severity == "alert" { "New alert. Open the app to watch.".to_string() } else { format!("{cam} saw {}", what.to_lowercase()) };

    let objects: Vec<String> = after["data"]["objects"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect();
    let person = objects.iter().any(|o| o.starts_with("person"));
    let want_image = match s.images.as_str() {
        "off" => false,
        "all" => true,
        _ => person, // default: only when a person is in it
    };
    if !want_image {
        let _ = platform::notify(app, &title, &body, None);
        return;
    }
    // Fetching the picture takes a moment; don't hold up the socket.
    let detections: Vec<String> = after["data"]["detections"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect();
    let (app, client, camera, id) = (app.clone(), client.clone(), camera.to_string(), id.to_string());
    std::thread::spawn(move || {
        let image = snapshot(&client, &camera, &id, &detections, person);
        let _ = platform::notify(&app, &title, &body, image.as_deref());
    });
}

/// A picture for the notification, saved to a temp file (the OS wants a
/// path): the tracked person's snapshot if there is one, otherwise the
/// first object's, otherwise the camera's current frame.
fn snapshot(client: &Frigate, camera: &str, review_id: &str, detections: &[String], person: bool) -> Option<String> {
    use crate::frigate::enc;
    let mut ids: Vec<&String> = detections.iter().take(4).collect();
    if person && ids.len() > 1 {
        // Put the person first: ask Frigate what each tracked object is.
        let is_person = |id: &str| {
            client.get_quick(&format!("/api/events/{}", enc(id)), 3).ok().and_then(|r| r.json::<Value>().ok()).is_some_and(|v| v["label"].as_str().is_some_and(|l| l.starts_with("person")))
        };
        if let Some(i) = ids.iter().position(|id| is_person(id)) {
            let p = ids.remove(i);
            ids.insert(0, p);
        }
    }
    let mut paths: Vec<String> = ids.iter().map(|id| format!("/api/events/{}/snapshot.jpg?bbox=1&h=480&quality=80", enc(id))).collect();
    paths.push(format!("/api/{}/latest.jpg?h=480&quality=80", enc(camera)));
    let bytes = paths.iter().find_map(|p| {
        let r = client.get_quick(p, 4).ok()?;
        let b = r.bytes().ok()?;
        (b.len() > 100).then_some(b)
    })?;
    let dir = std::env::temp_dir().join("frigate-desktop-notifications");
    std::fs::create_dir_all(&dir).ok()?;
    prune(&dir, 20);
    let safe: String = review_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' }).collect();
    let path = dir.join(format!("{safe}.jpg"));
    std::fs::write(&path, &bytes).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Keep only the newest `keep` images (the OS may still be showing recent ones).
fn prune(dir: &std::path::Path, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<_> = rd.flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
    if files.len() <= keep {
        return;
    }
    files.sort();
    for (_, p) in &files[..files.len() - keep] {
        let _ = std::fs::remove_file(p);
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}
