# macOS OCR and Scanned-PDF Editing Implementation Guide

This is the operational implementation guide for adding searchable OCR and scanned-PDF editing to Open PDF Studio with **macOS as the only active production platform**.

The current platform policy is:

- macOS arm64 is the live production target.
- Universal arm64/x86_64 packaging remains a compatibility deliverable.
- Native Intel certification remains provisional until the application is tested on real Intel hardware.
- Windows and Linux are deferred, non-blocking future work.
- Existing Windows/Linux scaffolding should be preserved when harmless, but it must not be expanded, tested, or advertised as production support during this work.
- PaddleOCR PP-OCRv6 Small is the approved macOS primary engine.
- Tesseract remains an unbenchmarked future fallback.

The packaged macOS arm64 Phase A gate has already passed its recognition, cancellation, memory, offline, cleanup, and viewer-responsiveness criteria. The desktop-wide evaluator may still report `EVALUATION GO, PRODUCTION NO-GO` because it requires Windows and Linux evidence. Use the separate macOS-scoped decision for this project scope. See [Phase A decision](phase-a/GO-NO-GO.md) and [memory remediation](phase-a/MEMORY_REMEDIATION.md).

## Model selection

Use these Codex configurations:

| Work | Model | Effort |
| --- | --- | --- |
| OCR engine, process isolation, coordinates, PDF streams, safe saving, audits, and scanned-text editing | `gpt-5.6-sol` | `max` |
| Job state, undo, cache, and model-pack integration | `gpt-5.6-sol` | `xhigh` |
| OCR UI, packaging documentation, and release notes | `gpt-5.6-terra` | `high` |
| Repetitive mechanical work only | `gpt-5.6-luna` | `medium` or `high` |

Do not substitute Terra or Luna for the coordinate, PDF-writing, save-integrity, process-lifetime, or visible-editing phases.

## Branch sequence

Use these branches in order:

1. `ocr-foundation`
2. `ocr-searchable-layer`
3. `ocr-review`
4. `ocr-edit-single-line`
5. `ocr-edit-regions`
6. `ocr-reflow`
7. `ocr-release-hardening`

Push branches to `origin`, which is the personal fork. Do not push directly to `upstream`.

Create a new branch only after the prior branch:

1. passes its acceptance gate;
2. is committed and pushed;
3. has been reviewed;
4. is merged into the appropriate `main` branch.

Never implement OCR directly on `main`.

## Standard checkpoint after every prompt

Before committing any implementation prompt, paste the following checkpoint prompt using the same model as the implementation prompt:

```text
Plan checkpoint:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Current phase: [phase just completed]
- Current branch: [branch name]
- Next phase: [next phase]

Do not edit files and do not commit.

Inspect the complete working-tree diff and run the relevant tests. Also run git diff --check.

Report:

- files changed by this phase;
- files that existed before this phase;
- tests passed;
- tests failed;
- macOS acceptance criteria passed;
- macOS acceptance criteria unverified;
- unrelated changes detected;
- Windows/Linux changes detected;
- exact file paths that should be staged for this phase;
- risks that must be fixed before continuing.

Do not recommend moving forward unless the current macOS phase is independently testable. Do not require Windows or Linux evidence.
```

After the checkpoint passes:

```bash
git status --short
git diff --check
git add <exact-files-approved-by-the-checkpoint>
git commit -m "<commit-message-listed-for-the-step>"
git push
```

Do not use `git add .`. Do not amend already-pushed commits; create a new fix commit instead.

## Step 1: Record the macOS production scope

**Branch:** `ocr-foundation`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Do not create another branch. Preserve all existing Phase A work in the current working tree.

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 1 — Searchable OCR
- Phase: Phase A — macOS production-scope confirmation
- Branch: ocr-foundation
- This prompt’s scope: Convert the passing macOS Phase A evidence into an explicit macOS-only production gate and document the revised product scope.
- Previous gate: Packaged macOS arm64 passed ten recognition cycles, ten cancellation cycles, memory limits, offline enforcement, resource cleanup, and viewer responsiveness.
- Next gate: Promote the Phase A contracts and isolated child pipeline into production OCR foundations.
- Out of scope: Windows/Linux production qualification, OCR UI, searchable PDF writing, visible editing, paragraph reflow, handwriting, and table editing.

Follow the approved implementation plan. Implement only this phase.

