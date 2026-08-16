# OCR Phase A macOS production-scope decision

## Decision

**MACOS PRODUCTION GO**

The original production blocker was real but was not a live PaddleOCR leak. A long-lived macOS WebContent process retained about 386 MiB of released allocator pages after `Worker.terminate()`. The fix is a disposable one-job instance of the Open PDF Studio executable: it owns one OCR Worker and exits after recognition or cancellation, making process exit the hard memory-reclamation boundary.

That boundary now passes the unchanged memory budget in a packaged macOS arm64 release build. The latest complete run used ten recognition jobs and ten cancellation jobs in 20 distinct child processes. No child survived, the maximum settled delta was 12.73 MiB, the final delta was 5.84 MiB, and the fitted trend was -0.35 MiB/cycle. The fixed limits remain 32 MiB retained and +2 MiB/cycle.

Six concrete measurement/packaging defects discovered during re-evaluation were also fixed:

- macOS RSS no longer guesses editor WebKit ownership from PID proximity. It includes the app/PDFium tree and only WebKit XPC processes born while a known OCR child is active.
- A suspicious baseline drop greater than 64 MiB now fails the gate instead of being counted as cleanup, and debug-build reports are ineligible.
- Linux no longer removes `binaries/pdfium-worker` from the merged Tauri configuration.
- Cross-target builds cannot copy a host-architecture worker under a target-architecture filename; Mach-O, PE, and ELF workers are validated before bundling.
- The Linux sidecar searches the Tauri AppImage/deb resource directories for `libpdfium.so`, and the AppImage smoke now executes `pdfium-worker --probe-pdfium`.
- The macOS CI gate now launches the actual `CFBundleExecutable`, `Contents/MacOS/open-pdf-studio`, rather than the nonexistent display-name path.

The product scope is now macOS only for OCR production. macOS arm64 is the live production target, so the passing packaged macOS evidence is sufficient for `MACOS PRODUCTION GO`. Universal arm64/x86_64 packaging is built and architecture-checked. The x86_64 worker launched under Rosetta and initialized the universal PDFium library, but native Intel GUI certification remains unverified without real Intel hardware.

Windows and Linux are deferred. Their existing scaffolding is preserved and their CI qualification runs remain useful, but they are non-blocking for the macOS OCR release and no production support claim is made for either platform. The unchanged all-desktop evaluator still reports `EVALUATION GO, PRODUCTION NO-GO` until live Windows and Linux reports pass; that future-qualification result must not be presented as the macOS decision.

This decision authorizes only the next planned gate: promoting the Phase A contracts and isolated child pipeline into production OCR foundations. That promotion is not implemented here. No OCR UI, text-editor change, searchable layer, or PDF writing was added.

## Current gate results

| Check | Result | Evidence or limitation |
| --- | --- | --- |
| PaddleOCR recognition quality | Pass for the selected Phase A page | Exact normalized text in all ten recognition cycles and the concurrent-viewer probe; edit distance 0 |
| Offline operation | Pass at the OCR boundary | Every Worker fetch is same-application-origin only, each recognition runs a blocked external-URL self-test, and vendored checksums pass |
| Worker cancellation | Pass | 10/10 cancellation jobs terminated their Worker at delays from 0 to 300 ms |
| Stale-result rejection | Pass | Pending state/listeners are cleared and a saved stale callback cannot reattach a result |
| Memory and repeated cycles | Pass on macOS arm64 | 10 recognitions + 10 cancellations, 20 unique children, no survivor, bounded below the approved limits |
| Viewer responsiveness | Pass on macOS arm64 | Six viewer commands completed successfully before concurrent OCR returned |
| Resource cleanup | Pass | Engine disposal, ONNX release, tensor/output disposal, detached transfer buffer, listener removal, and process exit were observed |
| macOS packaging | Production pass; arm64 live | Packaged arm64 `.app` and sidecar passed live; universal arm64/x86_64 packaging and PDFium architectures are checked; native Intel GUI remains uncertified |
| Windows compatibility | Deferred; not supported in production | PE/x86_64 validation, packaging path, working-set sampler, hidden child, and gate orchestration are preserved for future qualification |
| Linux compatibility | Deferred; not supported in production | Sidecar inclusion, ELF validation, AppImage PDFium probe, RSS sampler, Xvfb/DBus launch, and gate orchestration are preserved for future qualification |

