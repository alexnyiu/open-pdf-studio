# OCR quality corpus v1

This directory is the deterministic input corpus for the macOS searchable-OCR
quality benchmark. `corpus.v1.json` is authoritative for fixture identity,
classification, expected normalized text, reading order, and line polygons.
Every polygon is expressed in `source-raster-pixels`, with the origin at the
top-left pixel edge, x increasing right, and y increasing down.

Regenerate the corpus from repository-owned inputs with:

```sh
npm run generate:ocr-quality-fixtures
```

The generator records each PNG's byte count and SHA-256 digest. Benchmark
startup verifies those values before inference. The malformed and
resource-heavy cases are metadata-only so the benchmark can exercise limits
without committing or allocating an oversized raster.

The first-release passing scope is machine-printed text in supported model
scripts. Rotated pages, table structure, and an unsupported script are explicit
`unsupported` cases. Handwriting, curved text, and severe perspective warping
are excluded from passing scope rather than represented by misleading synthetic
approximations.

See [PROVENANCE.md](PROVENANCE.md) and [LICENSES.md](LICENSES.md) before adding or
replacing a fixture.
