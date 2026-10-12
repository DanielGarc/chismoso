// Stamps the build with its git commit and date, shown in About and --version.
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let git = |args: &[&str]| {
        Command::new("git").args(args).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let mut commit = git(&["rev-parse", "--short=8", "HEAD"]).unwrap_or_default();
    if !commit.is_empty() && git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty()) {
        commit.push_str("-dirty");
    }
    // SOURCE_DATE_EPOCH keeps reproducible builds reproducible.
    let secs = std::env::var("SOURCE_DATE_EPOCH").ok().and_then(|s| s.parse::<i64>().ok())
        .unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0));
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    println!("cargo:rustc-env=BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=BUILD_DATE={y:04}-{m:02}-{d:02}");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/index");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    tauri_build::build()
}

// Days since 1970-01-01 -> (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
