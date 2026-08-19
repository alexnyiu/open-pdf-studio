//! macOS-only, same-volume PDF replacement transaction.
//!
//! Candidate and validation-baseline files are private siblings of the
//! destination. The WebView writes them through the already-authorized Tauri
//! FS plugin; Rust flushes, verifies, validates with PDFium, and atomically
//! replaces only after every caller-side and native gate has passed.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri_plugin_fs::FsExt;

use crate::pdfium_renderer::{render_page_to_rgba, PdfiumDocumentHandle};

const ERROR_PREFIX: &str = "OPDS_SAFE_SAVE";
const PDFIUM_RENDER_SCALE: f32 = 2.0;
const MAX_CHANGED_PIXELS_PER_PAGE: usize = 0;
const MAX_CHANNEL_DELTA: u8 = 0;

#[derive(Clone, Debug, PartialEq, Eq)]
struct DestinationIdentity {
    device: u64,
    inode: u64,
    length: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
}

#[derive(Clone, Debug)]
struct SafeSaveRecord {
    destination: PathBuf,
    candidate: PathBuf,
    validation_baseline: Option<PathBuf>,
    candidate_sha256: String,
    candidate_length: u64,
    validation_baseline_sha256: Option<String>,
    validation_baseline_length: Option<u64>,
    destination_identity: Option<DestinationIdentity>,
    storage_kind: String,
    pdfium_validated: bool,
}

#[derive(Default)]
pub struct MacosSafeSaveState(Mutex<HashMap<String, SafeSaveRecord>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSafeSave {
    token: String,
    candidate_path: String,
    validation_baseline_path: Option<String>,
    storage_kind: String,
    same_volume: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfiumValidatedPage {
    page_index: u32,
    width: u32,
    height: u32,
    changed_pixels: usize,
    max_channel_delta: u8,
    baseline_text: String,
    candidate_text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfiumCandidateValidation {
    status: &'static str,
    baseline_page_count: usize,
    candidate_page_count: usize,
    render_scale: f32,
    max_changed_pixels_per_page: usize,
    max_channel_delta_tolerance: u8,
    pages: Vec<PdfiumValidatedPage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizedSafeSave {
    status: &'static str,
    destination_path: String,
    storage_kind: String,
    candidate_files_cleaned: bool,
    permissions_preserved: bool,
    macos_metadata_preserved: bool,
    full_sync_applied: bool,
    warnings: Vec<String>,
}

fn error(code: &str, message: impl AsRef<str>) -> String {
    format!(
        "{ERROR_PREFIX}|{code}|{}",
        message.as_ref().replace('|', "/")
    )
}

#[cfg(unix)]
fn classify_io(operation: &str, value: io::Error, storage_kind: &str) -> String {
    let code = match value.raw_os_error() {
        Some(libc::ENOSPC) | Some(libc::EDQUOT) => "OUT_OF_DISK_SPACE",
        Some(libc::EROFS) => "READ_ONLY_DESTINATION",
        Some(libc::EACCES) | Some(libc::EPERM) => "SECURITY_SCOPED_ACCESS_REQUIRED",
        Some(libc::EBUSY) | Some(libc::ETXTBSY) if storage_kind == "icloud" => {
            "ICLOUD_PROVIDER_BUSY"
        }
        Some(libc::EBUSY) | Some(libc::ETXTBSY) => "DESTINATION_LOCKED",
        Some(libc::EXDEV) => "CROSS_VOLUME_REPLACEMENT_REJECTED",
        Some(libc::ENOTSUP) => "ATOMIC_REPLACE_UNSUPPORTED",
        _ => "SAFE_SAVE_IO_FAILED",
    };
    error(code, format!("{operation}: {value}"))
}

#[cfg(not(unix))]
fn classify_io(operation: &str, value: io::Error, _storage_kind: &str) -> String {
    let code = match value.kind() {
        io::ErrorKind::PermissionDenied => "SECURITY_SCOPED_ACCESS_REQUIRED",
        _ => "SAFE_SAVE_IO_FAILED",
    };
    error(code, format!("{operation}: {value}"))
}

fn validate_digest(value: &str, label: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(error(
            "INVALID_DIGEST",
            format!("{label} must be a lowercase SHA-256 digest"),
        ))
    }
}

fn sha256_file(path: &Path, storage_kind: &str) -> Result<(String, u64), String> {
    let mut file = File::open(path)
        .map_err(|value| classify_io("open private save file", value, storage_kind))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut length = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|value| classify_io("read private save file", value, storage_kind))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        length += read as u64;
    }
    Ok((format!("{:x}", digest.finalize()), length))
}

fn verify_private_file(
    path: &Path,
    expected_digest: &str,
    expected_length: u64,
    storage_kind: &str,
) -> Result<(), String> {
    let (actual_digest, actual_length) = sha256_file(path, storage_kind)?;
    if actual_length != expected_length || actual_digest != expected_digest {
        return Err(error(
            "CANDIDATE_INTEGRITY_MISMATCH",
            format!(
                "private file integrity mismatch (expected {expected_length} bytes/{expected_digest}, got {actual_length} bytes/{actual_digest})"
            ),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn sync_file(path: &Path, storage_kind: &str) -> Result<bool, String> {
    use std::os::fd::AsRawFd;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|value| classify_io("open candidate for flush", value, storage_kind))?;
    file.sync_all()
        .map_err(|value| classify_io("flush candidate contents", value, storage_kind))?;
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC) };
    if result == 0 {
        return Ok(true);
    }
    let value = io::Error::last_os_error();
    match value.raw_os_error() {
        Some(libc::EINVAL) | Some(libc::ENOTSUP) => Ok(false),
        _ => Err(classify_io(
            "full-flush candidate contents",
            value,
            storage_kind,
        )),
    }
}

#[cfg(not(target_os = "macos"))]
fn sync_file(_path: &Path, _storage_kind: &str) -> Result<bool, String> {
    Err(error(
        "MACOS_ONLY",
        "Safe PDF replacement is enabled only on macOS",
    ))
}

fn sync_directory(path: &Path, storage_kind: &str) -> Result<(), String> {
    let directory = File::open(path).map_err(|value| {
        classify_io("open destination directory for flush", value, storage_kind)
    })?;
    directory
        .sync_all()
        .map_err(|value| classify_io("flush destination directory metadata", value, storage_kind))
}

fn storage_kind(path: &Path) -> String {
    let normalized = path.to_string_lossy();
    if normalized.contains("/Library/Mobile Documents/")
        || normalized.contains("/com~apple~CloudDocs/")
    {
        return "icloud".to_string();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let parent_device = path
            .parent()
            .and_then(|parent| fs::metadata(parent).ok())
            .map(|metadata| metadata.dev());
        let home_device = dirs::home_dir()
            .and_then(|home| fs::metadata(home).ok())
            .map(|metadata| metadata.dev());
        if parent_device.is_some() && home_device.is_some() && parent_device != home_device {
            return "external-volume".to_string();
        }
    }
    "local".to_string()
}

#[cfg(unix)]
fn destination_identity(path: &Path) -> Result<DestinationIdentity, io::Error> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path)?;
    Ok(DestinationIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        length: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
    })
}

