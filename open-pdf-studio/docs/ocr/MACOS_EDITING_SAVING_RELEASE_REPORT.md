# macOS Editing and Saving Release Report

Generated: 2026-08-30

Branch: `ocr-release-hardening`

Code-qualified SHA: `a71185347eebfb21c2d9b9910a79a7791bf398fb`

Report commit: this report is committed separately. It names the earlier code-qualified SHA and does not change the identity of the packaged application.

## Scope and decision

This report qualifies one exact code SHA and one exact packaged application. The complete static/unit gate, packaged launch preflight, four-suite browser manifest, 100-page OCR producer, and all twelve packaged macOS commands completed against that SHA. No assertion was weakened, no synthetic editor state or test-only entry point was used, and the two native lifecycle runs both passed without retry.

Three blocking acceptance areas remain genuinely unverified: the shaded/image/gradient/linework visual matrix, the dedicated save-adoption zoom/pan anchor measurement, and the complete File Provider/external-volume matrix. Physical trackpad, external-display, VoiceOver, and several combined manual flows were also unavailable and were not converted to automated passes.

**MACOS EDITING AND SAVING NO-GO**

## Implementation delivered

The requested contracts were implemented in separate commits:

- `48aa831c` — owner-scoped editor cleanup and immutable mount tokens;
- `f2da8524` — packaged launch and trusted-input harness hardening;
- `8aa36ca6` — exact-HEAD browser evidence manifest and CI wiring.

Qualification exposed additional product-path failures. Each was fixed narrowly and committed separately through the final code-qualified SHA:

- deterministic physical-input targeting and caret placement;
- delayed native, owned-record, scanned, inserted, and annotation editor cleanup ownership;
- separate packaged RPC timeouts and retained failure evidence;
- document-owner-pure background save alerts and serialization;
- page-rotation ordering before asynchronous render;
- abort-aware retirement of continuous raster streams so obsolete work releases the per-document scheduler cap.

The final scheduler fix is `a7118534` (`fix: settle retired continuous raster streams`). The earlier blank-document readiness and raster-publication-owner commits remain intact. No commits were pushed.

## Exact packaged application identity

Application bundle:

`/Users/alexander/Personal Projects/open-pdf-studio/target/aarch64-apple-darwin/release/bundle/macos/Open PDF Studio.app`

| Component | Architecture | SHA-256 |
|---|---|---|
| `Contents/MacOS/open-pdf-studio` | arm64 | `b188c813950d8986033d7df93fcaac07d34764faed6446969ed1119622eb8f2b` |
| `Contents/MacOS/pdfium-worker` | arm64 | `cdcfdea7579968223b0399777cfb5498bafacd4f36f586782944740e937d2366` |
| `Contents/Resources/libpdfium.dylib` | x86_64 + arm64 universal | `4e587d08486f54f60cd95e79771e7e4067982f3985dede615fc41f59713d2a1c` |

The executable is 72,384,848 bytes. `codesign --verify --deep --strict` passed. The bundle identifier is `org.openaec.openpdfstudio`; CDHash is `794ecd94314c536c446795eb33fe058856b50df7`. The signature is ad-hoc with hardened runtime and no Team Identifier. It proves local integrity and usability only; it is not Developer ID, notarization, Gatekeeper, quarantine-download, updater, or DMG distribution evidence.

The bundled PDFium probe returned ready. The unsandboxed `/usr/bin/open -n -W` preflight reached `webviewReady` as PID 55136 and then terminated cleanly. Its retained evidence is `test-artifacts/packaged-launch-preflight/preflight.json`.

## Qualification gates