The product scope has changed. Open PDF Studio will support OCR in production on macOS only for now.

Inspect the current Phase A implementation and reports. Do not rerun or recreate work that already passed.

Create a distinct macOS-scoped decision that can report:

- MACOS PRODUCTION GO;
- MACOS PRODUCTION NO-GO.

The macOS decision must require:

- a packaged release .app;
- macOS arm64 live execution;
- ten recognition cycles;
- ten cancellation cycles;
- a unique disposable OCR child per job;
- no surviving child;
- no more than 32 MiB settled retained RSS;
- no more than +2 MiB per-cycle growth;
- exact golden-fixture text;
- offline enforcement;
- stale-result rejection;
- viewer responsiveness;
- resource cleanup;
- model and dependency checksum verification;
- valid macOS sidecar architecture;
- PDFium initialization.

Keep the existing all-desktop evaluator intact for possible future use. Do not change its meaning or falsely report all-desktop production readiness.

Document clearly:

- macOS arm64 is the current production target;
- universal arm64/x86_64 packaging is built and architecture-checked;
- native Intel GUI certification remains unverified without real Intel hardware;
- Windows and Linux are deferred and are not current release blockers;
- no production support claim is made for Windows or Linux;
- PaddleOCR remains the macOS primary engine;
- Tesseract remains an unbenchmarked future fallback.

Preserve existing Windows/Linux scaffolding if it is harmless. Do not expand, refactor, or delete it merely because it is deferred. Make Windows/Linux CI jobs non-blocking for the macOS OCR release if they currently block it.

Run the macOS-scoped evaluator against the existing packaged macOS report. Do not alter measured evidence to make it pass.

Report:

- the exact macOS decision;
- files changed;
- tests run;
- whether existing cross-platform scaffolding was left unchanged;
- exact files that belong in the Phase A commit.

Do not implement later OCR phases.
```

After the checkpoint passes:

```bash
git add <exact-Phase-A-files-reported-by-the-checkpoint>
git commit -m "ocr: approve macOS Phase A production gate"
git push -u origin ocr-foundation
```

Do not open the foundation pull request yet. Continue through Step 4 on this branch.

## Step 2: Promote the Phase A contracts

**Branch:** `ocr-foundation`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 1 — Searchable OCR
- Phase: Phase A — Production OCR contracts
- Branch: ocr-foundation
- This prompt’s scope: Promote and extend the existing Phase A contracts into stable production contracts.
- Previous gate: MACOS PRODUCTION GO is recorded and PaddleOCR is approved as the macOS primary engine.
- Next gate: Production macOS OCR scheduling and canonical coordinate transforms.
- Out of scope: Windows/Linux implementation, UI, PDF writing, visible editing, paragraph reflow, handwriting, and tables.

Follow the approved implementation plan. Implement only this phase.

Inspect and reuse the existing Phase A OCR engine and result v1 schemas. Do not create duplicate parallel contracts.

Promote or extend them to support:

- engine capabilities;
- macOS model-pack manifests;
- OCR jobs and progress;
- document and page identity;
- page status;
- blocks;
- lines;
- optional words;
- confidence;
- alternatives;
- language and writing direction;
- warnings and unsupported-content reasons;
- preprocessing metadata;
- page transforms;
- review corrections;
- future visible OCR edit regions;
- schema versioning and migration.

Line polygons must be mandatory. Word polygons must remain optional. Never fabricate word geometry when the engine only returns line geometry.

Add strict runtime validation for:

- malformed polygons;
- NaN or infinite coordinates;
- invalid confidence;
- invalid Unicode;
- unsupported schema versions;
- missing model metadata;
- oversized results;
- incompatible model packs.

Keep the existing Phase A fixtures and add only the cases necessary for production contract coverage.

Do not modify Windows or Linux platform code. Do not add UI, PDF writing, or visible editing.

Run unit tests and report which Phase A contracts were reused, extended, or replaced.
```

After the checkpoint passes:

```bash
git add <exact-contract-files>
git commit -m "ocr: promote production OCR contracts"
git push
```

## Step 3: Promote the isolated macOS OCR pipeline

**Branch:** `ocr-foundation`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 1 — Searchable OCR
- Phase: Phase A — Production macOS OCR pipeline
- Branch: ocr-foundation
- This prompt’s scope: Promote the passing disposable-child Phase A path into a stable production OCR controller.
- Previous gate: Production OCR contracts pass.
- Next gate: Canonical coordinate transforms.
- Out of scope: Windows/Linux implementation, searchable PDF writing, OCR UI, visible editing, paragraph reflow, handwriting, and tables.

