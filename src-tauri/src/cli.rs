//! Headless mode, for scripts and scheduled jobs:
//!
//!   chismoso --url https://frigate.local:8971 --user admin --insecure \
//!       --camera pool --start "2026-10-10 06:00" --end "2026-10-10 18:00" --speed 720
//!
//! The password is read from --password or the FRIGATE_PASSWORD environment variable.

use crate::frigate::{ExportMode, Frigate};
use crate::jobs::{self, JobSpec, Update};
use chrono::{Local, NaiveDateTime, TimeZone};
use std::path::PathBuf;

const HELP: &str = "\
Chismoso, a client for Frigate NVR

Run with no arguments to open the app. Command-line mode:

  chismoso --url URL [options] --camera NAME --start TIME --end TIME

Connection:
  --url URL           Frigate address, e.g. https://frigate.local:8971 or http://host:5000
  --user NAME         Frigate username (omit for port 5000 / auth disabled)
  --password PASS     Password (or set FRIGATE_PASSWORD)
  --insecure          Accept a self-signed certificate (prints its fingerprint)
  --pin FINGERPRINT   With --insecure: only accept this certificate (SHA-256)

What to export:
  --camera NAME       Camera name; repeat for several, or use 'all'
  --start TIME        'YYYY-MM-DD HH:MM' (local time)
  --end TIME          'YYYY-MM-DD HH:MM' (local time)
  --speed N           Timelapse speed (default 60). 1440 = one day per minute
  --fps N             Timelapse frame rate (default 30)
  --smooth            Decode every frame (slower). By default speeds of 60x and
                      up decode only keyframes, which is many times faster
  --realtime          Export at normal speed instead of a timelapse
  --out DIR           Where to save (default: current folder)
  --delete-after      Delete the server copy once downloaded

Other:
  --list-cameras      Print camera names and exit
  --list-exports      Print exports stored on the server and exit
  -V, --version       Print the version and exit
  -h, --help          Show this help
";

#[derive(Default)]
struct Args {
    url: Option<String>,
    user: String,
    password: Option<String>,
    insecure: bool,
    pin: Option<String>,
    cameras: Vec<String>,
    start: Option<String>,
    end: Option<String>,
    speed: f32,
    fps: u32,
    realtime: bool,
    smooth: bool,
    out: Option<PathBuf>,
    delete_after: bool,
    list_cameras: bool,
    list_exports: bool,
}

pub fn run(argv: Vec<String>) -> i32 {
    crate::tls::init();
    match run_inner(argv) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            2
        }
    }
}