#[cfg(unix)]
fn reject_protected_original_alias(
    expected_destination_identity: Option<&DestinationIdentity>,
    protected_original: Option<&Path>,
    storage_kind: &str,
) -> Result<(), String> {
    let Some(protected_original) = protected_original else {
        return Ok(());
    };
    if !protected_original.is_absolute() {
        return Err(error(
            "INVALID_PROTECTED_ORIGINAL",
            "Protected signed/PDF-A original path must be absolute",
        ));
    }
    let metadata = fs::metadata(protected_original).map_err(|value| {
        classify_io(
            "inspect protected signed/PDF-A original",
            value,
            storage_kind,
        )
    })?;
    if !metadata.is_file() {
        return Err(error(
            "INVALID_PROTECTED_ORIGINAL",
            "Protected signed/PDF-A original is not a regular file",
        ));
    }
    if let Some(expected_destination_identity) = expected_destination_identity {
        let protected_identity = destination_identity(protected_original).map_err(|value| {
            classify_io(
                "identify protected signed/PDF-A original",
                value,
                storage_kind,
            )
        })?;
        if expected_destination_identity.device == protected_identity.device
            && expected_destination_identity.inode == protected_identity.inode
        {
            return Err(error(
                "PROTECTED_ORIGINAL_ALIAS",
                "Save As destination resolves to the protected signed/PDF-A original",
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn destination_is_locked(path: &Path) -> Result<bool, io::Error> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    let path_c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL")
    })?;
    let mut stat_value = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::stat(path_c.as_ptr(), stat_value.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let flags = unsafe { stat_value.assume_init() }.st_flags;
    if flags & (libc::UF_IMMUTABLE | libc::UF_APPEND | libc::SF_IMMUTABLE | libc::SF_APPEND) != 0 {
        return Ok(true);
    }

    let file = OpenOptions::new().read(true).write(true).open(path)?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result != 0 {
        return Ok(true);
    }
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    Ok(false)
}

#[cfg(not(target_os = "macos"))]
fn destination_is_locked(_path: &Path) -> Result<bool, io::Error> {
    Ok(false)
}

fn create_private_file(path: &Path, storage_kind: &str) -> Result<(), String> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options
        .open(path)
        .map(|_| ())
        .map_err(|value| classify_io("create private same-volume candidate", value, storage_kind))
}

fn cleanup_record_files(record: &SafeSaveRecord) {
    let _ = fs::remove_file(&record.candidate);
    if let Some(path) = &record.validation_baseline {
        let _ = fs::remove_file(path);
    }
}

#[tauri::command]
pub fn begin_macos_safe_pdf_save(
    app: tauri::AppHandle,
    destination_path: String,
    protected_original_path: Option<String>,
    candidate_sha256: String,
    candidate_length: u64,
    validation_baseline_sha256: Option<String>,
    validation_baseline_length: Option<u64>,
    state: tauri::State<MacosSafeSaveState>,
) -> Result<PreparedSafeSave, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            app,
            destination_path,
            protected_original_path,
            candidate_sha256,
            candidate_length,
            validation_baseline_sha256,
            validation_baseline_length,
            state,
        );
        return Err(error(
            "MACOS_ONLY",
            "Safe PDF replacement is enabled only on macOS",
        ));
    }

    #[cfg(target_os = "macos")]
    {
        validate_digest(&candidate_sha256, "candidateSha256")?;
        if candidate_length == 0 {
            return Err(error(
                "INVALID_CANDIDATE",
                "Candidate PDF must not be empty",
            ));
        }
        match (&validation_baseline_sha256, validation_baseline_length) {
            (Some(digest), Some(length)) if length > 0 => {
                validate_digest(digest, "validationBaselineSha256")?
            }
            (None, None) => {}
            _ => {
                return Err(error(
                    "INVALID_BASELINE",
                    "Validation baseline digest and length must be supplied together",
                ))
            }
        }

        let destination = PathBuf::from(&destination_path);
        if !destination.is_absolute() || destination.file_name().is_none() {
            return Err(error(
                "INVALID_DESTINATION",
                "Safe save requires an absolute destination file path",
            ));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| error("INVALID_DESTINATION", "Destination has no parent directory"))?
            .to_path_buf();
        let storage_kind = storage_kind(&destination);
        if !parent.is_dir() {
            return Err(error(
                "DESTINATION_DIRECTORY_MISSING",
                "Destination directory does not exist",
            ));
        }
        if !app.fs_scope().is_allowed(&destination) && !app.fs_scope().is_allowed(&parent) {
            return Err(error(
                "TAURI_FS_SCOPE_DENIED",
                "Destination is outside the Tauri file scope; choose it again with Open or Save As",
            ));
        }

        let destination_identity = if destination.exists() {
            let symlink_metadata = fs::symlink_metadata(&destination)
                .map_err(|value| classify_io("inspect destination", value, &storage_kind))?;
            if symlink_metadata.file_type().is_symlink() || !symlink_metadata.is_file() {
                return Err(error(
                    "UNSAFE_DESTINATION",
                    "Safe save refuses symlink and non-file destinations",
                ));
            }
            if symlink_metadata.permissions().readonly() {
                return Err(error("READ_ONLY_DESTINATION", "Destination is read-only"));
            }
            if destination_is_locked(&destination)
                .map_err(|value| classify_io("check destination lock", value, &storage_kind))?
            {
                return Err(error(
                    "DESTINATION_LOCKED",
                    "Destination is locked by another process",
                ));
            }
            Some(destination_identity(&destination).map_err(|value| {
                classify_io("record destination identity", value, &storage_kind)
            })?)
        } else {
            None
        };
        reject_protected_original_alias(
            destination_identity.as_ref(),
            protected_original_path.as_deref().map(Path::new),
            &storage_kind,
        )?;

        // Preflight directory flushing before any destination mutation. File
        // providers or external volumes that cannot provide the required
        // durability fail here while the original is untouched.
        sync_directory(&parent, &storage_kind)?;

        let mut random = [0_u8; 16];
        rand::thread_rng().fill_bytes(&mut random);
        let token = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let file_name = destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("document.pdf");
        let candidate = parent.join(format!(".{file_name}.open-pdf-studio-{token}.candidate"));
        let validation_baseline = validation_baseline_sha256
            .as_ref()
            .map(|_| parent.join(format!(".{file_name}.open-pdf-studio-{token}.baseline")));

        create_private_file(&candidate, &storage_kind)?;
        if let Some(path) = &validation_baseline {
            if let Err(value) = create_private_file(path, &storage_kind) {
                let _ = fs::remove_file(&candidate);
                return Err(value);
            }
        }
        if let Err(value) = sync_directory(&parent, &storage_kind) {
            let _ = fs::remove_file(&candidate);
            if let Some(path) = &validation_baseline {
                let _ = fs::remove_file(path);
            }
            return Err(value);
        }
        let allow_private_files = (|| {
            app.fs_scope()
                .allow_file(&candidate)
                .map_err(|value| error("TAURI_FS_SCOPE_DENIED", value.to_string()))?;
            if let Some(path) = &validation_baseline {
                app.fs_scope()
                    .allow_file(path)
                    .map_err(|value| error("TAURI_FS_SCOPE_DENIED", value.to_string()))?;
            }
            Ok::<(), String>(())
        })();
        if let Err(value) = allow_private_files {
            let _ = fs::remove_file(&candidate);
            if let Some(path) = &validation_baseline {
                let _ = fs::remove_file(path);
            }
            let _ = sync_directory(&parent, &storage_kind);
            return Err(value);
        }

        let record = SafeSaveRecord {
            destination,
            candidate: candidate.clone(),
            validation_baseline: validation_baseline.clone(),
            candidate_sha256,
            candidate_length,
            validation_baseline_sha256,
            validation_baseline_length,
            destination_identity,
            storage_kind: storage_kind.clone(),
            pdfium_validated: false,
        };
        match state.0.lock() {
            Ok(mut records) => {
                records.insert(token.clone(), record);
            }
            Err(value) => {
                let record = value.into_inner();
                drop(record);
                let _ = fs::remove_file(&candidate);
                if let Some(path) = &validation_baseline {
                    let _ = fs::remove_file(path);
                }
                let _ = sync_directory(&parent, &storage_kind);
                return Err(error(
                    "SAFE_SAVE_STATE_FAILED",
                    "Safe-save transaction state is unavailable",
                ));
            }
        }
        Ok(PreparedSafeSave {
            token,
            candidate_path: candidate.to_string_lossy().to_string(),
            validation_baseline_path: validation_baseline
                .map(|path| path.to_string_lossy().to_string()),
            storage_kind,
            same_volume: true,
        })
    }
}