Follow the approved implementation plan. Implement only this phase.

Reuse the passing macOS Phase A architecture:

- the editor requests a low-priority PDFium raster;
- the parent writes a private mode-0600 job envelope;
- one disposable child instance of the Open PDF Studio executable owns one OCR Worker;
- the child performs one recognition or cancellation job;
- the child returns validated result JSON;
- the child exits;
- process exit is the hard WebKit memory-reclamation boundary.

Promote this into a stable production controller without restoring inference to the editor’s long-lived WebContent process.

Implement:

- stable production command names and interfaces;
- one-page-at-a-time scheduling;
- low-priority PDFium routing;
- annotation-free rasterization;
- 300 DPI default;
- actual raster width and height;
- configurable pixel and maximum-side limits;
- transferable RGBA buffers;
- orientation preprocessing;
- deskew preprocessing;
- exact preprocessing metadata;
- cancellation;
- stale-result rejection;
- private temporary-file cleanup;
- application-close cleanup;
- child crash recovery;
- macOS app-bundle executable discovery;
- arm64 and universal sidecar validation.

Keep the Phase A harness available as a regression test around the production controller.

Do not add Windows/Linux runtime behavior. Do not add PDF writing or end-user UI.

Run:

- unit tests;
- Rust tests;
- packaged macOS arm64 recognition;
- cancellation;
- repeated-cycle memory tests;
- concurrent viewer responsiveness;
- universal sidecar architecture and PDFium probes.

Report peak memory, settled memory, latency, cancellation behavior, and child cleanup.
```

After the checkpoint passes:

```bash
git add <exact-production-pipeline-files>
git commit -m "ocr: promote isolated macOS OCR pipeline"
git push
```

## Step 4: Canonical coordinate transforms

**Branch:** `ocr-foundation`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 1 — Searchable OCR
- Phase: Phase A — Canonical OCR coordinate system
- Branch: ocr-foundation
- This prompt’s scope: Implement one authoritative OCR-pixel-to-PDF transform.
- Previous gate: The production macOS isolated OCR pipeline passes.
- Next gate: Pending searchable OCR and invisible PDF writing.
- Out of scope: Windows/Linux implementation, UI, visible editing, paragraph reflow, handwriting, and tables.

Follow the approved implementation plan. Implement only this phase.

Implement one shared OCR coordinate system supporting:

- MediaBox;
- CropBox;
- non-zero page origins;
- PDF UserUnit;
- intrinsic PDF rotation;
- application page rotation;
- actual raster dimensions;
- DPI;
- orientation preprocessing;
- deskew homographies;
- OCR quadrilaterals;
- OCR baselines;
- PDF-space polygons;
- inverse transforms for macOS UI highlighting.

Preserve quadrilaterals and baselines. Axis-aligned rectangles may be derived for UI convenience but must not become authoritative geometry.

Use the same transform implementation for:

- OCR overlays;
- search highlighting;
- invisible PDF writing;
- later visible OCR editing.

Add deterministic and property-based tests covering all rotations, page-box origins, UserUnit values, deskew angles, and randomized page dimensions.

Require round-trip error below 0.25 PDF points.

Do not add UI or PDF writing yet.
```

After the checkpoint passes:

```bash
git add <exact-coordinate-files>
git commit -m "ocr: add canonical OCR coordinate transforms"
git push
```

Open and merge the `ocr-foundation` pull request before continuing.

## Step 5: Create the searchable-layer branch

If the foundation branch was merged into `origin/main`:

```bash
git switch main
git pull --ff-only origin main
git switch -c ocr-searchable-layer
```

