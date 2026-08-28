# Save/Render Coherence Implementation Report

## Baseline and final commits

- Baseline: `d105926ed7760fa274308dc83f9a6609b49c9bfd` (`Improve text-edit auto-save persistence and diagnostics`)
- Final implementation candidate: `7a778d4262efe1350fc9590085cabe879ae47529`
- Closure report: the documentation-only commit containing this file
- Branch: `ocr-release-hardening`
- Local qualification host: macOS Darwin 25.6.0 arm64; Node v25.6.1; npm 11.9.0; rustc/cargo 1.97.1; Tauri CLI 2.10.0

## Root cause resolved

The baseline treated a successful disk replacement, a clean dirty flag, the live PDF.js proxy, visible pixels, semantic layers, native source provenance, and cache contents as if they were one state. Automatic save could therefore persist newer bytes without installing them into the live editor, while clean same-path Save could hide that synchronization debt. In-flight work was owned by paths, wrappers, or unrevisioned page identities, allowing an older result to publish after a save.

The repair carries immutable document/lifecycle/proxy/content/page/request identity through mutation, serialization, atomic replacement, live-proxy installation, derived-state invalidation, visible and semantic rebuilding, and subsequent edit activation. A save is not finally `saved` until the persisted revision is installed and required pages are edit-ready.

## Architecture implemented

- revision state: explicit content, serialized, persisted, live-PDF, visible-render, visible-semantic, per-page content, and per-layer readiness revisions with fail-closed transition assertions
- save coordinator: one serialized, revision-owned queue per document; automatic requests coalesce, manual Save joins/flushes, ownership is rechecked at the replacement boundary, and follow-up work is guaranteed for newer revisions
- proxy synchronization: automatic, manual, Save As, clean-debt, and retry-refresh paths use one saved-document transition; validated bytes install before central invalidation/rebuild and partial success remains explicit
- publication tokens: raster, continuous, tile, preview, vector, thumbnail, semantic, metadata, preload, and native-engine work validates document ID, lifecycle, direct proxy, document revision, page revision, and request identity at publication boundaries
- edit readiness: native, owned, OCR/scanned, and inserted-text activation waits for the current raster, annotation, text, link, form, editable-metadata, and provenance layers; queued pointer intent replays once against the replacement generation
- cache invalidation: one saved-document invalidator covers old/new Save As paths and every document-derived visual, semantic, geometry, preload, thumbnail, and engine cache; precisely reusable pages remain revision-stamped
- UI recovery: per-document Pending, Saving, Refreshing, Saved, Save failed, and Saved/editor refresh failed states; retry-save, refresh-only retry, and safe reopen actions; structured debug snapshots and deterministic fault injection

## Finding disposition

