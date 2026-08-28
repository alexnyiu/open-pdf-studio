use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener as StdTcpListener},
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{
        header::{
            ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CACHE_CONTROL,
            CONTENT_LENGTH, CONTENT_TYPE, ORIGIN,
        },
        HeaderMap, HeaderValue, StatusCode,
    },
    response::Response,
    routing::get,
    Router,
};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use tokio::io::{AsyncRead, ReadBuf};
use tokio_util::io::ReaderStream;

pub const CHUNK_FALLBACK_BYTES: usize = 16 * 1024;
pub const TRANSFER_TTL: Duration = Duration::from_secs(30);
const MAX_STREAM_DIMENSION: u32 = 32_768;
const MAX_STREAM_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_STREAM_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug)]
pub struct RenderPngTransferEntry {
    pub path: PathBuf,
    pub source_path: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub expected_origin: String,
    pub created_at: Instant,
}

#[derive(Default)]
struct TransferEntries(Mutex<HashMap<String, RenderPngTransferEntry>>);

impl Drop for TransferEntries {
    fn drop(&mut self) {
        if let Ok(entries) = self.0.get_mut() {
            for (_, entry) in entries.drain() {
                let _ = std::fs::remove_file(entry.path);
            }
        }
    }
}

#[derive(Clone, Default)]
pub struct RenderPngTransfers(Arc<TransferEntries>);

#[derive(Clone, Copy)]
pub struct RenderPngStreamEndpoint {
    pub address: SocketAddr,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPngTransferDescriptor {
    pub token: String,
    pub url: Option<String>,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub chunk_bytes: u32,
    pub expires_at: u64,
}

fn now_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let mut token = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut token, "{byte:02x}");
    }
    token
}

pub fn create_transfer_target() -> (String, PathBuf) {
    let token = random_token();
    let path = std::env::temp_dir().join(format!("open-pdf-studio-render-{token}.png"));
    (token, path)
}

pub fn validate_application_origin(origin: &str) -> Result<(), String> {
    let allowed = matches!(origin, "tauri://localhost" | "http://tauri.localhost")
        || (cfg!(debug_assertions)
            && matches!(origin, "http://localhost:3041" | "http://127.0.0.1:3041"));
    if allowed {
        Ok(())
    } else {
        Err("render stream refused an unexpected application origin".to_string())
    }
}

fn validate_transfer(width: u32, height: u32, bytes: u64) -> Result<(), String> {
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if width == 0
        || height == 0
        || width > MAX_STREAM_DIMENSION
        || height > MAX_STREAM_DIMENSION
        || pixels > MAX_STREAM_PIXELS
    {
        return Err("render stream dimensions exceed the bounded raster limit".to_string());
    }
    if bytes == 0 || bytes > MAX_STREAM_BYTES {
        return Err("render stream payload exceeds the bounded byte limit".to_string());
    }
    Ok(())
}

impl RenderPngTransfers {
    pub fn register(
        &self,
        token: String,
        path: PathBuf,
        source_path: String,
        width: u32,
        height: u32,
        bytes: u64,
        expected_origin: String,
        endpoint: RenderPngStreamEndpoint,
        prefer_stream: bool,
    ) -> Result<RenderPngTransferDescriptor, String> {
        validate_transfer(width, height, bytes)?;
        validate_application_origin(&expected_origin)?;
        self.cleanup_expired();
        self.0 .0.lock().map_err(|error| error.to_string())?.insert(
            token.clone(),
            RenderPngTransferEntry {
                path,
                source_path,
                bytes,
                width,
                height,
                expected_origin,
                created_at: Instant::now(),
            },
        );
        Ok(RenderPngTransferDescriptor {
            url: prefer_stream.then(|| format!("http://{}/raster/{token}", endpoint.address)),
            token,
            width,
            height,
            bytes,
            chunk_bytes: CHUNK_FALLBACK_BYTES as u32,
            expires_at: now_epoch_millis().saturating_add(TRANSFER_TTL.as_millis() as u64),
        })
    }

    pub fn cleanup_expired(&self) -> usize {
        let mut removed = Vec::new();
        if let Ok(mut entries) = self.0 .0.lock() {
            let expired = entries
                .iter()
                .filter_map(|(token, entry)| {
                    (entry.created_at.elapsed() >= TRANSFER_TTL).then(|| token.clone())
                })
                .collect::<Vec<_>>();
            for token in expired {
                if let Some(entry) = entries.remove(&token) {
                    removed.push(entry.path);
                }
            }
        }
        let count = removed.len();
        for path in removed {
            let _ = std::fs::remove_file(path);
        }
        count
    }

