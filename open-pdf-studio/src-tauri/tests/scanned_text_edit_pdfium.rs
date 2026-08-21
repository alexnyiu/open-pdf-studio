//! Independent macOS PDFium pixel proof for the scanned-text edit foundation.
//! The source scan remains in page content; the candidate adds one owned,
//! pixel-aligned repair overlay, and removal must reveal the exact source.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use app_lib::pdfium_renderer::{init_pdfium, render_page_to_rgba, PdfiumDocumentHandle};
use serde_json::{json, Value};

struct Raster {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[derive(Debug, PartialEq)]
struct PixelDifference {
    changed_pixels: usize,
    outside_approved_changed_pixels: usize,
    actual_bounds: Option<(u32, u32, u32, u32)>,
}

fn load(path: &Path) -> PdfiumDocumentHandle {
    let bytes =
        std::fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    PdfiumDocumentHandle::load_from_bytes(Arc::new(bytes))
        .unwrap_or_else(|error| panic!("PDFium reopen {}: {error}", path.display()))
}

fn render(handle: &PdfiumDocumentHandle) -> Raster {
    let (width, height, pixels) = render_page_to_rgba(handle.document(), 0, 1.0, 0)
        .unwrap_or_else(|error| panic!("PDFium render: {error}"));
    Raster {
        width,
        height,
        pixels,
    }
}

fn integer(value: &Value, pointer: &str) -> u32 {
    value
        .pointer(pointer)
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
        .unwrap_or_else(|| panic!("manifest field {pointer} must be a u32"))
}

fn compare(
    left: &Raster,
    right: &Raster,
    approved: Option<(u32, u32, u32, u32)>,
) -> PixelDifference {
    assert_eq!(
        (right.width, right.height),
        (left.width, left.height),
        "PDFium render dimensions changed"
    );
    assert_eq!(right.pixels.len(), left.pixels.len());
    let mut changed_pixels = 0_usize;
    let mut outside_approved_changed_pixels = 0_usize;
    let mut min_x = left.width;
    let mut min_y = left.height;
    let mut max_x = 0_u32;
    let mut max_y = 0_u32;
    for (index, (before, after)) in left
        .pixels
        .chunks_exact(4)
        .zip(right.pixels.chunks_exact(4))
        .enumerate()
    {
        if before == after {
            continue;
        }
        changed_pixels += 1;
        let x = index as u32 % left.width;
        let y = index as u32 / left.width;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
        let inside = approved.is_some_and(|(approved_x, approved_y, width, height)| {
            x >= approved_x && y >= approved_y && x < approved_x + width && y < approved_y + height
        });
        if !inside {
            outside_approved_changed_pixels += 1;
        }
    }
    PixelDifference {
        changed_pixels,
        outside_approved_changed_pixels,
        actual_bounds: (changed_pixels > 0)
            .then(|| (min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)),
    }
}

#[test]
fn owned_repair_changes_only_approved_pixels_and_removal_restores_source() {
    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/ocr/editing-foundation-v1");
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(fixture_dir.join("manifest.v1.json")).expect("read visual manifest"),
    )
    .expect("parse visual manifest");
    let dll_dir = std::env::var("OPEN_PDF_STUDIO_TEST_DLL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/macos-universal")
        });
    init_pdfium(&dll_dir).expect("initialize bundled macOS PDFium runtime");

    let source_name = manifest
        .pointer("/pdfProof/source")
        .and_then(Value::as_str)
        .expect("source fixture name");
    let repaired_name = manifest
        .pointer("/pdfProof/repaired")
        .and_then(Value::as_str)
        .expect("repaired fixture name");
    let reverted_name = manifest
        .pointer("/pdfProof/reverted")
        .and_then(Value::as_str)
        .expect("reverted fixture name");
    let source = render(&load(&fixture_dir.join(source_name)));
    let repaired = render(&load(&fixture_dir.join(repaired_name)));
    let reverted = render(&load(&fixture_dir.join(reverted_name)));
    let approved = (
        integer(&manifest, "/pdfProof/approvedRegion/x"),
        integer(&manifest, "/pdfProof/approvedRegion/y"),
        integer(&manifest, "/pdfProof/approvedRegion/width"),
        integer(&manifest, "/pdfProof/approvedRegion/height"),
    );
    let repaired_difference = compare(&source, &repaired, Some(approved));
    let expected_changed = integer(&manifest, "/pdfProof/changedRegion/changedPixelCount") as usize;
    let expected_bounds = (
        integer(&manifest, "/pdfProof/changedRegion/actualBounds/x"),
        integer(&manifest, "/pdfProof/changedRegion/actualBounds/y"),
        integer(&manifest, "/pdfProof/changedRegion/actualBounds/width"),
        integer(&manifest, "/pdfProof/changedRegion/actualBounds/height"),
    );
    assert_eq!(repaired_difference.changed_pixels, expected_changed);
    assert_eq!(repaired_difference.outside_approved_changed_pixels, 0);
    assert_eq!(repaired_difference.actual_bounds, Some(expected_bounds));

    let reverted_difference = compare(&source, &reverted, None);
    assert_eq!(
        reverted_difference,
        PixelDifference {
            changed_pixels: 0,
            outside_approved_changed_pixels: 0,
            actual_bounds: None,
        },
        "PDFium removal must restore the exact original scan pixels"
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "status": "pass",
            "renderer": "PDFium",
            "renderScale": 1.0,
            "widthPx": source.width,
            "heightPx": source.height,
            "changedPixels": repaired_difference.changed_pixels,
            "outsideApprovedChangedPixels": repaired_difference.outside_approved_changed_pixels,
            "actualBounds": repaired_difference.actual_bounds,
            "removalChangedPixels": reverted_difference.changed_pixels,
        }))
        .expect("serialize PDFium comparison")
    );
}
