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
    let r = Frigate::resume(&url(), &token, trust()).expect("resume with a good token");
    assert!(r.overview().is_ok());
    let err = Frigate::resume(&url(), "not-a-token", trust()).err().expect("bad token must fail");
    assert!(format!("{err:#}").starts_with("session-expired:"), "{err:#}");
}
