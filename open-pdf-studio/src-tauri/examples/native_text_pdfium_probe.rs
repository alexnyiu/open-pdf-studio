use std::path::Path;
use std::sync::Arc;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let pdfium_directory = args
        .next()
        .ok_or("usage: native_text_pdfium_probe <pdfium-dir> <pdf> <removed-text>")?;
    let pdf_path = args.next().ok_or("missing PDF path")?;
    let removed_text = args.next().ok_or("missing removed text")?;
    let baseline_path = args.next();
    app_lib::pdfium_renderer::init_pdfium(Path::new(&pdfium_directory))?;
    let bytes = Arc::new(std::fs::read(&pdf_path)?);
    let handle = app_lib::pdfium_renderer::PdfiumDocumentHandle::load_from_bytes(bytes)?;
    let extracted = app_lib::pdfium_renderer::extract_all_page_text(handle.document(), 0)?;
    let (width, height, rgba) =
        app_lib::pdfium_renderer::render_page_to_rgba(handle.document(), 0, 0.5, 0)?;
    println!(
        "pdf={} extracted_chars={} removed_text_present={} render={}x{} rgba={}",
        pdf_path,
        extracted.chars().count(),
        extracted.contains(&removed_text),
        width,
        height,
        rgba.len(),
    );
    if let Some(baseline_path) = baseline_path {
        let baseline = app_lib::pdfium_renderer::PdfiumDocumentHandle::load_from_bytes(Arc::new(
            std::fs::read(&baseline_path)?,
        ))?;
        let (baseline_width, baseline_height, baseline_rgba) =
            app_lib::pdfium_renderer::render_page_to_rgba(baseline.document(), 0, 0.5, 0)?;
        if (baseline_width, baseline_height) != (width, height) {
            return Err("baseline and edited render dimensions differ".into());
        }
        let mut changed = 0usize;
        let mut bounds = (width, height, 0u32, 0u32);
        for (pixel_index, (left, right)) in baseline_rgba
            .chunks_exact(4)
            .zip(rgba.chunks_exact(4))
            .enumerate()
        {
            if left != right {
                let x = pixel_index as u32 % width;
                let y = pixel_index as u32 / width;
                bounds.0 = bounds.0.min(x);
                bounds.1 = bounds.1.min(y);
                bounds.2 = bounds.2.max(x);
                bounds.3 = bounds.3.max(y);
                changed += 1;
            }
        }
        println!(
            "baseline={} changed_pixels={} difference_bounds={:?}",
            baseline_path, changed, bounds
        );
    }
    Ok(())
}
