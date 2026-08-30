//! Cocoa File Provider inspection and coordinated replacement support.
//!
//! This module does not perform PDF validation or replacement itself. The
//! coordinated accessor receives the exact destination URL and calls back into
//! `macos_safe_save`, where digest, destination identity, atomic swap, and
//! rollback remain authoritative.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;

use block2::StackBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{
    NSError, NSFileCoordinator, NSFileCoordinatorWritingOptions, NSNumber, NSString,
    NSURLIsUbiquitousItemKey, NSURLUbiquitousItemContainerDisplayNameKey,
    NSURLUbiquitousItemDownloadingErrorKey, NSURLUbiquitousItemDownloadingStatusKey,
    NSURLUbiquitousItemHasUnresolvedConflictsKey, NSURLUbiquitousItemIsDownloadingKey,
    NSURLUbiquitousItemIsUploadedKey, NSURLUbiquitousItemIsUploadingKey,
    NSURLUbiquitousItemUploadingErrorKey, NSURLVolumeIsLocalKey, NSURLVolumeIsReadOnlyKey,
    NSURLVolumeIsRemovableKey, NSURLVolumeTypeNameKey, NSURL,
};
use serde::Serialize;

const ERROR_PREFIX: &str = "OPDS_SAFE_SAVE";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ProviderResourceSnapshot {
    ubiquitous: bool,
    container_name: Option<String>,
    download_status: Option<String>,
    downloading: bool,
    uploaded: Option<bool>,
    uploading: bool,
    unresolved_conflicts: bool,
    download_error: Option<String>,
    upload_error: Option<String>,
    volume_is_local: Option<bool>,
    volume_is_removable: Option<bool>,
    volume_is_read_only: Option<bool>,
    volume_type: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacosFileProviderInfo {
    pub provider_kind: String,
    pub provider_managed: bool,
    pub ubiquitous: bool,
    pub materialized: bool,
    pub download_status: Option<String>,
    pub downloading: bool,
    pub uploaded: Option<bool>,
    pub uploading: bool,
    pub unresolved_conflicts: bool,
    pub download_error: Option<String>,
    pub upload_error: Option<String>,
    pub volume_is_local: Option<bool>,
    pub volume_is_removable: Option<bool>,
    pub volume_is_read_only: Option<bool>,
    pub volume_type: Option<String>,
    pub coordination_required: bool,
    pub security_scoped_access: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoordinatedWriteError {
    pub code: String,
    pub message: String,
    pub provider_kind: String,
    pub retryable: bool,
    pub recovery_action: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoordinatedWriteFailure {
    Coordination(CoordinatedWriteError),
    Operation(String),
}

impl CoordinatedWriteError {
    pub fn encoded(&self) -> String {
        format!(
            "{ERROR_PREFIX}|{}|{}|{}|{}|{}",
            self.code,
            self.message.replace('|', "/"),
            self.provider_kind,
            self.retryable,
            self.recovery_action,
        )
    }
}

fn path_is_icloud(path: &Path) -> bool {
    let path = path.to_string_lossy();
    path.contains("/Library/Mobile Documents/") || path.contains("/com~apple~CloudDocs/")
}

fn path_is_file_provider(path: &Path) -> bool {
    path.to_string_lossy().contains("/Library/CloudStorage/")
}

fn classify_provider(
    path: &Path,
    resources: &ProviderResourceSnapshot,
    external_volume_hint: bool,
) -> MacosFileProviderInfo {
    let provider_kind = if path_is_icloud(path) {
        "icloud"
    } else if resources.ubiquitous
        || resources.container_name.is_some()
        || path_is_file_provider(path)
    {
        "file-provider"
    } else if resources.volume_is_removable == Some(true)
        || resources.volume_is_local == Some(false)
        || external_volume_hint
    {
        "external-volume"
    } else {
        "local"
    };
    let provider_managed = matches!(provider_kind, "icloud" | "file-provider");
    let status = resources
        .download_status
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let materialized = !provider_managed
        || (!status.contains("notdownloaded")
            && !status.contains("not downloaded")
            && resources.download_error.is_none());
    MacosFileProviderInfo {
        provider_kind: provider_kind.to_string(),
        provider_managed,
        ubiquitous: resources.ubiquitous,
        materialized,
        download_status: resources.download_status.clone(),
        downloading: resources.downloading,
        uploaded: resources.uploaded,
        uploading: resources.uploading,
        unresolved_conflicts: resources.unresolved_conflicts,
        download_error: resources.download_error.clone(),
        upload_error: resources.upload_error.clone(),
        volume_is_local: resources.volume_is_local,
        volume_is_removable: resources.volume_is_removable,
        volume_is_read_only: resources.volume_is_read_only,
        volume_type: resources.volume_type.clone(),
        coordination_required: true,
        // The current package has hardened-runtime/user-selected-file
        // entitlements but no com.apple.security.app-sandbox entitlement.
        // Tauri's user-selected FS scope is therefore the access authority;
        // bookmark persistence becomes required only if App Sandbox is added.
        security_scoped_access: "not-required-non-sandboxed".to_string(),
    }
}

unsafe fn resource_object(
    url: &NSURL,
    key: &objc2_foundation::NSURLResourceKey,
) -> Option<Retained<AnyObject>> {
    let mut value = None;
    url.getResourceValue_forKey_error(&mut value, key).ok()?;
    value
}

fn resource_bool(url: &NSURL, key: &objc2_foundation::NSURLResourceKey) -> Option<bool> {
    let value = unsafe { resource_object(url, key) }?;
    value.downcast_ref::<NSNumber>().map(NSNumber::as_bool)
}

fn resource_string(url: &NSURL, key: &objc2_foundation::NSURLResourceKey) -> Option<String> {
    let value = unsafe { resource_object(url, key) }?;
    value.downcast_ref::<NSString>().map(ToString::to_string)
}

fn resource_error(url: &NSURL, key: &objc2_foundation::NSURLResourceKey) -> Option<String> {
    let value = unsafe { resource_object(url, key) }?;
    value
        .downcast_ref::<NSError>()
        .map(|error| error.localizedDescription().to_string())
}

fn inspect_url(url: &NSURL) -> ProviderResourceSnapshot {
    // Foundation exports these process-lifetime NSString constants as extern
    // statics. Reading the constants is safe after Foundation has linked.
    unsafe {
        ProviderResourceSnapshot {
            ubiquitous: resource_bool(url, NSURLIsUbiquitousItemKey).unwrap_or(false),
            container_name: resource_string(url, NSURLUbiquitousItemContainerDisplayNameKey),
            download_status: resource_string(url, NSURLUbiquitousItemDownloadingStatusKey),
            downloading: resource_bool(url, NSURLUbiquitousItemIsDownloadingKey).unwrap_or(false),
            uploaded: resource_bool(url, NSURLUbiquitousItemIsUploadedKey),
            uploading: resource_bool(url, NSURLUbiquitousItemIsUploadingKey).unwrap_or(false),
            unresolved_conflicts: resource_bool(url, NSURLUbiquitousItemHasUnresolvedConflictsKey)
                .unwrap_or(false),
            download_error: resource_error(url, NSURLUbiquitousItemDownloadingErrorKey),
            upload_error: resource_error(url, NSURLUbiquitousItemUploadingErrorKey),
            volume_is_local: resource_bool(url, NSURLVolumeIsLocalKey),
            volume_is_removable: resource_bool(url, NSURLVolumeIsRemovableKey),
            volume_is_read_only: resource_bool(url, NSURLVolumeIsReadOnlyKey),
            volume_type: resource_string(url, NSURLVolumeTypeNameKey),
        }
    }
}

pub fn inspect_provider(path: &Path, external_volume_hint: bool) -> MacosFileProviderInfo {
    let inspection_path = if path.exists() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    let value = NSString::from_str(&inspection_path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&value);
    classify_provider(path, &inspect_url(&url), external_volume_hint)
}

fn provider_error(
    code: &str,
    message: impl Into<String>,
    provider_kind: &str,
    retryable: bool,
    recovery_action: &str,
) -> CoordinatedWriteError {
    CoordinatedWriteError {
        code: code.to_string(),
        message: message.into(),
        provider_kind: provider_kind.to_string(),
        retryable,
        recovery_action: recovery_action.to_string(),
    }
}

pub fn provider_readiness_error(provider: &MacosFileProviderInfo) -> Option<CoordinatedWriteError> {
    if provider.volume_is_read_only == Some(true) {
        return Some(provider_error(
            "READ_ONLY_DESTINATION",
            "The provider destination volume is read-only",
            &provider.provider_kind,
            false,
            "save-as",
        ));
    }
    if provider.unresolved_conflicts {
        return Some(provider_error(
            "DESTINATION_CHANGED",
            "The provider reports an unresolved version conflict",
            &provider.provider_kind,
            false,
            "review-provider-conflict",
        ));
    }
    if provider.provider_managed && !provider.materialized {
        return Some(provider_error(
            "PROVIDER_NOT_MATERIALIZED",
            "The provider-backed PDF is not downloaded on this Mac",
            &provider.provider_kind,
            provider.downloading,
            "download-provider-file",
        ));
    }
    if let Some(provider_error_message) = provider
        .download_error
        .as_deref()
        .or(provider.upload_error.as_deref())
    {
        return Some(provider_error(
            "PROVIDER_UNAVAILABLE",
            provider_error_message,
            &provider.provider_kind,
            true,
            "retry-when-provider-online",
        ));
    }
    None
}

fn classify_coordination_error(error: &NSError, provider_kind: &str) -> CoordinatedWriteError {
    let domain = error.domain().to_string();
    let code = error.code();
    let message = error.localizedDescription().to_string();
    let normalized = format!("{domain} {message}").to_ascii_lowercase();
    if normalized.contains("conflict") || normalized.contains("changed") {
        return provider_error(
            "DESTINATION_CHANGED",
            message,
            provider_kind,
            false,
            "review-provider-conflict",
        );
    }
    if normalized.contains("not authenticated")
        || normalized.contains("authentication")
        || normalized.contains("sign in")
    {
        return provider_error(
            "PROVIDER_AUTHENTICATION_REQUIRED",
            message,
            provider_kind,
            false,
            "open-provider-settings",
        );
    }
    if normalized.contains("quota") || normalized.contains("no space") {
        return provider_error(
            "OUT_OF_DISK_SPACE",
            message,
            provider_kind,
            false,
            "free-provider-space",
        );
    }
    if normalized.contains("permission")
        || normalized.contains("not permitted")
        || normalized.contains("access denied")
    {
        return provider_error(
            "SECURITY_SCOPED_ACCESS_REQUIRED",
            message,
            provider_kind,
            false,
            "reselect-destination",
        );
    }
    if normalized.contains("not downloaded") || normalized.contains("evicted") {
        return provider_error(
            "PROVIDER_NOT_MATERIALIZED",
            message,
            provider_kind,
            false,
            "download-provider-file",
        );
    }
    if normalized.contains("busy")
        || normalized.contains("in progress")
        || normalized.contains("temporarily unavailable")
        || normalized.contains("would block")
    {
        let typed_code = if provider_kind == "icloud" {
            "ICLOUD_PROVIDER_BUSY"
        } else {
            "FILE_PROVIDER_BUSY"
        };
        return provider_error(typed_code, message, provider_kind, true, "retry-save");
    }
    if normalized.contains("unavailable")
        || normalized.contains("offline")
        || normalized.contains("network")
        || normalized.contains("server")
        || normalized.contains("connection")
    {
        return provider_error(
            "PROVIDER_UNAVAILABLE",
            message,
            provider_kind,
            true,
            "retry-when-provider-online",
        );
    }
    provider_error(
        "FILE_COORDINATION_FAILED",
        format!("File coordination failed ({domain} {code}): {message}"),
        provider_kind,
        false,
        "save-as",
    )
}

/// Coordinate replacement of one exact destination. `operation` must retain
/// all of its own validation, identity, atomicity, and rollback checks.
pub fn coordinate_replacing<T, F>(
    destination: &Path,
    provider_kind: &str,
    operation: F,
) -> Result<T, CoordinatedWriteFailure>
where
    F: FnOnce(&Path) -> Result<T, String>,
{
    let value = NSString::from_str(&destination.to_string_lossy());
    let url = NSURL::fileURLWithPath(&value);
    let coordinator = NSFileCoordinator::new();
    let operation = RefCell::new(Some(operation));
    let operation_result = RefCell::new(None);
    let writer = StackBlock::new(|coordinated_url: NonNull<NSURL>| {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let coordinated_url = unsafe { coordinated_url.as_ref() };
            let coordinated_path = coordinated_url.path().map(|path| PathBuf::from(path.to_string()));
            let Some(coordinated_path) = coordinated_path else {
                return Err(format!(
                    "{ERROR_PREFIX}|FILE_COORDINATION_FAILED|The coordinated URL has no file path"
                ));
            };
            let Some(operation) = operation.borrow_mut().take() else {
                return Err(format!(
                    "{ERROR_PREFIX}|FILE_COORDINATION_FAILED|The coordinated accessor ran more than once"
                ));
            };
            operation(&coordinated_path)
        }))
        .unwrap_or_else(|_| {
            Err(format!(
                "{ERROR_PREFIX}|FILE_COORDINATION_PANIC|The coordinated replacement accessor panicked"
            ))
        });
        *operation_result.borrow_mut() = Some(outcome);
    });
    let mut coordination_error = None;
    coordinator.coordinateWritingItemAtURL_options_error_byAccessor(
        &url,
        if destination.exists() {
            NSFileCoordinatorWritingOptions::ForReplacing
        } else {
            NSFileCoordinatorWritingOptions::empty()
        },
        Some(&mut coordination_error),
        &writer,
    );
    let operation_result = operation_result.into_inner();
    if let Some(operation_result) = operation_result {
        return operation_result.map_err(CoordinatedWriteFailure::Operation);
    }
    if let Some(coordination_error) = coordination_error {
        return Err(CoordinatedWriteFailure::Coordination(
            classify_coordination_error(&coordination_error, provider_kind),
        ));
    }
    Err(CoordinatedWriteFailure::Operation(format!(
        "{ERROR_PREFIX}|FILE_COORDINATION_FAILED|The coordinated replacement accessor did not run"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_signals_classify_icloud_and_third_party_providers() {
        let ubiquitous = ProviderResourceSnapshot {
            ubiquitous: true,
            download_status: Some("NSURLUbiquitousItemDownloadingStatusCurrent".to_string()),
            volume_is_local: Some(true),
            ..ProviderResourceSnapshot::default()
        };
        let icloud = classify_provider(
            Path::new("/Users/test/Library/Mobile Documents/com~apple~CloudDocs/document.pdf"),
            &ubiquitous,
            false,
        );
        assert_eq!(icloud.provider_kind, "icloud");
        assert!(icloud.provider_managed);
        assert!(icloud.materialized);

        let dropbox = classify_provider(
            Path::new("/Users/test/Library/CloudStorage/Dropbox/document.pdf"),
            &ubiquitous,
            false,
        );
        assert_eq!(dropbox.provider_kind, "file-provider");
        assert!(dropbox.coordination_required);
    }

    #[test]
    fn resource_volume_signals_beat_local_path_heuristics() {
        let external = classify_provider(
            Path::new("/Volumes/External/document.pdf"),
            &ProviderResourceSnapshot {
                volume_is_local: Some(false),
                volume_is_removable: Some(true),
                volume_type: Some("apfs".to_string()),
                ..ProviderResourceSnapshot::default()
            },
            false,
        );
        assert_eq!(external.provider_kind, "external-volume");
        assert!(!external.provider_managed);
    }

    #[test]
    fn cloud_only_and_conflicted_items_fail_closed_with_typed_recovery() {
        let cloud_only = classify_provider(
            Path::new("/Users/test/Library/CloudStorage/OneDrive/document.pdf"),
            &ProviderResourceSnapshot {
                ubiquitous: true,
                download_status: Some(
                    "NSURLUbiquitousItemDownloadingStatusNotDownloaded".to_string(),
                ),
                ..ProviderResourceSnapshot::default()
            },
            false,
        );
        let failure = provider_readiness_error(&cloud_only).expect("cloud-only error");
        assert_eq!(failure.code, "PROVIDER_NOT_MATERIALIZED");
        assert_eq!(failure.recovery_action, "download-provider-file");
        assert!(!failure.retryable);

        let mut conflicted = cloud_only;
        conflicted.materialized = true;
        conflicted.unresolved_conflicts = true;
        let failure = provider_readiness_error(&conflicted).expect("conflict error");
        assert_eq!(failure.code, "DESTINATION_CHANGED");
        assert!(!failure.retryable);
    }

    #[test]
    #[ignore = "NSFileCoordinator accessor execution is qualified in the packaged macOS app"]
    fn local_coordination_invokes_the_exact_destination_accessor() {
        let destination = std::env::temp_dir().join("opds-file-coordinator-unit.pdf");
        std::fs::write(&destination, b"original").expect("write destination");
        let coordinated = coordinate_replacing(&destination, "local", |path| {
            assert_eq!(path, destination);
            Ok(path.to_path_buf())
        })
        .expect("coordinate local replacement");
        assert_eq!(coordinated, destination);
        std::fs::remove_file(destination).expect("clean destination");
    }

    #[test]
    #[ignore = "NSFileCoordinator accessor execution is qualified in the packaged macOS app"]
    fn accessor_errors_are_returned_without_code_normalization() {
        let destination = std::env::temp_dir().join("opds-file-coordinator-error-unit.pdf");
        std::fs::write(&destination, b"original").expect("write destination");
        let failure = coordinate_replacing::<(), _>(&destination, "icloud", |_path| {
            Err("OPDS_SAFE_SAVE|DESTINATION_CHANGED|external edit".to_string())
        })
        .expect_err("accessor must fail");
        assert_eq!(
            failure,
            CoordinatedWriteFailure::Operation(
                "OPDS_SAFE_SAVE|DESTINATION_CHANGED|external edit".to_string()
            )
        );
        std::fs::remove_file(destination).expect("clean destination");
    }
}
