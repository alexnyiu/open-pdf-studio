# OCR Phase A smoke tests

These checks exercise only the Phase A spike and its one-job memory boundary. They do not expose OCR UI or modify a PDF. Run the measurement against a freshly launched app; otherwise the `processStart` baseline is not comparable.

## Common acceptance checks

1. Install the repository's normal platform prerequisites and run `npm ci`.
2. Run `npm run verify:ocr-assets` and `npm run test:ocr`.
3. Run `npm exec vite -- build`; confirm the build emits two local model files, the dictionary, `ort-wasm-simd-threaded`, and an OCR Worker chunk.
4. Build the target release package and launch the exact packaged executable with `scripts/run-ocr-phase-a-gate.mjs`; debug runs are diagnostic only and cannot enter the production matrix.
5. Allow roughly one minute: the launcher deliberately waits for the 2-, 5-, and 30-second checkpoints and then runs ten recognitions plus ten cancellations.
6. Require `schemaVersion: 3`, `environment.buildKind: "packaged-release"`, `environment.debugBuild: false`, ten exact recognition cycles, ten `worker.terminate` cancellation cycles, 20 unique child PIDs, `memory.repeatedCycles.bounded: true`, `memory.repeatedCycles.attributionStable: true`, no active child PID at the final checkpoint, `onnxSessionsReleased: true`, `duplicateModelInstances: false`, `fixture.unchangedAfterRun: true`, `viewerResponsiveness.responsiveWhileOcrActive: true`, no child PID after the viewer probe, and a populated package-size record.
7. Require `offline.allWorkerFetchesGuarded: true`, `offline.externalBlockSelfTestPassed: true`, at least one deliberately blocked probe per recognition child, and only local allowed requests. A physical network-disconnect run that preserves loopback remains a useful platform smoke, but external Worker I/O is now denied in code rather than inferred from the host network state.

The acceptance limits are encoded in the report: at most 32 MiB settled RSS above the fresh process sample, at most +2 MiB/cycle fitted growth, a different one-job child for each cycle, and no surviving child. The macOS production evaluator enforces those numeric values directly in addition to the report's `bounded` flag. Do not raise these limits to make a platform pass. Capture and diagnose any miss.

## macOS

Prerequisites: Xcode command-line tools and the repository's supported Node/Rust toolchains. The native-runtime script stages the universal PDFium dylib.

```text
npm ci
npm run prepare:native-runtime
npm run verify:ocr-assets
npm run test:ocr
npm exec vite -- build
npm run tauri:dev:debug
```

Then run this in a second terminal:

```text
OPS_OCR_REPORT_PATH=docs/ocr/phase-a/measurements/macos-arm64-local.json npm run measure:ocr
```

For production-eligible evidence, build and let the repeatable launcher own the packaged release app:

```text
npm run tauri build -- --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
node scripts/run-ocr-phase-a-gate.mjs --app '../target/release/bundle/macos/Open PDF Studio.app/Contents/MacOS/open-pdf-studio' --report docs/ocr/phase-a/measurements/macos-arm64-local.json
node scripts/evaluate-ocr-phase-a-macos-report.mjs docs/ocr/phase-a/measurements/macos-arm64-local.json --app '../target/release/bundle/macos/Open PDF Studio.app' --output docs/ocr/phase-a/measurements/macos-production-decision-local.json
```

RSS includes the native app/PDFium tree and each temporary OCR child plus WebKit XPC processes born while that child is active. The long-lived editor WebView is deliberately excluded because launchd reparenting makes PID-proximity ownership unreliable and the isolated path never sends it the raster or model. A baseline drop beyond 64 MiB fails attribution. After the command, `ps -axo pid,ppid,rss,command | grep ocr-phase-a-child` must return no child.

Observed in the latest packaged re-evaluation: macOS arm64 passed 10 recognition and 10 cancellation cycles plus the concurrent viewer probe, with +5.84 MiB final retained RSS and a -0.35 MiB/cycle trend. The x86_64 worker cross-builds with the correct Mach-O architecture, launches under Rosetta, initializes the universal PDFium library, and combines into validated universal arm64/x86_64 packaging. macOS arm64 is the current production target. Native Intel GUI certification remains unverified because real Intel hardware was not available.

## Windows

Prerequisites: Visual Studio C++ build tools, WebView2 Runtime, and the repository's supported Node/Rust toolchains. Run from PowerShell:

