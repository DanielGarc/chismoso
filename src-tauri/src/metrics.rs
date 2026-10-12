//! Counters of what this app asks of Frigate, so the load is visible in
//! Settings → "Load from this app". Cheap atomics; no history kept here.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::Relaxed};

static API_REQUESTS: AtomicU64 = AtomicU64::new(0);
static API_BYTES: AtomicU64 = AtomicU64::new(0);
static MEDIA_REQUESTS: AtomicU64 = AtomicU64::new(0);
static MEDIA_BYTES: AtomicU64 = AtomicU64::new(0);
static LIVE_BYTES: AtomicU64 = AtomicU64::new(0);
static LIVE_STREAMS: AtomicUsize = AtomicUsize::new(0);

pub fn api(bytes: u64) {
    API_REQUESTS.fetch_add(1, Relaxed);
    API_BYTES.fetch_add(bytes, Relaxed);
}
pub fn media_request() {
    MEDIA_REQUESTS.fetch_add(1, Relaxed);
}
pub fn media_bytes(n: u64) {
    MEDIA_BYTES.fetch_add(n, Relaxed);
}
pub fn live_bytes(n: u64) {
    LIVE_BYTES.fetch_add(n, Relaxed);
}

/// Counts an open MSE live stream for as long as the guard lives.
pub struct LiveStream;
impl LiveStream {
    pub fn open() -> Self {
        LIVE_STREAMS.fetch_add(1, Relaxed);
        LiveStream
    }
}
impl Drop for LiveStream {
    fn drop(&mut self) {
        LIVE_STREAMS.fetch_sub(1, Relaxed);
    }
}

#[derive(Serialize)]
pub struct Snapshot {
    pub api_requests: u64,
    pub api_bytes: u64,
    pub media_requests: u64,
    pub media_bytes: u64,
    pub live_bytes: u64,
    pub live_streams: usize,
}

pub fn snapshot() -> Snapshot {
    Snapshot {
        api_requests: API_REQUESTS.load(Relaxed),
        api_bytes: API_BYTES.load(Relaxed),
        media_requests: MEDIA_REQUESTS.load(Relaxed),
        media_bytes: MEDIA_BYTES.load(Relaxed),
        live_bytes: LIVE_BYTES.load(Relaxed),
        live_streams: LIVE_STREAMS.load(Relaxed),
    }
}
