//! Against dev/mock_frigate.py --tls (login admin/password):
//!   python3 dev/mock_frigate.py --tls &
//!   cd src-tauri && MOCK_FRIGATE=https://127.0.0.1:5443 cargo test --test mock_session -- --ignored
use chismoso_lib::frigate::Frigate;
use chismoso_lib::tls::Trust;

fn url() -> String {
    std::env::var("MOCK_FRIGATE").unwrap_or_else(|_| "https://127.0.0.1:5443".into())
}

#[test]
#[ignore]
fn kept_token_resumes_and_bad_token_is_expired() {
    chismoso_lib::tls::init();
    let trust = || Trust { self_signed: true, ..Default::default() };
    let c = Frigate::connect(&url(), "admin", "password", trust()).expect("login");
    let token = c.token().expect("token");
    // Resuming sends nothing; the first request tells whether the token is good.
    let r = Frigate::resume(&url(), &token, trust()).expect("resume with a good token");
    assert!(r.overview().is_ok());
    let bad = Frigate::resume(&url(), "not-a-token", trust()).expect("resume never touches the network");
    let Err(err) = bad.overview() else { panic!("bad token must fail") };
    assert!(format!("{err:#}").starts_with("session-expired:"), "{err:#}");
}

/// PTZ through the app's own command socket: info, hold-to-move, stop, preset.
#[test]
#[ignore]
fn ptz_moves_the_pretend_camera() {
    chismoso_lib::tls::init();
    let trust = Trust { self_signed: true, ..Default::default() };
    let c = Frigate::connect(&url(), "admin", "password", trust).expect("login");
    let info = c.ptz_info("backyard_ptz").unwrap();
    assert!(info["features"].as_array().unwrap().iter().any(|f| f == "pt"), "{info}");
    assert_eq!(c.ptz_info("garage").unwrap(), serde_json::json!({}));
    let cmd = chismoso_lib::mse::Commander::start(c.clone());
    for p in ["MOVE_RIGHT", "STOP", "ZOOM_IN", "STOP", "preset_gate", "MOVE_RELATIVE_0.5_-0.25"] {
        assert!(cmd.send("backyard_ptz/ptz", p));
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
}
