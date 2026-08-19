# Production invisible OCR writer and safe macOS save

Date: 2026-08-17
Branch: `ocr-searchable-layer`
Production platform: macOS only
Proof artifact: `output/pdf/open-pdf-studio-ocr-writer-proof.pdf`

## Phase boundary

The approved proof implementation is now the single production writer used by the normal macOS Save and Save As path. The proof filename and compatibility exports remain in place to preserve lineage; there is no parallel ownership contract. This phase does not add visible scanned-text editing, final OCR controls, or a Windows/Linux production claim. OCR is never routed through the legacy white-patch text-edit path.

## Writer contract

- Each eligible page receives exactly one application-owned indirect content stream. The stream enters a saved graphics state, begins one text object, sets text rendering mode `3` once, writes canonical `Tm`/`Tj` pairs in contiguous declared reading order, and restores graphics state.
- Line geometry is written from canonical PDF-default-user-space baselines. Optional word polygons produce monotonic word-level matrices along their line baseline. Ambiguous, out-of-bounds, non-finite, non-contiguous, or unsafe geometry fails closed.
- The application layer may produce a deterministic estimated baseline only for an elongated, predominantly horizontal four-point line polygon. The immutable engine result continues to record `baseline.status = "unavailable"`; the estimate is separately typed with `provenance = "estimated"`. Square, vertical, and ambiguous geometry remains unsupported.
- Text uses the approved Liberation Sans Regular font as an embedded `/Type0` `/Identity-H` font with one `/CIDFontType2` descendant and a valid indirect `/ToUnicode` CMap. Generated `bfchar` blocks are capped at 100 mappings. The approved font SHA-256 is `f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f`.
- Missing glyphs fail with `MISSING_GLYPH`. Explicit non-LTR direction and inferred right-to-left script text fail with `UNSUPPORTED_TEXT_DIRECTION`. Vertical and complex writing systems have no production claim in this phase.
- `/PieceInfo /OpenPDFStudioOCR` stores `Owner`, schema version `1`, writer version `invisible-unicode-v1`, owned stream and font references, resource name, font digest, content digest, and modified time. The owned stream and font carry matching private markers.
- Update and removal validate all ownership markers, references, hashes, resource mappings, and the exactly-once stream occurrence before mutation. Updating replaces the stream at its existing `/Contents` position. Explicit removal deletes only application-owned references and metadata. Pages absent from current typed state are preserved after reopen unless explicitly marked for removal.
- Native, third-party searchable text, content streams, resources, and unrelated PieceInfo entries are preserved. A full font object may remain unreachable after removal; object compaction is intentionally not attempted because it is not reference-safe.

## Candidate validation before replacement

The destination is untouched while the candidate is built and checked.

1. The writer builds candidate bytes in memory, then also builds a repeated-write candidate and a remove-all-owned candidate.
2. PDF.js reopens the baseline-without-owned-layer, candidate, repeated candidate, and removed candidate. It verifies page count, selected token counts, deterministic order, duplicate absence, repeated-write extraction identity, removal restoration, and ownership structure. The already-open candidate PDF.js document is retained for the post-save cache swap.
3. The native layer stages candidate and validation-baseline bytes in private mode-`0600` files beside the destination, verifies their lengths and SHA-256 digests, and reopens the first, middle, and last affected pages (up to three) with the packaged PDFium runtime.
4. PDFium verifies page count, selected token counts, and visible RGBA pixels at scale `2`. The production tolerance is deliberately exact: `maxChangedPixelsPerPage = 0` and `maxChannelDelta = 0`. The native transaction refuses to finalize an OCR candidate until its PDFium reopen has completed successfully.
5. Any PDF.js, ownership, idempotence, removal, PDFium, text, digest, or pixel failure rejects the transaction. Private files are cleaned and the destination, cached bytes, PDF.js handle, PDFium caches, and typed OCR persisted state remain unchanged.

## Native macOS replacement

`macos_safe_save.rs` owns the replacement transaction.

- The destination must be an absolute regular non-symlink path inside the granted Tauri filesystem scope. The macOS bundle declares user-selected read/write access; Save As reacquires access when the OS or Tauri scope no longer permits the original path.
- Candidate and optional validation-baseline files are created in the destination directory, guaranteeing a same-volume operation. The directory is synchronised before mutation so unsupported providers fail while the original is untouched.
- Before replacement, the candidate digest and size are rechecked, contents are flushed with `sync_all` and macOS `F_FULLFSYNC` where supported, original permissions are copied, and safe ACL/extended metadata are copied with `fcopyfile`. Immutable/append-only flags are not copied onto the candidate.
- Existing files are atomically exchanged with `renameatx_np(..., RENAME_SWAP)`. The new destination is reverified and the parent directory is flushed before the old file is removed. A post-swap failure swaps the original back; if rollback itself fails, the old bytes are retained as a named private recovery file instead of being deleted.
- Save As atomically renames the same-directory candidate to a new destination and rolls it back on post-rename verification failure. New files use mode `0644`.
- Abort and all pre-replacement failures remove private candidate/baseline files and flush directory metadata. Once a new destination is verified and durable, a failure to delete the old private file is reported as a recovery-file warning rather than falsely reporting that the save failed.
- The live application updates the active path, cached bytes, validated PDF.js document, PDFium/path caches, and persisted OCR ownership state only after native replacement succeeds. A subsequent UI refresh error reports that the file was saved and asks the user to reopen it.

