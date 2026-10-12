//! WebSockets to Frigate, opened here with the user's login and certificate
//! setting:
//!
//! * Live video over go2rtc's MSE socket (fragmented MP4), for webviews without
//!   WebRTC (most Linux distros' WebKitGTK) and networks where WebRTC's UDP
//!   port is blocked. Bytes are handed to the page as they arrive.
//! * One-shot commands on Frigate's /ws socket (the same messages as MQTT,
//!   no broker needed), e.g. switching detection on or off.

use crate::frigate::{Frigate, enc};
use crate::{metrics, tls};
use anyhow::{Context, Result, anyhow};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Connector, Message, WebSocket};

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

/// Opens an authenticated WebSocket to `path` on the Frigate server.
pub fn connect(client: &Frigate, path: &str) -> Result<Socket> {
    let base = client.base_url();
    let (secure, rest) = match base.strip_prefix("https://") {
        Some(r) => (true, r),
        None => (false, base.trim_start_matches("http://")),
    };
    let url = format!("{}://{rest}{path}", if secure { "wss" } else { "ws" });
    let mut request = url.as_str().into_client_request()?;
    if let Some(token) = client.token() {
        request.headers_mut().insert("Authorization", format!("Bearer {token}").parse()?);
    }

    let host = request.uri().host().ok_or_else(|| anyhow!("bad address"))?.trim_matches(['[', ']']).to_string();
    let port = request.uri().port_u16().unwrap_or(if secure { 443 } else { 80 });
    // Try every address (IPv6 may come first and be unreachable).
    let mut last_err = None;
    let mut tcp = None;
    for addr in (host.as_str(), port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(10)) {
            Ok(s) => {
                tcp = Some(s);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let tcp = match tcp {
        Some(t) => t,
        None => return Err(last_err.map(anyhow::Error::from).unwrap_or_else(|| anyhow!("can't resolve {host}"))).context("can't reach Frigate"),
    };
    tcp.set_nodelay(true)?;
    // Generous timeout for the TLS + WebSocket handshake (slow VPNs).
    tcp.set_read_timeout(Some(Duration::from_secs(10)))?;

    let connector = if secure {
        Connector::Rustls(Arc::new(tls::client_config(client.trust()).context("TLS setup failed")?))
    } else {
        Connector::Plain
    };
    let (ws, _) = tungstenite::client_tls_with_config(request, tcp, None, Some(connector)).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("401") {
            anyhow!("session-expired: Frigate refused the connection (401).")
        } else if msg.contains(tls::CHANGED) {
            anyhow!("{}: the server's certificate changed.", tls::CHANGED)
        } else {
            anyhow!("Couldn't open the connection: {msg}")
        }
    })?;
    Ok(ws)
}

pub fn set_read_timeout(ws: &Socket, d: Duration) {
    let _ = match ws.get_ref() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(d)),
        MaybeTlsStream::Rustls(s) => s.sock.set_read_timeout(Some(d)),
        _ => Ok(()),
    };
}

/// Streams `stream` until `stop` is set or a callback returns false.
/// `on_text` gets go2rtc's JSON control messages (the first one names the
/// codec), `on_data` gets fMP4 segments.
pub fn run(
    client: &Frigate,
    stream: &str,
    codecs: &str,
    stop: Arc<AtomicBool>,
    mut on_text: impl FnMut(String) -> bool,
    mut on_data: impl FnMut(Vec<u8>) -> bool,
) -> Result<()> {
    let mut ws = connect(client, &format!("/live/mse/api/ws?src={}", enc(stream)))?;
    let _counted = metrics::LiveStream::open();
    // Short read timeout from now on, so the loop notices `stop` quickly.
    set_read_timeout(&ws, Duration::from_millis(500));
    ws.send(Message::Text(serde_json::json!({ "type": "mse", "value": codecs }).to_string().into()))?;

    let mut idle = 0u32;
    loop {
        if stop.load(Ordering::Relaxed) {
            let _ = ws.close(None);
            let _ = ws.flush();
            return Ok(());
        }
        match ws.read() {
            Ok(Message::Binary(b)) => {
                idle = 0;
                metrics::live_bytes(b.len() as u64);
                if !on_data(b.to_vec()) {
                    return Ok(());
                }
            }
            Ok(Message::Text(t)) => {
                if !on_text(t.to_string()) {
                    return Ok(());
                }
            }
            Ok(Message::Close(_)) => return Err(anyhow!("Frigate closed the live stream.")),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                idle += 1;
                if idle > 40 {
                    return Err(anyhow!("No video from this camera for 20 seconds."));
                }
            }
            Err(e) => return Err(anyhow!("Live stream ended: {e}")),
        }
    }
}

/// Sends one message on Frigate's /ws socket, e.g. topic "pool/detect/set"
/// with payload "OFF". Frigate applies these at runtime (until it restarts).
pub fn send_command(client: &Frigate, topic: &str, payload: &str) -> Result<()> {
    let mut ws = connect(client, "/ws")?;
    ws.send(Message::Text(serde_json::json!({ "topic": topic, "payload": payload, "retain": false }).to_string().into()))?;
    let _ = ws.flush();
    // Give Frigate a moment to read it before we hang up.
    std::thread::sleep(Duration::from_millis(150));
    let _ = ws.close(None);
    let _ = ws.flush();
    Ok(())
}