If it was merged into `upstream/main`:

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
git switch -c ocr-searchable-layer
```

## Step 6: Pending searchable OCR

**Branch:** `ocr-searchable-layer`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 1 — Searchable OCR
- Phase: Phase B — Pending searchable text layer
- Branch: ocr-searchable-layer
- This prompt’s scope: Make recognized text searchable, selectable, and correctable before saving.
- Previous gate: Production contracts, isolated OCR pipeline, and coordinate transforms pass on macOS.
- Next gate: Invisible PDF persistence and macOS-safe saving.
- Out of scope: Windows/Linux implementation, visible scanned-text editing, paragraph reflow, handwriting, and tables.

Follow the approved implementation plan. Implement only this phase.

Integrate OCR results into document state and the existing PDF.js text/search architecture.

Add:

- per-document OCR state;
- per-page OCR revisions;
- synthetic transparent OCR spans;
- stable OCR IDs;
- language and writing-direction attributes;
- search support for unsaved OCR;
- copy and selection support;
- confidence highlighting;
- affected-page cache invalidation;
- existing-text detection;
- default skip behavior;
- force rerun that replaces only Open PDF Studio-owned OCR.

Never delete or replace unknown native or third-party text layers.

Add macOS UI-level integration tests for selection, copying, zooming, page rotation, and search navigation.

Do not write OCR into PDFs yet. Do not add visible scanned-text editing.
```

Commit and push:

```bash
git add <exact-searchable-layer-files>
git commit -m "ocr: integrate pending searchable text"
git push -u origin ocr-searchable-layer
```

## Step 7: Invisible PDF writer and macOS-safe save

**Branch:** `ocr-searchable-layer`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 1 — Searchable OCR
- Phase: Phase B — Invisible PDF OCR writer and safe macOS saving
- Branch: ocr-searchable-layer
- This prompt’s scope: Persist OCR as a valid invisible Unicode layer and save safely on macOS.
- Previous gate: Pending search, selection, skip, rerun, and coordinate tests pass.
- Next gate: Undo, progress, cache, and model packs.
- Out of scope: Windows/Linux save behavior, visible editing, paragraph reflow, handwriting, and tables.

Follow the approved implementation plan. Implement only this phase.

Create one application-owned invisible OCR content stream per page.

The writer must:

- use PDF text rendering mode 3;
- preserve reading order;
- write baselines and text matrices;
- support line boxes and optional word boxes;
- embed Unicode Type 0 fonts;
- generate valid ToUnicode maps;
- use approved Noto fonts and fontkit;
- store versioned private PieceInfo metadata;
- record the owned stream reference;
- remain idempotent;
- preserve native and third-party text layers.

Do not reuse the legacy white-rectangle visible-text writer.

Implement macOS-safe saving:

1. Build candidate bytes.
2. Reopen with PDF.js.
3. Validate page count and sampled OCR tokens.
4. Reopen selected pages through PDFium.
5. Compare visible pixels.
6. Write a same-volume temporary file.
7. Flush file contents and required directory metadata.
8. Atomically replace the destination.
9. Preserve the original if validation or replacement fails.
10. Preserve file permissions and macOS metadata where safely possible.

Handle:

- sandbox or security-scoped file access;
- iCloud Drive and external-volume failures;
- locked destinations;
- signed PDFs;
- encrypted PDFs;
- password-protected PDFs;
- failed atomic replacement.

Validate outputs in PDF.js, PDFium, Apple Preview, and Acrobat for macOS where available.
```

Commit:

```bash
git add <exact-writer-and-save-files>
git commit -m "ocr: add invisible PDF text writer"
git push
```

## Step 8: Undo, progress, cache, and macOS model packs

**Branch:** `ocr-searchable-layer`  
**Model:** `gpt-5.6-sol`  
**Effort:** `xhigh`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 1 — Searchable OCR
- Phase: Phase B — Job state, undo, cache, and model packs
- Branch: ocr-searchable-layer
- This prompt’s scope: Make macOS OCR jobs cancellable, undoable, cacheable, and reusable offline.
- Previous gate: Searchable OCR and macOS-safe PDF writing pass.
- Next gate: Recognition dialog and OCR review UI.
- Out of scope: Windows/Linux paths, visible editing, paragraph reflow, handwriting, and tables.

Follow the approved implementation plan. Implement only this phase.

Add:

- queued, rasterizing, preprocessing, recognizing, validating, applying, skipped, error, and cancelled states;
- weighted progress;
- cancellation through the disposable macOS OCR child;
- document-close cancellation;
- stale-job rejection;
- compound apply-OCR undo;
- remove-OCR undo;
- keep-completed-pages behavior;
- compressed OCR-result caching;
- document/page/model/config cache keys;
- page-level invalidation;
- 1 GB LRU default;
- cache clearing;
- bundled core model assets;
- explicit optional model-pack downloads;
- signed manifests;
- SHA-256 verification;
- atomic model installation;
- archive traversal and expanded-size checks;
- offline reuse.

Use the Tauri-resolved macOS application-data directory. Do not hardcode a home-directory path.

Never cache raw page rasters permanently. Do not add Windows or Linux storage logic.
```

