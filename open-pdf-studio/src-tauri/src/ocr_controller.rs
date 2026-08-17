//! macOS production OCR process controller.
//!
//! The long-lived application rasterizes one annotation-free page through the
//! low-priority PDFium sidecar lane, then starts one disposable application
//! child containing one OCR Worker. Process exit is the hard WebKit memory
//! reclamation boundary. The child receives no source-document path.

use crate::worker_pool::{OcrRasterLimits, WorkerPool};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const JOB_MAGIC: &[u8; 8] = b"OPSOCR2\0";
const NATIVE_REQUEST_CONTRACT: &str = "open-pdf-studio.ocr.native-page-request";
const NATIVE_JOB_CONTRACT: &str = "open-pdf-studio.ocr.native-job";
const NATIVE_RESULT_CONTRACT: &str = "open-pdf-studio.ocr.native-result";
const CONTROLLER_OUTCOME_CONTRACT: &str = "open-pdf-studio.ocr.native-controller-outcome";
const JOB_CONTRACT: &str = "open-pdf-studio.ocr.job";
const MODEL_PACK_CONTRACT: &str = "open-pdf-studio.ocr.model-pack";
const NATIVE_SCHEMA_VERSION: u32 = 1;
const JOB_SCHEMA_VERSION: u32 = 1;
const MODEL_PACK_SCHEMA_VERSION: u32 = 1;

const ENGINE_ID: &str = "paddleocr-pp-ocrv6-small-onnx-wasm";
const MODEL_PACK_ID: &str = "paddleocr-pp-ocrv6-small-macos";
const MODEL_PACK_VERSION: &str = "1.0.0";
const DETECTION_SHA256: &str = "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e";
const RECOGNITION_SHA256: &str = "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634";
const DICTIONARY_SHA256: &str = "d5b428957abd863137f0b98f81f38fea3eb70bc279f778fbea41e1a68fa090ec";

pub const MAX_WIDTH_PX: u32 = 8192;
pub const MAX_HEIGHT_PX: u32 = 8192;
pub const MAX_PIXELS: u64 = 16_000_000;
pub const MAX_METADATA_BYTES: usize = 1024 * 1024;
pub const MAX_RASTER_BYTES: usize = (64 * 1024 * 1024) - 32;
pub const MAX_RESULT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_SOURCE_PATH_BYTES: usize = 32 * 1024;
const TERMINATION_GRACE: Duration = Duration::from_millis(500);
const STALE_SESSION_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const JOB_ACTIVE: u8 = 0;
const JOB_CANCELLED: u8 = 1;
const JOB_TERMINAL: u8 = 2;