## Explicit document and storage policy

| Condition | Production behavior |
|---|---|
| Tauri scope or macOS access denied | Reject before replacement with an explicit access error and direct the user to choose the file again with Save As. |
| iCloud Drive | Classified explicitly. The same-directory and directory-flush requirements still apply; provider-busy errors are reported as `ICLOUD_PROVIDER_BUSY`. No non-atomic fallback is used. |
| External volume | Classified explicitly. Cross-device or unsupported atomic operations fail closed; no copy-overwrite fallback is used. |
| Read-only, Finder-locked, symlink, non-file, or concurrently replaced destination | Reject before replacement or identity recheck. Packaged testing confirms a mode-`0444` destination remains byte-identical and leaves no candidates. |
| Failed atomic replacement | Preserve or roll back the original. A rollback failure retains a recovery file and returns a distinct fatal error. |
| Encrypted/password-protected PDF | Reject before mutation with `ENCRYPTED_PDF_UNSUPPORTED`; the production writer does not decrypt or rewrite encrypted input. |
| Signed PDF | Warn that any modification invalidates signatures and force Save As to a different path, preserving the signed original. Signature dictionaries, signature fields, and catalog permissions are inspected. The native layer rejects alternate paths and hard links that resolve to the protected original inode. |
| PDF/A | Force Save As, warn that edited output is converted to standard PDF, and remove PDF/A identification markers from XMP. If conversion markers cannot be decoded or removed, fail closed. The original remains unchanged. |
| Malformed PDF | Reject during policy inspection, writer load, or PDF.js/PDFium reopen before replacement. |
| Out of disk space or quota | Return `OUT_OF_DISK_SPACE`, clean private files, and leave the original untouched. |

The current release bundle is not App-Sandboxed, but the user-selected read/write entitlement and Tauri filesystem scope are both present. Live iCloud-provider and removable-volume hardware were not available for this run; their native failure classifications and fail-closed paths are covered by Rust tests, while local packaged Save, Save As, metadata preservation, rollback injection, and read-only failure were exercised directly.

## Verification evidence

The following evidence was run on macOS from the packaged production application or the same production modules:

| Gate | Result |
|---|---|
| Writer proof | Passed write, repeat, targeted removal, full removal, ownership, third-party preservation, Unicode, and deterministic order checks. Two consecutive runs produced the same 167,154-byte artifact with SHA-256 `e7f01dc9255255229929fed98cc3fd97358cfccb7c48c6ef48e309770a36b751`. |
| `npm run test:ocr` | 123 passed, including production candidate, typed-state baseline, missing glyph, implicit/explicit direction, signed, encrypted, malformed, spoofed ownership, and PDF/A conversion cases. |
| `npm run test:unit` | 87 passed. |
| `npm run typecheck` | Passed. |
| Rust safe-save unit tests | 8 passed: permissions/metadata behavior, in-place rollback, Save As rollback, concurrent destination preservation, storage/error classifications, candidate tamper rejection, protected-original alias rejection, and mandatory PDFium validation. |
| Packaged macOS Save and Save As | Passed in-place Save, Save As, reopen, mode preservation, xattr preservation, candidate cleanup, and read-only original preservation. |
| PDF.js reopen | Passed exact extraction for the proof, repeat/remove variants, packaged Save, and packaged Save As. |
| PDFium reopen | Passed exact extraction/order and zero-pixel-change comparisons for proof variants and packaged output. |
| Apple Preview reopen | Packaged Save As output reopened as two pages; accessibility exposed application OCR plus preserved third-party text; Unicode search `Résumé: élève, déjà vu.` returned exactly one match on one page. |
| Visible-pixel regression | PDFium at scale `2` reported zero changed pixels and zero channel delta. Poppler at 144 DPI produced page-identical SHA-256 hashes for source, packaged Save, and packaged Save As. |
| `git diff --check` | Passed. A separate trailing-whitespace scan covered the untracked production files. |

The release `.app` bundle was produced and used for packaged tests. The verification build was deliberately app-only, unsigned, and created with updater artifacts disabled; distribution signing, notarization, DMG creation, and updater publication are outside this phase.

MACOS PRODUCTION INVISIBLE WRITER AND SAFE SAVE GO