fn record_for_token(state: &MacosSafeSaveState, token: &str) -> Result<SafeSaveRecord, String> {
    state
        .0
        .lock()
        .map_err(|value| error("SAFE_SAVE_STATE_FAILED", value.to_string()))?
        .get(token)
        .cloned()
        .ok_or_else(|| {
            error(
                "UNKNOWN_SAVE_TOKEN",
                "Safe-save token is missing or already consumed",
            )
        })
}

#[tauri::command]
pub async fn validate_macos_ocr_pdf_candidate(
    token: String,
    selected_page_indexes: Vec<u32>,
    state: tauri::State<'_, MacosSafeSaveState>,
) -> Result<PdfiumCandidateValidation, String> {
    let record = record_for_token(&state, &token)?;
    let validation = tauri::async_runtime::spawn_blocking({
        let record = record.clone();
        move || {
        let baseline_path = record.validation_baseline.as_ref().ok_or_else(|| {
            error("VALIDATION_BASELINE_MISSING", "OCR candidate requires a private validation baseline")
        })?;
        verify_private_file(
            &record.candidate,
            &record.candidate_sha256,
            record.candidate_length,
            &record.storage_kind,
        )?;
        verify_private_file(
            baseline_path,
            record.validation_baseline_sha256.as_deref().unwrap_or_default(),
            record.validation_baseline_length.unwrap_or_default(),
            &record.storage_kind,
        )?;
        let baseline_bytes = Arc::new(
            fs::read(baseline_path)
                .map_err(|value| classify_io("read validation baseline", value, &record.storage_kind))?,
        );
        let candidate_bytes = Arc::new(
            fs::read(&record.candidate)
                .map_err(|value| classify_io("read candidate for PDFium", value, &record.storage_kind))?,
        );
        let baseline = PdfiumDocumentHandle::load_from_bytes(baseline_bytes)
            .map_err(|value| error("PDFIUM_REOPEN_FAILED", format!("baseline: {value}")))?;
        let candidate = PdfiumDocumentHandle::load_from_bytes(candidate_bytes)
            .map_err(|value| error("PDFIUM_REOPEN_FAILED", format!("candidate: {value}")))?;
        let baseline_pages = baseline.document().pages();
        let candidate_pages = candidate.document().pages();
        let baseline_page_count = baseline_pages.len() as usize;
        let candidate_page_count = candidate_pages.len() as usize;
        if baseline_page_count != candidate_page_count {
            return Err(error("PAGE_COUNT_CHANGED", "PDFium page count differs between baseline and candidate"));
        }
        let mut indexes = selected_page_indexes;
        indexes.sort_unstable();
        indexes.dedup();
        if indexes.is_empty() {
            return Err(error("INVALID_SELECTED_PAGES", "At least one PDFium validation page is required"));
        }
        let mut pages = Vec::with_capacity(indexes.len());
        for page_index in indexes {
            if page_index as usize >= candidate_page_count {
                return Err(error("INVALID_SELECTED_PAGES", format!("Page {} is outside the candidate", page_index + 1)));
            }
            let baseline_page = baseline_pages
                .get(page_index as i32)
                .map_err(|value| error("PDFIUM_REOPEN_FAILED", value.to_string()))?;
            let candidate_page = candidate_pages
                .get(page_index as i32)
                .map_err(|value| error("PDFIUM_REOPEN_FAILED", value.to_string()))?;
            let baseline_text = baseline_page
                .text()
                .map(|text| text.all())
                .map_err(|value| error("PDFIUM_EXTRACTION_FAILED", value.to_string()))?;
            let candidate_text = candidate_page
                .text()
                .map(|text| text.all())
                .map_err(|value| error("PDFIUM_EXTRACTION_FAILED", value.to_string()))?;
            let (baseline_width, baseline_height, baseline_rgba) = render_page_to_rgba(
                baseline.document(),
                page_index,
                PDFIUM_RENDER_SCALE,
                0,
            )?;
            let (width, height, candidate_rgba) = render_page_to_rgba(
                candidate.document(),
                page_index,
                PDFIUM_RENDER_SCALE,
                0,
            )?;
            if (width, height) != (baseline_width, baseline_height)
                || candidate_rgba.len() != baseline_rgba.len()
            {
                return Err(error("VISIBLE_PIXEL_REGRESSION", format!("Page {} dimensions changed", page_index + 1)));
            }
            let mut changed_pixels = 0_usize;
            let mut max_channel_delta = 0_u8;
            for (left, right) in baseline_rgba.chunks_exact(4).zip(candidate_rgba.chunks_exact(4)) {
                let changed = left != right;
                if changed {
                    changed_pixels += 1;
                }
                for channel in 0..4 {
                    max_channel_delta = max_channel_delta.max(left[channel].abs_diff(right[channel]));
                }
            }
            if changed_pixels > MAX_CHANGED_PIXELS_PER_PAGE || max_channel_delta > MAX_CHANNEL_DELTA {
                return Err(error(
                    "VISIBLE_PIXEL_REGRESSION",
                    format!(
                        "Page {} changed {changed_pixels} pixels (max channel delta {max_channel_delta})",
                        page_index + 1
                    ),
                ));
            }
            pages.push(PdfiumValidatedPage {
                page_index,
                width,
                height,
                changed_pixels,
                max_channel_delta,
                baseline_text: baseline_text.replace("\r\n", "\n").replace('\r', "\n"),
                candidate_text: candidate_text.replace("\r\n", "\n").replace('\r', "\n"),
            });
        }
        Ok(PdfiumCandidateValidation {
            status: "pass",
            baseline_page_count,
            candidate_page_count,
            render_scale: PDFIUM_RENDER_SCALE,
            max_changed_pixels_per_page: MAX_CHANGED_PIXELS_PER_PAGE,
            max_channel_delta_tolerance: MAX_CHANNEL_DELTA,
            pages,
        })
        }
    })
    .await
    .map_err(|value| error("PDFIUM_VALIDATION_PANIC", value.to_string()))??;
    let mut records = state
        .0
        .lock()
        .map_err(|value| error("SAFE_SAVE_STATE_FAILED", value.to_string()))?;
    let current = records.get_mut(&token).ok_or_else(|| {
        error(
            "UNKNOWN_SAVE_TOKEN",
            "Safe-save transaction ended during PDFium validation",
        )
    })?;
    if current.candidate != record.candidate {
        return Err(error(
            "SAVE_TRANSACTION_CHANGED",
            "Safe-save transaction changed during PDFium validation",
        ));
    }
    current.pdfium_validated = true;
    Ok(validation)
}

