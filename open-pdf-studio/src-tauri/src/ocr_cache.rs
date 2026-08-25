//! Bounded macOS OCR result cache.
//!
//! Only validated JSON result/state envelopes are accepted. Page rasters never
//! enter this directory, and callers cannot supply or discover its path.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fingerprint {
    algorithm: String,
    value: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrCacheKey {
    document_fingerprint: Fingerprint,
    page_identity: String,
    page_revision: u64,
    model_pack_identity: serde_json::Value,
    recognition_configuration_hash: Fingerprint,
    geometry_preprocessing_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheGetResult {
    status: String,
    payload: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachePutResult {
    stored: bool,
    compressed_bytes: u64,
    total_bytes: u64,
    evicted_entries: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMutationResult {
    removed_entries: u64,
    removed_bytes: u64,
    total_bytes: u64,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use flate2::read::GzDecoder;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use sha2::{Digest, Sha256};
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::Manager;

    const CACHE_FORMAT_VERSION: u32 = 1;
    const CACHE_DIR: &str = "ocr-cache";
    const CACHE_VERSION_DIR: &str = "v1";
    const MAX_UNCOMPRESSED_PAYLOAD_BYTES: u64 = 34 * 1024 * 1024;
    const MIN_CONFIGURED_CACHE_BYTES: u64 = 1024;
    const MAX_CONFIGURED_CACHE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
    const MAX_MODEL_IDENTITY_BYTES: usize = 64 * 1024;
    const MAX_SOURCE_PATH_BYTES: usize = 16 * 1024;
    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct CacheMetadata {
        cache_format_version: u32,
        key: OcrCacheKey,
        compressed_bytes: u64,
        uncompressed_bytes: u64,
        payload_sha256: String,
        last_access_epoch_ms: u64,
    }

    fn epoch_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0)
    }

    fn is_sha256(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    }

    fn valid_fingerprint(value: &Fingerprint) -> bool {
        value.algorithm == "sha256" && is_sha256(&value.value)
    }

    fn valid_identifier(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 256
            && value.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_alphanumeric()
                    || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
            })
    }

    fn validate_key(key: &OcrCacheKey) -> Result<(), String> {
        if !valid_fingerprint(&key.document_fingerprint)
            || !valid_fingerprint(&key.recognition_configuration_hash)
            || !valid_identifier(&key.page_identity)
            || !valid_identifier(&key.geometry_preprocessing_version)
            || !key.model_pack_identity.is_object()
        {
            return Err("OCR cache key is invalid".to_string());
        }
        let identity_bytes = serde_json::to_vec(&key.model_pack_identity)
            .map_err(|_| "OCR cache model identity is invalid".to_string())?;
        if identity_bytes.len() > MAX_MODEL_IDENTITY_BYTES {
            return Err("OCR cache model identity is too large".to_string());
        }
        Ok(())
    }

    pub(super) fn resolve_cache_root(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(CACHE_DIR).join(CACHE_VERSION_DIR)
    }

    fn ensure_private_directory(path: &Path) -> Result<(), String> {
        match fs::create_dir(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("OCR cache directory could not be created".to_string()),
        }
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| "OCR cache directory could not be inspected".to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("OCR cache directory is unsafe".to_string());
        }
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "OCR cache directory permissions could not be secured".to_string())?;
        Ok(())
    }

    fn ensure_cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        if std::env::var("OPS_ENABLE_MCP").as_deref() == Ok("1") {
            if let Some(test_root) = std::env::var_os("OPS_TEST_OCR_CACHE_DIR") {
                let cache_directory = PathBuf::from(test_root);
                if !cache_directory.is_absolute() {
                    return Err("OCR test cache directory must be absolute".to_string());
                }
                fs::create_dir_all(&cache_directory)
                    .map_err(|_| "OCR test cache directory could not be created".to_string())?;
                ensure_private_directory(&cache_directory)?;
                let root = cache_directory.join(CACHE_VERSION_DIR);
                ensure_private_directory(&root)?;
                return Ok(root);
            }
        }
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|_| "OCR cache application-data directory is unavailable".to_string())?;
        fs::create_dir_all(&app_data)
            .map_err(|_| "OCR cache application-data directory is unavailable".to_string())?;
        let cache_directory = app_data.join(CACHE_DIR);
        ensure_private_directory(&cache_directory)?;
        let root = resolve_cache_root(&app_data);
        ensure_private_directory(&root)?;
        Ok(root)
    }

    fn key_digest(key: &OcrCacheKey) -> Result<String, String> {
        validate_key(key)?;
        let canonical =
            serde_json::to_vec(key).map_err(|_| "OCR cache key is invalid".to_string())?;
        Ok(format!("{:x}", Sha256::digest(canonical)))
    }

    fn payload_path(root: &Path, digest: &str) -> PathBuf {
        root.join(format!("{digest}.payload.json.gz"))
    }

    fn metadata_path(root: &Path, digest: &str) -> PathBuf {
        root.join(format!("{digest}.meta.json"))
    }

    fn managed_digest<'a>(file_name: &'a str, suffix: &str) -> Option<&'a str> {
        let digest = file_name.strip_suffix(suffix)?;
        if is_sha256(digest) {
            Some(digest)
        } else {
            None
        }
    }

    fn safe_regular_file(path: &Path) -> bool {
        fs::symlink_metadata(path)
            .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
            .unwrap_or(false)
    }

    fn temp_path(root: &Path) -> PathBuf {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        root.join(format!(
            ".ocr-cache-{}-{}-{}.tmp",
            std::process::id(),
            epoch_ms(),
            sequence
        ))
    }

    fn atomic_write(root: &Path, destination: &Path, bytes: &[u8]) -> Result<(), String> {
        let temporary = temp_path(root);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .map_err(|_| "OCR cache temporary file could not be created".to_string())?;
        let result = (|| {
            file.write_all(bytes)
                .map_err(|_| "OCR cache file could not be written".to_string())?;
            file.sync_all()
                .map_err(|_| "OCR cache file could not be flushed".to_string())?;
            drop(file);
            fs::rename(&temporary, destination)
                .map_err(|_| "OCR cache file could not be replaced".to_string())?;
            if let Ok(directory) = File::open(root) {
                let _ = directory.sync_all();
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn remove_entry(root: &Path, digest: &str) -> (u64, u64) {
        let payload = payload_path(root, digest);
        let metadata = metadata_path(root, digest);
        let bytes = [&payload, &metadata]
            .into_iter()
            .filter_map(|path| fs::symlink_metadata(path).ok())
            .map(|value| value.len())
            .sum();
        let mut removed = false;
        for path in [payload, metadata] {
            if fs::symlink_metadata(&path).is_ok() {
                removed |= fs::remove_file(path).is_ok();
            }
        }
        (u64::from(removed), bytes)
    }

    fn rejected(root: &Path, digest: &str, reason: &str) -> CacheGetResult {
        remove_entry(root, digest);
        CacheGetResult {
            status: "rejected".to_string(),
            payload: None,
            reason: Some(reason.to_string()),
        }
    }

    fn read_metadata(root: &Path, digest: &str) -> Result<CacheMetadata, ()> {
        let path = metadata_path(root, digest);
        if !safe_regular_file(&path) {
            return Err(());
        }
        let bytes = fs::read(path).map_err(|_| ())?;
        if bytes.len() > MAX_MODEL_IDENTITY_BYTES * 2 {
            return Err(());
        }
        serde_json::from_slice(&bytes).map_err(|_| ())
    }

    fn total_cache_bytes(root: &Path) -> u64 {
        fs::read_dir(root)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_str()?;
                if managed_digest(name, ".payload.json.gz").is_none()
                    && managed_digest(name, ".meta.json").is_none()
                {
                    return None;
                }
                let metadata = fs::symlink_metadata(entry.path()).ok()?;
                if metadata.is_file() && !metadata.file_type().is_symlink() {
                    Some(metadata.len())
                } else {
                    None
                }
            })
            .sum()
    }

    fn prune_lru(root: &Path, maximum_bytes: u64) -> Result<(u64, u64), String> {
        if !(MIN_CONFIGURED_CACHE_BYTES..=MAX_CONFIGURED_CACHE_BYTES).contains(&maximum_bytes) {
            return Err("OCR cache size limit is invalid".to_string());
        }
        let mut entries = Vec::new();
        let directory =
            fs::read_dir(root).map_err(|_| "OCR cache directory could not be read".to_string())?;
        for entry in directory.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(digest) = managed_digest(name, ".meta.json") else {
                continue;
            };
            if let Ok(metadata) = read_metadata(root, digest) {
                let payload = payload_path(root, digest);
                if safe_regular_file(&payload) {
                    entries.push((
                        metadata.last_access_epoch_ms,
                        digest.to_string(),
                        metadata.compressed_bytes,
                    ));
                } else {
                    remove_entry(root, digest);
                }
            } else {
                remove_entry(root, digest);
            }
        }
        // An interrupted atomic pair can leave a managed payload without its
        // metadata. Remove only exact managed names inside the resolved root.
        if let Ok(directory) = fs::read_dir(root) {
            for entry in directory.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                let Some(digest) = managed_digest(name, ".payload.json.gz") else {
                    continue;
                };
                if !safe_regular_file(&metadata_path(root, digest)) {
                    remove_entry(root, digest);
                }
            }
        }
        entries.sort_by_key(|entry| entry.0);
        let mut total = total_cache_bytes(root);
        let mut evicted = 0;
        for (_, digest, _) in entries {
            if total <= maximum_bytes {
                break;
            }
            let (removed, bytes) = remove_entry(root, &digest);
            if removed > 0 {
                total = total.saturating_sub(bytes);
                evicted += 1;
            }
        }
        Ok((total, evicted))
    }

    pub(super) fn get(app: &tauri::AppHandle, key: OcrCacheKey) -> Result<CacheGetResult, String> {
        let root = ensure_cache_root(app)?;
        let digest = key_digest(&key)?;
        let metadata = match read_metadata(&root, &digest) {
            Ok(value) => value,
            Err(_) => {
                if payload_path(&root, &digest).exists() || metadata_path(&root, &digest).exists() {
                    return Ok(rejected(&root, &digest, "corrupt"));
                }
                return Ok(CacheGetResult {
                    status: "miss".to_string(),
                    payload: None,
                    reason: None,
                });
            }
        };
        if metadata.cache_format_version != CACHE_FORMAT_VERSION {
            return Ok(rejected(&root, &digest, "version"));
        }
        if metadata.key != key || metadata.payload_sha256.len() != 64 {
            return Ok(rejected(&root, &digest, "corrupt"));
        }
        let payload_file = payload_path(&root, &digest);
        if !safe_regular_file(&payload_file) {
            return Ok(rejected(&root, &digest, "corrupt"));
        }
        let compressed =
            fs::read(&payload_file).map_err(|_| "OCR cache entry could not be read".to_string())?;
        if compressed.len() as u64 != metadata.compressed_bytes {
            return Ok(rejected(&root, &digest, "corrupt"));
        }
        let mut decoder = GzDecoder::new(compressed.as_slice());
        let mut decoded = Vec::new();
        if decoder
            .by_ref()
            .take(MAX_UNCOMPRESSED_PAYLOAD_BYTES + 1)
            .read_to_end(&mut decoded)
            .is_err()
        {
            return Ok(rejected(&root, &digest, "corrupt"));
        }
        if decoded.len() as u64 != metadata.uncompressed_bytes
            || decoded.len() as u64 > MAX_UNCOMPRESSED_PAYLOAD_BYTES
            || !is_sha256(&metadata.payload_sha256)
            || format!("{:x}", Sha256::digest(&decoded)) != metadata.payload_sha256
        {
            return Ok(rejected(&root, &digest, "corrupt"));
        }
        let value: serde_json::Value = match serde_json::from_slice(&decoded) {
            Ok(value) => value,
            Err(_) => return Ok(rejected(&root, &digest, "corrupt")),
        };
        if value
            .get("cacheFormatVersion")
            .and_then(|value| value.as_u64())
            != Some(u64::from(CACHE_FORMAT_VERSION))
        {
            return Ok(rejected(&root, &digest, "version"));
        }
        let mut accessed = metadata;
        accessed.last_access_epoch_ms = epoch_ms();
        if let Ok(bytes) = serde_json::to_vec(&accessed) {
            let _ = atomic_write(&root, &metadata_path(&root, &digest), &bytes);
        }
        let payload = String::from_utf8(decoded)
            .map_err(|_| "OCR cache entry is not valid UTF-8".to_string())?;
        Ok(CacheGetResult {
            status: "hit".to_string(),
            payload: Some(payload),
            reason: None,
        })
    }

    pub(super) fn put(
        app: &tauri::AppHandle,
        key: OcrCacheKey,
        payload: String,
        maximum_bytes: u64,
    ) -> Result<CachePutResult, String> {
        if !(MIN_CONFIGURED_CACHE_BYTES..=MAX_CONFIGURED_CACHE_BYTES).contains(&maximum_bytes) {
            return Err("OCR cache size limit is invalid".to_string());
        }
        let root = ensure_cache_root(app)?;
        let digest = key_digest(&key)?;
        let bytes = payload.as_bytes();
        if bytes.is_empty() || bytes.len() as u64 > MAX_UNCOMPRESSED_PAYLOAD_BYTES {
            return Err("OCR cache payload size is invalid".to_string());
        }
        let value: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|_| "OCR cache payload is invalid".to_string())?;
        if value
            .get("cacheFormatVersion")
            .and_then(|value| value.as_u64())
            != Some(u64::from(CACHE_FORMAT_VERSION))
        {
            return Err("OCR cache payload version is unsupported".to_string());
        }
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(bytes)
            .map_err(|_| "OCR cache payload could not be compressed".to_string())?;
        let compressed = encoder
            .finish()
            .map_err(|_| "OCR cache payload could not be compressed".to_string())?;
        if compressed.len() as u64 > maximum_bytes {
            remove_entry(&root, &digest);
            let total = total_cache_bytes(&root);
            return Ok(CachePutResult {
                stored: false,
                compressed_bytes: compressed.len() as u64,
                total_bytes: total,
                evicted_entries: 0,
            });
        }
        let metadata = CacheMetadata {
            cache_format_version: CACHE_FORMAT_VERSION,
            key,
            compressed_bytes: compressed.len() as u64,
            uncompressed_bytes: bytes.len() as u64,
            payload_sha256: format!("{:x}", Sha256::digest(bytes)),
            last_access_epoch_ms: epoch_ms(),
        };
        atomic_write(&root, &payload_path(&root, &digest), &compressed)?;
        let metadata_bytes = serde_json::to_vec(&metadata)
            .map_err(|_| "OCR cache metadata is invalid".to_string())?;
        if let Err(error) = atomic_write(&root, &metadata_path(&root, &digest), &metadata_bytes) {
            remove_entry(&root, &digest);
            return Err(error);
        }
        let (total, evicted) = prune_lru(&root, maximum_bytes)?;
        Ok(CachePutResult {
            stored: payload_path(&root, &digest).exists(),
            compressed_bytes: compressed.len() as u64,
            total_bytes: total,
            evicted_entries: evicted,
        })
    }

    pub(super) fn invalidate_page(
        app: &tauri::AppHandle,
        document_fingerprint: Fingerprint,
        page_identity: String,
    ) -> Result<CacheMutationResult, String> {
        if !valid_fingerprint(&document_fingerprint) || !valid_identifier(&page_identity) {
            return Err("OCR cache page identity is invalid".to_string());
        }
        let root = ensure_cache_root(app)?;
        let mut removed_entries = 0;
        let mut removed_bytes = 0;
        let directory =
            fs::read_dir(&root).map_err(|_| "OCR cache directory could not be read".to_string())?;
        for entry in directory.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(digest) = managed_digest(name, ".meta.json") else {
                continue;
            };
            let Ok(metadata) = read_metadata(&root, digest) else {
                remove_entry(&root, digest);
                continue;
            };
            if metadata.key.document_fingerprint == document_fingerprint
                && metadata.key.page_identity == page_identity
            {
                let (removed, bytes) = remove_entry(&root, digest);
                removed_entries += removed;
                removed_bytes += bytes;
            }
        }
        Ok(CacheMutationResult {
            removed_entries,
            removed_bytes,
            total_bytes: total_cache_bytes(&root),
        })
    }

    fn clear_root(root: &Path) -> Result<CacheMutationResult, String> {
        let mut digests = Vec::new();
        let mut temporary_files = Vec::new();
        let directory =
            fs::read_dir(root).map_err(|_| "OCR cache directory could not be read".to_string())?;
        for entry in directory.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if let Some(digest) = managed_digest(name, ".meta.json") {
                digests.push(digest.to_string());
            } else if let Some(digest) = managed_digest(name, ".payload.json.gz") {
                digests.push(digest.to_string());
            } else if name.starts_with(".ocr-cache-") && name.ends_with(".tmp") {
                temporary_files.push(entry.path());
            }
        }
        digests.sort();
        digests.dedup();
        let mut removed_entries = 0;
        let mut removed_bytes = 0;
        for digest in digests {
            let (removed, bytes) = remove_entry(root, &digest);
            removed_entries += removed;
            removed_bytes += bytes;
        }
        for path in temporary_files {
            let _ = fs::remove_file(path);
        }
        Ok(CacheMutationResult {
            removed_entries,
            removed_bytes,
            total_bytes: total_cache_bytes(root),
        })
    }

    pub(super) fn clear(app: &tauri::AppHandle) -> Result<CacheMutationResult, String> {
        clear_root(&ensure_cache_root(app)?)
    }

    pub(super) fn document_fingerprint(path: String) -> Result<Fingerprint, String> {
        if path.is_empty() || path.len() > MAX_SOURCE_PATH_BYTES {
            return Err("OCR document source is invalid".to_string());
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "OCR document source is unavailable".to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("OCR document source is not a regular file".to_string());
        }
        let mut file =
            File::open(path).map_err(|_| "OCR document source could not be opened".to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 128 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|_| "OCR document source could not be read".to_string())?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        Ok(Fingerprint {
            algorithm: "sha256".to_string(),
            value: format!("{:x}", hasher.finalize()),
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn cache_root_is_scoped_below_tauri_application_data() {
            let base = Path::new("/tmp/open-pdf-studio-app-data-test");
            assert_eq!(resolve_cache_root(base), base.join("ocr-cache").join("v1"));
        }

        #[test]
        fn managed_file_names_require_lowercase_sha256_digests() {
            let digest = "a".repeat(64);
            assert_eq!(
                managed_digest(&format!("{digest}.meta.json"), ".meta.json"),
                Some(digest.as_str())
            );
            assert!(managed_digest("../escape.meta.json", ".meta.json").is_none());
            assert!(
                managed_digest(&format!("{}.meta.json", "A".repeat(64)), ".meta.json").is_none()
            );
        }

        #[test]
        fn cache_keys_reject_unsafe_identifiers() {
            let key = OcrCacheKey {
                document_fingerprint: Fingerprint {
                    algorithm: "sha256".into(),
                    value: "a".repeat(64),
                },
                page_identity: "../page".into(),
                page_revision: 0,
                model_pack_identity: serde_json::json!({"packId": "core"}),
                recognition_configuration_hash: Fingerprint {
                    algorithm: "sha256".into(),
                    value: "b".repeat(64),
                },
                geometry_preprocessing_version: "geometry-v1".into(),
            };
            assert!(validate_key(&key).is_err());
        }

        fn test_key(page_identity: &str) -> OcrCacheKey {
            OcrCacheKey {
                document_fingerprint: Fingerprint {
                    algorithm: "sha256".into(),
                    value: "a".repeat(64),
                },
                page_identity: page_identity.into(),
                page_revision: 0,
                model_pack_identity: serde_json::json!({"packId": "core"}),
                recognition_configuration_hash: Fingerprint {
                    algorithm: "sha256".into(),
                    value: "b".repeat(64),
                },
                geometry_preprocessing_version: "geometry-v1".into(),
            }
        }

        fn write_test_entry(
            root: &Path,
            digest: &str,
            page_identity: &str,
            accessed: u64,
            bytes: usize,
        ) {
            fs::write(payload_path(root, digest), vec![0u8; bytes]).unwrap();
            let metadata = CacheMetadata {
                cache_format_version: CACHE_FORMAT_VERSION,
                key: test_key(page_identity),
                compressed_bytes: bytes as u64,
                uncompressed_bytes: 1,
                payload_sha256: "c".repeat(64),
                last_access_epoch_ms: accessed,
            };
            fs::write(
                metadata_path(root, digest),
                serde_json::to_vec(&metadata).unwrap(),
            )
            .unwrap();
        }

        #[test]
        fn lru_pruning_is_bounded_and_removes_managed_orphans() {
            let root = std::env::temp_dir().join(format!(
                "open-pdf-studio-ocr-cache-test-{}-{}",
                std::process::id(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&root).unwrap();
            let oldest = "d".repeat(64);
            let newest = "e".repeat(64);
            let orphan = "f".repeat(64);
            write_test_entry(&root, &oldest, "page-1", 1, 700);
            write_test_entry(&root, &newest, "page-2", 2, 700);
            fs::write(payload_path(&root, &orphan), vec![0u8; 300]).unwrap();
            let newest_bytes = fs::metadata(payload_path(&root, &newest)).unwrap().len()
                + fs::metadata(metadata_path(&root, &newest)).unwrap().len();

            let (total, evicted) = prune_lru(&root, newest_bytes.max(1024)).unwrap();

            assert_eq!(total, newest_bytes);
            assert_eq!(evicted, 1);
            assert!(!payload_path(&root, &oldest).exists());
            assert!(payload_path(&root, &newest).exists());
            assert!(!payload_path(&root, &orphan).exists());
            fs::remove_dir_all(&root).unwrap();
        }

        #[test]
        fn cache_clear_removes_only_managed_application_data() {
            let root = std::env::temp_dir().join(format!(
                "open-pdf-studio-ocr-cache-clear-test-{}-{}",
                std::process::id(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&root).unwrap();
            let digest = "f".repeat(64);
            fs::write(payload_path(&root, &digest), b"payload").unwrap();
            fs::write(metadata_path(&root, &digest), b"metadata").unwrap();
            let temporary = root.join(".ocr-cache-123-456-789.tmp");
            fs::write(&temporary, b"temporary").unwrap();
            let unrelated = root.join("keep-user-file.txt");
            fs::write(&unrelated, b"unrelated").unwrap();

            let result = clear_root(&root).unwrap();

            assert_eq!(result.removed_entries, 1);
            assert_eq!(result.removed_bytes, 15);
            assert_eq!(result.total_bytes, 0);
            assert!(!payload_path(&root, &digest).exists());
            assert!(!metadata_path(&root, &digest).exists());
            assert!(!temporary.exists());
            assert_eq!(fs::read(&unrelated).unwrap(), b"unrelated");
            fs::remove_dir_all(&root).unwrap();
        }

        #[test]
        fn document_fingerprinting_hashes_regular_files_and_rejects_symlinks() {
            let root = std::env::temp_dir().join(format!(
                "open-pdf-studio-ocr-fingerprint-test-{}-{}",
                std::process::id(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&root).unwrap();
            let source = root.join("document.pdf");
            let linked = root.join("linked-document.pdf");
            let bytes = b"test-only-pdf-fingerprint-input";
            fs::write(&source, bytes).unwrap();
            std::os::unix::fs::symlink(&source, &linked).unwrap();

            let fingerprint = document_fingerprint(source.to_string_lossy().into_owned()).unwrap();
            let error = document_fingerprint(linked.to_string_lossy().into_owned()).unwrap_err();

            assert_eq!(fingerprint.algorithm, "sha256");
            assert_eq!(fingerprint.value, format!("{:x}", Sha256::digest(bytes)));
            assert_eq!(error, "OCR document source is not a regular file");
            assert!(!error.contains(root.to_string_lossy().as_ref()));
            fs::remove_dir_all(&root).unwrap();
        }
    }
}

#[tauri::command]
pub fn ocr_cache_get(app: tauri::AppHandle, key: OcrCacheKey) -> Result<CacheGetResult, String> {
    #[cfg(target_os = "macos")]
    {
        macos::get(&app, key)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, key);
        Err("OCR cache is active on macOS only".to_string())
    }
}

#[tauri::command]
pub fn ocr_cache_put(
    app: tauri::AppHandle,
    key: OcrCacheKey,
    payload: String,
    maximum_bytes: u64,
) -> Result<CachePutResult, String> {
    #[cfg(target_os = "macos")]
    {
        macos::put(&app, key, payload, maximum_bytes)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, key, payload, maximum_bytes);
        Err("OCR cache is active on macOS only".to_string())
    }
}

#[tauri::command]
pub fn ocr_cache_invalidate_page(
    app: tauri::AppHandle,
    document_fingerprint: Fingerprint,
    page_identity: String,
) -> Result<CacheMutationResult, String> {
    #[cfg(target_os = "macos")]
    {
        macos::invalidate_page(&app, document_fingerprint, page_identity)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, document_fingerprint, page_identity);
        Err("OCR cache is active on macOS only".to_string())
    }
}

#[tauri::command]
pub fn ocr_cache_clear(app: tauri::AppHandle) -> Result<CacheMutationResult, String> {
    #[cfg(target_os = "macos")]
    {
        macos::clear(&app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("OCR cache is active on macOS only".to_string())
    }
}

#[tauri::command]
pub async fn ocr_document_fingerprint(path: String) -> Result<Fingerprint, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || macos::document_fingerprint(path))
            .await
            .map_err(|_| "OCR document fingerprinting failed".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("OCR document fingerprinting is active on macOS only".to_string())
    }
}
