//! Bidirectional bridge between the in-process MCP server and the live
//! Tauri WebView. Used by the `app_*` MCP tools (open-pdf, set-zoom,
//! screenshot-view, zoom-in, zoom-out) so an external test harness can
//! drive the *running* application instead of only the headless renderer.
//!
//! Flow per request:
//! 1. `request(handle, "open-pdf", params)` allocates a fresh `request_id`
//!    and a tokio `oneshot` channel, stashes the sender in
//!    `McpAppBridge.pending`, then emits a Tauri event named
//!    `mcp:open-pdf` with `{ request_id, params }`.
//! 2. JS (see `js/mcp-bridge.js`) listens for the event, performs the
//!    requested action, and calls `app_response(request_id, result)`.
//! 3. The `app_response` Tauri command pulls the matching sender out of
//!    `pending` and forwards `result` through the oneshot.
//! 4. `request` awaits the oneshot (with a timeout) and returns the
//!    JSON-serializable result to the MCP tool handler.
//!
//! If the WebView never responds (or panics), the timeout fires and the
//! pending entry is cleaned up so the slot doesn't leak.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// Tauri-managed state holding the in-flight oneshot senders keyed by
/// request id. Cheaply cloneable because it lives behind `tauri::State`
/// which already wraps the inner type in an `Arc`.
pub struct McpAppBridge {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    ready: AtomicBool,
}

impl McpAppBridge {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            ready: AtomicBool::new(false),
        }
    }

    fn next_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    fn mark_ready(&self) {
        self.ready.store(true, Ordering::Release);
    }
}

/// Send a request to the WebView and await its response.
///
/// `event_name` is emitted to the main window with payload
/// `{ request_id, params }`. The JS side must call
/// `invoke('app_response', { requestId, result })` once it's done.
///
/// Times out after `timeout` and returns `Err` (the pending slot is
/// cleaned up so old request IDs don't leak forever).
pub async fn request(
    app: &AppHandle,
    bridge: &McpAppBridge,
    event_name: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let request_id = bridge.next_request_id();
    let (tx, rx) = oneshot::channel::<Value>();

    {
        let mut pending = bridge
            .pending
            .lock()
            .map_err(|e| format!("pending lock poisoned: {e}"))?;
        pending.insert(request_id, tx);
    }

    let payload = json!({
        "request_id": request_id,
        "params":     params,
    });
    if let Err(e) = app.emit(event_name, payload) {
        // Drop the pending entry if emit failed — JS will never respond.
        if let Ok(mut pending) = bridge.pending.lock() {
            pending.remove(&request_id);
        }
        return Err(format!("emit {event_name}: {e}"));
    }

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_recv_err)) => {
            // Sender dropped without sending — pending was already removed
            // by app_response, but if not, clean up anyway.
            if let Ok(mut pending) = bridge.pending.lock() {
                pending.remove(&request_id);
            }
            Err(format!(
                "no response from WebView for {event_name} (request {request_id})"
            ))
        }
        Err(_elapsed) => {
            if let Ok(mut pending) = bridge.pending.lock() {
                pending.remove(&request_id);
            }
            Err(format!(
                "timed out after {:?} waiting for {event_name} (request {request_id})",
                timeout
            ))
        }
    }
}

/// Tauri command invoked by the WebView once it has finished servicing a
/// request. Pulls the matching oneshot sender out of `pending` and
/// forwards `result` to the awaiter in `request()`. If the request id is
/// unknown (timed out, duplicate response) we silently drop the value —
/// the request is already gone.
#[tauri::command]
pub fn app_response(
    request_id: u64,
    result: Value,
    bridge: tauri::State<McpAppBridge>,
) -> Result<bool, String> {
    let sender_opt = {
        let mut pending = bridge
            .pending
            .lock()
            .map_err(|e| format!("pending lock poisoned: {e}"))?;
        pending.remove(&request_id)
    };
    if let Some(sender) = sender_opt {
        // If the receiver is gone (already timed out) the send will fail —
        // that's fine, just discard.
        let _ = sender.send(result);
    }
    Ok(true)
}

/// Tiny one-shot diagnostic Tauri command — the WebView calls this from
/// `initMcpBridge()` so we can confirm the bridge JS reached the wiring
/// step. Kept lightweight so its presence in production builds is
/// harmless. Logged to stderr only.
#[tauri::command]
pub fn mcp_bridge_ready(
    events: Vec<String>,
    bridge: tauri::State<McpAppBridge>,
) -> Result<bool, String> {
    bridge.mark_ready();
    eprintln!("[mcp-bridge] WebView ready, listening for: {events:?}");
    Ok(true)
}
