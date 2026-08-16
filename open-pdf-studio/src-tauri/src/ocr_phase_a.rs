//! Phase A OCR process isolation.
//!
//! ONNX Runtime Web executes in a Web Worker, but WebKit can retain the
//! Worker's released WASM pages in the long-lived WebContent allocator.  A
//! Worker restart therefore bounds live JavaScript state without bounding the
//! application's process RSS.  This spike runs exactly one Worker job in a
//! short-lived child instance of this binary so the operating system owns the
//! final reclamation boundary.  No PDF content is changed or written.

use crate::worker_pool::WorkerPool;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const JOB_MAGIC: &[u8; 8] = b"OPSOCR1\0";
const CHILD_TIMEOUT: Duration = Duration::from_secs(120);
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OcrChildJobMetadata {
    schema_version: u32,
    job_id: String,
    path: String,
    page_index: u32,
    width: u32,
    height: u32,
    scale: f32,
    raster_ms: f64,
    cancel_after_ms: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct OcrChildJobState {
    request_path: Option<PathBuf>,
    result_path: Option<PathBuf>,
}

impl OcrChildJobState {
    pub fn from_request_path(request_path: Option<PathBuf>) -> Self {
        let result_path = request_path.as_ref().map(result_path_for);
        Self {
            request_path,
            result_path,
        }
    }

    pub fn is_child(&self) -> bool {
        self.request_path.is_some()
    }
}

struct JobFiles {
    request: PathBuf,
    result: PathBuf,
}

impl Drop for JobFiles {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.request);
        let _ = fs::remove_file(&self.result);
    }
}