| Finding | Status | Commit | Files | Tests/evidence |
|---|---|---|---|---|
| F-01 | Fixed | `6dc046f9`, `eca8b23e`, `c593ec19`, `601affb3` | `document-revision-state.*`, `save-state.js`, `save-coordinator.js`, `saved-document-transition.js`, `saver.js` | Red-first state sequence; coordinator/transition tests; packaged A1/A22 no-reopen report |
| F-02 | Fixed | `b3934494`, `e3044e89` | `tile-cache.js`, `render-publication-token.js`, `renderer.js` | Deferred stale tile/publication tests; high-zoom coverage |
| F-03 | Fixed | `c593ec19`, `fbbf3d96` | `visible-page-render-barrier.js`, `page-edit-readiness.js`, `saved-document-transition.js` | Deferred continuous child-render barrier tests; revisioned acceptance states |
| F-04 | Fixed | `b3934494`, `fbbf3d96` | `render-publication-token.js`, `renderer.js`, semantic layers | Deferred old raster/DOM/layer completions reject publication and release ownership |
| F-05 | Fixed | `b18ce88e`, `fbbf3d96` | `editable-metadata-preload.js`, `native-text-provenance.js`, `semantic-revision-identity.js` | Metadata/provenance races; packaged second and third native edits |
| F-06 | Fixed | `b3934494`, `e3044e89` | `left-panel.js`, `thumbnail-document-owner.js` | Thumbnail proxy/task/resource race tests; 384-case packaged matrix |
| F-07 | Fixed | `eca8b23e` | `save-coordinator.js`, `saver.js` | Deferred two-save ordering, final pre-replacement ownership, follow-up revision, tab/close tests |
| F-08 | Fixed | `c593ec19`, `92734427` | `saved-document-transition.js`, `save-fault-injection.js`, `document-save-status.js` | Persisted-plus-refresh-failed state, no-write retry, and recovery UI tests |
| F-09 | Fixed | `c593ec19`, `fbbf3d96`, `601affb3` | `page-edit-intent.js`, `page-edit-readiness.js`, `text-edit-tool.js` | Immediate queued edit/lifecycle tests; packaged edits B and C without reopen |
| F-10 | Fixed | `b3934494`, `e3044e89` | `low-resolution-preview-key.js`, `renderer.js` | Preview identity/race tests; stale draw rejection |
| F-11 | Fixed | `b18ce88e` | `whole-pdf-preload.js`, `pdf-preload-controller.js` | Deferred preload revision test; new-revision completion cannot be spoofed |
| F-12 | Fixed | `e3044e89` | `document-performance.js`, geometry owner state, central invalidator | Geometry revision/structural invalidation tests; page-operation packaged coverage |
| F-13 | Fixed | `b3934494`, `e3044e89` | `vector-renderer.js`, `revision-owned-engine-caches.test.mjs` | Old vector command/image owner is invisible after revision change |
| F-14 | Fixed | `e3044e89` | `page-type-cache.js`, central invalidator | Revision-owned page-type tests and structural scenario coverage |
| F-15 | Fixed | `b3934494`, `e3044e89` | `page-bitmap-cache.js`, `page-raster.js` | Legacy facade fails closed without a live owner; compatibility/raster tests |
| F-16 | Fixed | `c593ec19`, `fbbf3d96` | `saved-document-transition.js`, lifecycle/readiness ownership | Wrapper replacement with same immutable document ID remains valid; tab-switch acceptance |
| F-17 | Fixed | `eca8b23e`, `672fea0c` | `save-coordinator.js`, text-edit session registry | Event-driven editor completion, bounded failure, automatic latest-wins/admission tests |
| F-18 | Fixed | `92734427` | `StatusBar.jsx`, `document-save-status.js`, recovery/fault injection | Automatic failure stays visible/retryable; exact diagnostic retained by owner |
| F-19 | Fixed | `672fea0c` | `text-edit-click-away-intent.js`, `PdfTextEditOverlay.jsx` | Exactly-once toolbar/text replay; failed, stale, destructive, and browser-delivered actions do not replay |
| F-20 | macOS fixed; other platforms deferred | `5c377ea9`, `2d4c193c`, `7a778d42` | `.github/workflows/ci.yml`, OCR corpus test, OCR PDF candidate validator | Node/runtime and macOS corpus proof corrected; macOS is the active qualification target, while Linux/Windows remain outside the current scope |
| F-21 | Blocked | `5c377ea9` | `BRANCH_PROTECTION_REQUIRED.md` | Exact upstream `main` check/review/update/force-push/deletion settings recorded; implementing account lacks rule administration |
| F-22 | Fixed | `a5422b1e`, `601affb3`, `5c377ea9` | save/continue script, verifier, aggregate packaged runner, CI | Packaged A1/A22 edits A/B/C, independent extraction/reopen, revision equality, 0 stale publications |
| F-23 | Fixed | N/A | Upstream tracking history | Parent `OpenAEC-Foundation/open-pdf-studio#345`; linked workstreams `#346`–`#350` contain scope, acceptance, commits, and evidence |

