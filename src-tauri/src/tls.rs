//! One TLS setup for every connection to Frigate (HTTP and WebSockets).
//!
//! * Normal servers are checked against the operating system's certificate
//!   store, like a browser.
//! * Frigate's default self-signed certificate (port 8971) can't be checked
//!   that way. When the user chooses to trust it, we pin that exact
//!   certificate (its SHA-256 fingerprint) on first use. Later connections
//!   only accept the same certificate, so a different one (a stranger on the
//!   network, or a reinstalled server) is refused instead of silently trusted.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use rustls_platform_verifier::BuilderVerifierExt;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

/// Marker in error text so the UI can offer "trust the new certificate".
pub const CHANGED: &str = "certificate-changed";

#[derive(Clone, Default)]
pub struct Trust {
    /// Trust a certificate the OS doesn't (self-signed), pinned below.
    pub self_signed: bool,
    /// Fingerprint the user already trusted; None on first connection.
    pub pinned: Option<String>,
    /// Fingerprint of the certificate the server actually presented.
    pub seen: Arc<Mutex<Option<String>>>,
}

pub fn fingerprint(cert: &CertificateDer<'_>) -> String {
    Sha256::digest(cert.as_ref()).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

pub fn client_config(trust: &Trust) -> Result<ClientConfig, rustls::Error> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions()?;
    if trust.self_signed {
        Ok(builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedCert { provider, trust: trust.clone() }))
            .with_no_client_auth())
    } else {
        Ok(builder.with_platform_verifier()?.with_no_client_auth())
    }
}

#[derive(Debug)]
struct PinnedCert {
    provider: Arc<CryptoProvider>,
    trust: Trust,
}

impl std::fmt::Debug for Trust {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Trust").field("pinned", &self.pinned).finish()
    }
}

impl ServerCertVerifier for PinnedCert {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fp = fingerprint(end_entity);
        *self.trust.seen.lock().unwrap() = Some(fp.clone());
        match &self.trust.pinned {
            Some(p) if !p.eq_ignore_ascii_case(&fp) => Err(rustls::Error::General(CHANGED.into())),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}