Commit:

```bash
git add <exact-state-cache-and-model-files>
git commit -m "ocr: add macOS job state cache and undo"
git push
```

Open and merge the `ocr-searchable-layer` pull request before continuing.

## Step 9: Create the OCR review branch

```bash
git switch main
git pull --ff-only origin main
git switch -c ocr-review
```

## Step 10: macOS OCR UI and review panel

**Branch:** `ocr-review`  
**Model:** `gpt-5.6-terra`  
**Effort:** `high`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 1 — Searchable OCR
- Phase: Phase C — macOS recognition and review UI
- Branch: ocr-review
- This prompt’s scope: Add the user-facing OCR workflow for macOS.
- Previous gate: Searchable OCR, safe saving, undo, cancellation, cache, and model packs pass.
- Next gate: Complete macOS Milestone 1 audit.
- Out of scope: Windows/Linux UI, visible scanned-text editing, paragraph reflow, handwriting, and tables.

Follow the approved implementation plan. Implement only this phase.

Use the existing ribbon, dialog, progress-toast, left-panel, and store patterns.

Add Recognize Text to the existing Organize editing group.

The dialog must support:

- current page;
- page range;
- entire document;
- language selection;
- model-pack status;
- automatic orientation;
- deskew;
- skip existing searchable text;
- force rerun;
- offline status;
- storage requirements.

Add a non-modal progress toast with Cancel.

Add an OCR Review panel with:

- page navigation;
- recognized text;
- confidence;
- alternatives;
- low-confidence filtering;
- accept and correct;
- next warning;
- rerun page;
- remove page OCR;
- keyboard navigation;
- visible focus;
- VoiceOver-compatible labels;
- accessible live progress;
- confidence indicators that do not rely only on color.

Use macOS keyboard conventions and preserve existing menu/ribbon behavior.

Do not add visible scanned-text editing.
```

Commit and push:

```bash
git add <exact-review-UI-files>
git commit -m "ocr: add macOS recognition and review UI"
git push -u origin ocr-review
```

## Step 11: macOS Milestone 1 audit

**Branch:** `ocr-review`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 1 — Searchable OCR
- Phase: Phase C — macOS acceptance audit
- Branch: ocr-review
- This prompt’s scope: Verify that searchable OCR is production-ready on macOS.
- Previous gate: The OCR recognition and review UI passes its integration tests.
- Next gate: Milestone 2 isolated scanned-line editing.
- Out of scope: Windows/Linux qualification and new Milestone 2 features.

Follow the approved implementation plan. Do not begin Milestone 2.

Audit:

- packaged macOS arm64 recognition;
- isolated-child memory behavior;
- ten recognition and ten cancellation cycles;
- viewer responsiveness;
- offline operation;
- line geometry;
- coordinate round trips;
- image-only PDFs;
- native-text PDFs;
- mixed PDFs;
- rotated pages;
- non-zero CropBox origins;
- UserUnit;
- search before save;
- search after save and reopen;
- copy after save and reopen;
- repeated save;
- rerun;
- remove OCR;
- undo and redo;
- cancellation;
- document-close cancellation;
- model checksums;
- cache invalidation;
- PDF.js reopen;
- PDFium reopen;
- visible-pixel preservation;
- Apple Preview reopen;
- Acrobat for macOS reopen where available;
- signed-document warnings;
- encrypted-document behavior;
- 100-page memory behavior;
- VoiceOver and keyboard accessibility;
- arm64 application packaging;
- universal sidecar architecture and PDFium probes.

Do not require Windows or Linux evidence.

Report every criterion as PASS, FAIL, or UNVERIFIED. Fix only concrete failures.

Finish with exactly one decision:

- MACOS MILESTONE 1 GO;
- MACOS MILESTONE 1 NO-GO.
```

If fixes are made:

```bash
git add <exact-audit-fix-files>
git commit -m "ocr: pass macOS Milestone 1 audit"
git push
```

Do not begin Milestone 2 unless the result is `MACOS MILESTONE 1 GO`. Open and merge the `ocr-review` pull request before continuing.

## Step 12: Create the isolated-line editing branch

```bash
git switch main
git pull --ff-only origin main
git switch -c ocr-edit-single-line
```