## Test commands and results

All commands below passed unless an expected red-first/baseline result is stated.

### Baseline and red-first evidence

- `NPM_CONFIG_CACHE=/tmp/open-pdf-studio-save-coherence-npm-cache npm ci`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `git diff --check`
- `cargo test -p open-pdf-studio`
- `cargo test -p pdfium-worker`
- F-01 state test: expected failure before production changes because clean same-path Save accepted synchronization debt
- packaged save/continue outline: expected failure before the production path and report contract existed
- baseline GitHub run `33148195868`: failed in clean-checkout OCR fixture/runtime setup before downstream jobs; classified as an existing branch/CI-environment regression

### Final local static and unit gates

From `open-pdf-studio/`:

| Command | Outcome |
|---|---|
| `npm ci` with the task-specific cache | PASS; 128 packages; existing audit inventory 2 low, 6 high, 1 critical was not auto-modified |
| `npm run typecheck` | PASS |
| `npm run test` | PASS |
| `npm run test:editor-lifecycle:unit` | PASS, 206/206 |
| `npm run test:large-pdf-performance:unit` | PASS, 57/57 |
| `npm run test:quality` | PASS, 69/69 |
| `npm run build` | PASS, 1,298 modules |
| `node --test scripts/ocr-quality-benchmark.test.mjs` | PASS, 8/8; exact reproduction on macOS and byte/hash self-consistency everywhere |
| `NPM_CONFIG_CACHE=... npx --yes node@24.19.0 --test js/ocr/pdf-persistence.test.mjs` | PASS, 5/5 under the exact hosted Node runtime |

From repository root:

| Command | Outcome |
|---|---|
| `git diff --check` | PASS |
| `cargo test -p open-pdf-studio` | PASS; all configured unit/integration tests, existing explicitly ignored parity cases unchanged |
| `cargo test -p pdfium-worker` | PASS, 15 passed and existing ignored integration coverage unchanged |

### Packaged macOS gates

Packaged app source candidate `5c377ea9`; final-candidate macOS rerun against `7a778d42` is pending:

`/Users/alexander/Personal Projects/open-pdf-studio/target/aarch64-apple-darwin/release/bundle/macos/Open PDF Studio.app`

| Command | Outcome |
|---|---|
| `npm run package:ocr-release-hardening:arm64` | PASS; ad-hoc hardened-runtime bundle, strict signature verification and PDFium probe pass; notarization skipped because credentials were unavailable |
| `npm run test:editor-coverage:macos` | PASS, 384 matrix + 72 lifecycle cases |
| `npm run test:annotation-text-editing:macos` | PASS; insertion, textbox, callout, click-away, Escape, save/reopen, repeat-save, genuine re-edit |
| `npm run test:native-text-editing:macos` | PASS |
| `npm run test:ocr-production-100-page:macos` | PASS; 100/100 complete, 0 failed/skipped, 100 children reaped, external PDF.js/PDFium readers pass, cancellation 55/45 with no late results |
| `npm run test:editor-performance:macos` | PASS |
| explicit coherence script and verifier | PASS |
| `OPEN_PDF_STUDIO_BROWSER_ACCEPTANCE_OUTCOME=success npm run test:editor-acceptance:macos` | PASS; browser, coverage, coherence, native, annotation, OCR workflow/save/one-line/regions/reflow suites |

## Packaged acceptance

