# macOS searchable OCR audit record

- Date: 2026-08-18
- Branch: `ocr-searchable-layer`
- Production platform: macOS only
- Decision: `MACOS SEARCHABLE OCR NO-GO`

## Production blocker

**FAIL — production entry point.** `OcrApplicationController.startDocumentJob` has no non-test caller, and production code does not construct a controller and start a document job. The application therefore has no user-reachable path that takes native recognition output through `applyOcrPageResult` into the typed `doc.ocr` state.

**FAIL — downstream production workflow.** Search before and after save/reopen, copy, zoom, rotation, and view-mode checks cannot pass through the production application because their OCR state-producing path is unreachable. These failures are consequences of the missing production workflow, not evidence of independent defects in those consumers.

**FAIL — user cancellation.** `startDocumentJob` returns the job handle needed for cancellation, but no production UI retains that handle and invokes cancellation. The document-close hook is cleanup behavior and does not make a user Cancel action reachable.

## Repository state

- `HEAD` is `afd5911a` and matches `origin/ocr-searchable-layer`; the committed branch contains the searchable-layer orchestration/state work but not the writer/save work.
- Step 11 writer proof: **local artifacts only, uncommitted**. The proof document, writer, tests, fixture/runner, and PDFium proof test are untracked, and the writer paths have no commit in current `--all` history.
- Step 12 production writer/save: **uncommitted**. Its production integration is split between tracked working-tree modifications and untracked writer, persistence, safe-save, test, and packaged-test files. It is not present in `HEAD`.

## Criteria already passed

- **PASS — writer idempotence:** repeat writes replace the single owned stream without duplicate searchable text; targeted and full removal pass.
- **PASS — Unicode and ToUnicode:** the invisible Type 0/CIDFont writer embeds a valid ToUnicode map and preserves the tested Unicode text.
- **PASS — reopen:** PDF.js and PDFium reopen/extraction pass; Apple Preview reopen/search evidence also passes.
- **PASS — visible-pixel preservation:** PDFium exact RGBA comparison and the recorded Poppler comparison report no visible change.
- **PASS — atomic replacement:** in-place Save and Save As replacement, rollback, tamper/concurrency rejection, permissions/metadata preservation, and candidate cleanup pass.
- **PASS — ownership:** owned-stream markers, hashes, resource references, replacement, removal, and preservation of native/third-party content pass.
- **PASS — cache:** validated private cache envelopes, complete cache identities, corruption rejection, invalidation, atomic writes, and bounded pruning pass.
- **PASS — undo:** typed OCR apply/remove undo and redo restore searchable text, ownership, dirty state, and removal state.
- **PASS — benchmark:** the approved macOS quality benchmark meets its unchanged thresholds.
- **PASS — packaged arm64:** packaged macOS arm64 recognition, cancellation, offline, checksum, sidecar/PDFium architecture, and viewer-responsiveness gates pass.
- **PASS — memory behavior:** isolated-child cleanup, no surviving child, retained-RSS limit, and growth-per-cycle limit pass across the recorded recognition/cancellation cycles.

## Environment-only unverified items

- **UNVERIFIED — native Intel GUI execution:** universal inputs are architecture-checked, but no real Intel Mac was available.
- **UNVERIFIED — Acrobat for macOS reopen:** Acrobat was not available in the audit environment.
- **UNVERIFIED — live iCloud provider behavior:** fail-closed paths are unit-covered, but no live provider exercise was available.
- **UNVERIFIED — live removable/external-volume behavior:** fail-closed paths are unit-covered, but no mounted test volume was available.

Windows and Linux qualification is outside this macOS production decision and is not counted as unverified evidence for this gate.

## Corrective decision

Implement the production recognition/review workflow on a stacked `ocr-review` branch, including controller lifetime, the production `startDocumentJob` caller, job-handle retention, and user cancellation. Then run one combined Milestone 1 audit across the complete reachable macOS workflow.

`MACOS SEARCHABLE OCR NO-GO`
