//! Smoke test for the PDFium renderer module. Only runs if the
//! `OPEN_PDF_STUDIO_TEST_PDF` environment variable points at a
//! readable PDF and pdfium.dll is on the system PATH or in the
//! current working directory.

use std::path::PathBuf;
use std::sync::Arc;

use app_lib::pdfium_renderer::{
    get_or_load_pdfium_doc_with_bytes, init_pdfium, render_page_to_rgba, PdfiumDocCache,
};

#[test]
fn pdfium_renders_barn_page_one() {
    let pdf_path = match std::env::var("OPEN_PDF_STUDIO_TEST_PDF") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("Skipping: set OPEN_PDF_STUDIO_TEST_PDF env var to a PDF path");
            return;
        }
    };

    let dll_dir: PathBuf = std::env::var("OPEN_PDF_STUDIO_TEST_DLL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|q| q.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."))
        });

    init_pdfium(&dll_dir).expect("init_pdfium");

    let bytes = std::fs::read(&pdf_path).expect("read pdf");
    let arc_bytes = Arc::new(bytes);

    let cache = PdfiumDocCache::default();
    let handle =
        get_or_load_pdfium_doc_with_bytes(&pdf_path, arc_bytes, &cache).expect("load pdfium doc");

    let (w, h, rgba) = render_page_to_rgba(handle.document(), 0, 1.0, 0).expect("render page");

    assert!(w > 100, "width should be reasonable, got {}", w);
    assert!(h > 100, "height should be reasonable, got {}", h);
    assert_eq!(rgba.len(), (w * h * 4) as usize, "rgba size mismatch");

    let non_white = rgba
        .chunks(4)
        .filter(|p| p[0] != 255 || p[1] != 255 || p[2] != 255)
        .count();
    assert!(
        non_white > 100,
        "Page is mostly white — render likely empty"
    );

    println!(
        "BARN page 1 rendered: {}x{} px, {} non-white pixels",
        w, h, non_white
    );
}
