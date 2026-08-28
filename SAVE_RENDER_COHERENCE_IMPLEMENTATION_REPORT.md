# Save/Render Coherence Implementation Report

## Baseline and final commits

- Baseline: `d105926ed7760fa274308dc83f9a6609b49c9bfd`
- Baseline title: `Improve text-edit auto-save persistence and diagnostics`
- Final: Pending
- Branch: `ocr-release-hardening`
- Platform: macOS Darwin 25.6.0 arm64
- Node: v25.6.1
- npm: 11.9.0
- Rust: rustc 1.97.1, cargo 1.97.1
- Tauri CLI dependency: `^2.10.0`

## Root cause resolved

Pending implementation. Baseline reproduction confirms that automatic persistence can leave the live PDF revision unrepresented, after which ordinary dirty checks allow same-path Save to return a false no-op.

## Architecture implemented

- revision state: Implemented in Phase 1; explicit content, serialized, persisted, live-PDF, visible-render, visible-semantic, and page readiness identities now fail closed on impossible transitions
- save coordinator: Implemented in Phase 2; one revision-owned queue per document coordinates automatic and manual requests through bounded editor completion, persistence-boundary ownership, follow-up scheduling, and lifecycle cancellation
- proxy synchronization: Implemented in Phase 3; automatic and manual persistence share one saved-document transition, with live revision advancement, view restoration, edit activation holding, and Phase-B-only recovery
- publication tokens: Implemented in Phase 4; foreground and background raster, tile, preview, thumbnail, vector, metadata, and whole-document preload work publish only for their exact document, proxy, lifecycle, content revision, and page revision
- semantic invalidation: Implemented in Phase 5; live-proxy installation clears editable metadata, native provenance, search text, and preload completion state before required-page metadata is rebuilt and edit readiness is published
- edit readiness: Pending
- cache invalidation: Implemented in Phase 6; one saved-document invalidator clears both old and new Save As paths and all raster, tile, preview, thumbnail, vector, page-type, geometry, semantic, DOM-layer, preload, and native generations before registering the new owner
- UI recovery: Pending

## Finding disposition

