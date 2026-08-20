# Production OCR workflow fixtures

These PDFs are generated at test time by `scripts/generate-ocr-workflow-fixtures.mjs` from the checked-in, licensed `quality-v1` raster corpus. The generator adds PDF-only cases that a flattened PNG cannot represent: a non-zero CropBox origin, `/UserUnit 1.25`, a page containing real native PDF text, and a page containing both a scan image and meaningful native PDF text.

The generated files contain no OCR result, Open PDF Studio ownership metadata, or seeded application state. Production acceptance must open them through the packaged app and invoke the visible Recognize Text workflow.
