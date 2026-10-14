//! A tiny HTTP server on 127.0.0.1 that streams snapshots, thumbnails,
//! recordings and export videos from Frigate to the webview, carrying the
//! user's login and certificate setting. Real HTTP (with byte ranges) is what
//! every OS webview's video player handles best.
//!
//! Only this app can use it: the port is random, every path must start with
//! a random secret, and only media paths are forwarded (no general API access).

//!
//! Every connection gets its own thread, so a slow video download or a
//! connection the webview keeps open never holds up another camera's picture.
//! (A pooled server here once made the fifth simultaneous picture wait for an
//! idle connection to time out, about 8 seconds.)

use crate::frigate::Frigate;
use crate::metrics;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| anyhow::anyhow!("media server: {e}"))?;
    let port = listener.local_addr()?.port();
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| anyhow::anyhow!("random: {e}"))?;
    let secret: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let base = format!("http://127.0.0.1:{port}/{secret}");
    let prefix: Arc<str> = format!("/{secret}").into();

    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let (client, prefix) = (client.clone(), prefix.clone());
            std::thread::spawn(move || serve(conn, &client, &prefix));
        }
    });
    Ok(MediaServer { base })
}

/// One parsed request: just what this server needs.
struct Request {
    method: String,
    target: String,
    range: Option<String>,
    origin: Option<String>,
    close: bool,
}

/// Reads one request head. None when the connection ends or sends something
/// that isn't a small HTTP/1.x request.
fn read_request(r: &mut impl BufRead) -> Option<Request> {
    let mut line = String::new();
    let mut lines = Vec::new();
    let mut size = 0;
    loop {
        line.clear();
        let n = r.read_line(&mut line).ok()?;
        size += n;
        if n == 0 || size > 16 * 1024 {
            return None;
        }
        let l = line.trim_end_matches(['\r', '\n']);
        if l.is_empty() {
            if lines.is_empty() {
                continue; // stray blank line between requests
            }
            break;
        }
        lines.push(l.to_string());
    }
    let mut first = lines[0].split(' ');
    let (method, target, version) = (first.next()?.to_string(), first.next()?.to_string(), first.next()?);
    if !version.starts_with("HTTP/1.") {
        return None;
    }
    let mut req = Request { method, target, range: None, origin: None, close: version == "HTTP/1.0" };
    for h in &lines[1..] {
        let Some((k, v)) = h.split_once(':') else { continue };
        let v = v.trim();
        match k.trim().to_ascii_lowercase().as_str() {
            "range" => req.range = Some(v.to_string()),
            "origin" => req.origin = Some(v.to_string()),
            "connection" => req.close = v.eq_ignore_ascii_case("close"),
            // Bodies aren't accepted; close rather than misread the next request.
            "content-length" if v != "0" => req.close = true,
            "transfer-encoding" => req.close = true,
            _ => {}
        }
    }
    Some(req)
}

fn serve(conn: TcpStream, client: &Mutex<Option<Frigate>>, prefix: &str) {
    // An idle connection the webview keeps for later is let go after a while.
    let _ = conn.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = conn.set_nodelay(true);
    let Ok(read_half) = conn.try_clone() else { return };
    let mut reader = BufReader::new(read_half);
    let mut out = conn;
    while let Some(req) = read_request(&mut reader) {
        let keep = handle(&req, &mut out, client, prefix) && !req.close;
        if !keep {
            break;
        }
    }
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        206 => "Partial Content",
        304 => "Not Modified",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "",
    }
}

/// Writes a response. With a known length the connection can carry another
/// request afterwards (returns true); otherwise the body ends when the
/// connection closes.
fn respond(out: &mut TcpStream, code: u16, headers: &[(&str, String)], len: Option<u64>, head_only: bool, body: &mut dyn Read) -> bool {
    let mut head = format!("HTTP/1.1 {code} {}\r\n", reason(code));
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    match len {
        Some(n) => head.push_str(&format!("Content-Length: {n}\r\n\r\n")),
        None => head.push_str("Connection: close\r\n\r\n"),
    }
    if out.write_all(head.as_bytes()).is_err() {
        return false;
    }
    if !head_only && std::io::copy(body, out).is_err() {
        return false;
    }
    out.flush().is_ok() && len.is_some()
}