fn run_inner(argv: Vec<String>) -> anyhow::Result<i32> {
    let mut a = Args { speed: 60.0, fps: 30, ..Default::default() };
    let mut it = argv.into_iter();
    while let Some(flag) = it.next() {
        let mut val = |name: &str| it.next().ok_or_else(|| anyhow::anyhow!("{name} needs a value"));
        match flag.as_str() {
            "-V" | "--version" => {
                println!("{}", crate::about::line());
                return Ok(0);
            }
            "-h" | "--help" => {
                print!("{HELP}");
                return Ok(0);
            }
            "--url" => a.url = Some(val("--url")?),
            "--user" => a.user = val("--user")?,
            "--password" => a.password = Some(val("--password")?),
            "--insecure" => a.insecure = true,
            "--pin" => a.pin = Some(val("--pin")?),
            "--camera" => a.cameras.push(val("--camera")?),
            "--start" => a.start = Some(val("--start")?),
            "--end" => a.end = Some(val("--end")?),
            "--speed" => a.speed = val("--speed")?.parse()?,
            "--fps" => a.fps = val("--fps")?.parse()?,
            "--realtime" => a.realtime = true,
            "--smooth" => a.smooth = true,
            "--out" => a.out = Some(PathBuf::from(val("--out")?)),
            "--delete-after" => a.delete_after = true,
            "--list-cameras" => a.list_cameras = true,
            "--list-exports" => a.list_exports = true,
            other => anyhow::bail!("unknown option '{other}' (see --help)"),
        }
    }

    let url = a.url.ok_or_else(|| anyhow::anyhow!("--url is required (see --help)"))?;
    let password = a.password.or_else(|| std::env::var("FRIGATE_PASSWORD").ok()).unwrap_or_default();
    let trust = crate::tls::Trust { self_signed: a.insecure, pinned: a.pin.clone(), ..Default::default() };
    let client = Frigate::connect(&url, &a.user, &password, trust)?;
    if a.insecure && a.pin.is_none()
        && let Some(fp) = client.cert_fingerprint() {
            eprintln!("note: trusting certificate {fp}\n      pass --pin {fp} to require this exact certificate");
        }
    let cams = client.cameras()?;

    if a.list_cameras {
        for c in &cams {
            println!("{}\t{}", c.name, c.friendly_name);
        }
        return Ok(0);
    }
    if a.list_exports {
        for e in client.list_exports()? {
            println!("{}\t{}\t{}\t{}", e.id, e.camera, e.name, if e.in_progress { "rendering" } else { &e.video_path });
        }
        return Ok(0);
    }

    let selected: Vec<String> = if a.cameras.iter().any(|c| c == "all") {
        cams.iter().map(|c| c.name.clone()).collect()
    } else {
        for c in &a.cameras {
            if !cams.iter().any(|k| &k.name == c) {
                let names: Vec<_> = cams.iter().map(|k| k.name.as_str()).collect();
                anyhow::bail!("unknown camera '{c}'. Available: {}", names.join(", "));
            }
        }
        a.cameras.clone()
    };
    if selected.is_empty() {
        anyhow::bail!("choose at least one --camera (or --camera all)");
    }
    let start = parse_time(a.start.as_deref(), "--start")?;
    let end = parse_time(a.end.as_deref(), "--end")?;
    if end <= start {
        anyhow::bail!("--end must be after --start");
    }
    let mode = if a.realtime { ExportMode::Realtime } else { ExportMode::Timelapse { speed: a.speed, fps: a.fps, keyframes_only: !a.smooth && a.speed >= 60.0 } };
    let out_dir = a.out.unwrap_or_else(|| PathBuf::from("."));

    // All cameras are submitted at once; Frigate renders several in parallel.
    let failures = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let handles: Vec<_> = selected
        .into_iter()
        .map(|camera| {
            let spec = JobSpec { camera: camera.clone(), start, end, mode, small: false, out_dir: out_dir.clone(), delete_after_download: a.delete_after };
            let (client, failures) = (client.clone(), failures.clone());
            std::thread::spawn(move || {
                let mut last = String::new();
                jobs::run(&client, &spec, &mut |u| match u {
                    Update::Stage(s, _) => {
                        // one line per stage; render progress in 10% steps
                        let key = match s.find('%') {
                            Some(_) => s.split_whitespace().last().map(|p| {
                                let n: u32 = p.trim_end_matches('%').parse().unwrap_or(0);
                                format!("Rendering {}%", n / 10 * 10)
                            }).unwrap_or(s.clone()),
                            None if s.starts_with("Downloading") => "Downloading".into(),
                            None => s.clone(),
                        };
                        if key != last {
                            println!("[{camera}] {key}");
                            last = key;
                        }
                    }
                    Update::Done(p) => println!("[{camera}] saved {}", p.display()),
                    Update::Failed(e) => {
                        failures.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        println!("[{camera}] FAILED: {e}");
                    }
                });
            })
        })
        .collect();
    for h in handles {
        let _ = h.join();
    }
    let failures = failures.load(std::sync::atomic::Ordering::Relaxed);
    Ok(if failures == 0 { 0 } else { 1 })
}

fn parse_time(s: Option<&str>, flag: &str) -> anyhow::Result<i64> {
    let s = s.ok_or_else(|| anyhow::anyhow!("{flag} is required"))?;
    let n = NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%d %H:%M")
        .map_err(|_| anyhow::anyhow!("{flag} must look like '2026-10-10 18:30'"))?;
    Local
        .from_local_datetime(&n)
        .earliest()
        .map(|d| d.timestamp())
        .ok_or_else(|| anyhow::anyhow!("{flag}: that local time doesn't exist (DST change)"))
}