- app artifact: `/Users/alexander/Personal Projects/open-pdf-studio/target/aarch64-apple-darwin/release/bundle/macos/Open PDF Studio.app`
- executable: `Contents/MacOS/open-pdf-studio`, 71,994,896 bytes, SHA-256 `7cc836dd571ac3e7711dd9bd1f9e5bf63ef285cd7186d9123a571344c50a6aa6`
- aggregate report: `open-pdf-studio/test-artifacts/packaged-editor/acceptance.json`, PASS
- coherence report: `open-pdf-studio/test-artifacts/save-render-coherence/report.json`, PASS
- scenarios: A1 and A22 execute through the packaged production UI; A2–A21 have packaged or deterministic evidence; no synthetic state seeding or test-only app entry point
- final revisions: content = serialized = persisted = live PDF = visible render = visible semantic = 3
- text: edits A, B, and C exist in saved bytes, live semantics, and independent reopen; no reopen occurred before edits B or C
- visual: geometry preserved; clean manual Save preserved bytes; mounted/direct page crops differ by 0%, below the 0.1% maximum
- stale publication count: 0; rejected stale publication count after synchronization barriers: 0

## Performance comparison

The prior qualified packaged snapshot is `14019611`; the coherence candidate measurement is `5c377ea9`. The baseline defect did not have a valid save/synchronize workflow, so no misleading before latency is invented for that broken path. Coordinator tests directly assert bounded serialization duration/candidate-size diagnostics; packaged readiness and large-document behavior are covered by the tables below.

| Metric | Prior qualified | Candidate | Guardrail/result |
|---|---:|---:|---|
| typing-to-paint p95 | 12 ms | 12 ms | PASS, < 16 ms |
| warm exact validation | 15 ms | 15 ms | PASS, < 100 ms |
| maximum ordinary typing task | 3 ms | 4 ms | PASS, < 50 ms |
| active exact-layout tasks | 1 | 1 | PASS, bounded |
| idle placement reads/writes | 0 / 0 | 0 / 0 | PASS |
| history entries / approximate bytes | 2 / 24,184 | 2 / 24,184 | PASS |
| OCR UI publication maximum | 8.0645 Hz | 8.0645 Hz | PASS, <= 10 Hz |
| OCR bookkeeping CPU | 0.00374% | 0.00539% | PASS |
| OCR progress / late cancel publication | monotonic / none | monotonic / none | PASS |

The 100-page production run recorded parent RSS baseline 319,504,384 bytes, peak parent 337,838,080, peak child 207,847,424, settled parent 236,617,728, and settled delta 0 against a 33,554,432-byte allowance. Required page metadata reached 100/100, owned OCR streams were exactly one per page, all 100 child processes were reaped, and no stale/generation token error occurred.

## CI and protection evidence

- baseline failure: `https://github.com/alexnyiu/open-pdf-studio/actions/runs/33148195868`
- first candidate diagnostic: `https://github.com/alexnyiu/open-pdf-studio/actions/runs/33199296147` proved Node 20 incompatibility and cross-platform fixture reproduction mismatch
- second candidate diagnostic: `https://github.com/alexnyiu/open-pdf-studio/actions/runs/33199740679` proved the remaining modern-PDF.js/Node 24 `toHex` incompatibility
- final code-candidate workflow: `https://github.com/alexnyiu/open-pdf-studio/actions/runs/33200096495`; all JavaScript, OCR, lifecycle, quality, performance-unit, build, and diff checks passed before the workflow stopped at the Linux desktop build because the clean checkout did not contain its target sidecar
- macOS required check producers remain: `Desktop build (macos-26)`; `macOS packaged editor acceptance`; `save/render coherence report verification`; `macOS editor and OCR performance`; `macOS OCR release-hardening decision`
- Linux and Windows hosted build closure is explicitly deferred by the current macOS-only scope; the Linux sidecar failure is not reported as a macOS defect or as a passing cross-platform gate
- checks are fail-closed and downstream jobs depend on real upstream artifacts; the coherence verifier is a separate required job
- administrative blocker: the implementing account can read but cannot administer the authoritative `OpenAEC-Foundation/open-pdf-studio` rules. `BRANCH_PROTECTION_REQUIRED.md` records the exact required checks, PR/review/up-to-date requirements, and force-push/deletion prohibitions. F-21 must be closed by an upstream administrator and revalidated on an upstream pull request.

