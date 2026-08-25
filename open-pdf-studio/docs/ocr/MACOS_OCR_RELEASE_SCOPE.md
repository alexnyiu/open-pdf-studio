# macOS OCR and scanned-text release scope

Evidence snapshot: Open PDF Studio 1.85.0, `ocr-release-hardening` working tree
based on `ocr-reflow` commit `0e093b5b`, packaged macOS evidence through
2026-08-24.

## Release claim

OCR production support is limited to macOS. Live packaged certification passed
on Apple silicon (`arm64`). The arm64 application packaged successfully. Thin
arm64 and x86_64 OCR workers, a universal worker, and universal PDFium were
validated, and both universal worker slices initialized PDFium, with x86_64
running under Rosetta. The distribution workflow builds a universal
application, but a complete native Intel Mac GUI run has not been performed,
so Intel GUI certification remains unverified.

Open PDF Studio makes no Windows or Linux OCR support claim. Existing Windows
and Linux scaffolding and CI checks are preparation for future qualification,
not production certification.

## Searchable OCR

The supported workflow recognizes machine-printed text on scanned or image
pages, exposes owned results for review, correction, search, selection, and
copy, and saves eligible results as an invisible Unicode text layer. Pages with
meaningful existing PDF text are skipped by default to avoid duplicate text.
A forced rerun replaces only OCR owned by Open PDF Studio; native and unrelated
third-party PDF content is preserved.

The approved quality corpus passed these categories:

- clean 300 DPI Latin text;
- lower-resolution machine print;
- low-contrast text;
- mild line skew handled by quadrilateral rectification, without page deskew;
- mixed raster and native-text pages;
- one- and two-column reading order;
- forms, numbers, punctuation, and the benchmark's supported Unicode;
- dense pages with more than 64 lines;
- blank and no-text pages.

Across supported corpus cases, measured character error was 0.0%, word error
was 0.5%, reading-order error was 0.0%, and line precision and recall were both
100.0%. These synthetic results describe the approved corpus only. They are not
a general accuracy guarantee for arbitrary scans, languages, layouts, or image
conditions.

### Automatic multilingual model behavior

The bundled PP-OCRv6 Small pack is automatic and fixed-multilingual. There is
no language selector and no language or writing-direction detector. One model
considers its supported languages together:

`zh-Hans`, `zh-Hant`, `en`, `ja`, `fr`, `de`, `it`, `es`, `pt`, `nl`, `pl`,
`ro`, `cs`, `sv`, `no`, `da`, `fi`, `hu`, `tr`, `vi`, `id`, `ms`, `az`, `af`,
`bs`, `hr`, `cy`, `et`, `ga`, `is`, `ku`, `lt`, `lv`, `mt`, `mi`, `oc`, `sk`,
`sl`, `sq`, `sw`, `tl`, `uz`, `la`, `sr-Latn`, `ca`, `eu`, `gl`, `lb`, `rm`,
and `qu`.

The manifest lists the `Hans`, `Hant`, `Jpan`, and `Latn` scripts. Automatic
page orientation and deskew are disabled. Mild skew is handled at detected-line
level; rotated pages are not corrected.

Recognition and persistence are different gates. The model can recognize text
that the approved embedded Liberation Sans writer cannot encode. Saving an
owned searchable layer therefore also requires horizontal left-to-right
geometry and complete glyph coverage in the approved font. Missing glyphs or
unsupported direction reject the save before the destination is changed. The
50-language model list is not a promise that every recognized character can be
persisted by the current searchable-PDF writer.

## Scanned-text editing

Visible scanned-text editing is available only for OCR geometry owned by Open
PDF Studio and only after the edit-foundation eligibility and repair checks
pass. All modes preserve the source raster, own their visible and invisible
layers, support undo/redo and repeated save, and reject a change that cannot
remain inside its original region.

### Isolated single line

- Exactly one isolated, predominantly horizontal, left-to-right OCR line.
- Flat or near-flat repairable background with complete context.
- Basic estimated serif, sans-serif, or monospace style, size, weight, italic,
  color, and alignment.