#[cfg(unix)]
mod unix_process {
    unsafe extern "C" {
        pub fn geteuid() -> u32;
        pub fn kill(pid: i32, signal: i32) -> i32;
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    pub const O_NOFOLLOW: i32 = 0x0000_0100;
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    pub const O_NOFOLLOW: i32 = 0x0002_0000;
    pub const SIGTERM: i32 = 15;
    pub const SIGKILL: i32 = 9;
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fingerprint {
    algorithm: String,
    value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelPackAssets {
    detection: String,
    recognition: String,
    dictionary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelPackIdentity {
    contract: String,
    schema_version: u32,
    pack_id: String,
    pack_version: String,
    assets: ModelPackAssets,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentIdentity {
    id: String,
    fingerprint: Fingerprint,
    revision: u64,
    generation: String,
    page_count: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativePageIdentity {
    id: String,
    index: u32,
    revision: u64,
    source_raster_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguagePolicy {
    mode: String,
    languages: Vec<String>,
    scripts: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrientationRequest {
    mode: String,
    degrees: Option<i32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreprocessingRequest {
    mode: String,
    operations: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecognitionOptions {
    language_policy: LanguagePolicy,
    include_words: bool,
    orientation: OrientationRequest,
    deskew: bool,
    preprocessing: PreprocessingRequest,
    raster_dpi: f64,
    maximum_pixels: u64,
    maximum_side: u32,
    timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentPolicy {
    skip_meaningful_existing_text: bool,
    force_rerun: bool,
    replace_application_owned_ocr_only: bool,
    keep_completed_pages: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulerMetadata {
    priority: String,
    execution: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativePageRequest {
    contract: String,
    schema_version: u32,
    job_id: String,
    request_id: String,
    engine_id: String,
    model_pack: ModelPackIdentity,
    document: DocumentIdentity,
    page: NativePageIdentity,
    recognition_configuration_hash: Fingerprint,
    recognition_options: RecognitionOptions,
    document_policy: DocumentPolicy,
    scheduler: SchedulerMetadata,
    created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RasterIdentity {
    id: String,
    fingerprint: Fingerprint,
    coordinate_space: String,
    width_px: u32,
    height_px: u32,
    dpi: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductionPageIdentity {
    id: String,
    index: u32,
    revision: u64,
    source_raster: RasterIdentity,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductionJob {
    contract: String,
    schema_version: u32,
    job_id: String,
    request_id: String,
    engine_id: String,
    model_pack: ModelPackIdentity,
    document: DocumentIdentity,
    page: ProductionPageIdentity,
    recognition_configuration_hash: Fingerprint,
    recognition_options: RecognitionOptions,
    document_policy: DocumentPolicy,
    scheduler: SchedulerMetadata,
    created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RasterEnvelope {
    format: String,
    width_px: u32,
    height_px: u32,
    row_bytes: u64,
    byte_length: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeLimits {
    max_width_px: u32,
    max_height_px: u32,
    max_pixels: u64,
    max_metadata_bytes: u64,
    max_raster_bytes: u64,
    max_result_bytes: u64,
    timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultFileIdentity {
    id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeJobEnvelope {
    contract: String,
    schema_version: u32,
    job: ProductionJob,
    raster: RasterEnvelope,
    raster_ms: f64,
    preprocessing_request: PreprocessingRequest,
    limits: NativeLimits,
    result_file: ResultFileIdentity,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrFailure {
    code: String,
    stage: String,
    message: String,
    retryable: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeResultEnvelope {
    contract: String,
    schema_version: u32,
    status: String,
    job_id: String,
    request_id: String,
    document_id: String,
    document_revision: u64,
    document_generation: String,
    page_id: String,
    page_index: u32,
    page_revision: u64,
    engine_id: String,
    model_pack: ModelPackIdentity,
    recognition_configuration_hash: Fingerprint,
    source_raster: RasterIdentity,
    result_file_id: String,
    result: Option<Value>,
    failure: Option<OcrFailure>,
    lifecycle: Vec<Value>,
    resources: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolationMetadata {
    boundary: &'static str,
    one_job: bool,
    child_pid: Option<u32>,
    spawned_at_epoch_ms: Option<u128>,
    exited_at_epoch_ms: Option<u128>,
    exit_status: Option<i32>,
    reaped: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancellationMetadata {
    method: &'static str,
    message: String,
    requested_at_epoch_ms: u128,
    completed_at_epoch_ms: u128,
    latency_ms: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupMetadata {
    request_file_removed: bool,
    result_file_removed: bool,
    no_child_survived: bool,
    session_directory_private: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerOutcome {
    contract: &'static str,
    schema_version: u32,
    status: String,
    job_id: String,
    job: Option<ProductionJob>,
    result: Option<Value>,
    failure: Option<OcrFailure>,
    child_pid: Option<u32>,
    lifecycle: Vec<Value>,
    resources: Value,
    isolation: IsolationMetadata,
    cancellation: Option<CancellationMetadata>,
    cleanup: CleanupMetadata,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelReport {
    job_id: String,
    found: bool,
    child_pid: Option<u32>,
    terminated: bool,
    latency_ms: Option<f64>,
    cleanup: CleanupMetadata,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelBatchReport {
    scope: String,
    jobs: Vec<CancelReport>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrJobStatus {
    job_id: String,
    found: bool,
    state: &'static str,
    child_pid: Option<u32>,
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn failure(code: &str, stage: &str, message: &str, retryable: bool) -> OcrFailure {
    OcrFailure {
        code: code.to_string(),
        stage: stage.to_string(),
        message: message.to_string(),
        retryable,
    }
}

fn is_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 256
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-'))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn validate_fingerprint(value: &Fingerprint) -> bool {
    value.algorithm == "sha256" && is_sha256(&value.value)
}

fn validate_model_pack(value: &ModelPackIdentity) -> bool {
    value.contract == MODEL_PACK_CONTRACT
        && value.schema_version == MODEL_PACK_SCHEMA_VERSION
        && value.pack_id == MODEL_PACK_ID
        && value.pack_version == MODEL_PACK_VERSION
        && value.assets.detection == DETECTION_SHA256
        && value.assets.recognition == RECOGNITION_SHA256
        && value.assets.dictionary == DICTIONARY_SHA256
}

fn validate_native_request(request: &NativePageRequest) -> Result<(), OcrFailure> {
    let invalid = || {
        failure(
            "OCR_NATIVE_REQUEST_INVALID",
            "validating",
            "The native OCR page request is invalid or unsupported",
            false,
        )
    };
    if request.contract != NATIVE_REQUEST_CONTRACT
        || request.schema_version != NATIVE_SCHEMA_VERSION
        || !is_identifier(&request.job_id)
        || !is_identifier(&request.request_id)
        || request.engine_id != ENGINE_ID
        || !validate_model_pack(&request.model_pack)
        || !is_identifier(&request.document.id)
        || !validate_fingerprint(&request.document.fingerprint)
        || !is_identifier(&request.document.generation)
        || request.document.page_count == 0
        || request.page.index >= request.document.page_count
        || !is_identifier(&request.page.id)
        || !is_identifier(&request.page.source_raster_id)
        || !validate_fingerprint(&request.recognition_configuration_hash)
        || request.created_at.is_empty()
        || request.created_at.len() > 64
    {
        return Err(invalid());
    }
    let options = &request.recognition_options;
    if options.language_policy.mode != "automatic"
        || !options.language_policy.languages.is_empty()
        || !options.language_policy.scripts.is_empty()
        || options.include_words
        || options.orientation.mode != "none"
        || options.orientation.degrees.is_some()
        || options.deskew
        || options.preprocessing.mode != "none"
        || !options.preprocessing.operations.is_empty()
        || !options.raster_dpi.is_finite()
        || options.raster_dpi < 36.0
        || options.raster_dpi > 288.0
        || options.maximum_pixels == 0
        || options.maximum_pixels > MAX_PIXELS
        || options.maximum_side == 0
        || options.maximum_side > MAX_WIDTH_PX.min(MAX_HEIGHT_PX)
        || options.timeout_ms == 0
        || options.timeout_ms > MAX_TIMEOUT_MS
        || request.scheduler.priority != "background"
        || request.scheduler.execution != "one-page-child"
        || (request.document_policy.skip_meaningful_existing_text
            && request.document_policy.force_rerun)
    {
        return Err(invalid());
    }
    let serialized = serde_json::to_vec(request).map_err(|_| invalid())?;
    if serialized.len() > MAX_METADATA_BYTES {
        return Err(invalid());
    }
    Ok(())
}

fn raster_fingerprint(rgba: &[u8]) -> Fingerprint {
    Fingerprint {
        algorithm: "sha256".to_string(),
        value: format!("{:x}", Sha256::digest(rgba)),
    }
}

fn production_job(
    request: &NativePageRequest,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> ProductionJob {
    ProductionJob {
        contract: JOB_CONTRACT.to_string(),
        schema_version: JOB_SCHEMA_VERSION,
        job_id: request.job_id.clone(),
        request_id: request.request_id.clone(),
        engine_id: request.engine_id.clone(),
        model_pack: request.model_pack.clone(),
        document: request.document.clone(),
        page: ProductionPageIdentity {
            id: request.page.id.clone(),
            index: request.page.index,
            revision: request.page.revision,
            source_raster: RasterIdentity {
                id: request.page.source_raster_id.clone(),
                fingerprint: raster_fingerprint(rgba),
                coordinate_space: "source-raster-pixels".to_string(),
                width_px: width,
                height_px: height,
                dpi: request.recognition_options.raster_dpi,
            },
        },
        recognition_configuration_hash: request.recognition_configuration_hash.clone(),
        recognition_options: request.recognition_options.clone(),
        document_policy: request.document_policy.clone(),
        scheduler: request.scheduler.clone(),
        created_at: request.created_at.clone(),
    }
}

fn native_limits(request: &NativePageRequest) -> NativeLimits {
    NativeLimits {
        max_width_px: request.recognition_options.maximum_side.min(MAX_WIDTH_PX),
        max_height_px: request.recognition_options.maximum_side.min(MAX_HEIGHT_PX),
        max_pixels: request.recognition_options.maximum_pixels.min(MAX_PIXELS),
        max_metadata_bytes: MAX_METADATA_BYTES as u64,
        max_raster_bytes: MAX_RASTER_BYTES as u64,
        max_result_bytes: MAX_RESULT_BYTES as u64,
        timeout_ms: request.recognition_options.timeout_ms,
    }
}

fn validate_native_job(envelope: &NativeJobEnvelope, metadata_bytes: usize) -> Result<(), String> {
    let request = NativePageRequest {
        contract: NATIVE_REQUEST_CONTRACT.to_string(),
        schema_version: NATIVE_SCHEMA_VERSION,
        job_id: envelope.job.job_id.clone(),
        request_id: envelope.job.request_id.clone(),
        engine_id: envelope.job.engine_id.clone(),
        model_pack: envelope.job.model_pack.clone(),
        document: envelope.job.document.clone(),
        page: NativePageIdentity {
            id: envelope.job.page.id.clone(),
            index: envelope.job.page.index,
            revision: envelope.job.page.revision,
            source_raster_id: envelope.job.page.source_raster.id.clone(),
        },
        recognition_configuration_hash: envelope.job.recognition_configuration_hash.clone(),
        recognition_options: envelope.job.recognition_options.clone(),
        document_policy: envelope.job.document_policy.clone(),
        scheduler: envelope.job.scheduler.clone(),
        created_at: envelope.job.created_at.clone(),
    };
    validate_native_request(&request)
        .map_err(|_| "native OCR production job validation failed".to_string())?;
    let expected_limits = native_limits(&request);
    if envelope.contract != NATIVE_JOB_CONTRACT
        || envelope.schema_version != NATIVE_SCHEMA_VERSION
        || envelope.job.contract != JOB_CONTRACT
        || envelope.job.schema_version != JOB_SCHEMA_VERSION
        || metadata_bytes == 0
        || metadata_bytes > MAX_METADATA_BYTES
        || envelope.raster.format != "rgba8"
        || envelope.raster.width_px == 0
        || envelope.raster.height_px == 0
        || envelope.raster.width_px > envelope.limits.max_width_px
        || envelope.raster.height_px > envelope.limits.max_height_px
        || !envelope.raster_ms.is_finite()
        || envelope.raster_ms < 0.0
        || !is_identifier(&envelope.result_file.id)
        || !validate_fingerprint(&envelope.job.page.source_raster.fingerprint)
        || envelope.job.page.source_raster.coordinate_space != "source-raster-pixels"
        || envelope.preprocessing_request != envelope.job.recognition_options.preprocessing
        || envelope.limits != expected_limits
    {
        return Err("native OCR job protocol validation failed".to_string());
    }
    let width = u64::from(envelope.raster.width_px);
    let height = u64::from(envelope.raster.height_px);
    let row_bytes = width
        .checked_mul(4)
        .ok_or_else(|| "native OCR row byte count overflow".to_string())?;
    let byte_length = row_bytes
        .checked_mul(height)
        .ok_or_else(|| "native OCR raster byte count overflow".to_string())?;
    if envelope.raster.row_bytes != row_bytes
        || envelope.raster.byte_length != byte_length
        || width * height > envelope.limits.max_pixels
        || byte_length > envelope.limits.max_raster_bytes
        || envelope.job.page.source_raster.width_px != envelope.raster.width_px
        || envelope.job.page.source_raster.height_px != envelope.raster.height_px
        || envelope.job.page.source_raster.dpi != envelope.job.recognition_options.raster_dpi
    {
        return Err("native OCR raster metadata is inconsistent".to_string());
    }
    Ok(())
}

fn validate_result_echo(
    result: &NativeResultEnvelope,
    job: &NativeJobEnvelope,
) -> Result<(), String> {
    if result.contract != NATIVE_RESULT_CONTRACT
        || result.schema_version != NATIVE_SCHEMA_VERSION
        || result.job_id != job.job.job_id
        || result.request_id != job.job.request_id
        || result.document_id != job.job.document.id
        || result.document_revision != job.job.document.revision
        || result.document_generation != job.job.document.generation
        || result.page_id != job.job.page.id
        || result.page_index != job.job.page.index
        || result.page_revision != job.job.page.revision
        || result.engine_id != job.job.engine_id
        || result.model_pack != job.job.model_pack
        || result.recognition_configuration_hash != job.job.recognition_configuration_hash
        || result.source_raster != job.job.page.source_raster
        || result.result_file_id != job.result_file.id
        || !result.resources.is_object()
    {
        return Err("native OCR result identity does not match its job".to_string());
    }
    match result.status.as_str() {
        "completed" if result.result.is_some() && result.failure.is_none() => Ok(()),
        "failed" if result.result.is_none() && result.failure.is_some() => Ok(()),
        _ => Err("native OCR result has an invalid terminal state".to_string()),
    }
}

fn random_hex() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_session_id(value: &str) -> bool {
    value.len() <= 64
        && value.starts_with('p')
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

fn valid_file_token(value: &str) -> bool {
    value.len() == 32
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    if !path.exists() {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("create private OCR temporary directory failed".to_string()),
        }
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "inspect private OCR temporary directory failed".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("OCR temporary directory is not a private directory".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { unix_process::geteuid() } {
            return Err("OCR temporary directory has the wrong owner".to_string());
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "secure OCR temporary directory permissions failed".to_string())?;
    }
    Ok(())
}

fn private_directory_is_secure(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        return metadata.uid() == unsafe { unix_process::geteuid() }
            && metadata.permissions().mode() & 0o077 == 0;
    }
    #[cfg(not(unix))]
    true
}

fn private_create_new(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(unix_process::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|_| "create private OCR job file failed".to_string())
}

fn private_open_read(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(unix_process::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "open private OCR job file failed".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "inspect private OCR job file failed".to_string())?;
    if !metadata.is_file() {
        return Err("OCR job file is not a regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { unix_process::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err("OCR job file permissions are not private".to_string());
        }
    }
    Ok(file)
}

#[derive(Clone, Debug)]
struct TempStore {
    base: PathBuf,
    session_id: String,
    session: PathBuf,
}

impl TempStore {
    fn base_path() -> PathBuf {
        std::env::temp_dir()
            .join("org.openaec.openpdfstudio")
            .join("ocr-v1")
    }

    fn new_parent() -> Result<Self, String> {
        let base = Self::base_path();
        if let Some(owner) = base.parent() {
            ensure_private_directory(owner)?;
        }
        ensure_private_directory(&base)?;
        Self::cleanup_stale_sessions(&base, STALE_SESSION_AGE)?;
        let session_id = format!("p{}-{}", std::process::id(), random_hex());
        let session = base.join(format!("session-{session_id}"));
        ensure_private_directory(&session)?;
        Ok(Self {
            base,
            session_id,
            session,
        })
    }

    fn for_child(session_id: &str) -> Result<Self, String> {
        if !valid_session_id(session_id) {
            return Err("OCR child session identity is invalid".to_string());
        }
        let base = Self::base_path();
        let session = base.join(format!("session-{session_id}"));
        if !private_directory_is_secure(&base) || !private_directory_is_secure(&session) {
            return Err("OCR child temporary session is unavailable or insecure".to_string());
        }
        Ok(Self {
            base,
            session_id: session_id.to_string(),
            session,
        })
    }

    fn cleanup_stale_sessions(base: &Path, age: Duration) -> Result<(), String> {
        let now = SystemTime::now();
        let entries =
            fs::read_dir(base).map_err(|_| "scan OCR temporary sessions failed".to_string())?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("session-") || !valid_session_id(&name[8..]) {
                continue;
            }
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() {
                let _ = fs::remove_file(entry.path());
                continue;
            }
            let stale = metadata
                .modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|elapsed| elapsed >= age);
            if metadata.is_dir() && stale {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
        Ok(())
    }

    fn job_files(&self, token: &str) -> Result<JobFiles, String> {
        if !valid_file_token(token) {
            return Err("OCR job file identity is invalid".to_string());
        }
        Ok(JobFiles {
            request: self.session.join(format!("job-{token}.request")),
            result: self.session.join(format!("result-{token}.json")),
            result_file_id: format!("result-{token}"),
        })
    }

    fn descriptor(&self, token: &str) -> String {
        format!("{}:{token}", self.session_id)
    }

    fn is_private(&self) -> bool {
        private_directory_is_secure(&self.session)
    }

    fn cleanup_session(&self) {
        if let Ok(entries) = fs::read_dir(&self.session) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if (name.starts_with("job-") && name.ends_with(".request"))
                    || (name.starts_with("result-") && name.ends_with(".json"))
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        let _ = fs::remove_dir(&self.session);
        let _ = fs::remove_dir(&self.base);
    }
}

#[derive(Clone, Debug)]
struct JobFiles {
    request: PathBuf,
    result: PathBuf,
    result_file_id: String,
}

impl JobFiles {
    fn cleanup(&self, no_child_survived: bool, session_private: bool) -> CleanupMetadata {
        let request_file_removed = remove_private_file(&self.request);
        let result_file_removed = remove_private_file(&self.result);
        CleanupMetadata {
            request_file_removed,
            result_file_removed,
            no_child_survived,
            session_directory_private: session_private,
        }
    }
}

fn remove_private_file(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(path).is_ok() && !path.exists()
        }
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

fn write_job_file(path: &Path, envelope: &NativeJobEnvelope, rgba: &[u8]) -> Result<(), String> {
    let metadata =
        serde_json::to_vec(envelope).map_err(|_| "serialize native OCR job failed".to_string())?;
    validate_native_job(envelope, metadata.len())?;
    if rgba.len() != envelope.raster.byte_length as usize || rgba.len() > MAX_RASTER_BYTES {
        return Err("native OCR raster byte length is invalid".to_string());
    }
    if raster_fingerprint(rgba) != envelope.job.page.source_raster.fingerprint {
        return Err("native OCR raster fingerprint is invalid".to_string());
    }
    let metadata_len = u32::try_from(metadata.len())
        .map_err(|_| "native OCR metadata is too large".to_string())?;
    let mut file = private_create_new(path)?;
    file.write_all(JOB_MAGIC)
        .and_then(|_| file.write_all(&metadata_len.to_le_bytes()))
        .and_then(|_| file.write_all(&metadata))
        .and_then(|_| file.write_all(rgba))
        .and_then(|_| file.sync_all())
        .map_err(|_| "write private OCR job file failed".to_string())
}

fn read_job_file(path: &Path) -> Result<(Vec<u8>, NativeJobEnvelope), String> {
    let mut file = private_open_read(path)?;
    let length = file
        .metadata()
        .map_err(|_| "inspect OCR child job failed".to_string())?
        .len();
    let absolute_max = 12u64 + MAX_METADATA_BYTES as u64 + MAX_RASTER_BYTES as u64;
    if length < 12 || length > absolute_max {
        return Err("OCR child job file size is invalid".to_string());
    }
    let mut header = [0u8; 12];
    file.read_exact(&mut header)
        .map_err(|_| "read OCR child job header failed".to_string())?;
    if &header[..8] != JOB_MAGIC {
        return Err("OCR child job magic is invalid".to_string());
    }
    let metadata_len = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
    if metadata_len == 0 || metadata_len > MAX_METADATA_BYTES {
        return Err("OCR child metadata size is invalid".to_string());
    }
    let mut metadata_bytes = vec![0u8; metadata_len];
    file.read_exact(&mut metadata_bytes)
        .map_err(|_| "read OCR child metadata failed".to_string())?;
    let envelope: NativeJobEnvelope = serde_json::from_slice(&metadata_bytes)
        .map_err(|_| "parse OCR child metadata failed".to_string())?;
    validate_native_job(&envelope, metadata_len)?;
    let expected = 12u64 + metadata_len as u64 + envelope.raster.byte_length;
    if length != expected {
        return Err("OCR child job file length is inconsistent".to_string());
    }
    let raster_len = envelope.raster.byte_length as usize;
    let mut bytes = Vec::with_capacity(expected as usize);
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&metadata_bytes);
    let start = bytes.len();
    bytes.resize(start + raster_len, 0);
    file.read_exact(&mut bytes[start..])
        .map_err(|_| "read OCR child raster failed".to_string())?;
    if raster_fingerprint(&bytes[start..]) != envelope.job.page.source_raster.fingerprint {
        return Err("OCR child raster fingerprint is invalid".to_string());
    }
    Ok((bytes, envelope))
}

fn write_result_file(path: &Path, payload: &[u8]) -> Result<(), String> {
    if payload.is_empty() || payload.len() > MAX_RESULT_BYTES {
        return Err("OCR child result exceeds its byte limit".to_string());
    }
    let mut file = private_create_new(path)?;
    file.write_all(payload)
        .and_then(|_| file.sync_all())
        .map_err(|_| "write private OCR result failed".to_string())
}

fn read_result_file(path: &Path) -> Result<Vec<u8>, String> {
    let file = private_open_read(path)?;
    let length = file
        .metadata()
        .map_err(|_| "inspect OCR result file failed".to_string())?
        .len();
    if length == 0 || length > MAX_RESULT_BYTES as u64 {
        return Err("OCR result file exceeds its byte limit".to_string());
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAX_RESULT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "read OCR result file failed".to_string())?;
    if bytes.len() != length as usize || bytes.len() > MAX_RESULT_BYTES {
        return Err("OCR result file changed while reading".to_string());
    }
    Ok(bytes)
}

#[derive(Debug)]
pub struct OcrChildJobState {
    files: Option<JobFiles>,
    initialization_error: Option<String>,
    expected: Mutex<Option<NativeJobEnvelope>>,
}

impl OcrChildJobState {
    pub fn from_descriptor(descriptor: Option<String>) -> Self {
        let Some(descriptor) = descriptor else {
            return Self {
                files: None,
                initialization_error: None,
                expected: Mutex::new(None),
            };
        };
        let resolved = descriptor
            .split_once(':')
            .ok_or_else(|| "OCR child descriptor is invalid".to_string())
            .and_then(|(session, token)| {
                let store = TempStore::for_child(session)?;
                store.job_files(token)
            });
        match resolved {
            Ok(files) => Self {
                files: Some(files),
                initialization_error: None,
                expected: Mutex::new(None),
            },
            Err(error) => Self {
                files: None,
                initialization_error: Some(error),
                expected: Mutex::new(None),
            },
        }
    }

    pub fn is_child(&self) -> bool {
        self.files.is_some() || self.initialization_error.is_some()
    }
}

struct JobEntry {
    job_id: String,
    document_id: String,
    page_key: String,
    child: Mutex<Option<Child>>,
    files: Mutex<Option<JobFiles>>,
    cancelled: AtomicBool,
    terminal_state: AtomicU8,
    cancellation_requested_at: AtomicU64,
    child_pid: AtomicU32,
}

impl JobEntry {
    fn new(request: &NativePageRequest) -> Self {
        Self {
            job_id: request.job_id.clone(),
            document_id: request.document.id.clone(),
            page_key: format!("{}:{}", request.document.id, request.page.id),
            child: Mutex::new(None),
            files: Mutex::new(None),
            cancelled: AtomicBool::new(false),
            terminal_state: AtomicU8::new(JOB_ACTIVE),
            cancellation_requested_at: AtomicU64::new(0),
            child_pid: AtomicU32::new(0),
        }
    }
}

#[derive(Default)]
struct RegistryState {
    jobs: HashMap<String, Arc<JobEntry>>,
    latest_by_page: HashMap<String, String>,
    pending_job_cancellations: HashMap<String, u64>,
    pending_document_cancellations: HashMap<String, u64>,
}

#[derive(Clone)]
pub struct OcrJobRegistry {
    state: Arc<Mutex<RegistryState>>,
    temp: Option<Arc<TempStore>>,
    initialization_error: Option<String>,
}

impl OcrJobRegistry {
    pub fn new() -> Self {
        match TempStore::new_parent() {
            Ok(store) => Self {
                state: Arc::new(Mutex::new(RegistryState::default())),
                temp: Some(Arc::new(store)),
                initialization_error: None,
            },
            Err(error) => Self {
                state: Arc::new(Mutex::new(RegistryState::default())),
                temp: None,
                initialization_error: Some(error),
            },
        }
    }

    pub fn child_scaffold() -> Self {
        Self {
            state: Arc::new(Mutex::new(RegistryState::default())),
            temp: None,
            initialization_error: Some(
                "OCR parent controller is unavailable in a child".to_string(),
            ),
        }
    }

    pub fn unsupported_platform_scaffold() -> Self {
        Self {
            state: Arc::new(Mutex::new(RegistryState::default())),
            temp: None,
            initialization_error: Some("Production OCR is active on macOS only".to_string()),
        }
    }

    fn temp(&self) -> Result<Arc<TempStore>, OcrFailure> {
        self.temp.clone().ok_or_else(|| {
            failure(
                "OCR_TEMPORARY_STORAGE_UNAVAILABLE",
                "preparing",
                self.initialization_error
                    .as_deref()
                    .unwrap_or("Private OCR temporary storage is unavailable"),
                false,
            )
        })
    }

    fn register(&self, entry: Arc<JobEntry>) -> Result<Option<Arc<JobEntry>>, OcrFailure> {
        let mut state = self.state.lock().unwrap();
        if state.jobs.contains_key(&entry.job_id) {
            return Err(failure(
                "OCR_DUPLICATE_JOB",
                "scheduling",
                "An OCR job with this identity is already active",
                false,
            ));
        }
        let prior = state
            .latest_by_page
            .insert(entry.page_key.clone(), entry.job_id.clone())
            .and_then(|job_id| state.jobs.get(&job_id).cloned());
        let pending_cancellation = state
            .pending_job_cancellations
            .remove(&entry.job_id)
            .or_else(|| {
                state
                    .pending_document_cancellations
                    .get(&entry.document_id)
                    .copied()
            });
        if let Some(requested_at) = pending_cancellation {
            entry.cancelled.store(true, Ordering::Release);
            entry.terminal_state.store(JOB_CANCELLED, Ordering::Release);
            entry
                .cancellation_requested_at
                .store(requested_at, Ordering::Release);
        }
        state.jobs.insert(entry.job_id.clone(), entry);
        Ok(prior)
    }

    fn unregister(&self, entry: &JobEntry) {
        let mut state = self.state.lock().unwrap();
        state.jobs.remove(&entry.job_id);
        if state.latest_by_page.get(&entry.page_key) == Some(&entry.job_id) {
            state.latest_by_page.remove(&entry.page_key);
        }
    }

    fn is_latest(&self, entry: &JobEntry) -> bool {
        self.state
            .lock()
            .unwrap()
            .latest_by_page
            .get(&entry.page_key)
            == Some(&entry.job_id)
    }

    fn entry(&self, job_id: &str) -> Option<Arc<JobEntry>> {
        self.state.lock().unwrap().jobs.get(job_id).cloned()
    }

    fn entries_for_document(&self, document_id: &str) -> Vec<Arc<JobEntry>> {
        self.state
            .lock()
            .unwrap()
            .jobs
            .values()
            .filter(|entry| entry.document_id == document_id)
            .cloned()
            .collect()
    }

    fn entries(&self) -> Vec<Arc<JobEntry>> {
        self.state.lock().unwrap().jobs.values().cloned().collect()
    }

    pub fn job_status(&self, job_id: &str) -> OcrJobStatus {
        let Some(entry) = self.entry(job_id) else {
            return OcrJobStatus {
                job_id: job_id.to_string(),
                found: false,
                state: "not-found",
                child_pid: None,
            };
        };
        let child_pid = match entry.child_pid.load(Ordering::Acquire) {
            0 => None,
            pid => Some(pid),
        };
        let state = if entry.terminal_state.load(Ordering::Acquire) == JOB_CANCELLED {
            "cancelling"
        } else if child_pid.is_some() {
            "running"
        } else {
            "preparing"
        };
        OcrJobStatus {
            job_id: entry.job_id.clone(),
            found: true,
            state,
            child_pid,
        }
    }

    fn cancel_entry(&self, entry: &Arc<JobEntry>) -> CancelReport {
        let started = Instant::now();
        let requested_at = epoch_ms();
        let terminal_state = entry.terminal_state.compare_exchange(
            JOB_ACTIVE,
            JOB_CANCELLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        if terminal_state == Err(JOB_TERMINAL) {
            return CancelReport {
                job_id: entry.job_id.clone(),
                found: true,
                child_pid: match entry.child_pid.load(Ordering::Acquire) {
                    0 => None,
                    pid => Some(pid),
                },
                terminated: false,
                latency_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
                cleanup: CleanupMetadata {
                    request_file_removed: true,
                    result_file_removed: true,
                    no_child_survived: true,
                    session_directory_private: self
                        .temp
                        .as_ref()
                        .is_some_and(|store| store.is_private()),
                },
            };
        }
        entry.cancelled.store(true, Ordering::Release);
        entry
            .cancellation_requested_at
            .compare_exchange(0, requested_at as u64, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        let mut terminated = false;
        let mut no_child_survived = true;
        if let Ok(mut guard) = entry.child.lock() {
            if let Some(child) = guard.as_mut() {
                terminated = terminate_and_reap(child);
                no_child_survived = child.try_wait().ok().flatten().is_some();
            }
        }
        let session_private = self.temp.as_ref().is_some_and(|store| store.is_private());
        let cleanup = entry
            .files
            .lock()
            .ok()
            .and_then(|files| files.clone())
            .map(|files| files.cleanup(no_child_survived, session_private))
            .unwrap_or(CleanupMetadata {
                request_file_removed: true,
                result_file_removed: true,
                no_child_survived,
                session_directory_private: session_private,
            });
        CancelReport {
            job_id: entry.job_id.clone(),
            found: true,
            child_pid: match entry.child_pid.load(Ordering::Acquire) {
                0 => None,
                pid => Some(pid),
            },
            terminated,
            latency_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
            cleanup,
        }
    }

    pub fn cancel_job(&self, job_id: &str) -> CancelReport {
        if let Some(entry) = self.entry(job_id) {
            return self.cancel_entry(&entry);
        }
        let requested_at = epoch_ms() as u64;
        let mut state = self.state.lock().unwrap();
        if state.pending_job_cancellations.len() < 1024 {
            state
                .pending_job_cancellations
                .insert(job_id.to_string(), requested_at);
        }
        CancelReport {
            job_id: job_id.to_string(),
            found: false,
            child_pid: None,
            terminated: false,
            latency_ms: None,
            cleanup: CleanupMetadata::default(),
        }
    }

    pub fn cancel_document(&self, document_id: &str) -> CancelBatchReport {
        let entries = self.entries_for_document(document_id);
        if entries.is_empty() {
            let mut state = self.state.lock().unwrap();
            if state.pending_document_cancellations.len() < 1024 {
                state
                    .pending_document_cancellations
                    .insert(document_id.to_string(), epoch_ms() as u64);
            }
        }
        CancelBatchReport {
            scope: format!("document:{document_id}"),
            jobs: entries
                .iter()
                .map(|entry| self.cancel_entry(entry))
                .collect(),
        }
    }

    pub fn cancel_all(&self) -> CancelBatchReport {
        let jobs = self
            .entries()
            .iter()
            .map(|entry| self.cancel_entry(entry))
            .collect();
        if let Some(temp) = &self.temp {
            temp.cleanup_session();
        }
        CancelBatchReport {
            scope: "application".to_string(),
            jobs,
        }
    }
}

impl Default for OcrJobRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(unix)]
fn configure_child_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_child_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn signal_child_group(pid: u32, signal: i32) {
    let _ = unsafe { unix_process::kill(-(pid as i32), signal) };
}

#[cfg(not(unix))]
fn signal_child_group(_pid: u32, _signal: i32) {}

fn terminate_and_reap(child: &mut Child) -> bool {
    if child.try_wait().ok().flatten().is_some() {
        return true;
    }
    let pid = child.id();
    #[cfg(unix)]
    signal_child_group(pid, unix_process::SIGTERM);
    #[cfg(not(unix))]
    let _ = child.kill();
    let deadline = Instant::now() + TERMINATION_GRACE;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    #[cfg(unix)]
    signal_child_group(pid, unix_process::SIGKILL);
    #[cfg(not(unix))]
    let _ = child.kill();
    child.wait().is_ok()
}

fn empty_isolation() -> IsolationMetadata {
    IsolationMetadata {
        boundary: "native-child-process",
        one_job: true,
        child_pid: None,
        spawned_at_epoch_ms: None,
        exited_at_epoch_ms: None,
        exit_status: None,
        reaped: true,
    }
}

fn failed_outcome(job_id: &str, error: OcrFailure) -> ControllerOutcome {
    ControllerOutcome {
        contract: CONTROLLER_OUTCOME_CONTRACT,
        schema_version: NATIVE_SCHEMA_VERSION,
        status: "failed".to_string(),
        job_id: job_id.to_string(),
        job: None,
        result: None,
        failure: Some(error),
        child_pid: None,
        lifecycle: Vec::new(),
        resources: json!({}),
        isolation: empty_isolation(),
        cancellation: None,
        cleanup: CleanupMetadata::default(),
    }
}

fn cancellation_metadata(entry: &JobEntry, completed_at: u128) -> CancellationMetadata {
    let requested_at = entry.cancellation_requested_at.load(Ordering::Acquire) as u128;
    let requested_at = if requested_at == 0 {
        completed_at
    } else {
        requested_at
    };
    CancellationMetadata {
        method: "native-child-process-terminate",
        message: "OCR cancelled by the parent controller".to_string(),
        requested_at_epoch_ms: requested_at,
        completed_at_epoch_ms: completed_at,
        latency_ms: completed_at.saturating_sub(requested_at) as f64,
    }
}

fn wait_for_child(
    entry: &Arc<JobEntry>,
    timeout: Duration,
) -> Result<(ExitStatus, bool), OcrFailure> {
    let started = Instant::now();
    loop {
        if entry.cancelled.load(Ordering::Acquire) {
            let mut guard = entry.child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                terminate_and_reap(child);
                let status = child.try_wait().ok().flatten().ok_or_else(|| {
                    failure(
                        "OCR_CHILD_REAP_FAILED",
                        "cancelling",
                        "The cancelled OCR child could not be reaped",
                        false,
                    )
                })?;
                return Ok((status, true));
            }
        }
        {
            let mut guard = entry.child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => return Ok((status, false)),
                    Ok(None) => {}
                    Err(_) => {
                        terminate_and_reap(child);
                        return Err(failure(
                            "OCR_CHILD_WAIT_FAILED",
                            "reaping",
                            "The OCR child process could not be observed safely",
                            false,
                        ));
                    }
                }
            }
        }
        if started.elapsed() >= timeout {
            let mut guard = entry.child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                terminate_and_reap(child);
            }
            return Err(failure(
                "OCR_CHILD_TIMEOUT",
                "recognizing",
                "The OCR child exceeded its configured timeout",
                true,
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn run_child_process(
    registry: &OcrJobRegistry,
    entry: &Arc<JobEntry>,
    temp: &TempStore,
    files: &JobFiles,
    envelope: &NativeJobEnvelope,
) -> ControllerOutcome {
    let executable = match std::env::current_exe() {
        Ok(value) => value,
        Err(_) => {
            return failed_outcome(
                &entry.job_id,
                failure(
                    "OCR_CHILD_EXECUTABLE_UNAVAILABLE",
                    "spawning",
                    "The application child executable is unavailable",
                    false,
                ),
            )
        }
    };
    let token = files
        .request
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("job-"))
        .and_then(|name| name.strip_suffix(".request"))
        .unwrap_or_default();
    let descriptor = temp.descriptor(token);
    let mut command = Command::new(executable);
    command
        .arg("--ocr-child-job")
        .arg(descriptor)
        .env("OPDS_OCR_CHILD", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_child_process_group(&mut command);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let spawned_at = epoch_ms();
    let mut child_guard = entry.child.lock().unwrap();
    if entry.terminal_state.load(Ordering::Acquire) == JOB_CANCELLED {
        let cleanup = files.cleanup(true, temp.is_private());
        return ControllerOutcome {
            contract: CONTROLLER_OUTCOME_CONTRACT,
            schema_version: NATIVE_SCHEMA_VERSION,
            status: "cancelled".to_string(),
            job_id: entry.job_id.clone(),
            job: None,
            result: None,
            failure: None,
            child_pid: None,
            lifecycle: Vec::new(),
            resources: json!({}),
            isolation: empty_isolation(),
            cancellation: Some(cancellation_metadata(entry, epoch_ms())),
            cleanup,
        };
    }
    let child = match command.spawn() {
        Ok(value) => value,
        Err(_) => {
            return failed_outcome(
                &entry.job_id,
                failure(
                    "OCR_CHILD_SPAWN_FAILED",
                    "spawning",
                    "The disposable OCR child could not be started",
                    true,
                ),
            )
        }
    };
    let child_pid = child.id();
    entry.child_pid.store(child_pid, Ordering::Release);
    *child_guard = Some(child);
    drop(child_guard);
    let mut lifecycle = vec![json!({
        "stage": "ocr-child-process-spawned",
        "atEpochMs": spawned_at,
        "childPid": child_pid,
    })];
    let timeout = Duration::from_millis(envelope.limits.timeout_ms);
    let terminal = wait_for_child(entry, timeout);
    let exited_at = epoch_ms();
    let status = terminal.as_ref().ok().map(|(status, _)| status);
    let was_cancelled = terminal
        .as_ref()
        .ok()
        .is_some_and(|(_, cancelled)| *cancelled)
        || entry.cancelled.load(Ordering::Acquire);
    lifecycle.push(json!({
        "stage": "ocr-child-process-exited",
        "atEpochMs": exited_at,
        "childPid": child_pid,
    }));
    let reaped = entry
        .child
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|child| child.try_wait().ok().flatten())
        .is_some();
    let isolation = IsolationMetadata {
        boundary: "native-child-process",
        one_job: true,
        child_pid: Some(child_pid),
        spawned_at_epoch_ms: Some(spawned_at),
        exited_at_epoch_ms: Some(exited_at),
        exit_status: status.and_then(|value| value.code()),
        reaped,
    };
    let session_private = temp.is_private();

    if was_cancelled {
        let cleanup = files.cleanup(reaped, session_private);
        return ControllerOutcome {
            contract: CONTROLLER_OUTCOME_CONTRACT,
            schema_version: NATIVE_SCHEMA_VERSION,
            status: "cancelled".to_string(),
            job_id: entry.job_id.clone(),
            job: None,
            result: None,
            failure: None,
            child_pid: Some(child_pid),
            lifecycle,
            resources: json!({}),
            isolation,
            cancellation: Some(cancellation_metadata(entry, exited_at)),
            cleanup,
        };
    }

    let exit_status = match terminal {
        Ok((status, _)) => status,
        Err(error) => {
            let cleanup = files.cleanup(reaped, session_private);
            return ControllerOutcome {
                contract: CONTROLLER_OUTCOME_CONTRACT,
                schema_version: NATIVE_SCHEMA_VERSION,
                status: "failed".to_string(),
                job_id: entry.job_id.clone(),
                job: None,
                result: None,
                failure: Some(error),
                child_pid: Some(child_pid),
                lifecycle,
                resources: json!({}),
                isolation,
                cancellation: None,
                cleanup,
            };
        }
    };
    if !exit_status.success() {
        let cleanup = files.cleanup(reaped, session_private);
        return ControllerOutcome {
            contract: CONTROLLER_OUTCOME_CONTRACT,
            schema_version: NATIVE_SCHEMA_VERSION,
            status: "failed".to_string(),
            job_id: entry.job_id.clone(),
            job: None,
            result: None,
            failure: Some(failure(
                "OCR_CHILD_CRASHED",
                "recognizing",
                "The disposable OCR child exited unexpectedly",
                true,
            )),
            child_pid: Some(child_pid),
            lifecycle,
            resources: json!({}),
            isolation,
            cancellation: None,
            cleanup,
        };
    }

    let result_bytes = match read_result_file(&files.result) {
        Ok(value) => value,
        Err(_) => {
            let cleanup = files.cleanup(reaped, session_private);
            return ControllerOutcome {
                contract: CONTROLLER_OUTCOME_CONTRACT,
                schema_version: NATIVE_SCHEMA_VERSION,
                status: "failed".to_string(),
                job_id: entry.job_id.clone(),
                job: None,
                result: None,
                failure: Some(failure(
                    "OCR_CHILD_RESULT_MISSING",
                    "validating",
                    "The OCR child did not return a bounded result file",
                    true,
                )),
                child_pid: Some(child_pid),
                lifecycle,
                resources: json!({}),
                isolation,
                cancellation: None,
                cleanup,
            };
        }
    };
    let native_result: NativeResultEnvelope = match serde_json::from_slice(&result_bytes) {
        Ok(value) => value,
        Err(_) => {
            let cleanup = files.cleanup(reaped, session_private);
            return ControllerOutcome {
                contract: CONTROLLER_OUTCOME_CONTRACT,
                schema_version: NATIVE_SCHEMA_VERSION,
                status: "failed".to_string(),
                job_id: entry.job_id.clone(),
                job: None,
                result: None,
                failure: Some(failure(
                    "OCR_CHILD_RESULT_PROTOCOL",
                    "validating",
                    "The OCR child returned malformed result metadata",
                    false,
                )),
                child_pid: Some(child_pid),
                lifecycle,
                resources: json!({}),
                isolation,
                cancellation: None,
                cleanup,
            };
        }
    };
    if validate_result_echo(&native_result, envelope).is_err() {
        let cleanup = files.cleanup(reaped, session_private);
        return ControllerOutcome {
            contract: CONTROLLER_OUTCOME_CONTRACT,
            schema_version: NATIVE_SCHEMA_VERSION,
            status: "failed".to_string(),
            job_id: entry.job_id.clone(),
            job: None,
            result: None,
            failure: Some(failure(
                "OCR_CHILD_RESULT_IDENTITY_MISMATCH",
                "validating",
                "The OCR child result identity does not match the active job",
                false,
            )),
            child_pid: Some(child_pid),
            lifecycle,
            resources: json!({}),
            isolation,
            cancellation: None,
            cleanup,
        };
    }
    if !registry.is_latest(entry) {
        let cleanup = files.cleanup(reaped, session_private);
        return ControllerOutcome {
            contract: CONTROLLER_OUTCOME_CONTRACT,
            schema_version: NATIVE_SCHEMA_VERSION,
            status: "stale".to_string(),
            job_id: entry.job_id.clone(),
            job: None,
            result: None,
            failure: Some(failure(
                "OCR_STALE_RESULT",
                "validating",
                "A stale OCR result was deleted and ignored",
                false,
            )),
            child_pid: Some(child_pid),
            lifecycle,
            resources: json!({}),
            isolation,
            cancellation: None,
            cleanup,
        };
    }
    lifecycle.extend(native_result.lifecycle.clone());
    let cleanup = files.cleanup(reaped, session_private);
    if native_result.status == "failed" {
        return ControllerOutcome {
            contract: CONTROLLER_OUTCOME_CONTRACT,
            schema_version: NATIVE_SCHEMA_VERSION,
            status: "failed".to_string(),
            job_id: entry.job_id.clone(),
            job: None,
            result: None,
            failure: native_result.failure,
            child_pid: Some(child_pid),
            lifecycle,
            resources: native_result.resources,
            isolation,
            cancellation: None,
            cleanup,
        };
    }
    ControllerOutcome {
        contract: CONTROLLER_OUTCOME_CONTRACT,
        schema_version: NATIVE_SCHEMA_VERSION,
        status: "completed".to_string(),
        job_id: entry.job_id.clone(),
        job: Some(envelope.job.clone()),
        result: native_result.result,
        failure: None,
        child_pid: Some(child_pid),
        lifecycle,
        resources: native_result.resources,
        isolation,
        cancellation: None,
        cleanup,
    }
}

/// Parent-side production entry point. The local PDF path is consumed only by
/// the low-priority raster sidecar and is never serialized into the child job.
#[tauri::command]
pub async fn run_ocr_page_job(
    source_pdf_path: String,
    request: NativePageRequest,
    pool: tauri::State<'_, Arc<tokio::sync::OnceCell<WorkerPool>>>,
    registry: tauri::State<'_, OcrJobRegistry>,
) -> Result<ControllerOutcome, String> {
    if !cfg!(target_os = "macos") {
        return Ok(failed_outcome(
            &request.job_id,
            failure(
                "OCR_PLATFORM_UNSUPPORTED",
                "scheduling",
                "Production OCR is active on macOS only",
                false,
            ),
        ));
    }
    if source_pdf_path.is_empty() || source_pdf_path.len() > MAX_SOURCE_PATH_BYTES {
        return Ok(failed_outcome(
            &request.job_id,
            failure(
                "OCR_SOURCE_INVALID",
                "rasterizing",
                "The parent-side OCR source is invalid",
                false,
            ),
        ));
    }
    if let Err(error) = validate_native_request(&request) {
        return Ok(failed_outcome(&request.job_id, error));
    }
    let temp = match registry.temp() {
        Ok(value) => value,
        Err(error) => return Ok(failed_outcome(&request.job_id, error)),
    };
    let entry = Arc::new(JobEntry::new(&request));
    let prior = match registry.register(entry.clone()) {
        Ok(value) => value,
        Err(error) => return Ok(failed_outcome(&request.job_id, error)),
    };
    if let Some(prior) = prior {
        registry.cancel_entry(&prior);
    }

    let finish = |mut outcome: ControllerOutcome| {
        let terminal = entry.terminal_state.compare_exchange(
            JOB_ACTIVE,
            JOB_TERMINAL,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        if terminal == Err(JOB_CANCELLED) && outcome.status != "cancelled" {
            outcome.status = "cancelled".to_string();
            outcome.job = None;
            outcome.result = None;
            outcome.failure = None;
            outcome.cancellation = Some(cancellation_metadata(&entry, epoch_ms()));
            outcome.cleanup.no_child_survived = true;
        }
        registry.unregister(&entry);
        outcome
    };
    if entry.cancelled.load(Ordering::Acquire) {
        return Ok(finish(ControllerOutcome {
            contract: CONTROLLER_OUTCOME_CONTRACT,
            schema_version: NATIVE_SCHEMA_VERSION,
            status: "cancelled".to_string(),
            job_id: request.job_id.clone(),
            job: None,
            result: None,
            failure: None,
            child_pid: None,
            lifecycle: Vec::new(),
            resources: json!({}),
            isolation: empty_isolation(),
            cancellation: Some(cancellation_metadata(&entry, epoch_ms())),
            cleanup: CleanupMetadata {
                request_file_removed: true,
                result_file_removed: true,
                no_child_survived: true,
                session_directory_private: temp.is_private(),
            },
        }));
    }

    let pool = match pool.get() {
        Some(value) => value,
        None => {
            return Ok(finish(failed_outcome(
                &request.job_id,
                failure(
                    "OCR_RASTER_POOL_UNAVAILABLE",
                    "rasterizing",
                    "The low-priority PDFium raster pool is unavailable",
                    true,
                ),
            )))
        }
    };
    let scale = (request.recognition_options.raster_dpi / 72.0) as f32;
    let limits = native_limits(&request);
    let raster_started = Instant::now();
    let raster = pool
        .render_ocr_low_priority(
            &source_pdf_path,
            request.page.index,
            scale,
            0,
            OcrRasterLimits {
                max_width: limits.max_width_px,
                max_height: limits.max_height_px,
                max_pixels: limits.max_pixels,
                max_raster_bytes: limits.max_raster_bytes,
            },
        )
        .await;
    let raster_ms = raster_started.elapsed().as_secs_f64() * 1000.0;
    let (width, height, rgba) = match raster {
        Ok(value) => (value.width, value.height, value.rgba),
        Err(_) => {
            return Ok(finish(failed_outcome(
                &request.job_id,
                failure(
                    "OCR_RASTER_FAILED",
                    "rasterizing",
                    "The annotation-free PDFium raster could not be produced within limits",
                    true,
                ),
            )))
        }
    };
    if entry.cancelled.load(Ordering::Acquire) {
        return Ok(finish(ControllerOutcome {
            contract: CONTROLLER_OUTCOME_CONTRACT,
            schema_version: NATIVE_SCHEMA_VERSION,
            status: "cancelled".to_string(),
            job_id: request.job_id.clone(),
            job: None,
            result: None,
            failure: None,
            child_pid: None,
            lifecycle: Vec::new(),
            resources: json!({}),
            isolation: empty_isolation(),
            cancellation: Some(cancellation_metadata(&entry, epoch_ms())),
            cleanup: CleanupMetadata {
                request_file_removed: true,
                result_file_removed: true,
                no_child_survived: true,
                session_directory_private: temp.is_private(),
            },
        }));
    }
    let expected = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4));
    if expected != Some(rgba.len()) || rgba.len() > MAX_RASTER_BYTES {
        return Ok(finish(failed_outcome(
            &request.job_id,
            failure(
                "OCR_RASTER_PROTOCOL",
                "rasterizing",
                "The PDFium raster metadata is inconsistent",
                false,
            ),
        )));
    }

    let token = random_hex();
    let files = match temp.job_files(&token) {
        Ok(value) => value,
        Err(_) => {
            return Ok(finish(failed_outcome(
                &request.job_id,
                failure(
                    "OCR_TEMPORARY_FILE_INVALID",
                    "preparing",
                    "A private OCR job file could not be resolved",
                    false,
                ),
            )))
        }
    };
    *entry.files.lock().unwrap() = Some(files.clone());
    let job = production_job(&request, width, height, &rgba);
    let envelope = NativeJobEnvelope {
        contract: NATIVE_JOB_CONTRACT.to_string(),
        schema_version: NATIVE_SCHEMA_VERSION,
        job,
        raster: RasterEnvelope {
            format: "rgba8".to_string(),
            width_px: width,
            height_px: height,
            row_bytes: u64::from(width) * 4,
            byte_length: rgba.len() as u64,
        },
        raster_ms,
        preprocessing_request: request.recognition_options.preprocessing.clone(),
        limits,
        result_file: ResultFileIdentity {
            id: files.result_file_id.clone(),
        },
    };
    if write_job_file(&files.request, &envelope, &rgba).is_err() {
        let cleanup = files.cleanup(true, temp.is_private());
        let mut outcome = failed_outcome(
            &request.job_id,
            failure(
                "OCR_TEMPORARY_WRITE_FAILED",
                "preparing",
                "The bounded OCR job could not be written privately",
                false,
            ),
        );
        outcome.cleanup = cleanup;
        return Ok(finish(outcome));
    }
    drop(rgba);
    let registry_owned = registry.inner().clone();
    let entry_owned = entry.clone();
    let temp_owned = (*temp).clone();
    let files_owned = files.clone();
    let envelope_owned = envelope.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run_child_process(
            &registry_owned,
            &entry_owned,
            &temp_owned,
            &files_owned,
            &envelope_owned,
        )
    })
    .await
    .map_err(|_| "join native OCR child controller failed".to_string())?;
    Ok(finish(outcome))
}

#[tauri::command]
pub async fn cancel_ocr_job(
    job_id: String,
    registry: tauri::State<'_, OcrJobRegistry>,
) -> Result<CancelReport, String> {
    if !is_identifier(&job_id) {
        return Err("OCR job identity is invalid".to_string());
    }
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.cancel_job(&job_id))
        .await
        .map_err(|_| "join OCR cancellation failed".to_string())
}

#[tauri::command]
pub fn get_ocr_job_status(
    job_id: String,
    registry: tauri::State<'_, OcrJobRegistry>,
) -> Result<OcrJobStatus, String> {
    if !is_identifier(&job_id) {
        return Err("OCR job identity is invalid".to_string());
    }
    Ok(registry.job_status(&job_id))
}

#[tauri::command]
pub async fn cancel_ocr_document_jobs(
    document_id: String,
    registry: tauri::State<'_, OcrJobRegistry>,
) -> Result<CancelBatchReport, String> {
    if !is_identifier(&document_id) {
        return Err("OCR document identity is invalid".to_string());
    }
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.cancel_document(&document_id))
        .await
        .map_err(|_| "join OCR document cancellation failed".to_string())
}

#[tauri::command]
pub async fn cancel_all_ocr_jobs(
    registry: tauri::State<'_, OcrJobRegistry>,
) -> Result<CancelBatchReport, String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.cancel_all())
        .await
        .map_err(|_| "join OCR application cancellation failed".to_string())
}

/// Child-side read. The request file is unlinked as soon as the bounded bytes
/// are owned by the WebView, limiting raster persistence after a crash.
#[tauri::command]
pub fn ocr_child_take_job(
    state: tauri::State<'_, OcrChildJobState>,
) -> Result<tauri::ipc::Response, String> {
    if let Some(error) = &state.initialization_error {
        return Err(error.clone());
    }
    let Some(files) = state.files.as_ref() else {
        return Ok(tauri::ipc::Response::new(Vec::<u8>::new()));
    };
    match std::env::var("OPDS_OCR_TEST_CHILD_BEHAVIOR")
        .ok()
        .as_deref()
    {
        Some("crash") => std::process::exit(86),
        Some("timeout") => loop {
            std::thread::sleep(Duration::from_secs(1));
        },
        _ => {}
    }
    let (bytes, envelope) = read_job_file(&files.request)?;
    if envelope.result_file.id != files.result_file_id {
        return Err("OCR child result file identity is invalid".to_string());
    }
    *state.expected.lock().unwrap() = Some(envelope);
    let _ = fs::remove_file(&files.request);
    Ok(tauri::ipc::Response::new(bytes))
}

fn exit_child_after(app: tauri::AppHandle, code: i32) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        app.exit(code);
    });
}

/// Child-side completion. Rust validates the bounded top-level envelope and
/// all stale-result identity fields before using create-new result semantics.
#[tauri::command]
pub fn ocr_child_complete(
    app: tauri::AppHandle,
    state: tauri::State<'_, OcrChildJobState>,
    payload: String,
) -> Result<(), String> {
    let Some(files) = state.files.as_ref() else {
        return Err("normal application process cannot complete an OCR child job".to_string());
    };
    if payload.len() > MAX_RESULT_BYTES {
        return Err("OCR child result exceeds its byte limit".to_string());
    }
    let result: NativeResultEnvelope = serde_json::from_str(&payload)
        .map_err(|_| "OCR child result protocol is invalid".to_string())?;
    let expected = state
        .expected
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "OCR child job was not validated before completion".to_string())?;
    validate_result_echo(&result, &expected)?;
    write_result_file(&files.result, payload.as_bytes())?;
    exit_child_after(app, 0);
    Ok(())
}

/// Abort a child whose JavaScript-side detailed validation failed. When Rust
/// already validated the job, emit a typed failure with the exact echoed
/// identity; otherwise exit non-zero so the parent reports a protocol crash.
#[tauri::command]
pub fn ocr_child_abort(
    app: tauri::AppHandle,
    state: tauri::State<'_, OcrChildJobState>,
    code: String,
    message: String,
) -> Result<(), String> {
    let safe_code = if is_identifier(&code) {
        code
    } else {
        "OCR_CHILD_PROTOCOL".to_string()
    };
    let safe_message = if message.is_empty() || message.len() > 4096 {
        "OCR child protocol validation failed".to_string()
    } else {
        message
    };
    let expected = state.expected.lock().unwrap().clone();
    if let (Some(files), Some(job)) = (state.files.as_ref(), expected) {
        let result = NativeResultEnvelope {
            contract: NATIVE_RESULT_CONTRACT.to_string(),
            schema_version: NATIVE_SCHEMA_VERSION,
            status: "failed".to_string(),
            job_id: job.job.job_id.clone(),
            request_id: job.job.request_id.clone(),
            document_id: job.job.document.id.clone(),
            document_revision: job.job.document.revision,
            document_generation: job.job.document.generation.clone(),
            page_id: job.job.page.id.clone(),
            page_index: job.job.page.index,
            page_revision: job.job.page.revision,
            engine_id: job.job.engine_id.clone(),
            model_pack: job.job.model_pack.clone(),
            recognition_configuration_hash: job.job.recognition_configuration_hash.clone(),
            source_raster: job.job.page.source_raster.clone(),
            result_file_id: job.result_file.id.clone(),
            result: None,
            failure: Some(failure(&safe_code, "validating", &safe_message, false)),
            lifecycle: Vec::new(),
            resources: json!({}),
        };
        let payload = serde_json::to_vec(&result)
            .map_err(|_| "serialize OCR child failure failed".to_string())?;
        write_result_file(&files.result, &payload)?;
        exit_child_after(app, 0);
    } else {
        exit_child_after(app, 70);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_pack() -> ModelPackIdentity {
        ModelPackIdentity {
            contract: MODEL_PACK_CONTRACT.to_string(),
            schema_version: 1,
            pack_id: MODEL_PACK_ID.to_string(),
            pack_version: MODEL_PACK_VERSION.to_string(),
            assets: ModelPackAssets {
                detection: DETECTION_SHA256.to_string(),
                recognition: RECOGNITION_SHA256.to_string(),
                dictionary: DICTIONARY_SHA256.to_string(),
            },
        }
    }

    fn request(job_id: &str) -> NativePageRequest {
        NativePageRequest {
            contract: NATIVE_REQUEST_CONTRACT.to_string(),
            schema_version: 1,
            job_id: job_id.to_string(),
            request_id: format!("request-{job_id}"),
            engine_id: ENGINE_ID.to_string(),
            model_pack: model_pack(),
            document: DocumentIdentity {
                id: "document-1".to_string(),
                fingerprint: Fingerprint {
                    algorithm: "sha256".to_string(),
                    value: "1".repeat(64),
                },
                revision: 2,
                generation: "generation-3".to_string(),
                page_count: 1,
            },
            page: NativePageIdentity {
                id: "page-1".to_string(),
                index: 0,
                revision: 4,
                source_raster_id: "raster-1".to_string(),
            },
            recognition_configuration_hash: Fingerprint {
                algorithm: "sha256".to_string(),
                value: "2".repeat(64),
            },
            recognition_options: RecognitionOptions {
                language_policy: LanguagePolicy {
                    mode: "automatic".to_string(),
                    languages: Vec::new(),
                    scripts: Vec::new(),
                },
                include_words: false,
                orientation: OrientationRequest {
                    mode: "none".to_string(),
                    degrees: None,
                },
                deskew: false,
                preprocessing: PreprocessingRequest {
                    mode: "none".to_string(),
                    operations: Vec::new(),
                },
                raster_dpi: 144.0,
                maximum_pixels: MAX_PIXELS,
                maximum_side: MAX_WIDTH_PX,
                timeout_ms: 30_000,
            },
            document_policy: DocumentPolicy {
                skip_meaningful_existing_text: false,
                force_rerun: true,
                replace_application_owned_ocr_only: true,
                keep_completed_pages: true,
            },
            scheduler: SchedulerMetadata {
                priority: "background".to_string(),
                execution: "one-page-child".to_string(),
            },
            created_at: "2026-08-16T00:00:00.000Z".to_string(),
        }
    }

    fn test_store() -> TempStore {
        let base = std::env::temp_dir().join(format!("ocr-controller-test-{}", random_hex()));
        ensure_private_directory(&base).unwrap();
        let session_id = format!("p{}-{}", std::process::id(), random_hex());
        let session = base.join(format!("session-{session_id}"));
        ensure_private_directory(&session).unwrap();
        TempStore {
            base,
            session_id,
            session,
        }
    }

    fn envelope(job_id: &str, result_file_id: &str) -> NativeJobEnvelope {
        let request = request(job_id);
        let rgba = [1u8, 2, 3, 4];
        NativeJobEnvelope {
            contract: NATIVE_JOB_CONTRACT.to_string(),
            schema_version: 1,
            job: production_job(&request, 1, 1, &rgba),
            raster: RasterEnvelope {
                format: "rgba8".to_string(),
                width_px: 1,
                height_px: 1,
                row_bytes: 4,
                byte_length: 4,
            },
            raster_ms: 1.0,
            preprocessing_request: request.recognition_options.preprocessing.clone(),
            limits: native_limits(&request),
            result_file: ResultFileIdentity {
                id: result_file_id.to_string(),
            },
        }
    }

    #[test]
    fn request_rejects_unknown_model_or_unbounded_limits() {
        let mut value = request("job-1");
        assert!(validate_native_request(&value).is_ok());
        value.model_pack.assets.detection = "0".repeat(64);
        assert_eq!(
            validate_native_request(&value).unwrap_err().code,
            "OCR_NATIVE_REQUEST_INVALID"
        );
        value = request("job-2");
        value.recognition_options.maximum_pixels = MAX_PIXELS + 1;
        assert!(validate_native_request(&value).is_err());
    }

    #[test]
    fn binary_job_has_no_source_path_and_round_trips_with_private_modes() {
        let store = test_store();
        let files = store.job_files(&random_hex()).unwrap();
        let request = request("job-private");
        let rgba = [1u8, 2, 3, 4];
        let job = production_job(&request, 1, 1, &rgba);
        let envelope = NativeJobEnvelope {
            contract: NATIVE_JOB_CONTRACT.to_string(),
            schema_version: 1,
            job,
            raster: RasterEnvelope {
                format: "rgba8".to_string(),
                width_px: 1,
                height_px: 1,
                row_bytes: 4,
                byte_length: 4,
            },
            raster_ms: 1.0,
            preprocessing_request: request.recognition_options.preprocessing.clone(),
            limits: native_limits(&request),
            result_file: ResultFileIdentity {
                id: files.result_file_id.clone(),
            },
        };
        write_job_file(&files.request, &envelope, &rgba).unwrap();
        let (bytes, decoded) = read_job_file(&files.request).unwrap();
        assert_eq!(&bytes[..8], JOB_MAGIC);
        assert_eq!(decoded.job.job_id, "job-private");
        let json = serde_json::to_string(&decoded).unwrap();
        assert!(!json.contains("sourcePdfPath"));
        assert!(!json.contains(".pdf"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&files.request).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&store.session).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        files.cleanup(true, true);
        store.cleanup_session();
    }

    #[test]
    fn result_echo_rejects_stale_revision_and_model_identity() {
        let job = envelope("job-echo", "result-echo");
        let mut result = NativeResultEnvelope {
            contract: NATIVE_RESULT_CONTRACT.to_string(),
            schema_version: 1,
            status: "completed".to_string(),
            job_id: job.job.job_id.clone(),
            request_id: job.job.request_id.clone(),
            document_id: job.job.document.id.clone(),
            document_revision: job.job.document.revision,
            document_generation: job.job.document.generation.clone(),
            page_id: job.job.page.id.clone(),
            page_index: job.job.page.index,
            page_revision: job.job.page.revision,
            engine_id: job.job.engine_id.clone(),
            model_pack: job.job.model_pack.clone(),
            recognition_configuration_hash: job.job.recognition_configuration_hash.clone(),
            source_raster: job.job.page.source_raster.clone(),
            result_file_id: job.result_file.id.clone(),
            result: Some(json!({})),
            failure: None,
            lifecycle: Vec::new(),
            resources: json!({}),
        };
        assert!(validate_result_echo(&result, &job).is_ok());
        result.page_revision += 1;
        assert!(validate_result_echo(&result, &job).is_err());
        result.page_revision = job.job.page.revision;
        result.model_pack.pack_version = "9.9.9".to_string();
        assert!(validate_result_echo(&result, &job).is_err());
    }

    #[test]
    fn oversized_result_is_rejected_before_read_allocation() {
        let store = test_store();
        let files = store.job_files(&random_hex()).unwrap();
        let file = private_create_new(&files.result).unwrap();
        file.set_len(MAX_RESULT_BYTES as u64 + 1).unwrap();
        assert!(read_result_file(&files.result).is_err());
        files.cleanup(true, true);
        store.cleanup_session();
    }

    #[test]
    fn cancellation_requested_before_registration_is_not_lost() {
        let store = Arc::new(test_store());
        let registry = OcrJobRegistry {
            state: Arc::new(Mutex::new(RegistryState::default())),
            temp: Some(store.clone()),
            initialization_error: None,
        };
        let report = registry.cancel_job("job-race");
        assert!(!report.found);
        let entry = Arc::new(JobEntry::new(&request("job-race")));
        registry.register(entry.clone()).unwrap();
        assert!(entry.cancelled.load(Ordering::Acquire));
        assert_eq!(entry.terminal_state.load(Ordering::Acquire), JOB_CANCELLED);
        assert!(entry.cancellation_requested_at.load(Ordering::Acquire) > 0);
        registry.unregister(&entry);
        store.cleanup_session();
    }

    #[test]
    fn newer_page_job_marks_an_older_result_stale() {
        let store = Arc::new(test_store());
        let registry = OcrJobRegistry {
            state: Arc::new(Mutex::new(RegistryState::default())),
            temp: Some(store.clone()),
            initialization_error: None,
        };
        let old = Arc::new(JobEntry::new(&request("job-old")));
        let new = Arc::new(JobEntry::new(&request("job-new")));
        registry.register(old.clone()).unwrap();
        assert!(registry.is_latest(&old));
        registry.register(new.clone()).unwrap();
        assert!(!registry.is_latest(&old));
        assert!(registry.is_latest(&new));
        registry.unregister(&old);
        registry.unregister(&new);
        store.cleanup_session();
    }

    #[cfg(unix)]
    #[test]
    fn private_reader_rejects_symlink_substitution() {
        use std::os::unix::fs::symlink;
        let store = test_store();
        let files = store.job_files(&random_hex()).unwrap();
        let target = store.session.join("ordinary");
        fs::write(&target, b"data").unwrap();
        symlink(&target, &files.request).unwrap();
        assert!(private_open_read(&files.request).is_err());
        let _ = fs::remove_file(&files.request);
        let _ = fs::remove_file(&target);
        store.cleanup_session();
    }

    #[cfg(unix)]
    fn sleeping_child(seconds: u64) -> Child {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(format!("sleep {seconds}"));
        configure_child_process_group(&mut command);
        command.spawn().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn parent_cancellation_reaps_child_and_cleans_files() {
        let store = Arc::new(test_store());
        let registry = OcrJobRegistry {
            state: Arc::new(Mutex::new(RegistryState::default())),
            temp: Some(store.clone()),
            initialization_error: None,
        };
        let entry = Arc::new(JobEntry::new(&request("job-cancel")));
        registry.register(entry.clone()).unwrap();
        let files = store.job_files(&random_hex()).unwrap();
        private_create_new(&files.request).unwrap();
        *entry.files.lock().unwrap() = Some(files.clone());
        let child = sleeping_child(30);
        let pid = child.id();
        entry.child_pid.store(pid, Ordering::Release);
        *entry.child.lock().unwrap() = Some(child);
        let active = registry.job_status("job-cancel");
        assert_eq!(active.state, "running");
        assert_eq!(active.child_pid, Some(pid));
        let report = registry.cancel_job("job-cancel");
        assert!(report.terminated);
        assert!(report.cleanup.no_child_survived);
        assert!(report.cleanup.request_file_removed);
        assert!(entry
            .child
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some());
        registry.unregister(&entry);
        store.cleanup_session();
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_wins_the_pre_spawn_registry_race() {
        let store = Arc::new(test_store());
        let registry = OcrJobRegistry {
            state: Arc::new(Mutex::new(RegistryState::default())),
            temp: Some(store.clone()),
            initialization_error: None,
        };
        let entry = Arc::new(JobEntry::new(&request("job-pre-spawn")));
        registry.register(entry.clone()).unwrap();
        let files = store.job_files(&random_hex()).unwrap();
        *entry.files.lock().unwrap() = Some(files.clone());
        registry.cancel_job("job-pre-spawn");
        let outcome = run_child_process(
            &registry,
            &entry,
            &store,
            &files,
            &envelope("job-pre-spawn", &files.result_file_id),
        );
        assert_eq!(outcome.status, "cancelled");
        assert_eq!(outcome.child_pid, None);
        assert!(outcome.cleanup.no_child_survived);
        assert!(entry.child.lock().unwrap().is_none());
        registry.unregister(&entry);
        store.cleanup_session();
    }

    #[cfg(unix)]
    #[test]
    fn timeout_reaps_child_with_typed_failure() {
        let entry = Arc::new(JobEntry::new(&request("job-timeout")));
        let child = sleeping_child(30);
        *entry.child.lock().unwrap() = Some(child);
        let error = wait_for_child(&entry, Duration::from_millis(25)).unwrap_err();
        assert_eq!(error.code, "OCR_CHILD_TIMEOUT");
        assert!(entry
            .child
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some());
    }

    #[cfg(unix)]
    #[test]
    fn crash_is_observed_and_reaped() {
        let entry = Arc::new(JobEntry::new(&request("job-crash")));
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("exit 23");
        configure_child_process_group(&mut command);
        *entry.child.lock().unwrap() = Some(command.spawn().unwrap());
        let (status, cancelled) = wait_for_child(&entry, Duration::from_secs(1)).unwrap();
        assert!(!cancelled);
        assert_eq!(status.code(), Some(23));
        assert!(entry
            .child
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some());
    }

    #[cfg(unix)]
    #[test]
    fn application_close_cancels_every_registered_child() {
        let store = Arc::new(test_store());
        let registry = OcrJobRegistry {
            state: Arc::new(Mutex::new(RegistryState::default())),
            temp: Some(store.clone()),
            initialization_error: None,
        };
        let mut entries = Vec::new();
        for index in 0..2 {
            let mut request = request(&format!("job-close-{index}"));
            request.page.id = format!("page-{index}");
            let entry = Arc::new(JobEntry::new(&request));
            registry.register(entry.clone()).unwrap();
            let files = store.job_files(&random_hex()).unwrap();
            private_create_new(&files.request).unwrap();
            *entry.files.lock().unwrap() = Some(files);
            let child = sleeping_child(30);
            entry.child_pid.store(child.id(), Ordering::Release);
            *entry.child.lock().unwrap() = Some(child);
            entries.push(entry);
        }
        let report = registry.cancel_all();
        assert_eq!(report.jobs.len(), 2);
        assert!(report.jobs.iter().all(|job| job.cleanup.no_child_survived));
        assert!(entries.iter().all(|entry| {
            entry
                .child
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .try_wait()
                .unwrap()
                .is_some()
        }));
        assert!(!store.session.exists());
    }

    #[cfg(unix)]
    #[test]
    fn document_close_cancels_only_that_documents_jobs() {
        let store = Arc::new(test_store());
        let registry = OcrJobRegistry {
            state: Arc::new(Mutex::new(RegistryState::default())),
            temp: Some(store.clone()),
            initialization_error: None,
        };
        let first = Arc::new(JobEntry::new(&request("job-document-close")));
        let mut other_request = request("job-other-document");
        other_request.document.id = "document-2".to_string();
        other_request.page.id = "page-2".to_string();
        let second = Arc::new(JobEntry::new(&other_request));
        for entry in [&first, &second] {
            registry.register(entry.clone()).unwrap();
            let child = sleeping_child(30);
            entry.child_pid.store(child.id(), Ordering::Release);
            *entry.child.lock().unwrap() = Some(child);
        }
        let report = registry.cancel_document("document-1");
        assert_eq!(report.jobs.len(), 1);
        assert_eq!(report.jobs[0].job_id, "job-document-close");
        assert!(first
            .child
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some());
        assert!(second
            .child
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none());
        registry.cancel_all();
    }
}