## Final source audit

The five required `rg` searches were rerun against `7a778d42` and every match was reviewed rather than mechanically removed.

- path/page matches: page raster, bitmap, tile, thumbnail, preview, vector, geometry, and page-type owners also include immutable document ID, lifecycle, content revision, and page revision. The old compatibility facade registers with the formal raster owner and is cleared centrally; no content lookup is path-and-page only.
- active-document wrapper equality: remaining comparisons only protect publication into the active shared DOM/canvas or fail closed. Mutation, persistence, synchronization, and cache authority use document ID, lifecycle generation, direct PDF.js proxy, and revisions; owner resolution remains valid when a reactive wrapper changes.
- direct `modified` assignments: `true` remains a compatibility mirror within mutation/undo boundaries that call `noteDocumentMutation`; the loader sets `false` only after validated recovery state converges. Clean/save decisions use revision debt, not this Boolean.
- 250/750 ms timers: loader/renderer delays are background-admission settling windows; foreground retry and allocator relief recheck lifecycle, requested revision, and foreground idleness. None is proof of save, render, semantic, or edit readiness.
- fire-and-forget render/preload/get-page calls: continuous render work is owned by `createRenderWorkScheduler` and publication tokens, preload coordinators carry revision/generation ownership and catch failures, metadata warmup publishes nothing directly, and cancellation/clear paths are idempotent cleanup.
- stale-result cleanup: PDF.js tasks are cancelled and unregistered; in-flight leases release once; rejected raster/bitmap resources close; object URLs/streams/candidates transfer or dispose exactly once; central invalidation cancels old preload/thumbnail/native generations before reuse.
- save state paths: deterministic tests cover success, superseded request, pre-persistence cancellation, cancellation after the persistence point of no return, persistence failure, saved-refresh-failed partial success, and refresh-only recovery.

## Final release audit

| Criterion | Result |
|---|---|
| F-01 through F-19 and F-22 have code plus deterministic/packaged evidence | PASS |
| F-20 macOS CI/runtime compatibility has deterministic evidence | PASS |
| Automatic and manual save share one persistence/synchronization contract | PASS |
| Disk-clean state cannot hide live/editor synchronization debt | PASS |
| Required visible/semantic edit-readiness barrier is revision-owned | PASS |
| Old render, layer, preload, thumbnail, metadata, and engine work cannot publish after revision change | PASS |
| All listed caches are revision-owned or centrally invalidated | PASS |
| Save/refresh failure is visible and recoverable without unsafe editing | PASS |
| Exact packaged edit/save/edit-again/no-reopen scenario passes | PASS |
| Final local macOS static, desktop-package, coherence, performance, and release-hardening gates execute and pass | PENDING FINAL MACOS VALIDATION |
| Linux and Windows hosted desktop/package gates execute and pass | UNVERIFIED — deferred by macOS-only scope |
| Authoritative upstream `main` protection is configured and live-verified | UNVERIFIED — external administrator required |
| Tracking history contains reproduction, ownership, acceptance, commits, and evidence | PASS |
| Final clean-checkout reproduction at the closure commit | PENDING FINAL VALIDATION |

Release decision: **NO-GO** for a cross-platform/upstream merge until deferred Linux/Windows workflow closure and the documented F-21 administrator action are completed. macOS qualification remains pending only on the final clean-candidate rerun below; this decision does not misclassify deferred platforms or the external protection gap as macOS runtime defects.

## Remaining risks

- Upstream `main` protection remains external administrative work; do not merge without applying and live-verifying `BRANCH_PROTECTION_REQUIRED.md`.
- Linux and Windows hosted build/package evidence is deferred and must not be inferred from the macOS result.
- The local macOS artifact is usable and ad-hoc signed for acceptance but is not Developer ID/notarization evidence.
- The existing npm audit inventory remains outside this coherence fix; no broad dependency upgrade or audit rewrite was authorized.