- Replacement glyphs must fit the supported PDF standard-font WinAnsi path.
- No line break, paragraph reflow, missing glyph, clipping, or overflow.

The estimate is not exact source-font recovery.

### Fixed-region multiline

- Between 2 and 32 explicitly selected lines from one coherent OCR region.
- Canonical horizontal baselines, measured line spacing, and reliable common
  left, center, or right alignment.
- Fixed-line replacement and safe wrapping only when all lines remain inside
  the original region and use no more than the original line capacity.
- No inseparable columns, unrelated intersecting text, missing glyphs,
  unsupported direction, clipping, or overflow.

This mode does not move unrelated page content and does not perform paragraph
or page-wide reflow.

### Bounded paragraph reflow

- One paragraph inside a region already approved by the editing foundation.
- Uses the region's canonical baselines, measured line spacing, alignment, and
  existing line capacity.
- Uses bundled Liberation Sans Regular and the certified fontkit LTR shaping
  path.
- Supports left-to-right Latin, Greek, Cyrillic, Common, and Inherited Unicode
  characters only when every glyph is present and measured shaping succeeds.
- Wraps only at safe spaces; unbreakable words, excess lines, tall glyphs,
  clipping, and other overflow are rejected.

Right-to-left shaping is not certified. There is no page-wide reflow, arbitrary
layout reconstruction, exact font recovery, or commercial-editor parity claim.

## Unsupported and rejected content

The recognition benchmark measured these unsupported cases:

| Case | Character error | Word error | Reading-order error | Result |
| --- | ---: | ---: | ---: | --- |
| Page rotation 90 degrees | 55.6% | 60.0% | 66.7% | Unsupported |
| Page rotation 180 degrees | 75.3% | 100.0% | 100.0% | Unsupported |
| Page rotation 270 degrees | 74.0% | 100.0% | 33.3% | Unsupported |
| Table layout | 54.8% | 66.7% | 20.0% | Unsupported |
| Unlisted Cyrillic fixture | 92.6% | 83.3% | 0.0% | Unsupported; 33.3% line recall |

Handwriting, curved text, and severe perspective distortion were excluded from
the passing recognition corpus; no production accuracy is claimed for them.
Photographic or complex-background accuracy is also not generally certified.

Editing rejection tests cover tables, inseparable columns, handwriting,
vertical text, curved text, severely warped geometry, low-confidence geometry,
photographic or complex backgrounds, missing glyphs, unsupported scripts,
unsupported shaping or direction, and content that cannot fit. Passing a
rejection test proves fail-closed behavior; it does not prove recognition or
editing quality for that category.

## Safe save and protected documents

OCR and scanned-text changes are built as a candidate while the destination
remains untouched. PDF.js verifies structure, ownership, text order,
idempotence, and removal. The packaged PDFium runtime then reopens selected
pages, verifies text, and requires exact visible-pixel preservation outside the
approved edit regions. Only a validated candidate enters the native macOS save
transaction.

The native transaction writes private same-directory files, flushes them,
preserves safe metadata where possible, and uses an atomic same-volume replace.
On a post-replacement failure it swaps the original back. If rollback itself
fails, it preserves the previous bytes as a private recovery file and reports a
distinct fatal error. There is no copy-overwrite or non-atomic fallback.

