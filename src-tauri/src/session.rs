//! "Keep me signed in": remembers Frigate's session token (never the
//! password) in the app's own data folder, readable only by this user.
//! The token expires on Frigate's schedule (`auth.session_length`) and is
//! renewed while the app is in use; signing out deletes it.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Saved {
    pub url: String,
    pub user: String,
    pub token: String,
    /// How the server's certificate was trusted, so resuming checks it the same way.
    pub self_signed: bool,
    pub pinned: Option<String>,
}

fn file(dir: &Path) -> PathBuf {
    dir.join("session.json")
}

pub fn load(dir: &Path) -> Option<Saved> {
    let text = std::fs::read_to_string(file(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(dir: &Path, s: &Saved) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join("session.json.tmp");
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600); // this user only
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(serde_json::to_string(s)?.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(tmp, file(dir))
}

pub fn clear(dir: &Path) {
    let _ = std::fs::remove_file(file(dir));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_clear() {
        let dir = std::env::temp_dir().join(format!("chismoso-session-test-{}", std::process::id()));
        let s = Saved { url: "https://f:8971".into(), user: "me".into(), token: "t".into(), self_signed: true, pinned: Some("ab".into()) };
        save(&dir, &s).unwrap();
        let back = load(&dir).unwrap();
        assert_eq!((back.url, back.user, back.token, back.pinned), (s.url, s.user, s.token, s.pinned));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(file(&dir)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        clear(&dir);
        assert!(load(&dir).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