    pub fn cancel(&self, token: &str) -> bool {
        let entry = self
            .0
             .0
            .lock()
            .ok()
            .and_then(|mut entries| entries.remove(token));
        if let Some(entry) = entry {
            let _ = std::fs::remove_file(entry.path);
            true
        } else {
            false
        }
    }

    pub fn cancel_for_source(&self, source_path: &str) -> usize {
        let mut removed = Vec::new();
        if let Ok(mut entries) = self.0 .0.lock() {
            let tokens = entries
                .iter()
                .filter_map(|(token, entry)| {
                    (entry.source_path == source_path).then(|| token.clone())
                })
                .collect::<Vec<_>>();
            for token in tokens {
                if let Some(entry) = entries.remove(&token) {
                    removed.push(entry.path);
                }
            }
        }
        let count = removed.len();
        for path in removed {
            let _ = std::fs::remove_file(path);
        }
        count
    }

    pub fn cancel_all(&self) -> usize {
        let paths = self
            .0
             .0
            .lock()
            .map(|mut entries| {
                entries
                    .drain()
                    .map(|(_, entry)| entry.path)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let count = paths.len();
        for path in paths {
            let _ = std::fs::remove_file(path);
        }
        count
    }

    pub fn read_chunk(&self, token: &str, offset: u64) -> Result<Vec<u8>, String> {
        use std::io::{Read, Seek};

        self.cleanup_expired();
        let (path, total_bytes) = {
            let entries = self.0 .0.lock().map_err(|error| error.to_string())?;
            let entry = entries
                .get(token)
                .ok_or_else(|| "PNG transfer is absent or expired".to_string())?;
            (entry.path.clone(), entry.bytes)
        };
        if offset >= total_bytes {
            return Err("PNG transfer offset is outside the payload".to_string());
        }
        let remaining = usize::try_from(total_bytes - offset)
            .unwrap_or(usize::MAX)
            .min(CHUNK_FALLBACK_BYTES);
        let mut file = std::fs::File::open(&path).map_err(|error| error.to_string())?;
        file.seek(std::io::SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut chunk = vec![0_u8; remaining];
        file.read_exact(&mut chunk)
            .map_err(|error| error.to_string())?;
        if offset + remaining as u64 >= total_bytes {
            self.cancel(token);
        }
        Ok(chunk)
    }

    fn take_for_stream(
        &self,
        token: &str,
        request_origin: &str,
    ) -> Result<RenderPngTransferEntry, StatusCode> {
        self.cleanup_expired();
        let mut entries = self
            .0
             .0
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let entry = entries.get(token).ok_or(StatusCode::NOT_FOUND)?;
        if entry.expected_origin != request_origin {
            eprintln!(
                "[render-stream] rejected origin expected={} actual={}",
                entry.expected_origin, request_origin
            );
            return Err(StatusCode::FORBIDDEN);
        }
        entries.remove(token).ok_or(StatusCode::NOT_FOUND)
    }
}

pub fn bind_loopback() -> Result<(StdTcpListener, RenderPngStreamEndpoint), String> {
    let listener = StdTcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|error| format!("bind render stream: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("configure render stream: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("resolve render stream address: {error}"))?;
    if !address.ip().is_loopback() {
        return Err("render stream refused a non-loopback listener".to_string());
    }
    Ok((listener, RenderPngStreamEndpoint { address }))
}

struct DeleteAfterRead {
    file: tokio::fs::File,
    path: PathBuf,
}

impl AsyncRead for DeleteAfterRead {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.file).poll_read(cx, buffer)
    }
}

impl Drop for DeleteAfterRead {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn stream_raster(
    State(transfers): State<RenderPngTransfers>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Response<Body>, StatusCode> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StatusCode::NOT_FOUND);
    }
    let origin = headers
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            eprintln!("[render-stream] rejected request without Origin header");
            StatusCode::FORBIDDEN
        })?;
    let entry = transfers.take_for_stream(&token, origin)?;
    validate_transfer(entry.width, entry.height, entry.bytes)
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let file = tokio::fs::File::open(&entry.path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let body = Body::from_stream(ReaderStream::new(DeleteAfterRead {
        file,
        path: entry.path,
    }));
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    let response_headers = response.headers_mut();
    response_headers.insert(CONTENT_TYPE, HeaderValue::from_static("image/png"));
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response_headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response_headers.insert(
        ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_str(origin).map_err(|_| StatusCode::FORBIDDEN)?,
    );
    response_headers.insert(
        ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length, X-Content-Type-Options, Cache-Control"),
    );
    response_headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&entry.bytes.to_string())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    Ok(response)
}

