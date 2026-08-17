# macOS OCR quality post-processing baseline v2

This benchmark measures the production PaddleOCR detection and layout
post-processing path against the first-release searchable-OCR corpus. It is not a
replacement for the Phase A process-isolation, cleanup, cancellation, offline,
or memory gates.

Policy 1.0.0 is **APPROVED**.
The measured corpus meets its approved
thresholds. No threshold was changed from the prior baseline.

## Accuracy and result size

Accuracy values and serialized result sizes are stored in
`baseline.macos.v2.json`; timing is deliberately excluded from that baseline.

| Measure | Result |
| --- | ---: |
| Character error rate | 0.0% |
| Word error rate | 0.5% |
| Reading-order error | 0.0% |
| Line detection precision | 100.0% |
| Line detection recall | 100.0% |
| Mean polygon IoU | 51.2% |
| Mean expected-polygon coverage | 61.2% |
| Missed / duplicate lines | 0 / 0 |
| Unsupported-page classification accuracy | 100.0% |
| Rejected-input accuracy | 100.0% |
| Peak canonical serialized result size | 32650 bytes |

## Category decisions

Unsupported cases are reported but cannot satisfy a passing production
category. Geometry columns show precision/recall and mean IoU/coverage.

| Category | Status | CER | WER | Order error | Geometry P/R | Polygon IoU/coverage | Missed/duplicate | Engine disposition |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| clean-300-dpi-latin | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 69.6% / 84.6% | 0 / 0 | completed |
| lower-resolution-text | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 73.0% / 84.1% | 0 / 0 | completed |
| low-contrast | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 63.0% / 83.5% | 0 / 0 | completed |
| mild-skew | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 74.5% / 90.6% | 0 / 0 | completed |
| page-rotation-90 | UNSUPPORTED | 55.6% | 60.0% | 66.7% | 100.0% / 100.0% | 64.7% / 88.8% | 0 / 0 | unsupported |
| page-rotation-180 | UNSUPPORTED | 75.3% | 100.0% | 100.0% | 100.0% / 100.0% | 62.3% / 85.9% | 0 / 0 | unsupported |
| page-rotation-270 | UNSUPPORTED | 74.0% | 100.0% | 33.3% | 100.0% / 100.0% | 66.1% / 90.8% | 0 / 0 | unsupported |
| mixed-image-native-text | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 70.9% / 83.7% | 0 / 0 | completed |
| multiple-columns | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 72.6% / 88.3% | 0 / 0 | completed |
| forms-and-numeric-content | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 66.1% / 75.1% | 0 / 0 | completed |
| punctuation-and-supported-unicode | PASS | 1.1% | 11.8% | 0.0% | 100.0% / 100.0% | 72.5% / 82.5% | 0 / 0 | completed |
| dense-more-than-64-lines | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 41.9% / 50.2% | 0 / 0 | completed |
| blank-page | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 100.0% / 100.0% | 0 / 0 | completed |
| no-text-image | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 100.0% / 100.0% | 0 / 0 | completed |
| table-layout | UNSUPPORTED | 54.8% | 66.7% | 20.0% | 100.0% / 100.0% | 45.3% / 94.3% | 0 / 0 | unsupported |
| unsupported-script | UNSUPPORTED | 92.6% | 83.3% | 0.0% | 100.0% / 33.3% | 63.3% / 88.5% | 2 / 0 | unsupported |
| malformed-input | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 100.0% / 100.0% | 0 / 0 | rejected |
| resource-limit-enforcement | PASS | 0.0% | 0.0% | 0.0% | 100.0% / 100.0% | 100.0% / 100.0% | 0 / 0 | rejected |

## Category deltas from the approved-policy input baseline

Delta values compare macos-ocr-quality-357c6d6c514b5a54b91baa60 with macos-ocr-quality-3a87f3480239ee8e6dba1b3f. For
error, missed-line, and duplicate-line values, a negative delta is an
improvement. For precision, recall, overlap, and coverage, a positive delta is
an improvement. The machine-readable comparison is in
`delta.macos.v1-to-v2.json`.

