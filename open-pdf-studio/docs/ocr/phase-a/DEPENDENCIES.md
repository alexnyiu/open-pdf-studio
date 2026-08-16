# OCR Phase A dependency and license record

PaddleOCR PP-OCRv6 Small remains the primary production OCR engine for the current macOS-only scope. Tesseract is not included or benchmarked in Phase A and remains only a possible future fallback. This record makes no Windows or Linux production support claim.

## Direct runtime dependency

| Component | Pinned version | License | Lock integrity |
| --- | ---: | --- | --- |
| `onnxruntime-web` | 1.27.0 | MIT | `sha512-ogDLsqIozHZwifPuN37OproAo0byX6t43/bP8GzeZWBWD6MOGExswFAx3up4NS/vvWBOg2u2PXomDt3rMmdQSg==` |
| `onnxruntime-common` | 1.27.0 | MIT | `sha512-3KxL5wIVqa8Ex08jxSzncm9CMgw8CjOFyOQ7SxvG9o0cVLlhTNKXyIQuTbtX4tGPJEf73OER2xrjt4HJSBL4ow==` |

The exact dependency graph is in `package-lock.json`. The new first-level transitive packages are `flatbuffers` 25.9.23 (Apache-2.0), `guid-typescript` 1.0.9 (ISC), `long` 5.3.2 (Apache-2.0), `platform` 1.3.6 (MIT), and `protobufjs` 7.6.5 plus its `@protobufjs/*` modules (BSD-3-Clause).

The vendored MIT text is `licenses/onnxruntime-web-MIT.txt`. ONNX Runtime's supported JavaScript/WASM setup is documented at <https://onnxruntime.ai/docs/get-started/with-javascript/web.html>.

The memory remediation adds no package, native library, OCR engine, or model dependency. Its isolation boundary launches the current Open PDF Studio executable for exactly one internal job and uses Rust/Tauri and operating-system process APIs already present in the application. The private job envelope is an internal versioned transport, not a new persisted user format.

## Models

Both model repositories declare Apache-2.0. The vendored license text is `licenses/PaddleOCR-Apache-2.0.txt`.

| Asset | Upstream repository | Pinned revision | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| Detection ONNX | `PaddlePaddle/PP-OCRv6_small_det_onnx` | `28fe5895c24fd108c19eb3e8479f4ab385fbfc62` | 9,880,512 | `d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e` |
| Recognition ONNX | `PaddlePaddle/PP-OCRv6_small_rec_onnx` | `b8f84f0b80c529de40b4fbb3544b84fa7233a513` | 21,159,378 | `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634` |
| Recognition dictionary | PaddleOCR inference configuration | generated from the pinned 18,708-character dictionary | 112,503 | `d5b428957abd863137f0b98f81f38fea3eb70bc279f778fbea41e1a68fa090ec` |

The machine-readable provenance, revisions, byte counts, and checksums are in `public/ocr/pp-ocrv6-small/manifest.json`. Upstream model records: <https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx> and <https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx>.

## Golden fixtures

The three deterministic one-page fixtures and their expected lines are recorded in `tests/fixtures/ocr/golden.json`. They were created for this repository and dedicated under CC0-1.0; the complete legal text is `tests/fixtures/ocr/LICENSE-CC0-1.0.txt`. `scripts/generate-ocr-fixtures.mjs` reproduces the PDFs byte-for-byte.

## Verification

`npm run verify:ocr-assets` verifies model, dictionary, ONNX Runtime WASM/MJS, package version, package license, and lock integrity. `npm run test:ocr` also regenerates the fixture set in a temporary directory and compares each PDF checksum and page count.

`checksums.sha256` is the human-readable checksum ledger. It includes installed runtime artifacts so dependency upgrades fail visibly even when a filename remains unchanged.

The remediation did not change any model/runtime bytes, pinned revisions, licenses, or checksums. `npm run verify:ocr-assets` was rerun after the lifecycle changes and passed.