pub async fn serve(listener: StdTcpListener, transfers: RenderPngTransfers) -> Result<(), String> {
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|error| format!("start render stream: {error}"))?;
    let cleanup_transfers = transfers.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            cleanup_transfers.cleanup_expired();
        }
    });
    let router = Router::new()
        .route("/raster/{token}", get(stream_raster))
        .with_state(transfers);
    axum::serve(listener, router)
        .await
        .map_err(|error| format!("render stream server failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture_file(bytes: &[u8]) -> PathBuf {
        let (_, path) = create_transfer_target();
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        path
    }

    async fn test_server(
        transfers: RenderPngTransfers,
    ) -> (RenderPngStreamEndpoint, tokio::task::JoinHandle<()>) {
        let (listener, endpoint) = bind_loopback().unwrap();
        let handle = tokio::spawn(async move {
            let _ = serve(listener, transfers).await;
        });
        (endpoint, handle)
    }

    #[test]
    fn token_is_unpredictable_256_bit_hex() {
        let (left, _) = create_transfer_target();
        let (right, _) = create_transfer_target();
        assert_eq!(left.len(), 64);
        assert!(left.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(left, right);
    }

    #[test]
    fn listener_is_loopback_only_and_limits_are_enforced() {
        let (_, endpoint) = bind_loopback().unwrap();
        assert_eq!(endpoint.address.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert!(validate_transfer(0, 10, 10).is_err());
        assert!(validate_transfer(MAX_STREAM_DIMENSION + 1, 10, 10).is_err());
        assert!(validate_transfer(10, 10, MAX_STREAM_BYTES + 1).is_err());
        assert!(validate_application_origin("https://example.com").is_err());
    }

    #[tokio::test]
    async fn stream_rejects_wrong_origin_is_single_use_and_cleans_file() {
        let transfers = RenderPngTransfers::default();
        let (endpoint, server) = test_server(transfers.clone()).await;
        let bytes = b"not-a-real-png-but-lossless-stream-test";
        let path = fixture_file(bytes);
        let token = random_token();
        let descriptor = transfers
            .register(
                token,
                path.clone(),
                "/tmp/source.pdf".to_string(),
                10,
                10,
                bytes.len() as u64,
                "tauri://localhost".to_string(),
                endpoint,
                true,
            )
            .unwrap();
        let client = reqwest::Client::new();
        let rejected = client
            .get(descriptor.url.as_ref().unwrap())
            .header(ORIGIN.as_str(), "https://example.com")
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
        assert!(path.exists());
        let accepted = client
            .get(descriptor.url.as_ref().unwrap())
            .header(ORIGIN.as_str(), "tauri://localhost")
            .send()
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(accepted.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(accepted.headers()[CACHE_CONTROL], "no-store");
        assert_eq!(accepted.headers()["x-content-type-options"], "nosniff");
        assert_eq!(
            accepted.headers()[ACCESS_CONTROL_EXPOSE_HEADERS],
            "Content-Length, X-Content-Type-Options, Cache-Control"
        );
        assert_eq!(accepted.bytes().await.unwrap().as_ref(), bytes);
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!path.exists());
        let reused = client
            .get(descriptor.url.as_ref().unwrap())
            .header(ORIGIN.as_str(), "tauri://localhost")
            .send()
            .await
            .unwrap();
        assert_eq!(reused.status(), StatusCode::NOT_FOUND);
        server.abort();
    }

    #[test]
    fn cancellation_source_cleanup_and_expiry_remove_files() {
        let transfers = RenderPngTransfers::default();
        let (_, endpoint) = bind_loopback().unwrap();
        let first = fixture_file(b"first");
        let second = fixture_file(b"second");
        let first_token = random_token();
        let second_token = random_token();
        transfers
            .register(
                first_token.clone(),
                first.clone(),
                "one.pdf".to_string(),
                1,
                1,
                5,
                "tauri://localhost".to_string(),
                endpoint,
                false,
            )
            .unwrap();
        transfers
            .register(
                second_token,
                second.clone(),
                "two.pdf".to_string(),
                1,
                1,
                6,
                "tauri://localhost".to_string(),
                endpoint,
                false,
            )
            .unwrap();
        assert!(transfers.cancel(&first_token));
        assert!(!first.exists());
        assert_eq!(transfers.cancel_for_source("two.pdf"), 1);
        assert!(!second.exists());

        let expired = fixture_file(b"expired");
        let expired_token = random_token();
        transfers
            .register(
                expired_token.clone(),
                expired.clone(),
                "expired.pdf".to_string(),
                1,
                1,
                7,
                "tauri://localhost".to_string(),
                endpoint,
                false,
            )
            .unwrap();
        transfers
            .0
             .0
            .lock()
            .unwrap()
            .get_mut(&expired_token)
            .unwrap()
            .created_at = Instant::now() - TRANSFER_TTL - Duration::from_millis(1);
        assert_eq!(transfers.cleanup_expired(), 1);
        assert!(!expired.exists());
    }
}