## Step 13: Isolated scanned-line editing

**Branch:** `ocr-edit-single-line`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 2 — Scanned PDF to editable PDF
- Phase: Phase D — Isolated scanned-line editing
- Branch: ocr-edit-single-line
- This prompt’s scope: Replace one isolated horizontal OCR line on a simple background.
- Previous gate: MACOS MILESTONE 1 GO.
- Next gate: Fixed-region multiline editing.
- Out of scope: Windows/Linux, paragraphs, tables, handwriting, vertical text, complex backgrounds, and exact font reconstruction.

Follow the approved implementation plan. Implement only this phase.

Preserve the original scanned image.

Implement one reversible application-owned edit region containing:

- original OCR region;
- source OCR IDs;
- replacement text;
- estimated style;
- background repair patch;
- visible replacement text;
- updated invisible searchable text;
- revision;
- undo metadata.

Automatically permit editing only for flat or near-flat backgrounds.

Reject unsupported regions explicitly.

Ensure:

- baseline alignment;
- no doubled original glyphs;
- no obvious patch halo;
- correct search and copy text;
- exact undo and redo;
- save and reopen;
- unchanged pixels outside the edit region.

Test in the macOS application, Apple Preview, and Acrobat for macOS where available.
```

Commit and push:

```bash
git add <exact-isolated-edit-files>
git commit -m "ocr: add isolated scanned-line editing"
git push -u origin ocr-edit-single-line
```

Merge the branch before continuing.

## Step 14: Create the multiline editing branch

```bash
git switch main
git pull --ff-only origin main
git switch -c ocr-edit-regions
```

## Step 15: Fixed-region multiline editing

**Branch:** `ocr-edit-regions`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 2 — Scanned PDF to editable PDF
- Phase: Phase E — Fixed-region multiline editing
- Branch: ocr-edit-regions
- This prompt’s scope: Edit multiple OCR lines inside one fixed region.
- Previous gate: Isolated-line editing passes on macOS.
- Next gate: Bounded paragraph reflow.
- Out of scope: Windows/Linux, page-wide reflow, tables, handwriting, complex backgrounds, vertical text, and exact font recovery.

Follow the approved implementation plan. Implement only this phase.

Support:

- multiple lines;
- baseline preservation;
- line spacing;
- measurable alignment;
- replacement inside the original region;
- overflow detection;
- clipping prevention;
- visible repair patch;
- synchronized invisible searchable text;
- undo and redo;
- save and reopen.

Never move unrelated page content.

Reject complex tables, photographic backgrounds, handwriting, vertical writing, warped text, low-confidence geometry, and edits that cannot remain within the region.

Add macOS visual regression, search, undo, pixel-preservation, Preview, and Acrobat tests.
```

Commit and push:

```bash
git add <exact-multiline-files>
git commit -m "ocr: add fixed-region multiline editing"
git push -u origin ocr-edit-regions
```

Merge the branch before continuing.

## Step 16: Create the reflow branch

```bash
git switch main
git pull --ff-only origin main
git switch -c ocr-reflow
```

## Step 17: Bounded paragraph reflow

**Branch:** `ocr-reflow`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: Milestone 2 — Scanned PDF to editable PDF
- Phase: Phase F — Bounded paragraph reflow
- Branch: ocr-reflow
- This prompt’s scope: Reflow text only inside its original OCR region.
- Previous gate: Fixed-region multiline editing passes on macOS.
- Next gate: macOS release hardening.
- Out of scope: Windows/Linux, unrelated page movement, arbitrary tables, handwriting reconstruction, and exact Acrobat-level recovery.

Follow the approved implementation plan. Implement only this phase.

Support:

- line wrapping;
- paragraph alignment;
- measured line spacing;
- overflow detection;
- region clipping;
- multilingual Unicode;
- supported right-to-left text;
- synchronized visible and invisible layers;
- undo and redo;
- save and reopen.

Reject tables, inseparable columns, handwriting, complex backgrounds, missing glyphs, unsupported directions, low-confidence OCR, and text that cannot fit safely.