#[cfg(target_os = "macos")]
fn copy_macos_metadata(source: &Path, destination: &Path) -> Result<bool, String> {
    use std::os::fd::AsRawFd;

    let source_file = File::open(source).map_err(|value| value.to_string())?;
    let destination_file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(destination)
        .map_err(|value| value.to_string())?;
    let result = unsafe {
        libc::fcopyfile(
            source_file.as_raw_fd(),
            destination_file.as_raw_fd(),
            std::ptr::null_mut(),
            // Permissions are copied explicitly above. Preserve ACLs and
            // extended metadata (Finder tags, quarantine/provenance, resource
            // forks) without copying immutable/append-only stat flags onto the
            // candidate.
            libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
        )
    };
    if result == 0 {
        Ok(true)
    } else {
        Err(io::Error::last_os_error().to_string())
    }
}

#[cfg(target_os = "macos")]
fn swap_paths(left: &Path, right: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let left = std::ffi::CString::new(left.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "candidate path contains NUL"))?;
    let right = std::ffi::CString::new(right.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL")
    })?;
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            left.as_ptr(),
            libc::AT_FDCWD,
            right.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FinalizeFailurePoint {
    None,
    AfterAtomicReplace,
}

#[cfg(target_os = "macos")]
fn finalize_record(
    record: &SafeSaveRecord,
    failure_point: FinalizeFailurePoint,
) -> Result<FinalizedSafeSave, String> {
    let parent = record
        .destination
        .parent()
        .ok_or_else(|| error("INVALID_DESTINATION", "Destination has no parent directory"))?;
    if record.validation_baseline.is_some() && !record.pdfium_validated {
        return Err(error(
            "PDFIUM_VALIDATION_REQUIRED",
            "OCR candidate cannot be finalized before PDFium validation succeeds",
        ));
    }
    verify_private_file(
        &record.candidate,
        &record.candidate_sha256,
        record.candidate_length,
        &record.storage_kind,
    )?;
    let full_sync_applied = sync_file(&record.candidate, &record.storage_kind)?;
    let destination_exists = record.destination.exists();
    if destination_exists != record.destination_identity.is_some() {
        return Err(error(
            "DESTINATION_CHANGED",
            "Destination appeared or disappeared during validation",
        ));
    }
    if let Some(expected) = &record.destination_identity {
        let actual = destination_identity(&record.destination).map_err(|value| {
            classify_io("re-check destination identity", value, &record.storage_kind)
        })?;
        if actual.device != expected.device
            || actual.inode != expected.inode
            || actual.length != expected.length
            || actual.modified_seconds != expected.modified_seconds
            || actual.modified_nanoseconds != expected.modified_nanoseconds
        {
            return Err(error(
                "DESTINATION_CHANGED",
                "Destination was replaced or modified by another process during validation",
            ));
        }
    }

    let mut warnings = Vec::new();
    let mut permissions_preserved = true;
    let mut macos_metadata_preserved = true;
    if destination_exists {
        let permissions = fs::metadata(&record.destination)
            .map_err(|value| {
                classify_io("read destination permissions", value, &record.storage_kind)
            })?
            .permissions();
        fs::set_permissions(&record.candidate, permissions).map_err(|value| {
            classify_io(
                "preserve destination permissions",
                value,
                &record.storage_kind,
            )
        })?;
        if let Err(value) = copy_macos_metadata(&record.destination, &record.candidate) {
            macos_metadata_preserved = false;
            warnings.push(format!(
                "macOS extended metadata could not be copied: {value}"
            ));
        }
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&record.candidate, fs::Permissions::from_mode(0o644)).map_err(
                |value| classify_io("set new PDF permissions", value, &record.storage_kind),
            )?;
        }
        permissions_preserved = false;
        macos_metadata_preserved = false;
    }
    let _ = sync_file(&record.candidate, &record.storage_kind)?;

    if let Some(path) = &record.validation_baseline {
        fs::remove_file(path).map_err(|value| {
            classify_io("clean validation baseline", value, &record.storage_kind)
        })?;
    }
    sync_directory(parent, &record.storage_kind)?;

    if destination_exists {
        swap_paths(&record.candidate, &record.destination)
            .map_err(|value| classify_io("atomic destination swap", value, &record.storage_kind))?;
        let post_swap = (|| {
            if failure_point == FinalizeFailurePoint::AfterAtomicReplace {
                return Err(error(
                    "INJECTED_REPLACEMENT_FAILURE",
                    "Injected failure after atomic replacement",
                ));
            }
            verify_private_file(
                &record.destination,
                &record.candidate_sha256,
                record.candidate_length,
                &record.storage_kind,
            )?;
            sync_directory(parent, &record.storage_kind)?;
            Ok(())
        })();
        if let Err(value) = post_swap {
            let rollback = swap_paths(&record.candidate, &record.destination)
                .and_then(|_| File::open(parent)?.sync_all());
            if let Err(rollback_error) = rollback {
                // After the first exchange, candidate contains the old
                // destination. Never clean it when rollback fails: those are
                // the only preserved original bytes and the caller reports
                // their private recovery path.
                return Err(error(
                    "ATOMIC_REPLACE_ROLLBACK_FAILED",
                    format!(
                        "{value}; rollback also failed: {rollback_error}; original retained at {}",
                        record.candidate.to_string_lossy()
                    ),
                ));
            }
            // A successful reverse exchange puts the rejected new bytes back
            // at candidate and restores the original destination.
            let _ = fs::remove_file(&record.candidate);
            return Err(value);
        }
        if let Err(remove_error) = fs::remove_file(&record.candidate) {
            // The destination is already verified and durable. Do not turn an
            // old-version cleanup problem into a failed save or swap the new
            // document back out; preserve the old bytes as a private recovery
            // file and report its exact path.
            warnings.push(format!(
                "replaced original could not be cleaned and remains as a private recovery file at {}: {remove_error}",
                record.candidate.to_string_lossy()
            ));
        }
    } else {
        fs::rename(&record.candidate, &record.destination)
            .map_err(|value| classify_io("atomic Save As rename", value, &record.storage_kind))?;
        let post_rename = (|| {
            if failure_point == FinalizeFailurePoint::AfterAtomicReplace {
                return Err(error(
                    "INJECTED_REPLACEMENT_FAILURE",
                    "Injected failure after atomic Save As",
                ));
            }
            verify_private_file(
                &record.destination,
                &record.candidate_sha256,
                record.candidate_length,
                &record.storage_kind,
            )?;
            sync_directory(parent, &record.storage_kind)?;
            Ok(())
        })();
        if let Err(value) = post_rename {
            let _ = fs::rename(&record.destination, &record.candidate);
            let _ = fs::remove_file(&record.candidate);
            let _ = sync_directory(parent, &record.storage_kind);
            return Err(value);
        }
    }

    if let Err(value) = sync_directory(parent, &record.storage_kind) {
        // The replacement itself was already flushed before old-file cleanup.
        // Treat a cleanup-directory flush failure as a successful save with a
        // durability warning rather than falsely claiming the original remains.
        warnings.push(format!(
            "final candidate-cleanup directory flush failed: {value}"
        ));
    }
    Ok(FinalizedSafeSave {
        status: "pass",
        destination_path: record.destination.to_string_lossy().to_string(),
        storage_kind: record.storage_kind.clone(),
        candidate_files_cleaned: !record.candidate.exists()
            && record
                .validation_baseline
                .as_ref()
                .map_or(true, |path| !path.exists()),
        permissions_preserved,
        macos_metadata_preserved,
        full_sync_applied,
        warnings,
    })
}