| Finding | Status | Commit | Files | Tests/evidence |
|---|---|---|---|---|
| F-01 | Resolved in Phase 1 | `6dc046f9` | `open-pdf-studio/js/pdf/save-state.js`, `open-pdf-studio/js/core/document-revision-state.runtime.js` | Deterministic regression now passes; same-path no-op rejects synchronization debt |
| F-02 | Resolved in Phase 4 | `b3934494` | render publication tokens across renderer, viewport raster orchestration, thumbnails, and caches | Old asynchronous work is rejected after proxy, lifecycle, content, or page-revision change |
| F-03 | Resolved in Phase 3 | `c593ec19` | `open-pdf-studio/js/pdf/saved-document-transition.js`, `open-pdf-studio/js/pdf/loader.js` | Every persisted revision enters mandatory proxy synchronization |
| F-04 | Resolved in Phase 4 | `b3934494` | `open-pdf-studio/js/pdf/render-publication-token.js`, `open-pdf-studio/js/pdf/tile-cache.js` | Deterministic deferred-result races cover raster, continuous, tile, preview, thumbnail, metadata, preload, and native-result publication |
| F-05 | Resolved in Phase 5 | `b18ce88e` | saved semantic transition, revision-owned editable metadata/native provenance/search caches | Content identity advances once and stale semantic entries cannot survive a live-proxy transition |
| F-06 | Resolved in Phase 6 | Pending Phase 6 commit | central derived-state invalidation and revision-owned raster/tile/preview/thumbnail/vector/page-type keys | Same-path caches distinguish lifecycle, content, and page revisions and are cleared through one transition hook |
| F-07 | Resolved in Phase 2 | `eca8b23e` | `open-pdf-studio/js/pdf/save-coordinator.js`, `open-pdf-studio/js/core/undo-manager.js` | Newer revisions force an owned follow-up; old serialization cannot replace or mark clean |
| F-08 | Resolved in Phase 3 | `c593ec19` | saved-document transition edit hold | A requested next edit starts only after the new proxy generation is ready |
| F-09 | Resolved in Phase 3 | `c593ec19` | immutable owner lookup and transition tests | Active-tab wrapper changes do not suppress the correct document refresh |
| F-10 | Resolved in Phase 4 | `b3934494` | PDF.js task registry and native request IDs | PDF.js tasks are actively cancelled on revision change; uncancellable native completions are rejected before publication |
| F-11 | Resolved in Phase 5 | `b18ce88e` | explicit document/revision metadata preload and changed-page-first rebuild | Required-page native metadata is rebuilt before semantic/edit readiness; uncertain provenance changes clear the whole source cache |
| F-12 | Resolved in Phase 6 | Pending Phase 6 commit | structural revision invalidation plus revision-stamped geometry/performance index | Structural replacement rebuilds page geometry under the new proxy/lifecycle/content identity before shells consume it |
| F-13 | Resolved in Phases 4 and 6 | Pending Phase 6 commit | revision-owned tile, preview, thumbnail, vector, and bitmap caches | Async insertions reject stale owners and synchronous lookup keys cannot cross a saved revision |
| F-14 | Resolved in Phase 6 | Pending Phase 6 commit | revision-owned compatibility bitmap, page-type, vector image, and thumbnail resource keys | No production content cache is owned by path and page alone |
| F-15 | Resolved in Phases 4–6 | Pending Phase 6 commit | whole-document/editable-metadata token validation and central preload cancellation/restart | Old preloads cannot insert metadata or mark a new revision complete; visible thumbnails restart first from the new proxy |
| F-16 | Foundation complete in Phase 3 | `c593ec19` | saved-document transition readiness ownership | `livePdfRevision` advances only after candidate proxy install; final Saved waits for readiness |
| F-17 | Resolved in Phase 2 | `eca8b23e` | save coordinator persistence/publication boundaries | Superseded and closed-document requests cannot publish stale state |
| F-18 | Resolved in Phase 2 | `eca8b23e` | save coordinator editor promise and deadline | Save waits on the session commit promise and fails visibly at a bounded deadline |
| F-19 | Pending | Pending | Pending | Pending |
| F-20 | Reproduced | Pending | CI run 33148195868 | Static verification fails 19 OCR tests because untracked generated PNG fixtures are absent in a clean checkout |
| F-21 | Pending | Pending | Pending | Pending |
| F-22 | Reproduced | Pending | `open-pdf-studio/scripts/test-save-continue-editing-macos.mjs` | Explicitly red packaged scenario outline |
| F-23 | Blocked | N/A | GitHub repository settings | `gh issue create` returned: `the 'alexnyiu/open-pdf-studio' repository has disabled issues` |

## Test commands and results

### Phase 0 baseline

| Command | Result |
|---|---|
| `npm ci` | Environment failure: root-owned `~/.npm` cache returned `EPERM` |
| `NPM_CONFIG_CACHE=/tmp/open-pdf-studio-save-coherence-npm-cache npm ci` | PASS; locked dependency install completed |
| `npm run typecheck` | PASS |
| `npm run test` | PASS locally with generated fixture PNGs present |
| `npm run build` | PASS |
| `git diff --check` | PASS |
| `cargo test -p open-pdf-studio` | PASS: 75 unit tests plus focused integration tests; one pool-parity test ignored by existing configuration |
| `cargo test -p pdfium-worker` | PASS: 15 passed, 2 ignored by existing configuration |
| `node --test js/pdf/save-state.test.mjs` after red test | EXPECTED FAIL: F-01 returned `true` instead of `false` for disk-clean synchronization debt |
| `node scripts/test-save-continue-editing-macos.mjs` | EXPECTED FAIL: authoritative packaged scenario not implemented yet |

### Baseline CI classification

- GitHub Actions run: https://github.com/alexnyiu/open-pdf-studio/actions/runs/33148195868
- Category: existing branch regression in clean-checkout fixture provisioning.
- Failure: 19 OCR tests fail after missing generated PNG fixtures produce `ENOENT`; the first missing file is `open-pdf-studio/tests/fixtures/ocr/quality-v1/punctuation-unicode.png`.
- Consequence: frontend build, whitespace, Rust, desktop build, packaged editor acceptance, and performance jobs are skipped.
- Local/CI difference: the PNG files exist locally but `git ls-files` contains only the fixture Markdown and JSON files.