Add macOS visual regression, Preview, Acrobat, overflow, and failure-message tests.
```

Commit and push:

```bash
git add <exact-reflow-files>
git commit -m "ocr: add bounded paragraph reflow"
git push -u origin ocr-reflow
```

Merge the branch before continuing.

## Step 18: Create the release-hardening branch

```bash
git switch main
git pull --ff-only origin main
git switch -c ocr-release-hardening
```

## Step 19: macOS packaging and documentation

**Branch:** `ocr-release-hardening`  
**Model:** `gpt-5.6-terra`  
**Effort:** `high`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: macOS release preparation
- Phase: Phase G — Packaging and documentation
- Branch: ocr-release-hardening
- This prompt’s scope: Prepare the complete OCR feature for a macOS release.
- Previous gate: Bounded paragraph reflow passes on macOS.
- Next gate: Final macOS security and PDF-integrity audit.
- Out of scope: Windows/Linux installers, support claims, new OCR engines, major inpainting, handwriting, and table editing.

Follow the approved implementation plan. Implement only this phase.

Complete:

- macOS .app packaging;
- arm64 release validation;
- universal arm64/x86_64 sidecar validation;
- PDFium universal-library probes;
- hardened-runtime compatibility;
- code-signing validation;
- notarization workflow;
- Gatekeeper assessment;
- application-data and cache cleanup;
- model-pack packaging;
- license notices;
- checksums;
- installer-size measurements;
- macOS smoke tests;
- OCR documentation;
- unsupported-content documentation;
- release notes.

Do not build or document Windows/Linux OCR releases.

State clearly that native Intel GUI certification remains unverified unless tested on real Intel hardware.

Add only low-risk font metadata such as serif/sans/monospace classification, approximate size, weight, italic state, color, and alignment. Do not claim exact source-font recovery.
```

Commit and push:

```bash
git add <exact-packaging-and-documentation-files>
git commit -m "ocr: complete macOS release packaging"
git push -u origin ocr-release-hardening
```

## Step 20: Final macOS release audit

**Branch:** `ocr-release-hardening`  
**Model:** `gpt-5.6-sol`  
**Effort:** `max`

Paste:

```text
Plan context:
- Project: Open PDF Studio OCR and scanned-PDF editing
- Active production platform: macOS only
- Milestone: macOS release readiness
- Phase: Phase G — Final security and PDF-integrity audit
- Branch: ocr-release-hardening
- This prompt’s scope: Audit the macOS implementation and fix only confirmed release blockers.
- Previous gate: macOS packaging and documentation pass.
- Next gate: macOS release approval.
- Out of scope: Windows/Linux qualification, new features, speculative refactors, and unmeasured layout improvements.

Follow the approved implementation plan. Do not add speculative features.

Inspect:

- PDF corruption;
- duplicate OCR streams;
- invalid ToUnicode maps;
- incorrect rotations;
- CropBox and MediaBox errors;
- stale child or Worker results;
- cancellation races;
- surviving OCR child processes;
- memory growth;
- untrusted-PDF resource exhaustion;
- model archive traversal;
- checksum bypass;
- unsafe temporary files;
- failed atomic replacement;
- macOS sandbox and security-scoped access;
- signed PDFs;
- encrypted PDFs;
- license omissions;
- accidental document telemetry;
- VoiceOver duplication;
- visible changes outside edit regions;
- code signing;
- hardened runtime;
- notarization;
- Gatekeeper launch;
- packaged arm64 operation;
- universal sidecar architecture.

Run the complete macOS suite and report every criterion as PASS, FAIL, or UNVERIFIED.

Finish with exactly one decision:

- MACOS OCR RELEASE GO;
- MACOS OCR RELEASE NO-GO.

Fix only confirmed macOS release blockers.
```

If fixes are required:

```bash
git add <exact-release-fix-files>
git commit -m "ocr: fix macOS release blocker"
git push
```

Open the final pull request only when the result is `MACOS OCR RELEASE GO`.

## Pull-request and branch rules

For every branch:

1. Complete every prompt assigned to that branch.
2. Run the checkpoint prompt after every implementation prompt.
3. Commit only coherent, tested changes.
4. Push the first commit with `git push -u origin <branch>`.
5. Push subsequent commits with `git push`.
6. Open a pull request only after the branch-level gate passes.
7. Merge the pull request before creating the next branch.
8. Update `main` before creating the next branch.

Do not:

- push directly to `upstream`;
- use `git reset --hard`;
- use `git add .`;
- rewrite pushed history;
- claim Windows or Linux OCR support;
- start Milestone 2 before `MACOS MILESTONE 1 GO`;
- release before `MACOS OCR RELEASE GO`.
