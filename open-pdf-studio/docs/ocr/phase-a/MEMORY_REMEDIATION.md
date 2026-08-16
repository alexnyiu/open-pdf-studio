# OCR Phase A memory and resource-lifetime remediation

## Finding

The original long-lived WebView path retained 386.22 MiB of cohort RSS two seconds after `Worker.terminate()`. A separate reproduction retained 370.23 MiB. This was not a second live PaddleOCR model or a growing JavaScript object graph: a second recognition added only about 43 MiB and reused the already-resident pages instead of adding another approximately 386 MiB.

The decisive macOS profile was taken about 30 seconds after the original Worker had terminated. `vmmap` reported a 108.1 MiB physical footprint versus a 469.5 MiB peak, while the WebKit malloc regions still had 384.5 MiB resident but only about 66.1 MiB allocated. That gap, plus the plateau on a second run, is consistent with WebKit allocator/clean-page retention. It is not evidence of live ONNX sessions or a cycle-over-cycle process leak. Worker recreation cannot bound process RSS because a Web Worker remains inside the same WebContent process.

## Chosen boundary

Each Phase A job now uses a one-job native child instance of the Open PDF Studio executable. The parent reserves an idle PDFium sidecar, rasterizes the page at low priority, writes a versioned private mode-0600 job envelope, drops its RGBA vectors, and starts the child. The child creates one application-owned OCR Worker, returns validated result JSON, disposes or cancels the Worker, writes a private result file, and exits. Temporary job/result files are removed by a Rust cleanup guard.

This keeps the existing OCR engine/result v1 contract intact. It also keeps PaddleOCR in the existing Web Worker adapter, so the remediation does not introduce a native OCR implementation or a new OCR dependency. A dedicated long-lived Worker or recreating the Worker after each job was rejected because the original spike already recreated the Worker and still retained the pages in the editor's WebContent allocator. A separate native OCR executable remains possible future architecture work, but the passing macOS boundary does not require one.

## Packaged macOS arm64 checkpoint measurements

Measured on Darwin 25.5.0, arm64, Node 25.6.1, using a fresh packaged release application process and 50 ms OS RSS sampling. RSS sums the native editor/PDFium process tree and—while alive—the isolated OCR child plus WebKit XPC processes first observed while that child is active. The editor's long-lived WebView is excluded because macOS reparents it to launchd, PID proximity cannot prove ownership, and this isolated path never transfers page or model bytes into it. A baseline drop beyond 64 MiB fails closed as unstable attribution instead of masquerading as cleanup.

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
| After 10 recognition and 10 cancellation cycles | 172.91 MiB | +5.84 MiB |

The unchanged RSS in the few milliseconds between disposal checkpoints is expected allocator behavior: lifecycle telemetry already confirms that the sessions and live references are gone, but the child WebContent process still owns resident pages until it exits. At two seconds, the child application and all three child WebKit processes are absent.

Across the 20-cycle gate, every job used a distinct child PID, all children exited with status 0, and no OCR child remained at the final checkpoint. The maximum per-cycle settled delta was 12.73 MiB, the final delta was 5.84 MiB, the minimum settled delta was 5.83 MiB, and the fitted trend was -0.35 MiB per cycle. The predeclared gate requires no more than 32 MiB retained, no more than +2 MiB/cycle trend, ten recognitions, ten cancellations, a distinct child for every job, no surviving child, and stable attribution; it passed without relaxing the original acceptance problem.

The isolated cold job took 1,403.53 ms end to end. Inside it, Worker startup was 7 ms, model/session startup 436 ms, low-priority rasterization 45.60 ms, detection 221 ms, recognition 252 ms, and OCR compute 473 ms. All ten recognition cycles exactly matched the selected fixture. Cancellation delays of 0, 25, 75, 150, and 300 ms were repeated twice; all ten returned `worker.terminate`.

After the 20-cycle run, the packaged editor and four PDFium workers remained at 172.91 MiB. The OCR child/WebContent processes no longer existed, and the gate launcher subsequently terminated the packaged editor process tree.

The complete current machine-readable evidence is `measurements/macos-arm64-production-gate.json`. `measurements/macos-arm64-remediation.json` preserves the earlier debug-build remediation run but is not eligible for the production matrix.

## Resource ownership audit

| Resource | Successful recognition | Cancellation |
| --- | --- | --- |
| JavaScript page references | Original IPC job envelope and page references set to `null`; reported live count 0 | Pending request map cleared; child exits |
| ONNX Runtime sessions | Both `InferenceSession.release()` calls awaited and acknowledged | Worker is terminated immediately; child exit reclaims in-flight WASM/session state |
| Inference tensors and outputs | Optional tensor `dispose()` invoked; local references cleared in `finally` | Child exit is the hard boundary |
| OpenCV.js | Not used; zero allocations | Not used; zero allocations |
| `ImageData` / `ImageBitmap` | Not used; there is no bitmap to close | Not used |
| `TypedArray` / `ArrayBuffer` | Exact RGBA buffer transferred; sender buffer observed detached; Worker drops its view | Same transfer rules if reached; process exit handles an in-flight buffer |
| Model bytes/cache | Fetch uses `cache: 'no-store'`; dictionary and model byte references are cleared after session creation | Child-local cache/process is destroyed |
| Event listeners | `onmessage`, `onerror`, and `onmessageerror` cleared before Worker termination | Cleared during termination |
| Message ports | No explicit ports used; none remain open | No explicit ports used |
| Stale results | Pending map is cleared and listeners are detached; unit test invokes a saved stale callback and confirms no request is retained | Same path |
| Duplicate models | One adapter load per child; measured maximum adapter instances is 1 | A fresh one-job child is used |

The successful path calls the engine's asynchronous `dispose()` method and waits for the Worker's disposal acknowledgment before termination. Cancellation deliberately prioritizes prompt termination over waiting for an in-flight ONNX call to unwind. The process boundary makes both paths bounded.

## Production scope and deferred platforms

The bounded result is verified live against the packaged macOS arm64 release app. The latest complete re-evaluation is `measurements/macos-arm64-production-gate.json`: its maximum settled delta was 12.73 MiB, final delta was 5.84 MiB, trend was -0.35 MiB/cycle, attribution was stable, and all 20 children exited. macOS arm64 is the current production target, and the separate decision in `measurements/macos-production-decision.json` is `MACOS PRODUCTION GO`.

The macOS Intel packaging defect found during re-evaluation is fixed: cross-target builds no longer fall back to the host worker, every sidecar is parsed and architecture-checked before bundling, and x86_64 plus universal workers both initialized the universal PDFium library locally. Universal arm64/x86_64 packaging is built and architecture-checked. Native Intel GUI certification remains unverified without real Intel hardware.

Windows/WebView2 and Linux/WebKitGTK remain unavailable on this host and are deferred from the current product scope. Their harmless scaffolding is preserved: Linux retains the sidecar in its merged Tauri config and searches the AppImage/deb resource directory, while CI retains advisory 20-cycle runs for both platforms. Missing or failing Windows/Linux OCR evidence is not a macOS release blocker. No production support claim is made for either platform; the unchanged all-desktop evaluator remains available for future qualification.