### Phase 1 revision model

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `node --test js/core/document-revision-state.test.mjs js/pdf/save-state.test.mjs js/pdf/page-raster.test.mjs` | PASS: 20/20 |
| `npm run test:editor-lifecycle:unit` | PASS: 123/123 |
| `npm run test:unit` | PASS: 225/225 |
| `git diff --check` | PASS |

- All document instances initialize one stable revision-state object.
- `pageRenderRevisions` remains a compatibility alias of `pageContentRevisions`; there are not two independent counters.
- Persistence debt and live-proxy synchronization debt are separate, and disk-clean state cannot suppress required synchronization.
- Persistent mutation entry points route through the revision helper or the typed undo-command boundary; OCR/scanned inner state retains the existing `modified` compatibility marker while its owning command advances revision identity exactly once.

### Phase 2 save coordinator

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `node --test js/pdf/save-coordinator.test.mjs js/pdf/save-state.test.mjs js/text/text-edit-session.test.mjs js/core/document-lifecycle.test.mjs` | PASS: 33/33 |
| `npm run test:editor-lifecycle:unit` | PASS: 123/123 |
| `npm run test:unit` | PASS: 225/225 |
| `npm run build` | PASS |
| `git diff --check` | PASS |

- Automatic requests debounce and coalesce to the newest content revision; manual Save flushes or joins the same document queue.
- Each queue transaction carries immutable document ID, lifecycle generation, request ID, requested revision, kind, and Save As path.
- The final ownership assertion is adjacent to native atomic replacement or non-macOS writing, and publication is rechecked after replacement.
- A request cancelled during the point-of-no-return operation permits the native replacement to finish but cannot install a proxy or publish clean state.
- Editor completion is promise-driven through the existing session registry, with a 15-second failure boundary rather than polling.
- Structured diagnostics are bounded to the latest 200 document/request/revision events.

### Phase 3 saved-document transition

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `node --test js/pdf/saved-document-transition.test.mjs js/pdf/save-coordinator.test.mjs js/pdf/save-state.test.mjs js/core/document-revision-state.test.mjs js/text/text-edit-session.test.mjs` | PASS: 47/47 |
| `npm run test:editor-lifecycle:unit` | PASS: 123/123 |
| `npm run test:unit` | PASS: 225/225 |
| `npm run build` | PASS |
| `git diff --check` | PASS |

- The former automatic cache-only branch is removed. Automatic and manual Save both install the already validated PDF.js candidate.
- Proxy replacement is owner-ID based, captures page/PDF-space scroll anchor plus view/tool/selection/search state, and restores without reviving a transient editor.
- `livePdfRevision` advances only after proxy installation; page render and semantic readiness then gate final `Saved` state.
- Textbox, native-source, and scanned-text entry points wait for the document-scoped transition and register against the post-save lifecycle generation.
- A disk-clean but unsynchronized document runs Phase B from retained/cached validated bytes without serializing or replacing the destination again.
- Refresh failure retains persisted revision, bytes, candidate/reload path, and exposes Phase-B-only retry; successful retry does not rewrite the file.

### Phase 4 asynchronous publication ownership

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `node --test js/pdf/render-publication-token.test.mjs js/pdf/render-work-scheduler.test.mjs js/pdf/tile-cache.test.mjs js/pdf/page-bitmap-cache.test.mjs` | PASS: 26/26 |
| `npm run test:editor-lifecycle:unit` | PASS |
| `npm run test:unit` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

- Publication tokens capture request ID, immutable document ID, lifecycle generation, direct PDF.js proxy identity, document content revision, page content revision, and page number.
- Foreground single-page/continuous rendering and viewport raster orchestration validate after asynchronous boundaries and before canvas, DOM, cache, event, or document-state publication.
- PDF.js render tasks are registered and actively cancelled when their token becomes stale; native render calls carry request IDs and all late results are rejected before publication.
- Bitmap, tile, vector, preview, thumbnail, metadata, and whole-document preload paths close or revoke stale resources and use bounded rejection diagnostics.
- Deterministic paused-result tests cover every race required by the plan, including direct tile-cache insertion and scheduler completion rejection.