The code worktree was clean at `a7118534` before packaging.

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run test` | PASS |
| `npm run test:editor-lifecycle:unit` | PASS — 332/332 |
| `npm run test:large-pdf-performance:unit` | PASS — 79/79 |
| `cargo test -p open-pdf-studio -- --nocapture` | PASS — 85 passed, 3 ignored, plus integration suites |
| `git diff --check` | PASS |
| `npm run package:ocr-release-hardening:arm64` | PASS |
| signature, architecture, executable hashes, and PDFium probe | PASS |
| packaged launch preflight | PASS |

The exact-HEAD browser producer wrote `test-artifacts/browser-ui/browser-acceptance.json`. Its four required suites all exited 0: native text UI, metadata editing UI, modal hardening UI, and macOS OCR browser UI.

The exact-HEAD 100-page producer passed completion and cancellation. It completed 100/100 pages, bounded prefetch to one page, reaped all child processes, passed PDF.js and PDFium readers, and cancelled 45 of 100 pages without late publication. The path was the visible production UI with no synthetic OCR state or test-only OCR entry point.

## Packaged acceptance matrix

The commands ran serially outside the Codex sandbox against the exact bundle above. A product failure in the first 500-page run was retained, diagnosed as two aborted image streams that never settled, fixed in `a7118534`, and followed by a new package and a complete restart from command 1.

| Order | Command | Result | Exact-build evidence |
|---:|---|---|---|
| 1 | `npm run test:native-text-editing:macos` | PASS | Save/reopen, repeat-save, real re-edit, interior-caret click-away, side-by-side isolation, alignment, scroll attachment, substitution width compensation, and first-save commit all passed. |
| 2 | `npm run test:annotation-text-editing:macos` | PASS | Production pointer editing, click-away, Save/reopen, repeat-save, and genuine re-edit passed. |
| 3 | `npm run test:editor-coverage:macos` | PASS | 384 matrix cases and 72 lifecycle cases passed; executable hash matched `b188c8…`. |
| 4 | `npm run test:editor-acceptance:macos` | PASS | Exact browser manifest accepted; native lifecycle passed independently a second time; annotation, save/render, OCR workflow, OCR save, single-line, fixed-region, and reflow children passed. |
| 5 | `npm run test:save-render-coherence:macos` | PASS | Three edits converged all six revisions to 3; stale publications 0; rejected stale publications 0; persisted/rendered crop difference 0%. |
| 6 | `npm run test:editor-performance:macos` | PASS | Typing-to-paint p95 12 ms; warm exact validation 13 ms; ordinary typing task max 3 ms; idle placement reads/writes 0/0. |
| 7 | `npm run test:large-pdf-performance:macos` | PASS | Controlled 500-page fixture passed in two fresh packaged processes after the full restart. |
| 8 | `npm run test:ocr-save:macos` | PASS | Safe Save/Save As, original preservation, candidate cleanup, xattrs, and independent reader checks passed. |
| 9 | `npm run test:ocr-edit-single-line:macos` | PASS | Production single-line OCR edit and persistence passed. |
| 10 | `npm run test:ocr-edit-regions:macos` | PASS | Fixed-region OCR editing and persistence passed. |
| 11 | `npm run test:ocr-reflow:macos` | PASS | OCR reflow editing and persistence passed. |
| 12 | `npm run test:ocr-release-hardening:macos` | PASS | Command exited 0; applicable artifact and filesystem criteria passed. Distribution trust and unavailable provider cases remain explicitly `UNVERIFIED`. |

The packaged coverage and aggregate manifests record `productionUiOnly: true`, `syntheticStateSeeding: false`, and `testOnlyEntryPoint: false`.

## Performance and required metrics

The controlled large-document fixture is a 500-page PDF, 126,962 bytes, SHA-256 `add59dae1cdd27d2776beeaca60f79e5b330007a1ab88425ed61459f57db74ec`.

| Required metric | Result | Before | After / exact-SHA evidence |
|---|---|---|---|
| Ten-edit burst write count | UNVERIFIED | No trustworthy packaged baseline | Coalescing and terminal-save regressions pass, but no exact packaged ten-edit numeric write-count measurement was produced. |
| Save-adoption zoom/PDF-anchor drift | UNVERIFIED | No trustworthy packaged baseline | Save/render coherence reproduced the editor rectangle exactly before and after reopen; the separate 500-page zoom gesture measured 0 px drift. Neither is the required noncentral save-adoption before/after measurement. |
| Visible-page preview latency | PASS | No trustworthy packaged baseline | Visible first-preview p95 39 ms; cached-preview p95 3 ms; blank-with-source max 30 ms; full-quality max 530 ms. |
| Typing-to-paint | PASS | Not measured | p95 12 ms, below 16 ms. |
| Warm exact validation | PASS | Not measured | 13 ms, below 100 ms. |
| Save/render pixel coherence | PASS | Not applicable | 0% differing pixels, below the 0.1% limit. |
| Stale retired publication | PASS | Not applicable | 0 stale retired publications; retired native work peak 2. |
| Placement idle work | PASS | Not applicable | 0 reads and 0 writes while idle. |

Additional 500-page results: cold open 260 ms; scroll-handler p95 1 ms; visible cold pages suppressed 0; useful visible previews cancelled 0; mounted page surfaces peak 5; thumbnails peak 27; zoom input-to-transform p95 13 ms; 100% of zoom frames below 20 ms; final pixel difference 0%; second traversal memory growth 0; two fresh packaged process runs passed.

The 100-page OCR producer measured total OCR median 1,496 ms and p95 1,552 ms, UI median 4 ms and p95 7 ms, UI publication peak 8.06 Hz, and bookkeeping CPU 0.0023%.

## Safe-save, providers, and distribution evidence

The exact-SHA filesystem report is `output/ocr-release-hardening/filesystem-latest.json`.

| Case | Result | Evidence or limitation |
|---|---|---|
| Local APFS coordinated transaction | PASS | Coordinated atomic replacement, repeated save, valid PDF, candidate cleanup. |
| Destination changed externally | PASS | Rejected with `DESTINATION_CHANGED`; external edit preserved; no blind retry. |
| Read-only destination | PASS | Save rejected; original preserved; candidate removed. |
| Finder-locked destination | PASS | Save rejected; original preserved; candidate removed. |
| Advisory file lock | PASS | Save rejected; original preserved; candidate removed. |
| External APFS | PASS | Distinct-device atomic transaction and repeat-save passed. |
| Disk full | PASS | ENOSPC observed; original preserved; candidate removed. |
| OneDrive File Provider | PASS | Live provider transaction and repeated save passed. |
| iCloud cloud-only before open | PASS | Live eviction observed; typed not-materialized recovery; original preserved. |
| iCloud upload in progress | PASS | Live upload observed and completed. |
| Provider eviction | PASS | Live eviction and fail-closed recovery passed. |
| iCloud Drive transaction | PASS | Live save and upload passed. |
| External exFAT | UNVERIFIED | `hdiutil` could not create or mount the image: operation not permitted. |
| Dropbox File Provider | UNVERIFIED | Dropbox is not configured on this host. |
| Isolated provider network loss | UNVERIFIED | No provider-only network fault was available without changing host-wide connectivity. |

The artifact report passed arm64 packaging, bundled probes/assets/checksums, hardened-runtime compatibility, code-sign verification, entitlements review, cleanup, and size measurement. Developer ID signing, notarization, Gatekeeper assessment, and quarantine-download launch remain `UNVERIFIED`, as expected for the explicitly local ad-hoc package.

## Manual macOS checks

Automated evidence is cited as support only. It does not substitute for a physical observation where the runbook requires one.

| Check | Result | Host observation and supporting evidence |
|---|---|---|
| Physical trackpad click-away and pinch | UNVERIFIED | No `AppleMultitouchTrackpad` device was exposed. Production pointer/click-away and zoom automation passed. |
| Window blur during click-away | UNVERIFIED | Blur/watchdog unit coverage passed; no genuine manual window-blur run was recorded. |
| Retina and scaled external display | UNVERIFIED | The built-in 3456×2234 Retina display was present; no external display was connected. DPR coverage passed. |
| Single and continuous modes | UNVERIFIED | Same-SHA packaged matrix coverage passed, but no manual observation was recorded. |
| Book and facing modes | UNVERIFIED | Same-SHA packaged matrix coverage passed, but no manual observation was recorded. |
| Inactive-tab save | UNVERIFIED | Owner-isolation and lifecycle coverage passed; no manual background-tab save was recorded. |
| Save, Save As, close, and app quit | UNVERIFIED | Packaged automation covered the component flows; the combined manual flow was not recorded. |
| iCloud/File Provider and external volumes | UNVERIFIED | Live iCloud, OneDrive, and external APFS passed; exFAT, Dropbox, and isolated network loss remain unavailable. |
| Finder tags/ACL warning injection | UNVERIFIED | Finder lock, permissions, advisory lock, warning-state, and recovery tests passed; the exact manual tags/ACL flow was not recorded. |
| VoiceOver/focus navigation | UNVERIFIED | VoiceOver was not running and no physical accessibility-navigation session was performed. |

## 39-finding acceptance matrix

Status counts: 36 PASS, 0 FAIL, 3 UNVERIFIED.

| ID | Result | Closing evidence or remaining gap |
|---|---|---|
| TE-01 | PASS | Exact-SHA coherence proves owner, visible-render, and visible-semantic revisions converge before save success. |
| TE-02 | PASS | Page-local surface registry tests and 384-case packaged continuous-view coverage pass. |
| TE-03 | UNVERIFIED | No exact packaged shaded/image/gradient/linework visual matrix was produced; generic visual coherence is insufficient for this specific gate. |
| TE-04 | PASS | Owner/generation/page registry regressions and packaged lifecycle coverage pass. |
| TE-05 | PASS | DPR 1/2/3, capped-raster, surface registry, rotation, and zoom coverage pass. |
| TE-06 | PASS | Exact empty/whitespace persistence, undo, and deterministic replacement regressions pass. |
| TE-07 | PASS | Fault-injected cleanup/finally and owner-scoped cleanup regressions pass. |
| TE-08 | PASS | Deferred OCR projection/publication tests and all exact-SHA OCR packaged children pass. |
| TE-09 | PASS | Same/different OCR target identity regressions and packaged region/reflow runs pass. |
| TE-10 | PASS | Gesture watchdog regressions and both packaged native lifecycle runs pass. |
| TE-11 | PASS | Typed activation/replay tests and deterministic trusted physical-input evidence pass. |
| TE-12 | PASS | Semantic pointer-command replay and real packaged click-away coverage pass. |
| TE-13 | PASS | Structured terminal save-result/status tests and the packaged save-state sequence pass. |
| TE-14 | PASS | Authoritative page publication and 0% persisted/rendered crop difference pass. |
| TE-15 | PASS | The complete exact-SHA packaged matrix passed, including two independent native lifecycle runs and pixel assertions. |
| TE-16 | PASS | Clean V2 draft/no-op revision, undo, write, and byte-identity regressions pass. |
| TE-17 | PASS | A23 binds final layout to the typed draft, records zero resize-handle events, commits a safe no-resize edit, and retains an impossible-fit draft. |
| SV-01 | PASS | Burst coalescing, terminal-save, and no-viewport-reset regressions pass; the separately requested numeric ten-edit metric remains unverified. |
| SV-02 | PASS | Page-scoped invalidation and unrelated warm-cache retention regressions pass. |
| SV-03 | PASS | Immutable owner-snapshot and A-save/B-active data-isolation regressions pass. |
| SV-04 | PASS | Owner-scoped cleanup regressions plus two packaged lifecycle runs prove an older save/cleanup cannot cancel the newer editor. |
| SV-05 | PASS | Every save result reaches a typed terminal state in unit and packaged sequences. |
| SV-06 | PASS | Readiness timeout/recovery tests pass; impossible layout retains the complete draft and actionable recovery. |
| VS-01 | PASS | Per-field view mutation/conflict tests pass. |
| VS-02 | PASS | Deferred logical-anchor restoration tests pass. |
| VS-03 | PASS | Inactive-owner UI isolation and packaged tab-lifecycle coverage pass. |
| VS-04 | UNVERIFIED | Proxy transition tests pass, but the dedicated same-document save-adoption zoom/pan and ≤1 CSS-pixel anchor measurement was not produced. |
| VS-05 | PASS | Post-restore required-page/readiness regressions and continuous-mode coverage pass. |
| MS-01 | PASS | Saved-with-warning, recovery-action, and provider-status UI regressions pass without console-only fallback. |
| MS-02 | UNVERIFIED | Exact-SHA local APFS, iCloud, OneDrive, and external APFS passed; exFAT, Dropbox, and isolated provider-network loss remain unavailable. |
| CV-01 | PASS | Exact packaged 500-page active-scroll run published visible first previews at p95 39 ms with no cold suppression. |
| CV-02 | PASS | Per-page preview coalescing regressions and exact packaged sustained-scroll evidence pass with zero useful-preview cancellation. |
| CV-03 | PASS | Directional look-ahead regressions and exact packaged active-scroll coverage pass. |
| CV-04 | PASS | Visible-center priority regressions and exact packaged preview/full-raster latency gates pass. |
| CV-05 | PASS | Abort-aware retirement, backend-completion regressions, peak retired-work cap 2, and zero stale publication pass. |
| CV-06 | PASS | Adaptive look-ahead regressions and exact packaged scroll/zoom performance gates pass. |
| CV-07 | PASS | Immediate preview-on-mount regressions and blank-with-source max 30 ms pass. |
| CV-08 | PASS | Failure/degraded-preview/retry-action regression passes; exact packaged performance records zero later pages blocked by page-local failure. |
| CV-09 | PASS | Page-lease/stable-target regressions and packaged continuous click-away/lifecycle coverage pass. |

## Remaining work required to clear the release gate

Run the shaded/image/gradient/linework visual matrix, capture the dedicated save-adoption zoom/pan anchor metric, and complete live exFAT, Dropbox, and isolated provider-network-loss transactions against this code identity or a newly packaged successor. Also perform the unavailable physical trackpad, external-display, VoiceOver, and combined manual flows. Any product change requires a new code-qualified SHA, a new package, and a complete restart of the twelve-command matrix.