| Document or storage condition | Behavior |
| --- | --- |
| Signed PDF | Warn that modification invalidates signatures and require Save As to a different path. The signed original is preserved. |
| Encrypted or password-protected PDF | Reject before mutation. Open PDF Studio does not decrypt or rewrite it. |
| PDF/A | Require Save As, warn that output becomes standard PDF, and remove PDF/A identification markers. If markers cannot be safely removed, fail closed. |
| Read-only, locked, symlink, malformed, replaced, or inaccessible destination | Reject before replacement or roll back; keep the original unchanged. |
| iCloud Drive | Use the same atomic requirements. A real provider-backed save and upload completed on 2026-08-24 and its temporary provider item was removed. Provider-busy errors remain explicit; there is no unsafe fallback. |
| External or removable APFS volume | A dynamically created, separately mounted APFS volume passed save, repeated save, atomic replacement, Finder-lock rejection, original preservation, and private-candidate cleanup. |
| exFAT volume | Unverified. This host returned `Operation not permitted` while creating the temporary exFAT image, so no live transaction or compatibility claim was made. |
| Out of space or quota | A deliberately full 64 MiB APFS image produced `ENOSPC`; the save was rejected, private candidates were cleaned, and the original bytes were unchanged. |

## Cache, privacy, and offline operation

The OCR cache is below the Tauri application-data directory at
`ocr-cache/v1`, normally:

`~/Library/Application Support/org.openaec.openpdfstudio/ocr-cache/v1`

The directory is private (`0700`) and cache files are created privately
(`0600`). Entries are gzip-compressed, SHA-256 checked, versioned validated
result/state envelopes. They contain recognized text and geometry so results
can be reused, but never page raster bytes or source file paths. The default
shared limit is 1 GiB with bounded least-recently-used eviction; the accepted
configuration range is 1 KiB through 4 GiB.

The internal cache service supports per-page invalidation and complete clear.
The current UI does not expose a standalone Clear OCR Cache button. To clear it
manually, quit Open PDF Studio and move the `ocr-cache` directory to Trash. A
future UI may call the same bounded clear operation without changing the cache
format.

Recognition uses bundled models and ONNX Runtime WASM. The OCR worker permits
only same-application-origin asset requests and blocks external URLs. OCR page
content, recognized text, and cache data stay on the Mac. This statement is
limited to OCR: unrelated application functions such as update or release-note
checks may use the network under their own policies.

The live retained-memory gate covers ten completed recognitions and ten timed
cancellations with no surviving OCR child. A deterministic 100-page image-only
document also completed through the packaged production workflow: 100 pages
completed, none disappeared or failed, inference stayed serialized, and no
child survived. On the qualification Mac, processing took 207,707 ms; median
page time was 2,136 ms and p95 was 2,275 ms. Parent RSS was 239,697,920 bytes
at baseline, 240,435,200 bytes at peak, and 179,437,568 bytes after settling,
for zero positive retained delta against the unchanged 32 MiB limit; peak child
RSS was 205,520,896 bytes. A separate second-half cancellation retained 55
completed pages, cancelled 45, reaped the active child, and applied no late
result. These measurements qualify this artifact and Mac; they are not a
performance guarantee for other documents or hardware.

## Accessibility

The macOS OCR surfaces provide labeled controls, range validation and alerts,
keyboard-operable review and correction actions, current-line state, a labeled
progress bar, polite atomic live regions, and accessible undo/redo and removal
actions. Scanned-text editors expose the owned region and rejection status;
rejection keeps the editor available for correction. Search and copy were
verified in Open PDF Studio, Apple Preview, PDF.js, and Chrome's PDFium viewer.

Automated packaged accessibility assertions passed. This is not a claim of a
complete manual VoiceOver certification across every workflow.

## Release wording that must not be used

Do not claim any of the following:

- Windows or Linux OCR support;
- native Intel GUI certification;
- automatic rotation, deskew, handwriting, table, curved-text, or arbitrary
  complex-background support;
- all-script or bidirectional shaping support;
- exact source-font recovery;
- page-wide or arbitrary layout reconstruction;
- edits that can expand beyond the approved original region;
- preservation of digital-signature validity after modification;
- modification of encrypted or password-protected PDFs;
- arbitrary commercial-editor parity.

See also the [release notes](RELEASE_NOTES_1.85.0.md) and
[third-party notices](THIRD_PARTY_NOTICES.md). Packaging, signing, filesystem,
and distribution-trust evidence is recorded separately in
[macOS release hardening](MACOS_RELEASE_HARDENING.md).