### Phase 5 semantic invalidation and preload rebuilding

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `node --test js/pdf/saved-document-transition.test.mjs js/pdf/editable-metadata-preload.test.mjs js/pdf/pdf-preload-controller.test.mjs js/text/native-text-provenance.test.mjs js/search/text-cache.test.mjs` | PASS: 27/27 |
| `npm run test:editor-lifecycle:unit` | PASS |
| `npm run test:unit` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

- Saved semantic invalidation runs only after the validated candidate proxy is installed and `livePdfRevision` advances; the former pre-install metadata clear was removed.
- Editable metadata controllers and native source provenance caches are owned by direct proxy, lifecycle, content revision, and live-PDF revision, even when the outer document object remains stable.
- Required foreground metadata bypasses background-idle admission and is rebuilt before page semantic readiness; precisely changed pages are attempted first.
- Whole-document preload status carries revision identity, restarts after required-page rebuilding, and stale runs cannot publish `complete` for a newer revision.
- Search waits for saved-document synchronization, refuses persisted-newer-than-live or refresh-failed owners, and caches page text under direct proxy plus document/page revision identity.

### Phase 6 centralized visual and engine cache invalidation

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `node --test js/core/document-revision-state.test.mjs js/pdf/page-raster.test.mjs js/pdf/page-bitmap-cache.test.mjs js/pdf/tile-cache.test.mjs js/pdf/revision-owned-engine-caches.test.mjs js/pdf/low-resolution-preview-key.test.mjs js/pdf/document-performance.test.mjs js/pdf/saved-document-transition.test.mjs js/ui/panels/thumbnail-document-owner.test.mjs` | PASS: 43/43 |
| `npm run test:large-pdf-performance:unit` | PASS: 55/55 |
| `npm run test:editor-lifecycle:unit` | PASS: 123/123 |
| `npm run test:unit` | PASS: 227/227 |
| `npm run build` | PASS |
| `git diff --check` | PASS |

- `invalidateSavedDocumentDerivedState` is the single post-install transition hook. It cancels old preload/thumbnail work, clears page readiness, semantic state, all visual/engine caches, visible text/link/form layers, and PDFium state for both the prior and destination Save As paths.
- Page raster, tile, vector command/image, page-type, low-resolution preview, and thumbnail resource identities include document, lifecycle, global content revision, and page revision in addition to their rendering parameters.
- The legacy bitmap compatibility facade fails closed without a live revision-owned document context and writes into the formal page-raster registry rather than a path-only entry.
- Thumbnail state always replaces its retained PDF.js proxy after save, clears old promises/tasks/resources, primes the active and visible pages first, then restarts ordinary and whole-document generation.
- Page geometry carries direct proxy/lifecycle/content identity. Structural or uncertain saves clear and synchronously initialize performance geometry; precise non-structural saves restamp retained dimensions before new cache owners are registered.
- Deterministic tests prove that denser old rasters/tiles cannot satisfy a new revision, old page-type/vector entries are invisible, low-resolution preview keys change, stale resources close, and the central hook invokes every required invalidator.

## Packaged acceptance

- app artifact: Pending
- report artifact: Pending
- scenarios passed: Pending
- stale publication count: Pending

## Performance comparison

Pending Phase 10 measurements.

## CI and protection evidence

- workflow run: Baseline failure recorded above
- required checks: Pending
- admin blockers: GitHub Issues are disabled, preventing the required parent and linked workstream issues. Repository-rule administration remains to be verified in Phase 11.

## Remaining risks

- Complete visible edit readiness, click-away scheduling, UI recovery, packaged acceptance, and CI enforcement remain for Phases 7–12.
- The source audit named by the supplied plan, `open-pdf-studio-ocr-release-hardening-bug-audit.md`, was not present in the workspace, Downloads, or Documents search scope.
