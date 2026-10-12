//! A tiny HTTP server on 127.0.0.1 that streams snapshots, thumbnails,
//! recordings and export videos from Frigate to the webview, carrying the
//! user's login and certificate setting. Real HTTP (with byte ranges) is what
//! every OS webview's video player handles best.
//!
//! Only this app can use it: the port is random, every path must start with
//! a random secret, and only media paths are forwarded (no general API access).

use crate::frigate::Frigate;
use crate::metrics;
use std::io::Read;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Response, Server, StatusCode};

pub struct MediaServer {
    pub base: String, // http://127.0.0.1:PORT/SECRET
}

/// Origins the app's own page can have, per platform.
const APP_ORIGINS: &[&str] = &["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

/// Media paths only: snapshots, clip/review thumbnails, exports, recordings.
pub fn allowed(path: &str) -> bool {
    let p = path.split('?').next().unwrap_or("");
    if p.contains("..") {
        return false;
    }
    if p.starts_with("/exports/") || p.starts_with("/clips/") || p.starts_with("/vod/") {
        return true;
    }
    let parts: Vec<&str> = p.split('/').collect();
    if parts.len() < 4 || parts[1] != "api" || parts[2].is_empty() {
        return false;
    }
    match parts.len() {
        // /api/<camera>/latest.jpg (or .webp)
        4 => parts[3] == "latest.jpg" || parts[3] == "latest.webp",
        // /api/<camera>/recordings/<time>/snapshot.jpg: a still from the recordings
        6 => parts[3] == "recordings" && parts[4].parse::<f64>().is_ok() && parts[5] == "snapshot.jpg",
        _ => false,
    }
}

pub fn start(client: Arc<Mutex<Option<Frigate>>>) -> anyhow::Result<MediaServer> {
    let server = Server::http("127.0.0.1:0").map_err(|e| anyhow::anyhow!("media server: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| anyhow::anyhow!("random: {e}"))?;
    let secret: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let base = format!("http://127.0.0.1:{port}/{secret}");

    let server = Arc::new(server);
    // Enough workers that a few slow video transfers can't starve snapshots.
    for _ in 0..16 {
        let (server, client, prefix) = (server.clone(), client.clone(), format!("/{secret}"));
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                handle(req, &client, &prefix);
            }
        });
    }
    Ok(MediaServer { base })
}

/// Counts bytes as they stream through, for the load meter.
struct Counting<R>(R);
impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.0.read(buf)?;
        metrics::media_bytes(n as u64);
        Ok(n)
    }
}

fn handle(req: tiny_http::Request, client: &Mutex<Option<Frigate>>, prefix: &str) {
    let plain = |code: u16, msg: &str| Response::from_string(msg).with_status_code(StatusCode(code));
    if !matches!(req.method(), Method::Get | Method::Head) {
        let _ = req.respond(plain(405, "method not allowed"));
        return;
    }
    let Some(path) = req.url().strip_prefix(prefix).map(str::to_string) else {
        let _ = req.respond(plain(404, "not found"));
        return;
    };
    if !allowed(&path) {
        let _ = req.respond(plain(403, "path not allowed"));
        return;
    }
    let Some(c) = client.lock().unwrap().clone() else {
        let _ = req.respond(plain(503, "not connected"));
        return;
    };
    let range = req.headers().iter().find(|h| h.field.equiv("Range")).map(|h| h.value.as_str().to_string());
    // The page fetches playlists and segments with fetch(), so it needs CORS,
    // but only for the app's own origin.
    let origin = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Origin"))
        .map(|h| h.value.as_str().to_string())
        .filter(|o| APP_ORIGINS.contains(&o.as_str()));

    metrics::media_request();
    match c.open_stream(&path, range.as_deref()) {
        Ok(upstream) => {
            let status = upstream.status().as_u16();
            let len = upstream.content_length().map(|l| l as usize);
            let mut headers = vec![Header::from_bytes("Cache-Control", "no-store").unwrap()];
            if let Some(o) = origin {
                headers.push(Header::from_bytes("Access-Control-Allow-Origin", o).unwrap());
                headers.push(Header::from_bytes("Vary", "Origin").unwrap());
            }
            for name in ["content-type", "content-range", "accept-ranges"] {
                if let Some(v) = upstream.headers().get(name).and_then(|v| v.to_str().ok())
                    && let Ok(h) = Header::from_bytes(name, v) {
                        headers.push(h);
                    }
            }
            let _ = req.respond(Response::new(StatusCode(status), headers, Counting(upstream), len, None));
        }
        Err(e) => {
            let _ = req.respond(plain(502, &format!("{e:#}")));
        }
    }
    // Drop our client handle on this plain thread, never inside the async runtime.
    drop(c);
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn allowlist() {
        assert!(allowed("/api/pool/latest.jpg?h=360&t=1"));
        assert!(allowed("/exports/a.mp4"));
        assert!(allowed("/vod/pool/start/1/end/2/master.m3u8"));
        assert!(allowed("/clips/review/thumb-pool-1.webp"));
        assert!(!allowed("/api/config/raw"));
        assert!(!allowed("/api/pool/recordings"));
        assert!(allowed("/api/pool/recordings/1791750000.5/snapshot.jpg?height=360"));
        assert!(!allowed("/api/pool/recordings/summary/snapshot.jpg"));
        assert!(!allowed("/api/login"));
        assert!(!allowed("/exports/../api/config/raw"));
    }
}
