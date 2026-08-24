//! Independent macOS PDFium pixel proof for the scanned-text edit foundation.
//! The source scan remains in page content; the candidate adds one owned,
//! pixel-aligned repair overlay, and removal must reveal the exact source.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use app_lib::pdfium_renderer::{
    extract_all_page_text, init_pdfium, render_page_to_rgba, PdfiumDocumentHandle,
};
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

    let edited_name = manifest
        .pointer("/singleLineProof/edited")
        .and_then(Value::as_str)
        .expect("edited single-line fixture name");
    let repeated_name = manifest
        .pointer("/singleLineProof/editedRepeat")
        .and_then(Value::as_str)
        .expect("repeated single-line fixture name");
    let restored_name = manifest
        .pointer("/singleLineProof/restored")
        .and_then(Value::as_str)
        .expect("restored single-line fixture name");
    let replacement_text = manifest
        .pointer("/singleLineProof/replacementText")
        .and_then(Value::as_str)
        .expect("replacement text");
    let original_text = manifest
        .pointer("/singleLineProof/originalText")
        .and_then(Value::as_str)
        .expect("original text");
    let edited_handle = load(&fixture_dir.join(edited_name));
    let repeated_handle = load(&fixture_dir.join(repeated_name));
    let restored_handle = load(&fixture_dir.join(restored_name));
    let edited = render(&edited_handle);
    let repeated = render(&repeated_handle);
    let restored_searchable = render(&restored_handle);
    let edit_approved = (
        integer(&manifest, "/singleLineProof/approvedRegion/x"),
        integer(&manifest, "/singleLineProof/approvedRegion/y"),
        integer(&manifest, "/singleLineProof/approvedRegion/width"),
        integer(&manifest, "/singleLineProof/approvedRegion/height"),
    );
    let edited_difference = compare(&source, &edited, Some(edit_approved));
    assert!(
        edited_difference.changed_pixels > 0,
        "PDFium must render the visible replacement"
    );
    assert_eq!(edited_difference.outside_approved_changed_pixels, 0);
    assert_eq!(
        compare(&edited, &repeated, None).changed_pixels,
        0,
        "repeated save must not duplicate or alter visible replacement pixels"
    );
    assert_eq!(
        compare(&source, &restored_searchable, None).changed_pixels,
        0,
        "restoring original searchable text must not alter scan pixels"
    );

    let edited_text = extract_all_page_text(edited_handle.document(), 0)
        .expect("PDFium extracts edited searchable text");
    let repeated_text = extract_all_page_text(repeated_handle.document(), 0)
        .expect("PDFium extracts repeated-save searchable text");
    let restored_text = extract_all_page_text(restored_handle.document(), 0)
        .expect("PDFium extracts restored searchable text");
    assert_eq!(edited_text.match_indices(replacement_text).count(), 1);
    assert_eq!(edited_text.match_indices(original_text).count(), 0);
    assert_eq!(repeated_text.match_indices(replacement_text).count(), 1);
    assert_eq!(repeated_text.match_indices(original_text).count(), 0);
    assert_eq!(restored_text.match_indices(original_text).count(), 1);
    assert_eq!(restored_text.match_indices(replacement_text).count(), 0);

    let region_source_name = manifest
        .pointer("/fixedRegionProof/source")
        .and_then(Value::as_str)
        .expect("fixed-region source fixture name");
    let region_edited_name = manifest
        .pointer("/fixedRegionProof/edited")
        .and_then(Value::as_str)
        .expect("fixed-region edited fixture name");
    let region_repeated_name = manifest
        .pointer("/fixedRegionProof/editedRepeat")
        .and_then(Value::as_str)
        .expect("fixed-region repeated fixture name");
    let region_replacement_text = manifest
        .pointer("/fixedRegionProof/replacementText")
        .and_then(Value::as_str)
        .expect("fixed-region replacement text");
    let region_original_text = manifest
        .pointer("/fixedRegionProof/originalText")
        .and_then(Value::as_str)
        .expect("fixed-region original text");
    let region_source_handle = load(&fixture_dir.join(region_source_name));
    let region_edited_handle = load(&fixture_dir.join(region_edited_name));
    let region_repeated_handle = load(&fixture_dir.join(region_repeated_name));
    let region_source = render(&region_source_handle);
    let region_edited = render(&region_edited_handle);
    let region_repeated = render(&region_repeated_handle);
    let region_approved = (
        integer(&manifest, "/fixedRegionProof/approvedRegion/x"),
        integer(&manifest, "/fixedRegionProof/approvedRegion/y"),
        integer(&manifest, "/fixedRegionProof/approvedRegion/width"),
        integer(&manifest, "/fixedRegionProof/approvedRegion/height"),
    );
    let region_difference = compare(&region_source, &region_edited, Some(region_approved));
    assert!(
        region_difference.changed_pixels > 0,
        "PDFium must render every visible fixed-region replacement line"
    );
    assert_eq!(region_difference.outside_approved_changed_pixels, 0);
    assert_eq!(
        compare(&region_edited, &region_repeated, None).changed_pixels,
        0,
        "fixed-region repeated save must preserve exact visible pixels"
    );
    let region_edited_text = extract_all_page_text(region_edited_handle.document(), 0)
        .expect("PDFium extracts fixed-region searchable text");
    let region_repeated_text = extract_all_page_text(region_repeated_handle.document(), 0)
        .expect("PDFium extracts repeated fixed-region searchable text");
    for token in region_replacement_text.lines() {
        assert_eq!(region_edited_text.match_indices(token).count(), 1);
        assert_eq!(region_repeated_text.match_indices(token).count(), 1);
    }
    for token in region_original_text.lines() {
        assert_eq!(region_edited_text.match_indices(token).count(), 0);
        assert_eq!(region_repeated_text.match_indices(token).count(), 0);
    }

    let reflow_source_name = manifest
        .pointer("/reflowProof/source")
        .and_then(Value::as_str)
        .expect("reflow source fixture name");
    let reflow_edited_name = manifest
        .pointer("/reflowProof/edited")
        .and_then(Value::as_str)
        .expect("reflow edited fixture name");
    let reflow_repeated_name = manifest
        .pointer("/reflowProof/editedRepeat")
        .and_then(Value::as_str)
        .expect("reflow repeated fixture name");
    let reflow_lines = manifest
        .pointer("/reflowProof/wrappedLines")
        .and_then(Value::as_array)
        .expect("reflow wrapped lines");
    let reflow_original_text = manifest
        .pointer("/reflowProof/originalText")
        .and_then(Value::as_str)
        .expect("reflow original text");
    let reflow_source_handle = load(&fixture_dir.join(reflow_source_name));
    let reflow_edited_handle = load(&fixture_dir.join(reflow_edited_name));
    let reflow_repeated_handle = load(&fixture_dir.join(reflow_repeated_name));
    let reflow_source = render(&reflow_source_handle);
    let reflow_edited = render(&reflow_edited_handle);
    let reflow_repeated = render(&reflow_repeated_handle);
    let reflow_approved = (
        integer(&manifest, "/reflowProof/approvedRegion/x"),
        integer(&manifest, "/reflowProof/approvedRegion/y"),
        integer(&manifest, "/reflowProof/approvedRegion/width"),
        integer(&manifest, "/reflowProof/approvedRegion/height"),
    );
    let reflow_difference = compare(&reflow_source, &reflow_edited, Some(reflow_approved));
    assert!(
        reflow_difference.changed_pixels > 0,
        "PDFium must render the visible paragraph reflow"
    );
    assert_eq!(reflow_difference.outside_approved_changed_pixels, 0);
    assert_eq!(
        compare(&reflow_edited, &reflow_repeated, None).changed_pixels,
        0,
        "paragraph reflow repeated save must preserve exact visible pixels"
    );
    let reflow_edited_text = extract_all_page_text(reflow_edited_handle.document(), 0)
        .expect("PDFium extracts paragraph reflow searchable text");
    let reflow_repeated_text = extract_all_page_text(reflow_repeated_handle.document(), 0)
        .expect("PDFium extracts repeated paragraph reflow searchable text");
    for token in reflow_lines {
        let token = token.as_str().expect("reflow line must be text");
        assert_eq!(reflow_edited_text.match_indices(token).count(), 1);
        assert_eq!(reflow_repeated_text.match_indices(token).count(), 1);
    }
    for token in reflow_original_text.lines() {
        assert_eq!(reflow_edited_text.match_indices(token).count(), 0);
        assert_eq!(reflow_repeated_text.match_indices(token).count(), 0);
    }
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
            "singleLineChangedPixels": edited_difference.changed_pixels,
            "singleLineOutsideApprovedChangedPixels": edited_difference.outside_approved_changed_pixels,
            "singleLineReplacementOccurrences": edited_text.match_indices(replacement_text).count(),
            "singleLineRepeatedReplacementOccurrences": repeated_text.match_indices(replacement_text).count(),
            "singleLineRestoredOriginalOccurrences": restored_text.match_indices(original_text).count(),
            "fixedRegionChangedPixels": region_difference.changed_pixels,
            "fixedRegionOutsideApprovedChangedPixels": region_difference.outside_approved_changed_pixels,
            "fixedRegionRepeatedChangedPixels": compare(&region_edited, &region_repeated, None).changed_pixels,
            "fixedRegionReplacementLines": region_replacement_text.lines().count(),
            "reflowChangedPixels": reflow_difference.changed_pixels,
            "reflowOutsideApprovedChangedPixels": reflow_difference.outside_approved_changed_pixels,
            "reflowRepeatedChangedPixels": compare(&reflow_edited, &reflow_repeated, None).changed_pixels,
            "reflowWrappedLines": reflow_lines.len(),
        }))
        .expect("serialize PDFium comparison")
    );
}
