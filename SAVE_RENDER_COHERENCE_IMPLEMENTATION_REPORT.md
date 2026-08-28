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
- publication tokens: Pending
- edit readiness: Pending
- cache invalidation: Pending
- UI recovery: Pending

## Finding disposition

| Finding | Status | Commit | Files | Tests/evidence |
|---|---|---|---|---|
| F-01 | Resolved in Phase 1 | `6dc046f9` | `open-pdf-studio/js/pdf/save-state.js`, `open-pdf-studio/js/core/document-revision-state.runtime.js` | Deterministic regression now passes; same-path no-op rejects synchronization debt |
| F-02 | Pending | Pending | Pending | Pending |
| F-03 | Resolved in Phase 3 | Pending Phase 3 commit | `open-pdf-studio/js/pdf/saved-document-transition.js`, `open-pdf-studio/js/pdf/loader.js` | Every persisted revision enters mandatory proxy synchronization |
| F-04 | Pending | Pending | Pending | Pending |
| F-05 | Foundation complete in Phase 1 | `6dc046f9` | document revision state and persistent mutation routing | Content identity advances once per committed mutation |
| F-06 | Pending | Pending | Pending | Pending |
| F-07 | Resolved in Phase 2 | `eca8b23e` | `open-pdf-studio/js/pdf/save-coordinator.js`, `open-pdf-studio/js/core/undo-manager.js` | Newer revisions force an owned follow-up; old serialization cannot replace or mark clean |
| F-08 | Resolved in Phase 3 | Pending Phase 3 commit | saved-document transition edit hold | A requested next edit starts only after the new proxy generation is ready |
| F-09 | Resolved in Phase 3 | Pending Phase 3 commit | immutable owner lookup and transition tests | Active-tab wrapper changes do not suppress the correct document refresh |
| F-10 | Pending | Pending | Pending | Pending |
| F-11 | Foundation complete in Phase 1 | `6dc046f9` | page content revision compatibility alias | Page-scoped mutation identity is explicit |
| F-12 | Foundation complete in Phase 1 | `6dc046f9` | structural revision invalidation | Structural changes invalidate page readiness and geometry identity |
| F-13 | Pending | Pending | Pending | Pending |
| F-14 | Pending | Pending | Pending | Pending |
| F-15 | Pending | Pending | Pending | Pending |
| F-16 | Foundation complete in Phase 3 | Pending Phase 3 commit | saved-document transition readiness ownership | `livePdfRevision` advances only after candidate proxy install; final Saved waits for readiness |
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

- All runtime findings remain open after Phase 0.
- The source audit named by the supplied plan, `open-pdf-studio-ocr-release-hardening-bug-audit.md`, was not present in the workspace, Downloads, or Documents search scope.