The selected clean Latin page is the approved Phase A live target. The other CC0 fixtures remain deterministic corpus seeds, not broad production-accuracy claims. Low contrast, skew, rotated or curved text, handwriting, and tables remain unqualified.

## Latest macOS memory measurements

The latest machine-readable report is `measurements/macos-arm64-production-gate.json`, measured on Darwin 25.5.0 arm64 with Node 25.6.1 against the packaged release app. RSS sums the native editor/PDFium process tree and—while alive—the isolated OCR child and WebKit XPC processes born during that child's lifetime. The long-lived editor WebView is excluded from the RSS acceptance cohort because macOS reparents XPC processes to launchd, making ownership guesses unreliable, and the isolated path never sends its raster or model bytes to that WebView.

| Checkpoint | Cohort RSS | Delta from process start |
| --- | ---: | ---: |
| Process start | 167.06 MiB | 0 MiB |
| Before model initialization | 452.50 MiB | +285.44 MiB |
| After model initialization | 782.19 MiB | +615.13 MiB |
| After one-page inference | 818.55 MiB | +651.48 MiB |
| Immediately before disposal | 818.55 MiB | +651.48 MiB |
| After OCR engine disposal | 818.55 MiB | +651.48 MiB |
| Two seconds after Worker termination | 179.56 MiB | +12.50 MiB |
| Five seconds after Worker termination | 179.44 MiB | +12.38 MiB |
| Thirty seconds after Worker termination | 179.45 MiB | +12.39 MiB |
| After ten recognition + ten cancellation cycles | 172.91 MiB | +5.84 MiB |

The equal readings immediately before and after disposal are allocator retention in the still-running child WebContent process, not skipped cleanup. Both ONNX sessions had been released and live page/buffer references had been dropped. After child-process exit, the cohort returned within budget. The maximum per-cycle settled delta was 12.73 MiB, the final delta was 5.84 MiB, the minimum settled delta was 5.83 MiB, and the cycle trend was -0.35 MiB/cycle. This is bounded allocator retention rather than a live or process-level leak.

## Timing, quality, offline behavior, and size

| Measure | Result |
| --- | ---: |
| Cold isolated wall time | 1,403.53 ms |
| Worker startup | 7 ms |
| Model/session startup | 436 ms |
| Low-priority PDFium raster | 45.60 ms |
| Detection | 221 ms |
| Recognition | 252 ms |
| OCR compute total | 473 ms |
| Recognition wall range | 1,284.61-1,403.53 ms |
| Cancellation wall range | 450.95-768.19 ms |
| Selected-page normalized accuracy | 100%; all cycles exact |
| Built OCR assets/chunks | 42.68 MiB (44,749,405 bytes) |
| Total frontend distribution | 69,170,346 bytes |

The offline policy guarded every OCR Worker fetch. The cold recognition made five allowed local fetches; each of the ten recognition children blocked its deliberately external self-test URL before any native fetch could occur. Model, dictionary, runtime, package-lock, and license checksums passed. The host network interface was not disabled, but external Worker I/O is mechanically denied rather than merely inferred from a request log.

The viewer probe ran an additional isolated OCR job for 1,268.52 ms. All six concurrent viewer commands succeeded and completed first; their maximum round trip was 2.15 ms. No new viewer-latency budget was invented.

## Resource-lifetime classification

- The successful path calls and awaits `OcrEngine.dispose()`.
- Both ONNX Runtime sessions receive `release()`; inference tensors and outputs are disposed where supported.
- OpenCV.js, `ImageData`, explicit `ImageBitmap`, and explicit `MessagePort` are not used, so their allocation counts are zero.
- The parent and child drop the private job envelope and raster vectors. The exact RGBA `ArrayBuffer` is transferred, the sender is observed detached, and the Worker drops its view.
- Worker `message`, `error`, and `messageerror` handlers are removed; pending requests are cleared and stale results are ignored.
- Each child creates at most one adapter/model instance. No duplicate model remains alive.
- Forced cancellation terminates the Worker immediately; child-process exit reclaims in-flight ONNX/WASM state.

The chosen fix remains a one-job native child of the same application. Recreating only the Worker cannot bound process RSS because WebKit retains released pages in its long-lived WebContent allocator.

## macOS gate and preserved all-desktop evaluator

`scripts/run-ocr-phase-a-gate.mjs` launches the target app/package, waits for the actual WebView bridge—not merely the native socket—runs the complete measurement with an explicit root PID, and terminates the app process tree. `.github/workflows/ci.yml` invokes it against:

