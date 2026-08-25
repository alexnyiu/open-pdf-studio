# OCR third-party and fixture notices

This notice covers components used by the macOS OCR, searchable-PDF writer,
scanned-text editor, and deterministic OCR fixture pipeline in Open PDF Studio
1.85.0. The versions and integrity values below were verified against the
`package-lock.json` and bundled model manifest at release-candidate commit
`0e093b5b`. After integration, that release lockfile is the machine-readable
dependency record.

## Models and OCR runtime

| Component | Version or revision | Purpose | License |
| --- | --- | --- | --- |
| PaddleOCR PP-OCRv6 Small detection model | `28fe5895c24fd108c19eb3e8479f4ab385fbfc62` | Text detection | Apache-2.0 |
| PaddleOCR PP-OCRv6 Small recognition model | `b8f84f0b80c529de40b4fbb3544b84fa7233a513` | Fixed multilingual recognition | Apache-2.0 |
| ONNX Runtime Web | 1.27.0 | Local WASM inference | MIT |
| ONNX Runtime Common | 1.27.0 | Shared runtime types | MIT |
| FlatBuffers | 25.9.23 | ONNX Runtime dependency | Apache-2.0 |
| guid-typescript | 1.0.9 | ONNX Runtime dependency | ISC |
| long | 5.3.2 | ONNX Runtime dependency | Apache-2.0 |
| platform | 1.3.6 | ONNX Runtime dependency | MIT |
| protobuf.js and `@protobufjs/*` | 7.6.5 family | ONNX Runtime dependency | BSD-3-Clause |

The PP-OCRv6 model assets are distributed by PaddlePaddle under Apache-2.0.
Their pinned upstream repositories are:

- <https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx>
- <https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx>

A complete Apache License 2.0 text is bundled at
[`public/pdfjs/LICENSE`](../../public/pdfjs/LICENSE). The ONNX Runtime notice
and MIT text are bundled at
[`licenses/onnxruntime-web-MIT.txt`](licenses/onnxruntime-web-MIT.txt).

## PDF writing, rendering, and shaping

| Component | Version | OCR use | License |
| --- | ---: | --- | --- |
| PDF.js / `pdfjs-dist` | 5.4.624 | Reopen, text extraction, ownership and search validation | Apache-2.0 |
| PDFium binary snapshot | Chromium 7834 | Native render, extraction, pixel, and save validation | BSD-style plus bundled third-party licenses |
| `pdf-lib` | 1.17.1 | Owned PDF text and repair-layer construction | MIT; copyright 2019 Andrew Dillon |
| `@pdf-lib/fontkit` | 1.1.1 | Approved Unicode reflow shaping and embedding | MIT |
| Liberation Sans | bundled Regular, Bold, Italic, Bold Italic | Searchable writer and approved reflow font | SIL Open Font License 1.1 |
| PDF.js Foxit standard-font substitutes | bundled Type 1 fonts | Rendering PDF base-14 standard fonts | PDFium Authors BSD-style license |

PDF.js's license is [`public/pdfjs/LICENSE`](../../public/pdfjs/LICENSE).
PDFium and its transitive notices are bundled under
[`src-tauri/pdfium-extract/licenses`](../../src-tauri/pdfium-extract/licenses/pdfium.txt).
The pinned macOS PDFium 7834 archive adds an ICU4J `sorttable.js` MIT notice;
that release-specific text is bundled at
[`pdfium-7834-icu4j-sorttable-MIT.txt`](licenses/pdfium-7834-icu4j-sorttable-MIT.txt).
The Liberation font copyright and license are at
[`LICENSE_LIBERATION`](../../public/pdfjs/web/standard_fonts/LICENSE_LIBERATION).
The Foxit standard-font substitute notice is at
[`LICENSE_FOXIT`](../../public/pdfjs/web/standard_fonts/LICENSE_FOXIT).
The npm package notices remain attributable through `package-lock.json` and
their distributed package metadata.

## Fixtures and fixture tooling

Open PDF Studio's OCR golden, quality, workflow, and scanned-text editing
fixtures contain synthetic wording, geometry, backgrounds, and metadata made
for this repository. They contain no customer documents, personal data, or
third-party benchmark pages. The synthetic fixture content and expected data
are dedicated under CC0 1.0; the complete legal text is bundled at
[`licenses/CC0-1.0.txt`](licenses/CC0-1.0.txt).

Fixture generation uses the bundled Liberation fonts under OFL-1.1 and Sharp
0.34.5 under Apache-2.0. Sharp and fixture generators are development/test
inputs; the generated fixtures do not include the Sharp library or OCR model
copies.

## No endorsement

Third-party names identify upstream components and do not imply endorsement of
Open PDF Studio. Each component remains subject to its own license and warranty
disclaimer.