```text
npm ci
npm run prepare:native-runtime
npm run verify:ocr-assets
npm run test:ocr
npm exec vite -- build
npm run tauri:dev:debug
```

Run this in a second PowerShell window:

```text
$env:OPS_OCR_REPORT_PATH = "docs/ocr/phase-a/measurements/windows-local.json"
npm run measure:ocr
```

The CI/package-equivalent command is:

```text
Copy-Item src-tauri/binaries/win-x64/pdfium.dll ../target/release/pdfium.dll -Force
node scripts/run-ocr-phase-a-gate.mjs --app ../target/release/open-pdf-studio.exe --report "$env:TEMP/ocr-phase-a-Windows-X64.json"
```

The harness uses `Get-CimInstance Win32_Process` to sum the app and descendant working sets. Confirm the emitted sidecar is `pdfium-worker.exe`, each internal `--ocr-phase-a-child` process exits, no console or OCR window becomes visible, and the final process listing contains only the editor instance and its normal children.

Windows was not available locally. The CI matrix retains this exact 20-cycle gate and uploads its JSON when it passes. The step is advisory for the macOS OCR release; absence of the artifact still prevents the preserved all-desktop evaluator from returning `PRODUCTION GO`, but it does not prevent `MACOS PRODUCTION GO`. No Windows production support claim is made.

## Linux

Prerequisites: the Tauri/WebKitGTK development packages for the target distribution, PDFium runtime dependencies, and the repository's supported Node/Rust toolchains.

```text
npm ci
npm run prepare:native-runtime
npm run verify:ocr-assets
npm run test:ocr
npm exec vite -- build
npm run tauri:dev:debug
```

Run this in a second terminal:

```text
OPS_OCR_REPORT_PATH=docs/ocr/phase-a/measurements/linux-local.json npm run measure:ocr
```

For an AppImage, first run `bash scripts/linux-appimage-smoke.sh <appimage> 10`. It now verifies that `libpdfium.so` and the executable sidecar are present and executes `pdfium-worker --probe-pdfium` from the extracted bundle. Then run the package gate under the target display stack:

```text
dbus-run-session -- xvfb-run -a node scripts/run-ocr-phase-a-gate.mjs --app <appimage> --report /tmp/ocr-phase-a-Linux-X64.json
```

The harness uses `ps` to sum RSS for the app process and descendants. Confirm the PDFium sidecar starts, each `--ocr-phase-a-child` process exits, no OCR child window is visible, and the WebKitGTK version supports module Workers and WebAssembly SIMD. On Wayland and X11, separately verify that positioning the 1x1 internal child window off-screen does not surface it in the task switcher.

Linux was not available locally. CI retains the AppImage gate under DBus/Xvfb as an advisory qualification run; a separate Wayland smoke should confirm the off-screen one-pixel child never surfaces in the task switcher. No Linux production support claim is made.

## CI decisions

The macOS matrix entry runs the live package gate and then evaluates the resulting report against the built `.app`:

```text
node scripts/evaluate-ocr-phase-a-macos-report.mjs <macos-report.json> --app <Open PDF Studio.app> --output <macos-decision.json>
```

That required macOS step emits `MACOS PRODUCTION GO` or `MACOS PRODUCTION NO-GO`. The Windows and Linux live OCR steps use `continue-on-error` and do not block the macOS OCR release.

The dependent advisory job still downloads all available reports and runs the unchanged future all-desktop evaluator:

```text
node open-pdf-studio/scripts/evaluate-ocr-phase-a-reports.mjs <report-directory> --output <decision.json>
```

The all-desktop evaluator returns a failing status and `EVALUATION GO, PRODUCTION NO-GO` when a report is missing or any fixed criterion fails. It emits `PRODUCTION GO` only for a complete passing desktop matrix. This advisory result is retained for possible future support and must not be substituted for the current macOS decision.

## Failure capture

Record the OS/architecture, WebView engine/version, debug or packaged build, exact command, complete error, all memory checkpoints, surviving child PIDs, whether PDFium workers reached ready state, whether the failure occurred during raster/model startup/detection/recognition/disposal/process exit, and the output of `npm run verify:ocr-assets`. Do not classify a platform as supported from contract tests alone; the live PDFium-to-Worker path and 20-cycle memory gate must pass.
