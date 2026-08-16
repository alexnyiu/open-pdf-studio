# OCR Phase A feasibility spike

This directory records the Phase A feasibility spike and its memory/resource-lifetime remediation. It proves one deliberately narrow path: a selected PDF fixture page is rasterized by an idle PDFium sidecar, recognized offline by PP-OCRv6 Small in an application-owned Web Worker, and returned as versioned, validated JSON. Each shipped spike job now runs in a disposable instance of the application process because terminating only the Worker did not return retained WebKit allocator pages to the long-lived editor process.

The current production scope is macOS arm64 only. Windows and Linux scaffolding remains available for future qualification, but neither platform is a current OCR release blocker and no production support claim is made for either one. Universal arm64/x86_64 macOS packaging is built and architecture-checked; native Intel GUI certification remains unverified because real Intel hardware was not available.

The spike does not expose end-user UI, touch the text editor, write OCR text into a PDF, add a PDF writer, or add ribbon controls or dialogs.

## Implemented boundary

- Engine contract: `js/ocr/contracts/engine.v1.schema.json`
- Result contract: `js/ocr/contracts/result.v1.schema.json`
- Runtime validators: `js/ocr/contracts/v1.js`
- Application-owned Worker lifecycle and termination cancellation: `js/ocr/engine.js`
- PP-OCRv6 Small ONNX/WASM adapter: `js/ocr/paddleocr/adapter.js`
- Worker entry point with enforced same-application-origin loading and a blocked external fetch self-test: `js/ocr/paddleocr/worker.js`
- One-job child frontend and resource evidence: `js/ocr/child-runner.js`
- Development-only spike orchestrator: `js/ocr/spike.js`
- Idle-only PDFium raster and native process boundary: `src-tauri/src/ocr_phase_a.rs`
- Development measurement entry point: MCP tool `app_ocr_phase_a_spike`
- Cross-platform gate launcher: `scripts/run-ocr-phase-a-gate.mjs`
- Current macOS production evaluator: `scripts/evaluate-ocr-phase-a-macos-report.mjs`
- Preserved all-desktop future-qualification evaluator: `scripts/evaluate-ocr-phase-a-reports.mjs`
- Sidecar format/architecture verifier: `scripts/verify-pdfium-sidecar.mjs`

The OCR command has no in-process PDFium fallback. It waits up to five seconds to atomically reserve a sidecar whose queue depth is zero, then fails rather than starting behind already queued or active interactive rendering. The raster buffer moves directly from the PDFium sidecar through Rust into the private one-job envelope; it is not retained by the editor WebView.

The engine and result v1 contracts are unchanged by the remediation. Successful jobs explicitly dispose the adapter and both ONNX Runtime sessions before terminating the Worker. Cancellation terminates the Worker immediately. In both cases, the child app and its WebContent process then exit, providing the hard reclamation boundary that Worker recreation alone could not provide.

## Reproduce

Run the contract, cancellation, adapter, asset, and fixture tests:

```text
npm run test:ocr
```

Run a production frontend build:

```text
npm exec vite -- build
```

For the ordinary development path, start a fresh app in one terminal and run the harness in another:

```text
npm run tauri:dev:debug
npm run measure:ocr
```

For the repeatable production-eligible macOS path, build the package and let the gate own the exact `CFBundleExecutable`:

```text
npm run tauri build -- --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
node scripts/run-ocr-phase-a-gate.mjs --app '../target/release/bundle/macos/Open PDF Studio.app/Contents/MacOS/open-pdf-studio' --report docs/ocr/phase-a/measurements/macos-arm64-local.json
node scripts/evaluate-ocr-phase-a-macos-report.mjs docs/ocr/phase-a/measurements/macos-arm64-local.json --app '../target/release/bundle/macos/Open PDF Studio.app' --output docs/ocr/phase-a/measurements/macos-production-decision-local.json
```

The launcher waits for the native MCP listener and the actual WebView bridge, supplies the exact root PID to the RSS sampler, runs ten recognition and ten cancellation cycles, validates the report, and terminates the app process tree. The macOS evaluator then combines that unchanged live report with read-only verification of the packaged `.app`, macOS sidecar architectures, universal PDFium library, and pinned model/runtime checksums. Its exact outcomes are `MACOS PRODUCTION GO` and `MACOS PRODUCTION NO-GO`.

CI still runs the same launcher against the Windows release executable and Linux AppImage as non-blocking qualification scaffolding. The unchanged all-desktop evaluator still requires all three live reports and can emit only `PRODUCTION GO` or `EVALUATION GO, PRODUCTION NO-GO`; it does not represent current macOS-only release readiness.

The harness records every requested lifecycle checkpoint, then runs at least ten successful recognition jobs and ten cancellation jobs. After the final repeated-cycle memory checkpoint, it opens the fixture in the viewer and records viewer-command round trips while an additional isolated OCR job is active. Set `OPS_OCR_REPORT_PATH` to save the result; the latest macOS production-gate evidence is `measurements/macos-arm64-production-gate.json`.

See `MEMORY_REMEDIATION.md` for the diagnosis and ownership audit, `SMOKE_TESTS.md` for platform-specific setup, `DEPENDENCIES.md` and `checksums.sha256` for provenance, and `GO-NO-GO.md` for the current decision. `measurements/macos-production-decision.json` is the current macOS-scoped decision. `measurements/production-decision.json` remains the intentionally unchanged all-desktop decision. `measurements/macos-arm64-remediation.json` preserves the first successful isolation run, `measurements/macos-arm64-final.json` preserves the earlier re-evaluation, and `measurements/macos-arm64.json` remains the unremediated baseline.
