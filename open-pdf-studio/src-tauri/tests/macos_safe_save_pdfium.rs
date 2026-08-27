//! Independent PDFium reopen and exact-pixel gate for files produced through
//! the packaged macOS Save and Save As paths.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use app_lib::pdfium_renderer::{
    extract_all_page_text, init_pdfium, render_page_to_rgba, PdfiumDocumentHandle,
};

fn load(path: &Path) -> PdfiumDocumentHandle {
    let bytes =
        std::fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    PdfiumDocumentHandle::load_from_bytes(Arc::new(bytes))
        .unwrap_or_else(|error| panic!("PDFium reopen {}: {error}", path.display()))
}

fn text_pages(handle: &PdfiumDocumentHandle) -> Vec<String> {
    (0..handle.document().pages().len())
        .map(|index| {
            extract_all_page_text(handle.document(), index as u32)
                .unwrap_or_else(|error| panic!("page {index} text: {error}"))
        })
        .collect()
}

fn pixels(handle: &PdfiumDocumentHandle) -> Vec<(u32, u32, Vec<u8>)> {
    (0..handle.document().pages().len())
        .map(|index| {
            render_page_to_rgba(handle.document(), index as u32, 2.0, 0)
                .unwrap_or_else(|error| panic!("render page {index}: {error}"))
        })
        .collect()
}

#[test]
fn packaged_save_and_save_as_reopen_identically_in_pdfium() {
    let test_dir = match std::env::var("OPEN_PDF_STUDIO_PACKAGED_SAVE_TEST_DIR") {
        Ok(value) => PathBuf::from(value),
        Err(_) => {
            eprintln!("Skipping: run npm run test:ocr-save:macos and set OPEN_PDF_STUDIO_PACKAGED_SAVE_TEST_DIR to its testDir");
            return;
        }
    };
    let dll_dir = std::env::var("OPEN_PDF_STUDIO_TEST_DLL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/macos-universal")
        });
    init_pdfium(&dll_dir).expect("initialize application PDFium runtime");

    let baseline = load(&test_dir.join("source-baseline.pdf"));
    let in_place = load(&test_dir.join("save-in-place.pdf"));
    let save_as = load(&test_dir.join("save-as.pdf"));
    let baseline_text = text_pages(&baseline);
    assert_eq!(
        text_pages(&in_place),
        baseline_text,
        "PDFium extraction changed after packaged Save"
    );
    assert_eq!(
        text_pages(&save_as),
        baseline_text,
        "PDFium extraction changed after packaged Save As"
    );

    let baseline_pixels = pixels(&baseline);
    for (label, candidate) in [("Save", pixels(&in_place)), ("Save As", pixels(&save_as))] {
        assert_eq!(
            candidate.len(),
            baseline_pixels.len(),
            "{label} page count changed"
        );
        for (page_index, ((base_width, base_height, base), (width, height, value))) in
            baseline_pixels.iter().zip(candidate.iter()).enumerate()
        {
            assert_eq!(
                (width, height),
                (base_width, base_height),
                "{label} page {page_index} dimensions changed"
            );
            assert_eq!(
                value, base,
                "{label} visibly changed page {page_index} at 2x PDFium rendering"
            );
        }
    }
    println!("packaged macOS Save and Save As passed PDFium reopen, extraction, and exact-pixel comparison");
}
