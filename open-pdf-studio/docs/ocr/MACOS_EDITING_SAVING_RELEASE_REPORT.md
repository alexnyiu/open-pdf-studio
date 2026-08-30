# macOS Editing and Saving Release Report

Generated: 2026-08-30

Branch: `ocr-release-hardening`

Code-qualified SHA: `2bdc524d03157bd6d3064a01ce498c234006a16c`

Report commit: this report is committed separately and does not change the packaged build identity.

## Scope and decision basis

This report qualifies the exact code SHA above. It does not carry forward packaged results from another SHA. The implementation and full static/unit gate passed, and substantial packaged production-UI evidence passed against the exact app. The final sequential packaged restart did not complete: native-text acceptance produced conflicting failures after an earlier pass, and subsequent app launches aborted inside macOS `_RegisterApplication` before Tauri/WebKit initialization. Blocking File Provider, external-volume, large-document performance, accessibility, and hardware checks also remain unverified.

**MACOS EDITING AND SAVING NO-GO**

## Implementation delivered

The requested blank-document and raster-publication contracts are present in separate commits:

- `d7f4c5c4` — `fix: keep new document revisions ready`
  - adds the explicit Save-As-required document transition without advancing content, serialized, persisted, live-proxy, page, or readiness revisions;
  - uses that transition for blank/template creation;
  - removes the fabricated mutation and redundant readiness repair render.
- `421c05ab` — `fix: isolate raster publication owners`
  - keeps reusable bitmap cache identity separate from pending publication-owner identity;
  - keys pending publication work by document, lifecycle, content, live-proxy, target-page, and published-page revisions;
  - returns structured `published`, `superseded`, or `failed` outcomes and prevents superseded work from poisoning current readiness.

Follow-up fixes found while qualifying the same release are individually committed through `2bdc524d`, including pending OCR readiness, speculative-preload suspension, and controlled 500-page fixture qualification. No commits were pushed.

## Exact packaged app identity

App bundle:

`/Users/alexander/Personal Projects/open-pdf-studio/target/aarch64-apple-darwin/release/bundle/macos/Open PDF Studio.app`

| Component | Architecture | SHA-256 |
|---|---|---|
| `Contents/MacOS/open-pdf-studio` | arm64 | `0b685eb1ec50fd0e29f3498d00d2412802cb8e3ada4b691e07ee3e20bcf345fe` |
| `Contents/MacOS/pdfium-worker` | arm64 | `cdcfdea7579968223b0399777cfb5498bafacd4f36f586782944740e937d2366` |
| `Contents/Resources/libpdfium.dylib` | arm64 + x86_64 universal | `4e587d08486f54f60cd95e79771e7e4067982f3985dede615fc41f59713d2a1c` |

`codesign --verify --deep --strict` passed. The bundle identifier is `org.openaec.openpdfstudio`; the signature is ad-hoc with hardened runtime and no Team Identifier. This proves local packaged usability and integrity only. It is not Developer ID signing, notarization, updater, or DMG distribution evidence.

The bundled worker probe returned `{"pdfium":"ready"}`.

## Qualification gates

