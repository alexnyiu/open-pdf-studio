# OCR quality benchmark

Run the macOS benchmark from `open-pdf-studio/`:

```sh
npm run benchmark:ocr
```

The command verifies fixture hashes and licenses, runs the production
PaddleOCR adapter offline against each raster, evaluates all categories, and
writes the accuracy baseline, timing observation, baseline delta, and report in
this directory. It does not exercise PDF writing or the user interface.

`baseline.macos.v1.json` preserves the pre-hardening input evidence.
`baseline.macos.v2.json` contains current text, reading-order, geometry,
disposition, and serialized-result-size evidence.
`delta.macos.v1-to-v2.json` records every category comparison.
`timing.macos-<architecture>.v2.json` contains the machine-dependent timing
observation and is deliberately excluded from the accuracy gate. `REPORT.md` is
the human-readable summary. The production algorithm and limits are documented
in [`../PRODUCTION_POSTPROCESSING.md`](../PRODUCTION_POSTPROCESSING.md).

`thresholds.v1.json` is versioned separately and explicitly approved. The
command exits non-zero whenever an aggregate or supported-category threshold or
supported-page disposition regresses. The numeric targets are unchanged from
the pre-hardening baseline.

The Phase A evidence remains authoritative for process isolation, cleanup,
offline operation, cancellation, memory behavior, and its one selected clean
page. This benchmark adds broader quality evidence; it does not replace or
reinterpret that gate.
