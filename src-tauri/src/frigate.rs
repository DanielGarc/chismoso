//! Minimal blocking client for the parts of the Frigate HTTP API this app needs.
//!
//! Works against the authenticated port (8971, username + password) and the
//! unauthenticated internal port (5000, no login). Newer Frigate versions
//! (0.17+) queue exports as jobs; older ones are handled with fallbacks.

use anyhow::{Context, Result, anyhow, bail};
use reqwest::Method;
use reqwest::StatusCode;
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use crate::metrics;
use crate::tls::{self, Trust};

/// Called with the new session token whenever Frigate renews it.
pub type TokenListener = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct Frigate {
    base: String,
    http: Client,
    /// Shared by every clone, so a token Frigate refreshes reaches all threads.
    token: Arc<RwLock<Option<String>>>,
    trust: Trust,
    on_token: Option<TokenListener>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Camera {
    pub name: String,
    pub friendly_name: String,
    /// go2rtc stream names for live view, as (label, stream). The first is the default.
    pub streams: Vec<(String, String)>,
    pub enabled: bool,
    pub audio: bool,
    /// Runtime switches (can be flipped from the app until Frigate restarts).
    pub detect: bool,
    pub recordings: bool,
    pub snapshots: bool,
}

/// A camera group from Frigate's config (used as a grid layout).
#[derive(Clone, Debug, Serialize)]
pub struct CameraGroup {
    pub name: String,
    pub cameras: Vec<String>,
    pub order: i64,
}

/// One review item (alert or detection) for the timeline.
#[derive(Clone, Debug, Serialize)]
pub struct ReviewItem {
    pub id: String,
    pub camera: String,
    pub start: f64,
    pub end: Option<f64>,
    pub severity: String,
    pub labels: Vec<String>,
    /// Thumbnail path on the media server, e.g. /clips/review/thumb-….webp
    pub thumb: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExportInfo {
    pub id: String,
    pub camera: String,
    pub name: String,
    pub date: f64,
    pub video_path: String,
    pub thumb_path: String,
    pub in_progress: bool,
    /// File size on the server, when it could be read (filled by `list_exports`).
    pub size: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum ExportMode {
    /// Normal-speed clip of the time range.
    Realtime,
    /// Sped-up clip: `speed`x faster, output at `fps` frames per second.
    /// `keyframes_only` makes Frigate decode only keyframes (about one per
    /// second or two of footage) instead of every frame: many times faster,
    /// and invisible once the speed is high enough.
    Timelapse { speed: f32, fps: u32, keyframes_only: bool },
}

#[derive(Debug)]
pub enum ExportState {
    Pending { running: bool, progress: f32 },
    Done { video_path: String },
    Failed(String),
}

impl Frigate {
    /// Connects to Frigate. Leave `user` empty for an unauthenticated
    /// endpoint (e.g. port 5000 or auth disabled).
    /// `trust` decides how the server's certificate is checked (see tls.rs).
    pub fn connect(url: &str, user: &str, password: &str, trust: Trust) -> Result<Self> {
        let mut client = Self::build(url, trust)?;
        if !user.trim().is_empty() {
            client.login(user.trim(), password)?;
        }
        Ok(client)
    }

    /// Picks up a session saved earlier ("Keep me signed in"): no password,
    /// just Frigate's session token. Nothing is sent yet; the first request
    /// tells whether it's still good (an expired or revoked token fails with
    /// `session-expired:`).
    pub fn resume(url: &str, token: &str, trust: Trust) -> Result<Self> {
        let client = Self::build(url, trust)?;
        *client.token.write().unwrap() = Some(token.to_string());
        Ok(client)
    }

    /// Reports renewed session tokens (so a kept session stays current).
    pub fn on_token(&mut self, f: TokenListener) {
        self.on_token = Some(f);
    }

    fn build(url: &str, trust: Trust) -> Result<Self> {
        let base = normalize_url(url)?;
        let http = Client::builder()
            .tls_backend_preconfigured(tls::client_config(&trust).context("TLS setup failed")?)
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("chismoso/", env!("CARGO_PKG_VERSION")))
            .build()
            .context("could not create HTTP client")?;

        Ok(Self { base, http, token: Arc::new(RwLock::new(None)), trust, on_token: None })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub fn token(&self) -> Option<String> {
        self.token.read().unwrap().clone()
    }

    pub fn trust(&self) -> &Trust {
        &self.trust
    }

    /// Fingerprint of the server certificate seen on this connection.
    pub fn cert_fingerprint(&self) -> Option<String> {
        self.trust.seen.lock().unwrap().clone()
    }

    /// Frigate renews the session cookie shortly before it expires; keep it.
    fn refresh_token(&self, resp: &Response) {
        if let Some(t) = token_from_cookies(resp) {
            let mut cur = self.token.write().unwrap();
            if cur.as_deref() != Some(t.as_str()) {
                if let Some(f) = &self.on_token {
                    f(&t);
                }
                *cur = Some(t);
            }
        }
    }

    fn login(&mut self, user: &str, password: &str) -> Result<()> {
        let resp = self
            .http
            .post(format!("{}/api/login", self.base))
            .header("X-CSRF-TOKEN", "1")
            .json(&json!({ "user": user, "password": password }))
            .timeout(Duration::from_secs(20))
            .send()
            .map_err(friendly_net_error)?;

        match resp.status() {
            s if s.is_success() => {}
            StatusCode::UNAUTHORIZED => bail!("Login failed: wrong username or password."),
            StatusCode::TOO_MANY_REQUESTS => bail!("Too many login attempts. Wait a minute and try again."),
            StatusCode::NOT_FOUND => bail!(
                "This endpoint has no login (authentication is disabled or this is the internal port 5000). \
                 Clear the username and connect again."
            ),
            _ => return Err(api_error(resp)),
        }

        // Frigate returns the JWT as a cookie. We re-send it as a Bearer token,
        // which Frigate accepts and which also works over plain http.
        let token = token_from_cookies(&resp).ok_or_else(|| anyhow!("Logged in, but Frigate didn't return a session token."))?;
        *self.token.write().unwrap() = Some(token);
        Ok(())
    }

    fn req(&self, method: Method, path: &str) -> RequestBuilder {
        let mut rb = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .header("X-CSRF-TOKEN", "1");
        if let Some(t) = self.token.read().unwrap().as_deref() {
            rb = rb.bearer_auth(t);
        }
        rb
    }

    fn send(&self, rb: RequestBuilder) -> Result<Response> {
        let resp = rb.timeout(Duration::from_secs(30)).send().map_err(friendly_net_error)?;
        self.refresh_token(&resp);
        metrics::api(resp.content_length().unwrap_or(0));
        Ok(resp)
    }

    fn ok(&self, rb: RequestBuilder) -> Result<Response> {
        let resp = self.send(rb)?;
        if resp.status().is_success() { Ok(resp) } else { Err(api_error(resp)) }
    }

    /// The logged-in user's role ("admin", "viewer", …). Port 5000 reports admin;
    /// anything unreadable is treated as the least-privileged role.
    pub fn role(&self) -> String {
        self.ok(self.req(Method::GET, "/api/profile"))
            .ok()
            .and_then(|r| r.json::<Value>().ok())
            .and_then(|v| v["role"].as_str().map(str::to_string))
            .unwrap_or_else(|| "viewer".into())
    }

    /// WebRTC signaling through Frigate's go2rtc proxy: send our SDP offer,
    /// get go2rtc's answer (with its ICE candidates) back.
    pub fn webrtc_answer(&self, stream: &str, offer_sdp: &str) -> Result<String> {
        let path = format!("/api/go2rtc/webrtc?src={}", enc(stream));
        let raw = self.raw(self.req(Method::POST, &path).json(&json!({ "type": "offer", "sdp": offer_sdp })))?;
        if !raw.status.is_success() {
            return Err(raw.error()).context("WebRTC signaling failed");
        }
        let v: Value = serde_json::from_str(&raw.body).context("unexpected WebRTC answer")?;
        v["sdp"].as_str().map(str::to_string).ok_or_else(|| anyhow!("go2rtc returned no SDP answer"))
    }

    /// How many clients are watching each go2rtc stream right now (all
    /// viewers, not just this app).
    pub fn go2rtc_viewers(&self) -> Result<Vec<(String, usize)>> {
        let v: Value = self.ok(self.req(Method::GET, "/api/go2rtc/streams"))?.json()?;
        let mut out: Vec<(String, usize)> = v
            .as_object()
            .map(|m| m.iter().map(|(k, s)| (k.clone(), s["consumers"].as_array().map(|a| a.len()).unwrap_or(0))).collect())
            .unwrap_or_default();
        out.sort();
        Ok(out)
    }

    pub fn stats(&self) -> Result<Value> {
        Ok(self.ok(self.req(Method::GET, "/api/stats"))?.json()?)
    }

    /// The raw YAML config file (admin only).
    pub fn config_raw(&self) -> Result<String> {
        let body = self.ok(self.req(Method::GET, "/api/config/raw"))?.text()?;
        // Frigate wraps the YAML in a JSON string; older versions send it plain.
        Ok(serde_json::from_str::<String>(&body).unwrap_or(body))
    }

    /// Validates and saves the YAML config; optionally restarts Frigate.
    pub fn config_save(&self, yaml: &str, restart: bool) -> Result<String> {
        let opt = if restart { "restart" } else { "saveonly" };
        let raw = self.raw(
            self.req(Method::POST, &format!("/api/config/save?save_option={opt}"))
                .header(reqwest::header::CONTENT_TYPE, "text/plain")
                .body(yaml.to_string()),
        )?;
        let v: Value = serde_json::from_str(&raw.body).unwrap_or(Value::Null);
        let msg = v["message"].as_str().unwrap_or("").to_string();
        if raw.status.is_success() && v["success"] != Value::Bool(false) {
            Ok(if msg.is_empty() { "Saved.".into() } else { msg })
        } else if msg.is_empty() {
            Err(raw.error())
        } else {
            bail!("{msg}")
        }
    }

    pub fn restart(&self) -> Result<()> {
        self.ok(self.req(Method::POST, "/api/restart"))?;
        Ok(())
    }

    /// Opens a streaming GET to any Frigate path (snapshots, export videos)
    /// on behalf of the webview, forwarding a byte range if given.
    pub fn open_stream(&self, path_and_query: &str, range: Option<&str>) -> Result<Response> {
        // Snapshots must answer quickly or the grid stalls; videos can take long.
        let timeout = if path_and_query.starts_with("/api/") { 15 } else { 60 * 60 };
        let mut rb = self.req(Method::GET, path_and_query).timeout(Duration::from_secs(timeout));
        if let Some(r) = range {
            rb = rb.header(reqwest::header::RANGE, r);
        }
        let resp = rb.send().map_err(friendly_net_error)?;
        self.refresh_token(&resp);
        Ok(resp)
    }

    /// A small GET with its own short timeout (notification images and the
    /// like must not hold anything up).
    pub fn get_quick(&self, path: &str, secs: u64) -> Result<Response> {
        let resp = self.req(Method::GET, path).timeout(Duration::from_secs(secs)).send().map_err(friendly_net_error)?;
        self.refresh_token(&resp);
        metrics::api(resp.content_length().unwrap_or(0));
        if resp.status().is_success() { Ok(resp) } else { Err(api_error(resp)) }
    }

    /// Alerts and detections for some cameras in a time range.
    pub fn review_items(&self, cameras: &[String], after: f64, before: f64) -> Result<Vec<ReviewItem>> {
        let list = cameras.iter().map(|c| enc(c)).collect::<Vec<_>>().join(",");
        let path = format!("/api/review?cameras={list}&after={after}&before={before}&limit=2000");
        let v: Value = self.ok(self.req(Method::GET, &path))?.json()?;
        let mut items: Vec<ReviewItem> = v
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|r| {
                        let d = &r["data"];
                        let mut labels: Vec<String> = ["objects", "audio", "sub_labels"]
                            .iter()
                            .flat_map(|k| d[*k].as_array().into_iter().flatten())
                            .filter_map(|x| x.as_str().map(str::to_string))
                            .collect();
                        labels.sort();
                        labels.dedup();
                        Some(ReviewItem {
                            id: r["id"].as_str()?.to_string(),
                            camera: r["camera"].as_str().unwrap_or_default().to_string(),
                            start: r["start_time"].as_f64()?,
                            end: r["end_time"].as_f64(),
                            severity: r["severity"].as_str().unwrap_or("detection").to_string(),
                            labels,
                            thumb: r["thumb_path"].as_str().map(|p| p.trim_start_matches("/media/frigate").to_string()),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        items.sort_by(|a, b| a.start.total_cmp(&b.start));
        Ok(items)
    }

    /// Recording segments (start, end, media duration) overlapping a range,
    /// oldest first. Frigate stores ~10 s segments.
    pub fn recordings(&self, camera: &str, after: f64, before: f64) -> Result<Vec<[f64; 3]>> {
        let v: Value = self
            .ok(self.req(Method::GET, &format!("/api/{}/recordings?after={after}&before={before}", enc(camera))))?
            .json()?;
        let mut rows: Vec<[f64; 3]> = v
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|r| {
                        let (s, e) = (r["start_time"].as_f64()?, r["end_time"].as_f64()?);
                        let d = r["duration"].as_f64().filter(|d| *d > 0.0).unwrap_or(e - s);
                        (e > s).then_some([s, e, d])
                    })
                    .collect()
            })
            .unwrap_or_default();
        rows.sort_by(|a, b| a[0].total_cmp(&b[0]));
        Ok(rows)
    }

    /// Hourly recorded seconds per day, for zoomed-out timelines.
    pub fn recordings_summary(&self, camera: &str, timezone: &str) -> Result<Value> {
        let tz: String = timezone.bytes().map(|b| if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        Ok(self.ok(self.req(Method::GET, &format!("/api/{}/recordings/summary?timezone={tz}", enc(camera))))?.json()?)
    }

    /// What a camera's PTZ (pan/tilt/zoom) can do, as Frigate reports it for
    /// ONVIF cameras: `{"features": ["pt", "zoom", "pt-r-fov", …], "presets": […]}`.
    /// Cameras without PTZ give an empty object.
    pub fn ptz_info(&self, camera: &str) -> Result<Value> {
        let resp = self.send(self.req(Method::GET, &format!("/api/{}/ptz/info", enc(camera))))?;
        if !resp.status().is_success() {
            return Ok(json!({}));
        }
        Ok(resp.json::<Value>().unwrap_or_else(|_| json!({})))
    }

    pub fn version(&self) -> Result<String> {
        let resp = self.ok(self.req(Method::GET, "/api/version"))?;
        Ok(resp.text()?.trim().trim_matches('"').to_string())
    }

    pub fn cameras(&self) -> Result<Vec<Camera>> {
        Ok(self.overview()?.0)
    }

    /// Cameras and camera groups from one /api/config call.
    pub fn overview(&self) -> Result<(Vec<Camera>, Vec<CameraGroup>)> {
        let cfg: Value = self.ok(self.req(Method::GET, "/api/config"))?.json()?;
        let obj = cfg["cameras"]
            .as_object()
            .ok_or_else(|| anyhow!("Unexpected /api/config response (no cameras)."))?;
        let mut cams: Vec<Camera> = obj
            .iter()
            .map(|(name, c)| {
                let mut streams: Vec<(String, String)> = c["live"]["streams"]
                    .as_object()
                    .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
                    .unwrap_or_default();
                if streams.is_empty() {
                    // Frigate's default: the go2rtc stream named like the camera.
                    streams.push(("Main".into(), name.clone()));
                }
                let on = |a: &str| c[a]["enabled"].as_bool().unwrap_or(false);
                Camera {
                    name: name.clone(),
                    friendly_name: c["friendly_name"].as_str().filter(|s| !s.is_empty()).unwrap_or(name).to_string(),
                    streams,
                    enabled: c["enabled"].as_bool().unwrap_or(true),
                    audio: c["audio"]["enabled_in_config"].as_bool().or(c["audio"]["enabled"].as_bool()).unwrap_or(false),
                    detect: on("detect"),
                    recordings: on("record"),
                    snapshots: on("snapshots"),
                }
            })
            .collect();
        cams.sort_by_key(|a| a.friendly_name.to_lowercase());
        let mut groups: Vec<CameraGroup> = cfg["camera_groups"]
            .as_object()
            .map(|m| {
                m.iter()
                    .filter(|(name, _)| name.as_str() != "default")
                    .map(|(name, g)| CameraGroup {
                        name: name.clone(),
                        cameras: g["cameras"].as_array().into_iter().flatten().filter_map(|c| c.as_str().map(str::to_string)).collect(),
                        order: g["order"].as_i64().unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default();
        groups.sort_by_key(|g| g.order);
        Ok((cams, groups))
    }

    /// Queues an export on the server. Returns the export id when the server
    /// provides one (Frigate 0.14+).
    /// `small`: re-encode to at most 720p with a higher compression, so the file
    /// is easy to send (needs Frigate 0.17+, which takes custom ffmpeg settings).
    pub fn start_export(&self, camera: &str, start: i64, end: i64, name: &str, mode: ExportMode, small: bool) -> Result<Option<String>> {
        let cam = enc(camera);
        // 720p keeps the aspect ratio; CRF 28 is visibly fine on a phone at a fraction of the size.
        const SMALL: &str = "scale=-2:720";
        const SMALL_ENC: &str = " -c:v libx264 -preset veryfast -crf 28";
        let raw = match mode {
            ExportMode::Realtime if small => {
                let body = json!({
                    "source": "recordings",
                    "name": name,
                    "ffmpeg_input_args": "",
                    "ffmpeg_output_args": format!("-vf {SMALL}{SMALL_ENC} -c:a aac"),
                });
                let raw = self.raw(self.req(Method::POST, &format!("/api/export/custom/{cam}/start/{start}/end/{end}")).json(&body))?;
                if raw.is_missing_route() {
                    bail!("Smaller files for sharing need Frigate 0.17 or newer. Untick \"Smaller file for sharing\".");
                }
                raw
            }
            ExportMode::Realtime => self.raw(self.req(Method::POST, &format!("/api/export/{cam}/start/{start}/end/{end}"))
                .json(&json!({ "source": "recordings", "name": name })))?,
            ExportMode::Timelapse { speed, fps, keyframes_only } => {
                let factor = 1.0 / speed.clamp(1.0, 1_000_000.0) as f64;
                let fps = fps.clamp(1, 60);
                let input = if keyframes_only { "-an -skip_frame nokey" } else { "-an" };
                let body = json!({
                    "source": "recordings",
                    "name": name,
                    "ffmpeg_input_args": input,
                    "ffmpeg_output_args": if small {
                        format!("-vf setpts={factor:.8}*PTS,{SMALL} -r {fps}{SMALL_ENC}")
                    } else {
                        format!("-vf setpts={factor:.8}*PTS -r {fps}")
                    },
                });
                let raw = self.raw(self.req(Method::POST, &format!("/api/export/custom/{cam}/start/{start}/end/{end}")).json(&body))?;
                if raw.is_missing_route() {
                    // Frigate < 0.17 has no custom export endpoint, only a fixed 25x timelapse.
                    if small {
                        bail!("Smaller files for sharing need Frigate 0.17 or newer. Untick \"Smaller file for sharing\".");
                    }
                    if (speed - 25.0).abs() > 0.5 {
                        bail!("This Frigate version only supports 25x timelapses. Set the speed to 25x.");
                    }
                    self.raw(self.req(Method::POST, &format!("/api/export/{cam}/start/{start}/end/{end}"))
                        .json(&json!({ "source": "recordings", "name": name, "playback": "timelapse_25x" })))?
                } else {
                    raw
                }
            }
        };

        if !raw.status.is_success() {
            return Err(raw.error());
        }
        let v: Value = serde_json::from_str(&raw.body).unwrap_or(Value::Null);
        if v["success"] == Value::Bool(false) {
            bail!("{}", v["message"].as_str().unwrap_or("Export was rejected"));
        }
        Ok(v["export_id"].as_str().map(str::to_string))
    }

    fn raw(&self, rb: RequestBuilder) -> Result<Raw> {
        let resp = self.send(rb)?;
        let status = resp.status();
        Ok(Raw { status, body: resp.text().unwrap_or_default() })
    }

    /// Checks on an export started with [`start_export`].
    pub fn export_state(&self, id: &str) -> Result<ExportState> {
        // Frigate 0.17+: export job status.
        let resp = self.send(self.req(Method::GET, &format!("/api/jobs/export/{}", enc(id))))?;
        if resp.status().is_success() {
            let v: Value = resp.json()?;
            let progress = (v["progress_percent"].as_f64().unwrap_or(0.0) / 100.0).clamp(0.0, 1.0) as f32;
            match v["status"].as_str().unwrap_or("") {
                "queued" => return Ok(ExportState::Pending { running: false, progress: 0.0 }),
                "running" => return Ok(ExportState::Pending { running: true, progress }),
                s @ ("failed" | "cancelled") => {
                    return Ok(ExportState::Failed(v["error_message"].as_str().unwrap_or(s).to_string()));
                }
                "success" => {
                    if let Some(p) = v["results"]["video_path"].as_str() {
                        return Ok(ExportState::Done { video_path: p.to_string() });
                    }
                }
                _ => {}
            }
        }

        // Fall back to the export record itself.
        let resp = self.send(self.req(Method::GET, &format!("/api/exports/{}", enc(id))))?;
        if resp.status().is_success() {
            let v: Value = resp.json()?;
            if let Some(e) = parse_export(&v) {
                return Ok(state_from_row(&e));
            }
        }
        match self.list_exports()?.into_iter().find(|e| e.id == id) {
            Some(e) => Ok(state_from_row(&e)),
            None => Ok(ExportState::Pending { running: false, progress: 0.0 }),
        }
    }

    pub fn list_exports(&self) -> Result<Vec<ExportInfo>> {
        let v: Value = self.ok(self.req(Method::GET, "/api/exports"))?.json()?;
        Ok(v.as_array().map(|a| a.iter().filter_map(parse_export).collect()).unwrap_or_default())
    }

    /// Finds an export by its friendly name (for old servers that don't return an id).
    pub fn find_export_by_name(&self, name: &str) -> Result<Option<ExportInfo>> {
        Ok(self.list_exports()?.into_iter().find(|e| e.name == name))
    }

    /// Downloads a finished export to `dest`, calling `progress(downloaded, total)`.
    /// Where Frigate serves an export's video file.
    fn export_url_path(video_path: &str) -> String {
        let rel = video_path
            .strip_prefix("/media/frigate/exports/")
            .unwrap_or_else(|| video_path.rsplit('/').next().unwrap_or(video_path));
        format!("/exports/{}", rel.split('/').map(enc).collect::<Vec<_>>().join("/"))
    }

    /// Size of an export's video on the server (a HEAD request; None if unknown).
    pub fn export_size(&self, video_path: &str) -> Option<u64> {
        let resp = self.req(Method::HEAD, &Self::export_url_path(video_path)).timeout(Duration::from_secs(5)).send().ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.headers().get(reqwest::header::CONTENT_LENGTH)?.to_str().ok()?.parse().ok()
    }

    pub fn download(&self, video_path: &str, dest: &Path, mut progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf> {
        let url_path = Self::export_url_path(video_path);

        metrics::media_request();
        let mut resp = self
            .req(Method::GET, &url_path)
            .timeout(Duration::from_secs(60 * 60 * 6))
            .send()
            .map_err(friendly_net_error)?;
        if !resp.status().is_success() {
            return Err(api_error(resp)).context("download failed");
        }
        let total = resp.content_length();

        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("can't create {}", dir.display()))?;
        }
        let tmp = dest.with_extension("part");
        let mut file = File::create(&tmp).with_context(|| format!("can't write {}", tmp.display()))?;
        let mut buf = vec![0u8; 256 * 1024];
        let mut done: u64 = 0;
        loop {
            let n = resp.read(&mut buf).context("download interrupted")?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            done += n as u64;
            metrics::media_bytes(n as u64);
            progress(done, total);
        }
        file.flush()?;
        drop(file);
        if let Some(t) = total
            && done < t {
                let _ = std::fs::remove_file(&tmp);
                bail!("download incomplete ({done} of {t} bytes)");
            }
        std::fs::rename(&tmp, dest).with_context(|| format!("can't save {}", dest.display()))?;
        Ok(dest.to_path_buf())
    }

    pub fn delete_export(&self, id: &str) -> Result<()> {
        let raw = self.raw(self.req(Method::POST, "/api/exports/delete").json(&json!({ "ids": [id] })))?;
        if raw.status.is_success() {
            return Ok(());
        }
        if raw.is_missing_route() {
            // Older Frigate: DELETE /api/export/{id}
            let raw = self.raw(self.req(Method::DELETE, &format!("/api/export/{}", enc(id))))?;
            if raw.status.is_success() {
                return Ok(());
            }
            return Err(raw.error());
        }
        Err(raw.error())
    }
}

struct Raw {
    status: StatusCode,
    body: String,
}

impl Raw {
    /// FastAPI answers an unknown route with `{"detail": "Not Found"}` (or 405),
    /// whereas Frigate's own errors carry `"success": false`. Only the former
    /// means "this server is older, try the legacy endpoint".
    fn is_missing_route(&self) -> bool {
        matches!(self.status, StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED)
            && serde_json::from_str::<Value>(&self.body).map(|v| v.get("success").is_none()).unwrap_or(true)
    }

    fn error(&self) -> anyhow::Error {
        error_from(self.status, &self.body)
    }
}

fn state_from_row(e: &ExportInfo) -> ExportState {
    if e.in_progress {
        ExportState::Pending { running: true, progress: 0.0 }
    } else {
        ExportState::Done { video_path: e.video_path.clone() }
    }
}

fn parse_export(v: &Value) -> Option<ExportInfo> {
    Some(ExportInfo {
        id: v["id"].as_str()?.to_string(),
        camera: v["camera"].as_str().unwrap_or_default().to_string(),
        name: v["name"].as_str().unwrap_or_default().to_string(),
        date: v["date"].as_f64().unwrap_or(0.0),
        video_path: v["video_path"].as_str().unwrap_or_default().to_string(),
        thumb_path: v["thumb_path"].as_str().unwrap_or_default().to_string(),
        in_progress: v["in_progress"].as_bool().unwrap_or(false),
        size: None,
    })
}

fn token_from_cookies(resp: &Response) -> Option<String> {
    resp.headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|c| c.split(';').next())
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, v)| k.trim() == "frigate_token" && !v.trim().is_empty())
        .map(|(_, v)| v.trim().to_string())
}

fn api_error(resp: Response) -> anyhow::Error {
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    error_from(status, &body)
}

fn error_from(status: StatusCode, body: &str) -> anyhow::Error {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["message"].as_str().or(v["detail"].as_str()).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(200).collect::<String>().trim().to_string());
    match status {
        StatusCode::UNAUTHORIZED => anyhow!("session-expired: Frigate says you're not signed in (401). {msg}"),
        StatusCode::FORBIDDEN => anyhow!("Access denied (403): {msg}"),
        _ if msg.is_empty() => anyhow!("Frigate returned {status}"),
        _ => anyhow!("Frigate returned {status}: {msg}"),
    }
}

fn friendly_net_error(e: reqwest::Error) -> anyhow::Error {
    // The useful part is at the bottom of the chain (DNS, refused, TLS alert…).
    let mut causes: Vec<String> = Vec::new();
    let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
    while let Some(s) = src {
        let text = s.to_string();
        if !causes.iter().any(|c| c.contains(&text)) {
            causes.push(text);
        }
        src = s.source();
    }
    let root = causes.last().cloned().unwrap_or_else(|| e.to_string());
    let chain = format!("{e:?} {}", causes.join(" ")).to_lowercase();
    let host = e.url().and_then(|u| u.host_str()).unwrap_or("the server").to_string();
    if chain.contains(tls::CHANGED) {
        anyhow!("{}: this server's certificate is different from the one you trusted before. If you reinstalled Frigate or renewed its certificate, trust the new one; otherwise someone may be intercepting the connection.", tls::CHANGED)
    } else if chain.contains("certificaterequired") || chain.contains("certificate required") {
        anyhow!("{host} asks for a client certificate (mutual TLS, often set up on a reverse proxy). Chismoso can't send one yet. Connect to Frigate directly, for example https://{host}:8971, or ask whoever runs the server. ({root})")
    } else if chain.contains("invalid peer certificate") || chain.contains("unknownissuer") {
        // Only the *server's* certificate failing our checks means "not trusted yet".
        // Other TLS failures that merely mention certificates (alerts sent by the
        // server, unsupported key types) fall through to the messages below.
        anyhow!("certificate-untrusted: Frigate's certificate isn't from a trusted authority (normal for Frigate's built-in certificate on port 8971).")
    } else if chain.contains("dns error") || chain.contains("failed to lookup") || chain.contains("no address associated") || chain.contains("name or service not known") {
        anyhow!("Couldn't find {host}: the name doesn't resolve on this network. If it only works at home, connect to your home Wi-Fi or VPN. ({root})")
    } else if chain.contains("connection refused") {
        anyhow!("{host} refused the connection. Check the port. ({root})")
    } else if chain.contains("timed out") || e.is_timeout() {
        anyhow!("{host} didn't answer in time. Check that it's reachable from this network. ({root})")
    } else if chain.contains("alert") || chain.contains("handshake") || chain.contains("tls") {
        anyhow!("Couldn't set up a secure connection with {host}. ({root})")
    } else if e.is_connect() {
        anyhow!("Can't reach {host}. Check the address and port. ({root})")
    } else {
        anyhow!("Network error: {root}")
    }
}

/// Accepts "frigate.local:8971", "https://host:8971/", "http://1.2.3.4:5000/api" etc.
pub fn normalize_url(input: &str) -> Result<String> {
    let mut s = input.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        bail!("Enter the Frigate address, e.g. https://frigate.local:8971");
    }
    if !s.starts_with("http://") && !s.starts_with("https://") {
        // 8971 is HTTPS by default; anything else (5000, 80, custom) is usually plain HTTP.
        s = if s.contains(":8971") { format!("https://{s}") } else { format!("http://{s}") };
    }
    if let Some(stripped) = s.strip_suffix("/api") {
        s = stripped.to_string();
    }
    Ok(s)
}

/// Percent-encodes one URL path segment.
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(normalize_url("frigate.local:8971").unwrap(), "https://frigate.local:8971");
        assert_eq!(normalize_url("192.168.1.169:5000/").unwrap(), "http://192.168.1.169:5000");
        assert_eq!(normalize_url("https://x.org:8971/api").unwrap(), "https://x.org:8971");
        assert!(normalize_url("  ").is_err());
    }

    #[test]
    fn encoding() {
        assert_eq!(enc("north_outside"), "north_outside");
        assert_eq!(enc("a b/c"), "a%20b%2Fc");
    }
}