- the ad-hoc-signed universal macOS app;
- the Windows release executable with the staged PDFium DLL;
- the Linux AppImage under DBus and Xvfb after the AppImage sidecar/PDFium probe.

`scripts/evaluate-ocr-phase-a-macos-report.mjs` is the current production gate. It requires the packaged `.app`, live Darwin arm64 evidence, at least ten recognition and ten cancellation cycles, one unique disposable native child per job, no surviving child, no more than 32 MiB settled retained RSS, no more than +2 MiB/cycle growth, exact golden text, offline enforcement, stale-result rejection, viewer responsiveness, resource cleanup, verified model/runtime dependency checksums, a valid arm64 packaged sidecar, architecture-checked universal packaging inputs, and PDFium initialization evidence. Its output is exactly one of `MACOS PRODUCTION GO` or `MACOS PRODUCTION NO-GO`.

The macOS evaluator does not reinterpret or edit measured values. It reads the existing packaged macOS report and statically verifies the already-built app, staged thin sidecars, universal PDFium library, and pinned assets. Windows and Linux reports are neither inputs nor criteria for this decision.

`scripts/evaluate-ocr-phase-a-reports.mjs` is preserved without a scope or meaning change for possible future all-desktop support. It still requires current schema-v3 release/package reports for `darwin`, `win32`, and `linux`, and its output remains exactly one of `PRODUCTION GO` or `EVALUATION GO, PRODUCTION NO-GO`. CI treats that complete-desktop qualification and the deferred Windows/Linux live OCR steps as advisory for the current macOS release.

## Engine recommendation

PaddleOCR remains the primary production OCR engine on macOS. Recognition, latency, cancellation, offline enforcement, resource cleanup, and the bounded isolation strategy pass. Tesseract remains an unbenchmarked future fallback; this phase makes no accuracy, performance, packaging, or support claim for it.

## Commands and outcomes

- `npm run verify:ocr-assets`: passed.
- `npm run test:ocr`: passed, including contracts, cancellation, stale results, offline guard, assets, fixtures, memory attribution, build classification, the unchanged all-desktop evaluator, and the macOS evaluator.
- `npm run test:quality`: passed, 31 tests including the macOS bundle executable path, Linux config, and cross-format sidecar validation.
- `npm run tauri build -- --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'`: passed and produced the packaged arm64 release app, with existing Vite/Rust warnings.
- `cargo test -p pdfium-worker`: passed (5 passed, 1 ignored; integration probe ignored by design).
- `cargo test -p open-pdf-studio mcp_server::tests::initialize_response_shape`: passed.
- `cargo check -p open-pdf-studio`: passed with existing unrelated Rust warnings.
- `cargo check -p open-pdf-studio --target x86_64-apple-darwin`: passed with the same warnings.
- arm64, x86_64, and universal macOS sidecar architecture verification: passed.
- arm64, x86_64-under-Rosetta, and universal `--probe-pdfium`: passed.
- `node scripts/run-ocr-phase-a-gate.mjs --app '../target/release/bundle/macos/Open PDF Studio.app/Contents/MacOS/open-pdf-studio' --report docs/ocr/phase-a/measurements/macos-arm64-production-gate.json`: passed and cleaned up the packaged app process tree.
- `node scripts/evaluate-ocr-phase-a-macos-report.mjs docs/ocr/phase-a/measurements/macos-arm64-production-gate.json --app '../target/release/bundle/macos/Open PDF Studio.app' --output docs/ocr/phase-a/measurements/macos-production-decision.json`: `MACOS PRODUCTION GO` with no failures; the measured report was not changed.
- `node scripts/evaluate-ocr-phase-a-reports.mjs docs/ocr/phase-a/measurements/macos-arm64-production-gate.json --output docs/ocr/phase-a/measurements/production-decision.json`: the preserved all-desktop result remains `EVALUATION GO, PRODUCTION NO-GO` because Windows and Linux reports are absent.
- Local Linux AppImage execution: unavailable on macOS; shell syntax and regression tests passed, and the real smoke remains a Linux CI gate.
- Windows/WebView2 and Linux/WebKitGTK live reports: not run in this environment.

Stop at this phase boundary. The next gate is promotion of the Phase A contracts and isolated child pipeline into production OCR foundations. Do not implement OCR UI, searchable PDF writing, visible editing, paragraph reflow, handwriting, table editing, or other later OCR work as part of this decision.
