# OCR release-qualification fixture provenance

All PDFs in this corpus are generated at test time. No generated PDF is
committed. The 100-page and pathological image-only documents derive solely
from the repository-owned CC0 OCR quality rasters in `../quality-v1/`; see
`../LICENSE-CC0-1.0.txt`.

Malformed structural fixtures are deterministic byte strings authored for this
project. They contain no third-party document content and are bounded defensive
test inputs, not general-purpose exploit payloads.
