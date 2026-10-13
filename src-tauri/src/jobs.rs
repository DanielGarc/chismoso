//! One export job: queue on Frigate → wait → download → (optionally) delete on server.
//! Shared by the GUI and the command-line mode.

use crate::frigate::{ExportMode, ExportState, Frigate};
use anyhow::{Result, bail};
use chrono::{Local, TimeZone};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub enum Update {
    Stage(String, f32),
    Done(PathBuf),
    Failed(String),
}

pub struct JobSpec {
    pub camera: String,
    pub start: i64,
    pub end: i64,
    pub mode: ExportMode,
    /// Re-encode smaller (720p) for sending to people.
    pub small: bool,
    pub out_dir: PathBuf,
    pub delete_after_download: bool,
}

impl JobSpec {
    /// e.g. `pool_2026-10-10_0600-to-2026-10-10_1800_60x`
    pub fn base_name(&self) -> String {
        let fmt = |ts: i64| {
            Local
                .timestamp_opt(ts, 0)
                .single()
                .map(|d| d.format("%Y-%m-%d_%H%M").to_string())
                .unwrap_or_else(|| ts.to_string())
        };
        let mode = match self.mode {
            ExportMode::Realtime => "realtime".to_string(),
            ExportMode::Timelapse { speed, .. } => format!("{}x", trim_float(speed)),
        };
        sanitize(&format!("{}_{}-to-{}_{}", self.camera, fmt(self.start), fmt(self.end), mode))
    }
}

pub fn run(client: &Frigate, spec: &JobSpec, report: &mut dyn FnMut(Update)) {
    match run_inner(client, spec, report) {
        Ok(path) => report(Update::Done(path)),
        Err(e) => report(Update::Failed(format!("{e:#}"))),
    }
}

fn run_inner(client: &Frigate, spec: &JobSpec, report: &mut dyn FnMut(Update)) -> Result<PathBuf> {
    let name = spec.base_name();
    let dest = unique_path(&spec.out_dir, &name, "mp4");

    // 1. Queue the export, waiting politely if Frigate's export queue is full.
    report(Update::Stage("Queuing export…".into(), 0.0));
    let started = Instant::now();
    let id = loop {
        match client.start_export(&spec.camera, spec.start, spec.end, &name, spec.mode, spec.small) {
            Ok(id) => break id,
            Err(e) if format!("{e}").contains("queue is full") && started.elapsed() < Duration::from_secs(1800) => {
                report(Update::Stage("Frigate's export queue is full, waiting…".into(), 0.0));
                std::thread::sleep(Duration::from_secs(10));
            }
            Err(e) => return Err(e),
        }
    };

    // Old Frigate versions don't return an id: find the export by its name.
    let id = match id {
        Some(id) => id,
        None => {
            let mut found = None;
            for _ in 0..30 {
                if let Some(e) = client.find_export_by_name(&name)? {
                    found = Some(e.id);
                    break;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
            match found {
                Some(id) => id,
                None => bail!("Export was accepted but never appeared on the server."),
            }
        }
    };

    // 2. Wait for Frigate to render it.
    let started = Instant::now();
    let mut failures = 0;
    let video_path = loop {
        // A long render can outlast a Wi-Fi blip or a Frigate restart; keep
        // waiting through a few minutes of errors before giving up.
        let state = match client.export_state(&id) {
            Ok(s) => {
                failures = 0;
                s
            }
            Err(e) if failures < 60 && !format!("{e}").starts_with("session-expired") => {
                failures += 1;
                report(Update::Stage(format!("Waiting for Frigate (retrying: {e})"), 0.0));
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
            Err(e) => return Err(e),
        };
        match state {
            ExportState::Pending { running: false, .. } => report(Update::Stage("Queued on Frigate…".into(), 0.0)),
            ExportState::Pending { running: true, progress } => {
                let label = if progress > 0.0 {
                    format!("Rendering on Frigate… {:.0}%", progress * 100.0)
                } else {
                    "Rendering on Frigate…".to_string()
                };
                report(Update::Stage(label, progress * 0.8));
            }
            ExportState::Failed(msg) => bail!("Frigate couldn't create the export: {msg}"),
            ExportState::Done { video_path } => break video_path,
        }
        if started.elapsed() > Duration::from_secs(6 * 3600) {
            bail!("Gave up waiting after 6 hours.");
        }
        std::thread::sleep(Duration::from_secs(2));
    };

    // 3. Download.
    let mut last = Instant::now() - Duration::from_secs(1);
    let path = client.download(&video_path, &dest, |done, total| {
        if last.elapsed() >= Duration::from_millis(150) {
            last = Instant::now();
            let (frac, label) = match total {
                Some(t) if t > 0 => {
                    (done as f32 / t as f32, format!("Downloading… {} / {}", mb(done), mb(t)))
                }
                _ => (0.0, format!("Downloading… {}", mb(done))),
            };
            report(Update::Stage(label, 0.8 + 0.2 * frac));
        }
    })?;

    // 4. Optionally clean up the server copy.
    if spec.delete_after_download {
        report(Update::Stage("Removing server copy…".into(), 1.0));
        if let Err(e) = client.delete_export(&id) {
            report(Update::Stage(format!("Saved, but couldn't delete the server copy: {e}"), 1.0));
        }
    }
    Ok(path)
}

fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_000_000.0)
}

fn trim_float(v: f32) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

pub fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect()
}

pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}_{n}.{ext}"));
        n += 1;
    }
    p
}
