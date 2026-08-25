# macOS release-hardening evidence

This record covers Open PDF Studio 1.85.0 on the
`ocr-release-hardening` working tree on 2026-08-24. It distinguishes local
hardened-runtime evidence from identity-backed distribution evidence.

## Packaged artifact

| Criterion | Status | Evidence |
| --- | --- | --- |
| arm64 `.app` packaging | PASS | The packaged main executable and worker are arm64; bundle identifier `org.openaec.openpdfstudio`, version 1.85.0. |
| Universal sidecar validation | PASS | Thin arm64 and x86_64 workers and the combined universal worker passed Mach-O architecture validation. |
| Universal PDFium probes | PASS | Universal PDFium contains arm64 and x86_64; both universal worker slices initialized it under hardened runtime. |
| Hardened runtime compatibility | PASS | A temporary copy was signed with hardened runtime, the worker received the narrow library-validation entitlement, PDFium initialized, and the packaged MCP smoke passed. |
| Code-signing validation | PASS | The local ad-hoc artifact and its worker and PDFium code objects passed strict on-disk signature validation with hardened runtime enabled. |
| Intentional minimal entitlements | PASS | The app has its declared WebView, PDFium, file-selection, and network entitlements; the worker has only `disable-library-validation`; PDFium has none. The final bundle is re-signed bottom-up before any credential-backed notarization submission. |
| Developer ID signing | UNVERIFIED | This Mac had zero valid Developer ID identities. Ad-hoc signing is not distribution-signing evidence. |
| Notarization | UNVERIFIED | No identity-backed artifact was submitted to Apple. Release and nightly workflows use App Store Connect API credentials, bounded transient-service retry, stapling, and a required post-notarization gate. |
| Gatekeeper assessment | UNVERIFIED | Gatekeeper rejection of an ad-hoc artifact is expected. The distribution gate requires a real Developer ID artifact, a valid stapled ticket, and `spctl` acceptance. |
| Bundled models and checksums | PASS | Detection, recognition, character-map, ONNX Runtime WASM, and loader assets matched the pinned sizes and SHA-256 values in source and production build output. |
| Cache and application-data cleanup | PASS | The managed OCR cache pair and temporary files were removed while an unrelated application-data file was preserved. |
| Installer-size measurement | PASS | App: 88,674,382 logical bytes and 86,628 allocated KiB. Temporary unsigned compressed DMG: 60,371,274 bytes. The measurement DMG was deleted. |
| Complete packaged UI/reader suite in this run | PASS | Every stage was pinned to the fresh arm64 bundle. The 20-criterion production workflow, safe save, single-line editing, fixed-region editing, bounded reflow, search/copy, undo/redo, repeated save, Apple Preview, PDF.js, and PDFium checks passed from an unlocked interactive session. |
| Temporary-artifact cleanup | PASS | Temporary bundle copies and DMGs were removed; generated machine evidence and disk images are ignored and are not release source. |

The local result is intentionally `UNVERIFIED`, not `PASS`, because Developer
ID signing, Apple notarization, and Gatekeeper distribution acceptance require
a real release artifact and credentials that were unavailable on this Mac.
The release workflow uses `--require-distribution-trust`, which turns any of
those missing or rejected conditions into a failing release job.

## Controlled filesystem transactions

| Criterion | Status | Evidence |
| --- | --- | --- |
| Permission-locked destination | PASS | A read-only destination rejected save and preserved its SHA-256 bytes with no private candidate left behind. |
| Finder lock flag | PASS | A live `uchg` lock rejected save, preserved the original, and cleaned candidates. |
| Advisory file lock | PASS | A separate Swift process held a real exclusive `flock`; save rejected without modifying the original. |
| APFS external-volume behavior | PASS | A dynamically created, separately mounted APFS image passed save, repeated save, PDF reopen, atomic replacement, locked-original preservation, and candidate cleanup. No non-atomic fallback was used. |
| Disk-full behavior | PASS | A 64 MiB APFS image was filled until a real `ENOSPC` after 63,963,136 bytes. Save rejected and preserved the original with no candidate residue. |
| exFAT behavior | UNVERIFIED | `hdiutil create` returned `Operation not permitted`. No exFAT image mounted and no transaction or fallback claim was made. |
| External-volume fallback and preservation | UNVERIFIED | APFS atomic replacement and preservation passed, but the exFAT-specific branch could not be exercised on this host. No non-atomic fallback was observed or enabled. |
| iCloud Drive provider transaction | PASS | The live folder was confirmed as an uploaded ubiquitous provider root. A real PDF save completed, the provider confirmed the item uploaded, the PDF reopened, and the temporary provider directory was deleted. |
| Filesystem cleanup | PASS | Temporary images were created dynamically, mounted images detached, disk images and isolated application data deleted, and the iCloud test directory removed. |

Tests must continue to create capacity-limited images dynamically. Disk images,
mount paths, provider paths, signing identities, and generated JSON reports are
machine evidence and must not be committed. When an iCloud account or confirmed
provider root is unavailable, the test performs no provider transaction and
reports `UNVERIFIED`; it never substitutes a local folder.
