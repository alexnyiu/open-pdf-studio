//! PDFium evidence for the production invisible Unicode OCR writer lineage.
//! The proof runner emits the exact baseline/write/rewrite/remove candidates
//! consumed here; the application save path uses the same writer module and
//! the same exact-pixel policy before native replacement.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use app_lib::pdfium_renderer::{
    extract_all_page_text, init_pdfium, render_page_to_rgba, PdfiumDocumentHandle,
};
use serde_json::json;

const PAGE_LINES: [&[&str]; 2] = [
    &[
        "Café naïve façade",
        "Résumé: élève, déjà vu.",
        "€ 1,234.56 — discount 20%",
        "“Quoted text” • No. 42",
    ],
    &[
        "Left column heading",
        "First left paragraph",
        "Second left paragraph",
        "Right column heading",
        "First right paragraph",
        "Second right paragraph",
    ],
];

fn load(path: &Path) -> PdfiumDocumentHandle {
    let bytes =
        std::fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    PdfiumDocumentHandle::load_from_bytes(Arc::new(bytes))
        .unwrap_or_else(|error| panic!("load {} in PDFium: {error}", path.display()))
}

fn extracted_pages(handle: &PdfiumDocumentHandle) -> Vec<String> {
    (0..handle.document().pages().len())
        .map(|index| extract_all_page_text(handle.document(), index as u32)
            .unwrap_or_else(|error| panic!("load page {index} text: {error}")))
        .collect()
}

fn rendered_pages(handle: &PdfiumDocumentHandle) -> Vec<(u32, u32, Vec<u8>)> {
    (0..handle.document().pages().len())
        .map(|index| {
            render_page_to_rgba(handle.document(), index as u32, 2.0, 0)
                .unwrap_or_else(|error| panic!("render page {index}: {error}"))
        })
        .collect()
}

fn assert_same_pixels(
    label: &str,
    baseline: &[(u32, u32, Vec<u8>)],
    candidate: &[(u32, u32, Vec<u8>)],
) -> Vec<usize> {
    assert_eq!(
        candidate.len(),
        baseline.len(),
        "{label} page count changed"
    );
    baseline
        .iter()
        .zip(candidate)
        .enumerate()
        .map(
            |(page_index, ((base_width, base_height, base), (width, height, pixels)))| {
                assert_eq!(
                    (width, height),
                    (base_width, base_height),
                    "{label} page {page_index} dimensions changed"
                );
                let changed = base
                    .chunks_exact(4)
                    .zip(pixels.chunks_exact(4))
                    .filter(|(left, right)| left != right)
                    .count();
                assert_eq!(changed, 0, "{label} visibly changed page {page_index}");
                changed
            },
        )
        .collect()
}

#[test]
fn invisible_unicode_writer_preserves_pdfium_pixels_and_search_state() {
    let proof_dir = match std::env::var("OPEN_PDF_STUDIO_OCR_WRITER_PROOF_DIR") {
        Ok(value) => PathBuf::from(value),
        Err(_) => {
            eprintln!("Skipping: set OPEN_PDF_STUDIO_OCR_WRITER_PROOF_DIR after running npm run proof:ocr-writer");
            return;
        }
    };
    let dll_dir = std::env::var("OPEN_PDF_STUDIO_TEST_DLL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/macos-universal")
        });
    init_pdfium(&dll_dir).expect("initialize application PDFium runtime");

    let baseline = load(&proof_dir.join("baseline.pdf"));
    let written = load(&proof_dir.join("written.pdf"));
    let repeated = load(&proof_dir.join("repeated.pdf"));
    let removed = load(&proof_dir.join("removed.pdf"));

    let baseline_text = extracted_pages(&baseline);
    let written_text = extracted_pages(&written);
    let repeated_text = extracted_pages(&repeated);
    let removed_text = extracted_pages(&removed);
    assert_eq!(
        removed_text, baseline_text,
        "removal did not restore PDFium searchable text"
    );

    for (page_index, expected_lines) in PAGE_LINES.iter().enumerate() {
        let mut last_offset = 0;
        for line in *expected_lines {
            let offset = written_text[page_index]
                .find(line)
                .unwrap_or_else(|| panic!("PDFium did not extract {line:?} on page {page_index}"));
            assert!(
                offset >= last_offset,
                "PDFium reading order changed on page {page_index}"
            );
            last_offset = offset;
            assert_eq!(
                repeated_text[page_index].match_indices(line).count(),
                1,
                "repeat write duplicated {line:?}"
            );
        }
    }
    let mut last_dense_offset = 0;
    for line_number in 1..=70 {
        let line = format!("Line {line_number:02} value {}", 1000 + line_number);
        let offset = written_text[2]
            .find(&line)
            .unwrap_or_else(|| panic!("PDFium did not extract {line:?} from the non-zero CropBox dense page"));
        assert!(
            offset >= last_dense_offset,
            "PDFium dense-page reading order changed at {line:?}"
        );
        last_dense_offset = offset;
        assert_eq!(
            repeated_text[2].match_indices(&line).count(),
            1,
            "repeat write duplicated {line:?}"
        );
    }

    let baseline_pixels = rendered_pages(&baseline);
    let written_changed_pixels =
        assert_same_pixels("written", &baseline_pixels, &rendered_pages(&written));
    let repeated_changed_pixels =
        assert_same_pixels("repeated", &baseline_pixels, &rendered_pages(&repeated));
    let removed_changed_pixels =
        assert_same_pixels("removed", &baseline_pixels, &rendered_pages(&removed));

    let result = json!({
        "status": "pass",
        "pdfiumExtractionAfterReopen": "pass",
        "pdfiumReadingOrder": "pass",
        "repeatedWriteNoDuplicate": "pass",
        "removalRestoresSearchableState": "pass",
        "renderScale": 2.0,
        "writtenChangedPixels": written_changed_pixels,
        "repeatedChangedPixels": repeated_changed_pixels,
        "removedChangedPixels": removed_changed_pixels,
        "writtenText": written_text,
    });
    std::fs::write(
        proof_dir.join("pdfium-proof-results.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&result).expect("serialize PDFium proof result")
        ),
    )
    .expect("write PDFium proof result");
    println!(
        "{}",
        serde_json::to_string_pretty(&result).expect("serialize PDFium proof result")
    );
}