fn plain(out: &mut TcpStream, code: u16, msg: &str, head_only: bool) -> bool {
    let h = [("Content-Type", "text/plain; charset=utf-8".to_string()), ("Cache-Control", "no-store".to_string())];
    respond(out, code, &h, Some(msg.len() as u64), head_only, &mut msg.as_bytes())
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

/// Answers one request; true if the connection can be reused.
fn handle(req: &Request, out: &mut TcpStream, client: &Mutex<Option<Frigate>>, prefix: &str) -> bool {
    let head_only = req.method == "HEAD";
    if req.method != "GET" && !head_only {
        plain(out, 405, "method not allowed", false);
        return false;
    }
    let Some(path) = req.target.strip_prefix(prefix) else {
        return plain(out, 404, "not found", head_only);
    };
    if !allowed(path) {
        return plain(out, 403, "path not allowed", head_only);
    }
    let Some(c) = client.lock().unwrap().clone() else {
        return plain(out, 503, "not connected", head_only);
    };
    // The page fetches playlists and segments with fetch(), so it needs CORS,
    // but only for the app's own origin.
    let origin = req.origin.as_deref().filter(|o| APP_ORIGINS.contains(o));

    metrics::media_request();
    let reuse = match c.open_stream(path, req.range.as_deref()) {
        Ok(upstream) => {
            let status = upstream.status().as_u16();
            let len = upstream.content_length();
            let mut headers = vec![("Cache-Control", "no-store".to_string())];
            if let Some(o) = origin {
                headers.push(("Access-Control-Allow-Origin", o.to_string()));
                headers.push(("Vary", "Origin".to_string()));
            }
            for name in ["content-type", "content-range", "accept-ranges"] {
                if let Some(v) = upstream.headers().get(name).and_then(|v| v.to_str().ok()) {
                    headers.push((name, v.to_string()));
                }
            }
            // HEAD upstream isn't used, so a HEAD still reads (and drops) nothing:
            // the body is simply not copied.
            respond(out, status, &headers, len, head_only, &mut Counting(upstream))
        }
        Err(e) => plain(out, 502, &format!("{e:#}"), head_only),
    };
    // Drop our client handle on this plain thread, never inside the async runtime.
    drop(c);
    reuse
}

#[cfg(test)]
mod tests {
    use super::{allowed, read_request};

    #[test]
    fn parses_requests_and_keep_alive() {
        let raw = b"GET /s/api/pool/latest.jpg?h=270 HTTP/1.1\r\nHost: x\r\nRange: bytes=0-\r\nOrigin: tauri://localhost\r\n\r\nHEAD /s/x HTTP/1.1\r\nConnection: close\r\n\r\n";
        let mut r = std::io::BufReader::new(&raw[..]);
        let a = read_request(&mut r).unwrap();
        assert_eq!((a.method.as_str(), a.target.as_str()), ("GET", "/s/api/pool/latest.jpg?h=270"));
        assert_eq!(a.range.as_deref(), Some("bytes=0-"));
        assert_eq!(a.origin.as_deref(), Some("tauri://localhost"));
        assert!(!a.close);
        let b = read_request(&mut r).unwrap();
        assert!(b.method == "HEAD" && b.close);
        assert!(read_request(&mut r).is_none());
        assert!(read_request(&mut std::io::BufReader::new(&b"SSH-2.0-x\r\n\r\n"[..])).is_none());
    }

    /// Many pictures at once must not wait on each other (the old pooled
    /// server held the fifth until an idle connection timed out).
    #[test]
    fn many_connections_at_once() {
        use std::io::{Read, Write};
        let server = super::start(std::sync::Arc::new(std::sync::Mutex::new(None))).unwrap();
        let addr = server.base.trim_start_matches("http://").split('/').next().unwrap().to_string();
        let path = format!("/{}/api/pool/latest.jpg", server.base.rsplit('/').next().unwrap());
        // Ten idle keep-alive connections, like a webview holding them open...
        let idle: Vec<_> = (0..10).map(|_| std::net::TcpStream::connect(&addr).unwrap()).collect();
        // ...and a request on a fresh one still answers right away (503: not signed in).
        let t = std::time::Instant::now();
        let mut c = std::net::TcpStream::connect(&addr).unwrap();
        write!(c, "GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
        let mut resp = String::new();
        c.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 503"), "{resp}");
        assert!(t.elapsed() < std::time::Duration::from_secs(2));
        drop(idle);
    }

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