| Category | Decision | CER Δ | WER Δ | Order Δ | Geometry P/R Δ | Polygon IoU/coverage Δ | Missed/duplicate Δ | Disposition |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| clean-300-dpi-latin | FAIL → PASS | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | +12.1 pp / +27.0 pp | ±0 / ±0 | completed → completed |
| lower-resolution-text | PASS → PASS | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | +21.2 pp / +32.2 pp | ±0 / ±0 | completed → completed |
| low-contrast | PASS → PASS | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | +2.4 pp / +22.2 pp | ±0 / ±0 | completed → completed |
| mild-skew | PASS → PASS | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | +11.3 pp / +8.4 pp | ±0 / ±0 | completed → completed |
| page-rotation-90 | UNSUPPORTED → UNSUPPORTED | −44.4 pp | −40.0 pp | +66.7 pp | +100.0 pp / +100.0 pp | +64.7 pp / +88.8 pp | −3 / −1 | completed → unsupported |
| page-rotation-180 | UNSUPPORTED → UNSUPPORTED | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | −8.3 pp / +14.1 pp | ±0 / ±0 | completed → unsupported |
| page-rotation-270 | UNSUPPORTED → UNSUPPORTED | −26.0 pp | ±0.0 pp | +33.3 pp | +100.0 pp / +100.0 pp | +66.1 pp / +90.8 pp | −3 / −1 | completed → unsupported |
| mixed-image-native-text | PASS → PASS | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | +15.8 pp / +28.6 pp | ±0 / ±0 | completed → completed |
| multiple-columns | FAIL → PASS | −40.6 pp | −66.7 pp | ±0.0 pp | ±0.0 pp / +50.0 pp | +32.2 pp / +8.6 pp | −3 / ±0 | completed → completed |
| forms-and-numeric-content | FAIL → PASS | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | +17.8 pp / +26.7 pp | ±0 / ±0 | completed → completed |
| punctuation-and-supported-unicode | FAIL → PASS | −2.2 pp | −11.8 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | +19.9 pp / +29.9 pp | ±0 / ±0 | completed → completed |
| dense-more-than-64-lines | FAIL → PASS | −8.6 pp | −8.6 pp | ±0.0 pp | ±0.0 pp / +8.6 pp | +9.0 pp / +17.2 pp | −6 / ±0 | completed → completed |
| blank-page | PASS → PASS | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | ±0.0 pp / ±0.0 pp | ±0 / ±0 | completed → completed |
| no-text-image | FAIL → PASS | −100.0 pp | −100.0 pp | ±0.0 pp | +100.0 pp / ±0.0 pp | +100.0 pp / +100.0 pp | ±0 / −2 | completed → completed |
| table-layout | UNSUPPORTED → UNSUPPORTED | +41.9 pp | −33.3 pp | +20.0 pp | ±0.0 pp / +66.7 pp | +25.5 pp / −0.1 pp | −4 / ±0 | completed → unsupported |
| unsupported-script | UNSUPPORTED → UNSUPPORTED | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / −66.7 pp | +1.8 pp / +27.0 pp | +2 / ±0 | completed → unsupported |
| malformed-input | PASS → PASS | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | ±0.0 pp / ±0.0 pp | ±0 / ±0 | rejected → rejected |
| resource-limit-enforcement | PASS → PASS | ±0.0 pp | ±0.0 pp | ±0.0 pp | ±0.0 pp / ±0.0 pp | ±0.0 pp / ±0.0 pp | ±0 / ±0 | rejected → rejected |

## Threshold findings

- No threshold failures.

## Machine-dependent timing

Timing is stored separately in `timing.macos-arm64.v2.json`. This observation
used arm64 macOS with Darwin kernel 25.5.0,
Node v25.6.1, one WASM thread, and a disposable adapter
instance per page. It is informational and is not part of the accuracy gate.

- Median page recognition wall time: 758.74 ms
- p95 page recognition wall time: 5666.49 ms
- Maximum page recognition wall time: 5666.49 ms
- Measured recognition pages: 16
- Peak full serialized production result: 32670 bytes

## Scope and provenance

The corpus contains 18 cases. Machine-printed supported-script
pages are eligible to pass. Rotation without orientation support, table
structure, and an unlisted script are explicit unsupported cases. Handwriting,
curved text, and severe perspective correction are excluded from passing scope.
Fixture provenance and license records are in
`../../../tests/fixtures/ocr/quality-v1/`.