fn result_path_for(request_path: &PathBuf) -> PathBuf {
    request_path.with_extension("result.json")
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn create_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("create OCR child file {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("write OCR child file {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync OCR child file {}: {error}", path.display()))
}

fn encode_job(metadata: &OcrChildJobMetadata, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let metadata = serde_json::to_vec(metadata)
        .map_err(|error| format!("serialize OCR child metadata: {error}"))?;
    let metadata_len =
        u32::try_from(metadata.len()).map_err(|_| "OCR child metadata is too large".to_string())?;
    let mut output = Vec::with_capacity(JOB_MAGIC.len() + 4 + metadata.len() + rgba.len());
    output.extend_from_slice(JOB_MAGIC);
    output.extend_from_slice(&metadata_len.to_le_bytes());
    output.extend_from_slice(&metadata);
    output.extend_from_slice(rgba);
    Ok(output)
}

fn spawn_one_job_child(files: JobFiles) -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("resolve OCR child executable: {error}"))?;
    let spawned_at = epoch_ms();
    let mut command = Command::new(&executable);
    command
        .arg("--ocr-phase-a-child")
        .arg(&files.request)
        .env("OPDS_OCR_CHILD", "1")
        .stdin(Stdio::null());
    #[cfg(debug_assertions)]
    command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    #[cfg(not(debug_assertions))]
    command.stdout(Stdio::null()).stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW. The executable already uses the Windows GUI
        // subsystem; this also protects development builds and test runners.
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("start isolated OCR child: {error}"))?;
    let child_pid = child.id();
    let wait_started = Instant::now();
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if wait_started.elapsed() < CHILD_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "isolated OCR child timed out after {} seconds",
                    CHILD_TIMEOUT.as_secs()
                ));
            }
            Err(error) => return Err(format!("wait for isolated OCR child: {error}")),
        }
    };
    if !exit_status.success() {
        return Err(format!("isolated OCR child exited with {exit_status}"));
    }

    let output = fs::read_to_string(&files.result)
        .map_err(|error| format!("read isolated OCR result: {error}"))?;
    let mut value: Value = serde_json::from_str(&output)
        .map_err(|error| format!("parse isolated OCR result: {error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "isolated OCR result must be a JSON object".to_string())?;
    let exited_at = epoch_ms();
    object.insert(
        "isolation".to_string(),
        json!({
            "boundary": "native-child-process",
            "oneJob": true,
            "childPid": child_pid,
            "spawnedAtEpochMs": spawned_at,
            "exitedAtEpochMs": exited_at,
            "exitStatus": exit_status.code(),
        }),
    );
    let lifecycle = object
        .entry("lifecycle".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Some(checkpoints) = lifecycle.as_array_mut() {
        checkpoints.insert(
            0,
            json!({
                "stage": "ocr-child-process-spawned",
                "atEpochMs": spawned_at,
                "childPid": child_pid,
            }),
        );
        checkpoints.push(json!({
            "stage": "ocr-child-process-exited",
            "atEpochMs": exited_at,
            "childPid": child_pid,
        }));
    }
    serde_json::to_string(&value).map_err(|error| format!("serialize isolated OCR result: {error}"))
}

/// Parent-side Phase A entry point. PDFium rasterization remains low priority
/// and in the main app's existing idle sidecar pool. Only the RGBA page and
/// metadata cross into the disposable OCR child process.
#[tauri::command]
pub async fn run_ocr_phase_a_isolated(
    path: String,
    page_index: u32,
    scale: f32,
    cancel_after_ms: Option<f64>,
    pool: tauri::State<'_, Arc<tokio::sync::OnceCell<WorkerPool>>>,
) -> Result<String, String> {
    if path.is_empty() {
        return Err("OCR path must not be empty".to_string());
    }
    if !scale.is_finite() || !(0.5..=4.0).contains(&scale) {
        return Err("OCR scale must be between 0.5 and 4.0".to_string());
    }
    if cancel_after_ms.is_some_and(|value| !value.is_finite() || value < 0.0) {
        return Err("OCR cancellation delay must be a non-negative finite number".to_string());
    }
    let pool = pool.get().ok_or_else(|| {
        "PDFium worker pool is not ready; isolated OCR will not use in-process fallback".to_string()
    })?;
    let raster_started = Instant::now();
    let (width, height, rgba) = pool
        .render_low_priority(&path, page_index, scale, 0)
        .await
        .map_err(|error| error.to_string())?;
    let raster_ms = raster_started.elapsed().as_secs_f64() * 1000.0;
    let expected = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "OCR raster dimensions overflow".to_string())?;
    if rgba.len() != expected {
        return Err(format!(
            "OCR raster byte length mismatch: got {}, expected {expected}",
            rgba.len()
        ));
    }

    let sequence = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
    let job_id = format!("{}-{sequence}-{}", std::process::id(), epoch_ms());
    let request_path = std::env::temp_dir().join(format!("open-pdf-studio-ocr-{job_id}.job"));
    let result_path = result_path_for(&request_path);
    let files = JobFiles {
        request: request_path.clone(),
        result: result_path,
    };
    let metadata = OcrChildJobMetadata {
        schema_version: 1,
        job_id,
        path,
        page_index,
        width,
        height,
        scale,
        raster_ms,
        cancel_after_ms,
    };
    let encoded = encode_job(&metadata, &rgba)?;
    create_private_file(&request_path, &encoded)?;
    drop(encoded);
    drop(rgba);

    tauri::async_runtime::spawn_blocking(move || spawn_one_job_child(files))
        .await
        .map_err(|error| format!("join isolated OCR child: {error}"))?
}

/// Child-side read. An empty binary response means this is a normal app
/// process. The request file is unlinked as soon as its bytes are mapped into
/// the WebView so cancelled or crashed jobs do not leave page pixels on disk.
#[tauri::command]
pub fn ocr_phase_a_child_take_job(
    state: tauri::State<'_, OcrChildJobState>,
) -> Result<tauri::ipc::Response, String> {
    let Some(path) = state.request_path.as_ref() else {
        return Ok(tauri::ipc::Response::new(Vec::<u8>::new()));
    };
    #[cfg(debug_assertions)]
    eprintln!("[ocr-child] taking job from {}", path.display());
    let bytes = fs::read(path)
        .map_err(|error| format!("read OCR child request {}: {error}", path.display()))?;
    let _ = fs::remove_file(path);
    Ok(tauri::ipc::Response::new(bytes))
}

/// Child-side completion. The payload is validated as JSON before it is
/// written; the app process exits immediately afterwards, reclaiming the
/// WebContent allocator along with the terminated OCR Worker.
#[tauri::command]
pub fn ocr_phase_a_child_complete(
    app: tauri::AppHandle,
    state: tauri::State<'_, OcrChildJobState>,
    payload: String,
) -> Result<(), String> {
    let Some(result_path) = state.result_path.as_ref() else {
        return Err("normal app process cannot complete an OCR child job".to_string());
    };
    let _: Value = serde_json::from_str(&payload)
        .map_err(|error| format!("OCR child result is not valid JSON: {error}"))?;
    #[cfg(debug_assertions)]
    eprintln!("[ocr-child] writing result to {}", result_path.display());
    create_private_file(result_path, payload.as_bytes())?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        handle.exit(0);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_job_binary_has_versioned_header_and_exact_rgba_tail() {
        let metadata = OcrChildJobMetadata {
            schema_version: 1,
            job_id: "test".to_string(),
            path: "/fixture.pdf".to_string(),
            page_index: 0,
            width: 1,
            height: 1,
            scale: 2.0,
            raster_ms: 1.5,
            cancel_after_ms: None,
        };
        let encoded = encode_job(&metadata, &[1, 2, 3, 4]).unwrap();
        assert_eq!(&encoded[..8], JOB_MAGIC);
        let metadata_len = u32::from_le_bytes(encoded[8..12].try_into().unwrap()) as usize;
        let decoded: OcrChildJobMetadata =
            serde_json::from_slice(&encoded[12..12 + metadata_len]).unwrap();
        assert_eq!(decoded.schema_version, 1);
        assert_eq!(&encoded[12 + metadata_len..], &[1, 2, 3, 4]);
    }

    #[test]
    fn result_path_does_not_alias_the_page_buffer_file() {
        let request = PathBuf::from("/tmp/open-pdf-studio-ocr-test.job");
        assert_eq!(
            result_path_for(&request),
            PathBuf::from("/tmp/open-pdf-studio-ocr-test.result.json")
        );
    }
}