#[tauri::command]
pub async fn finalize_macos_safe_pdf_save(
    token: String,
    state: tauri::State<'_, MacosSafeSaveState>,
) -> Result<FinalizedSafeSave, String> {
    let record = record_for_token(&state, &token)?;
    #[cfg(target_os = "macos")]
    let result = tauri::async_runtime::spawn_blocking({
        let record = record.clone();
        move || finalize_record(&record, FinalizeFailurePoint::None)
    })
    .await
    .map_err(|value| error("SAFE_SAVE_TASK_PANIC", value.to_string()))?;
    #[cfg(not(target_os = "macos"))]
    let result: Result<FinalizedSafeSave, String> = Err(error(
        "MACOS_ONLY",
        "Safe PDF replacement is enabled only on macOS",
    ));

    state
        .0
        .lock()
        .map_err(|value| error("SAFE_SAVE_STATE_FAILED", value.to_string()))?
        .remove(&token);
    let preserve_recovery_file = result.as_ref().err().map_or(false, |value| {
        value.contains("ATOMIC_REPLACE_ROLLBACK_FAILED")
    });
    if result.is_err() && !preserve_recovery_file {
        cleanup_record_files(&record);
    }
    result
}

#[tauri::command]
pub fn abort_macos_safe_pdf_save(
    token: String,
    state: tauri::State<MacosSafeSaveState>,
) -> Result<bool, String> {
    let record = state
        .0
        .lock()
        .map_err(|value| error("SAFE_SAVE_STATE_FAILED", value.to_string()))?
        .remove(&token);
    if let Some(record) = record {
        cleanup_record_files(&record);
        if let Some(parent) = record.destination.parent() {
            let _ = sync_directory(parent, &record.storage_kind);
        }
    }
    Ok(true)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    fn test_dir(label: &str) -> PathBuf {
        let mut random = [0_u8; 8];
        rand::thread_rng().fill_bytes(&mut random);
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = std::env::temp_dir().join(format!("opds-safe-save-{label}-{suffix}"));
        fs::create_dir(&path).expect("create test directory");
        path
    }

    fn record(dir: &Path, destination_exists: bool) -> SafeSaveRecord {
        let destination = dir.join("document.pdf");
        if destination_exists {
            fs::write(&destination, b"original").expect("write original");
            fs::set_permissions(&destination, fs::Permissions::from_mode(0o640)).unwrap();
        }
        let candidate = dir.join(".document.candidate");
        fs::write(&candidate, b"candidate").expect("write candidate");
        let candidate_sha256 = format!("{:x}", Sha256::digest(b"candidate"));
        SafeSaveRecord {
            destination: destination.clone(),
            candidate,
            validation_baseline: None,
            candidate_sha256,
            candidate_length: 9,
            validation_baseline_sha256: None,
            validation_baseline_length: None,
            destination_identity: destination_exists
                .then(|| destination_identity(&destination).expect("identity")),
            storage_kind: "local".to_string(),
            pdfium_validated: false,
        }
    }

    #[test]
    fn atomic_replace_preserves_permissions_and_cleans_candidate() {
        let dir = test_dir("replace");
        let record = record(&dir, true);
        let result = finalize_record(&record, FinalizeFailurePoint::None).expect("safe replace");
        assert_eq!(fs::read(&record.destination).unwrap(), b"candidate");
        assert_eq!(
            fs::metadata(&record.destination)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
        assert!(!record.candidate.exists());
        assert!(result.candidate_files_cleaned);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failure_after_swap_restores_original_and_cleans_candidate() {
        let dir = test_dir("rollback");
        let record = record(&dir, true);
        let error = finalize_record(&record, FinalizeFailurePoint::AfterAtomicReplace).unwrap_err();
        assert!(error.contains("INJECTED_REPLACEMENT_FAILURE"));
        assert_eq!(fs::read(&record.destination).unwrap(), b"original");
        assert!(!record.candidate.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_as_failure_removes_new_destination() {
        let dir = test_dir("save-as-rollback");
        let record = record(&dir, false);
        let error = finalize_record(&record, FinalizeFailurePoint::AfterAtomicReplace).unwrap_err();
        assert!(error.contains("INJECTED_REPLACEMENT_FAILURE"));
        assert!(!record.destination.exists());
        assert!(!record.candidate.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn out_of_space_and_locked_errors_are_explicit() {
        assert!(
            classify_io("write", io::Error::from_raw_os_error(libc::ENOSPC), "local")
                .contains("OUT_OF_DISK_SPACE")
        );
        assert!(
            classify_io("write", io::Error::from_raw_os_error(libc::EDQUOT), "local")
                .contains("OUT_OF_DISK_SPACE")
        );
        assert!(classify_io(
            "write",
            io::Error::from_raw_os_error(libc::EROFS),
            "external-volume"
        )
        .contains("READ_ONLY_DESTINATION"));
        assert!(
            classify_io("write", io::Error::from_raw_os_error(libc::EACCES), "local")
                .contains("SECURITY_SCOPED_ACCESS_REQUIRED")
        );
        assert!(
            classify_io("rename", io::Error::from_raw_os_error(libc::EBUSY), "local")
                .contains("DESTINATION_LOCKED")
        );
        assert!(classify_io(
            "rename",
            io::Error::from_raw_os_error(libc::EBUSY),
            "icloud"
        )
        .contains("ICLOUD_PROVIDER_BUSY"));
        assert!(classify_io(
            "rename",
            io::Error::from_raw_os_error(libc::EXDEV),
            "external-volume"
        )
        .contains("CROSS_VOLUME_REPLACEMENT_REJECTED"));
        assert!(classify_io(
            "rename",
            io::Error::from_raw_os_error(libc::ENOTSUP),
            "external-volume"
        )
        .contains("ATOMIC_REPLACE_UNSUPPORTED"));
        assert_eq!(
            storage_kind(Path::new(
                "/Users/test/Library/Mobile Documents/com~apple~CloudDocs/document.pdf"
            )),
            "icloud"
        );
    }

    #[test]
    fn tampered_candidate_never_replaces_original() {
        let dir = test_dir("integrity");
        let record = record(&dir, true);
        let mut file = OpenOptions::new()
            .append(true)
            .open(&record.candidate)
            .unwrap();
        file.write_all(b"tampered").unwrap();
        let error = finalize_record(&record, FinalizeFailurePoint::None).unwrap_err();
        assert!(error.contains("CANDIDATE_INTEGRITY_MISMATCH"));
        assert_eq!(fs::read(&record.destination).unwrap(), b"original");
        fs::remove_file(&record.candidate).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrently_modified_destination_is_not_replaced() {
        let dir = test_dir("destination-changed");
        let record = record(&dir, true);
        fs::write(&record.destination, b"external edit after staging").unwrap();
        let error = finalize_record(&record, FinalizeFailurePoint::None).unwrap_err();
        assert!(error.contains("DESTINATION_CHANGED"));
        assert_eq!(
            fs::read(&record.destination).unwrap(),
            b"external edit after staging"
        );
        assert_eq!(fs::read(&record.candidate).unwrap(), b"candidate");
        fs::remove_file(&record.candidate).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn protected_original_hard_link_alias_is_rejected() {
        let dir = test_dir("protected-alias");
        let original = dir.join("signed-original.pdf");
        let alias = dir.join("different-name.pdf");
        fs::write(&original, b"signed original").unwrap();
        fs::hard_link(&original, &alias).unwrap();
        let alias_identity = destination_identity(&alias).unwrap();
        let error =
            reject_protected_original_alias(Some(&alias_identity), Some(&original), "local")
                .unwrap_err();
        assert!(error.contains("PROTECTED_ORIGINAL_ALIAS"));
        assert_eq!(fs::read(&original).unwrap(), b"signed original");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ocr_candidate_requires_pdfium_validation_before_finalize() {
        let dir = test_dir("pdfium-required");
        let mut record = record(&dir, true);
        let baseline = dir.join(".document.baseline");
        fs::write(&baseline, b"baseline").unwrap();
        record.validation_baseline = Some(baseline.clone());
        let error = finalize_record(&record, FinalizeFailurePoint::None).unwrap_err();
        assert!(error.contains("PDFIUM_VALIDATION_REQUIRED"));
        assert_eq!(fs::read(&record.destination).unwrap(), b"original");
        assert_eq!(fs::read(&record.candidate).unwrap(), b"candidate");
        fs::remove_file(&record.candidate).unwrap();
        fs::remove_file(baseline).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