The complete code gate passed on `2bdc524d` before packaging:

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run test` | PASS |
| `npm run test:editor-lifecycle:unit` | PASS — 321/321 |
| `npm run test:large-pdf-performance:unit` | PASS — 77/77 |
| `cargo test -p open-pdf-studio -- --nocapture` | PASS — 85 passed, 3 ignored, plus integration suites |
| `git diff --check` | PASS |
| `npm run package:ocr-release-hardening:arm64` | PASS |
| signature, architecture, and PDFium probe | PASS |

The packaged GUI evidence is production-configured: no synthetic state seeding and no test-only editor entry point.

## Packaged acceptance matrix

All paths below refer to the exact app above. `PASS` records a completed same-SHA execution. `FAIL` records a completed failing gate or conflicting product-path result. `UNVERIFIED` means the required final execution did not complete; older-SHA evidence is not promoted.

| Order | Command | Result | Evidence and limitation |
|---:|---|---|---|
| 1 | `npm run test:native-text-editing:macos` | FAIL | One standalone run passed fully, but the aggregate rerun lost trusted physical text insertion and a later standalone run left a live owner session while the reparented editor portal disappeared during final save/reopen re-edit. Later retries aborted before initialization. The conflicting result blocks qualification. |
| 2 | `npm run test:annotation-text-editing:macos` | PASS | Same-SHA production pointer, click-away, Save/reopen, repeat-save, and genuine re-edit run passed. A later diagnostic retry aborted during host initialization and does not replace the completed pass. |
| 3 | `npm run test:editor-coverage:macos` | PASS | `test-artifacts/browser-ui/editor-coverage-manifest.json`: 384 matrix cases and 72 lifecycle cases passed against executable SHA `0b685e…`. |
| 4 | `npm run test:editor-acceptance:macos` | FAIL | `test-artifacts/packaged-editor/acceptance.json`: same-SHA aggregate failed. Its browser-outcome input was supplied as `pass` instead of the required literal `success`, and its native-text child also failed. Assertions were not weakened. |
| 5 | `npm run test:save-render-coherence:macos` | PASS | `test-artifacts/packaged-editor/reports/save-render-coherence.json`: three edits, save/reopen, repeat-save, live render/semantic revision equality, A23 no-resize commit, blocked-draft retention, and 0% crop pixel difference. |
| 6 | `npm run test:editor-performance:macos` | UNVERIFIED | The available performance artifact names SHA `658770ef`, not the qualified SHA, so it is excluded. |
| 7 | `npm run test:large-pdf-performance:macos` | UNVERIFIED | The old 108-page run exposed a hard-coded fixture contract. Commit `2bdc524d` qualifies the controlled manifest-verified 500-page fixture, and focused/unit tests pass, but the packaged 500-page rerun was blocked by the macOS launch crash. |
| 8 | `npm run test:ocr-save:macos` | PASS | Same-SHA aggregate child exited 0. |
| 9 | `npm run test:ocr-edit-single-line:macos` | PASS | Same-SHA aggregate artifact passed. |
| 10 | `npm run test:ocr-edit-regions:macos` | PASS | Same-SHA aggregate artifact passed. |
| 11 | `npm run test:ocr-reflow:macos` | PASS | Same-SHA aggregate artifact passed. |
| 12 | `npm run test:ocr-release-hardening:macos` | UNVERIFIED | A 100-page producer artifact exists for SHA `658770ef`, but no complete release-hardening run was produced for `2bdc524d`; it is excluded. |

Supplemental browser suites `test:native-text-editing:ui`, `test:metadata-editing:ui`, `test:modal-hardening:ui`, and `test:ocr-ui:browser:macos` each passed when run directly before the aggregate. The aggregate did not ingest those results because its outcome token was not the required literal `success`.

## Host launch blocker

After the conflicting native result, two native-text retries and an independent annotation-text retry failed before document open. The app printed its MCP startup line and both PDFium workers became ready, but the frontend never reported ready. Direct launch then exited with status 134.

The following crash reports show `SIGABRT` on the main thread in `___RegisterApplication_block_invoke` -> `_RegisterApplication` -> `NSApplication sharedApplication`, before the Tauri event loop or WebKit page is created:

- `/Users/alexander/Library/Logs/DiagnosticReports/open-pdf-studio-2026-08-30-042132.ips`
- `/Users/alexander/Library/Logs/DiagnosticReports/open-pdf-studio-2026-08-30-042406.ips`
- `/Users/alexander/Library/Logs/DiagnosticReports/open-pdf-studio-2026-08-30-042817.ips`

The failure reproduced both through direct executable spawn and through `/usr/bin/open -n -W`; therefore it is not evidence for changing blank readiness, raster ownership, or the GUI assertions. A fresh interactive macOS session is required to restart the matrix.

## Release metrics

| Required metric | Result | Evidence |
|---|---|---|
| Ten-edit burst write count, before/after | UNVERIFIED | Unit coalescing regressions pass, but no exact-SHA packaged ten-edit benchmark completed. No numeric value is inferred. |
| Save-time zoom/PDF-anchor drift, before/after | UNVERIFIED | Same-SHA coverage preserved live sessions across 100% -> 250% -> 100%, and save-render coherence preserved the editor rectangle exactly at its tested view, but the required post-save anchor-drift measurement was not completed. |
| Visible-page preview latency, before/after | UNVERIFIED | Controlled 500-page fixture identity is now enforced, but the same-SHA packaged performance run did not launch. No old-SHA latency is reused. |
| Save/render pixel coherence | PASS | Persisted PDF crop and mounted view differed by 0%, under the 0.1% maximum. |
| Stale render publication | PASS | Same-SHA coherence report recorded 0 stale publications and 0 rejected stale publications. |
| Placement idle work | PASS | Exact-SHA 384/72 coverage completed with no release-gate placement failure; focused controller tests prove no idle placement loop. |

## Safe-save and provider evidence

The exact-SHA unit/Rust gates pass the coordinated safe-save contracts: candidate validation, hash/length checks, destination identity protection, atomic replacement, rollback/recovery, typed provider errors, and warning/recovery UI projection. Same-SHA packaged save/render coherence also proves repeated persisted edits and clean repeat-save behavior.

The live provider matrix is still blocking. A detailed local/iCloud/OneDrive/APFS report exists for SHA `194cd802`, but it is deliberately not counted for `2bdc524d`. Fresh exact-SHA results are required for local APFS, iCloud states, Dropbox, OneDrive, external APFS, external exFAT, network loss, provider eviction, destination change, locked/read-only, and out-of-space behavior. In particular, exFAT, Dropbox, and isolated provider-network loss remain unavailable on this host and are not simulated into PASS.

## Manual macOS checks

| Check | Result | Notes |
|---|---|---|
| Physical trackpad click-away and pinch | UNVERIFIED | Production pointer automation passed; no physical trackpad observation was recorded. |
| Window blur during click-away | UNVERIFIED | No genuine manual blur run completed. |
| Retina and scaled external display | UNVERIFIED | DPR unit coverage passed; no external-display hardware run completed. |
| Single and continuous modes | UNVERIFIED | Automated same-SHA coverage passed, but the plan separately requires a manual check. |
| Book and facing modes | UNVERIFIED | Automated same-SHA coverage passed, but the manual check did not complete. |
| Inactive-tab save | UNVERIFIED | Owner-isolation tests passed; no manual background-save run completed. |
| Save, Save As, close, and app quit | UNVERIFIED | Packaged automation covered Save, Save As, and close; the combined manual flow did not complete. |
| iCloud/File Provider and external volumes | UNVERIFIED | Exact-SHA live matrix unavailable; no simulation accepted. |
| Finder tags/ACL warning injection | UNVERIFIED | Safe-save unit contracts pass; exact-SHA manual warning injection did not complete. |
| VoiceOver/focus navigation | UNVERIFIED | VoiceOver was not genuinely exercised. |

## 39-finding acceptance matrix

Status counts: 26 PASS, 1 FAIL, 12 UNVERIFIED.

| ID | Result | Closing evidence or remaining gap |
|---|---|---|
| TE-01 | PASS | Same-SHA save/render coherence proves owner, visible-render, and visible-semantic revisions converge before success. |
| TE-02 | PASS | Page-local surface registry tests and 384-case continuous-view coverage pass. |
| TE-03 | UNVERIFIED | The exact-SHA suite did not produce the required packaged shaded/image/gradient/linework visual matrix. |
| TE-04 | PASS | Owner/generation/page registry regressions and lifecycle coverage pass. |
| TE-05 | PASS | DPR 1/2/3, capped-raster, surface-registry, and rotated/zoomed packaged coverage pass. |
| TE-06 | PASS | Exact empty/whitespace persistence, undo, and deterministic replacement tests pass. |
| TE-07 | PASS | Fault-injected cleanup/finally and lifecycle cleanup regressions pass. |
| TE-08 | PASS | Deferred OCR publication tests and same-SHA OCR packaged children pass. |
| TE-09 | PASS | Same/different OCR target identity regressions and packaged OCR region/reflow runs pass. |
| TE-10 | PASS | Watchdog/gesture regressions and 72 packaged lifecycle cases pass. |
| TE-11 | PASS | Typed editor-activation replay tests and packaged lifecycle cases pass. |
| TE-12 | PASS | Semantic command replay regressions and real pointer click-away coverage pass. |
| TE-13 | PASS | Terminal save-result/status tests and same-SHA save-state sequence pass. |
| TE-14 | PASS | Authoritative page publication and 0% persisted/rendered crop difference pass. |
| TE-15 | FAIL | The required final packaged matrix is not clean: aggregate/native acceptance failed and the restart was blocked by `_RegisterApplication` aborts. |
| TE-16 | PASS | Clean V2 draft/no-op revision, undo, write, and byte-identity regressions pass. |
| TE-17 | PASS | Same-SHA A23 proves typed final-layout ownership, zero resize-handle events, successful no-resize commit, and explicit retained-draft rejection. |
| SV-01 | PASS | Save-coordinator burst/coalescing regressions and same-SHA consecutive-edit coherence pass; the numeric ten-edit performance metric remains separately unverified. |
| SV-02 | PASS | Page-scoped invalidation/cache-retention regressions pass. |
| SV-03 | PASS | Immutable owner-snapshot and A-save/B-active isolation regressions pass. |
| SV-04 | UNVERIFIED | Lifecycle unit tests preserve newer editors, but the required same-SHA packaged second-editor-during-save run did not complete. |
| SV-05 | PASS | Every save result reaches a typed terminal state in unit tests and the same-SHA packaged save sequence. |
| SV-06 | PASS | Readiness timeout/recovery tests pass; A23 retains the full draft with actionable recovery. |
| VS-01 | PASS | Per-field view mutation/conflict tests pass. |
| VS-02 | PASS | Deferred logical-anchor restoration tests pass. |
| VS-03 | PASS | Inactive-owner UI isolation tests and tab lifecycle coverage pass. |
| VS-04 | UNVERIFIED | Same-document transition tests pass, but the exact packaged <=1 CSS-pixel save-adoption anchor gate did not complete. |
| VS-05 | PASS | Post-restore required-page/readiness regressions and continuous-mode coverage pass. |
| MS-01 | PASS | Saved-with-warning, recovery-action, and provider-status UI regressions pass without console-only fallback. |
| MS-02 | UNVERIFIED | Exact-SHA live File Provider/external-volume matrix is incomplete; exFAT, Dropbox, and isolated network-loss checks remain unavailable. |
| CV-01 | UNVERIFIED | Visible-first unit gate passes; same-SHA controlled 500-page packaged performance evidence is missing. |
| CV-02 | UNVERIFIED | Preview coalescing unit gate passes; same-SHA sustained-scroll packaged evidence is missing. |
| CV-03 | UNVERIFIED | Directional look-ahead unit gate passes; same-SHA packaged observer-lead evidence is missing. |
| CV-04 | UNVERIFIED | Priority/latency unit gate passes; same-SHA visible-center packaged latency is missing. |
| CV-05 | UNVERIFIED | Native-work accounting unit gate passes; same-SHA backend completion/cap evidence is missing. |
| CV-06 | UNVERIFIED | Adaptive look-ahead unit gate passes; same-SHA packaged performance evidence is missing. |
| CV-07 | UNVERIFIED | Immediate-preview unit gate passes; same-SHA cold-wrapper packaged evidence is missing. |
| CV-08 | UNVERIFIED | Degraded-preview/error-action unit gate passes; same-SHA native-failure packaged evidence is missing. |
| CV-09 | PASS | Page-lease/stable-target tests and packaged continuous click-away/lifecycle coverage pass. |

## Required next run

From a fresh interactive macOS login session, run the twelve packaged commands serially against the unchanged app path above. Supply the browser aggregate token as `OPEN_PDF_STUDIO_BROWSER_ACCEPTANCE_OUTCOME=success`, not `pass`. If native-text acceptance fails again, preserve the app log, viewport/editor placement diagnostics, and crash report; make only the evidenced product fix, produce a new code-qualified SHA, repackage, and restart all twelve commands. Then run the exact-SHA File Provider/manual matrix and update this report in a new report-only commit.
