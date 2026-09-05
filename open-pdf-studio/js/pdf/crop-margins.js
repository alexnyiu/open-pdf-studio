import { state, getActiveDocument } from "../core/state.js";
import { getCachedPdfBytes } from "./loader.js";
import { getCacheKey, reloadFromBytes } from "./page-manager.js";
import { renderPageOffscreen, parsePageRange } from "./exporter.js";
import { recordPageStructure } from "../core/undo-manager.js";
import { showLoading, hideLoading } from "../ui/chrome/dialogs.js";
import { PDFDocument } from "pdf-lib";

const ALPHA_THRESHOLD = 10;
const MAX_PIXELS = 20_000_000;
const MM_TO_POINTS = 72 / 25.4;

/**
 * Detect the content bounds of a rendered page by edge-inward pixel scanning.
 * @param {number} pageNum - 1-based page number
 * @param {number} threshold - Whiteness threshold (0-255), pixels brighter are "white"
 * @returns {Promise<{minX: number, minY: number, maxX: number, maxY: number, width: number, height: number, scale: number} | null>}
 */
async function detectContentBounds(pageNum, threshold) {
  // Determine render scale — reduce for very large pages
  const doc = getActiveDocument();
  const page = await doc.pdfDoc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const basePixels = vp.width * vp.height;
  let scale = 1;
  if (basePixels > MAX_PIXELS) {
    scale = Math.sqrt(MAX_PIXELS / basePixels);
  } else if (basePixels * 4 <= MAX_PIXELS) {
    // Use scale 2 for small pages to get better accuracy
    scale = 2;
  }

  const canvas = await renderPageOffscreen(pageNum, scale, doc);
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  /**
   * Check if a pixel at (x, y) is "content" (non-white).
   */
  function isContent(x, y) {
    const idx = (y * width + x) * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const a = data[idx + 3];
    return a >= ALPHA_THRESHOLD && (r < threshold || g < threshold || b < threshold);
  }

  // Scan rows from top to find first content row
  let minY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isContent(x, y)) {
        minY = y;
        break;
      }
    }
    if (minY !== -1) break;
  }

  // Fully white page
  if (minY === -1) return null;

  // Scan rows from bottom to find last content row
  let maxY = minY;
  for (let y = height - 1; y > minY; y--) {
    let found = false;
    for (let x = 0; x < width; x++) {
      if (isContent(x, y)) {
        maxY = y;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  // Scan columns from left (only between minY..maxY)
  let minX = width;
  for (let x = 0; x < width; x++) {
    let found = false;
    for (let y = minY; y <= maxY; y++) {
      if (isContent(x, y)) {
        minX = x;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  // Scan columns from right (only between minY..maxY)
  let maxX = minX;
  for (let x = width - 1; x > minX; x--) {
    let found = false;
    for (let y = minY; y <= maxY; y++) {
      if (isContent(x, y)) {
        maxX = x;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  return { minX, minY, maxX, maxY, width, height, scale };
}

/**
 * Compute a PDF CropBox from pixel bounds, accounting for page rotation.
 * @param {{minX: number, minY: number, maxX: number, maxY: number, width: number, height: number, scale: number}} bounds
 * @param {import('pdf-lib').PDFPage} pdfPage - The pdf-lib page
 * @param {number} paddingPt - Padding in PDF points
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function computeCropBox(bounds, pdfPage, paddingPt) {
  const mediaBox = pdfPage.getMediaBox();
  const rotation = pdfPage.getRotation().angle % 360;

  // Convert pixel bounds to fractional positions (0..1)
  const fracLeft = bounds.minX / bounds.width;
  const fracRight = bounds.maxX / bounds.width;
  const fracTop = bounds.minY / bounds.height;
  const fracBottom = bounds.maxY / bounds.height;

  let cropX, cropY, cropW, cropH;

  if (rotation === 0) {
    // Canvas: origin top-left, Y down. PDF: origin bottom-left, Y up
    cropX = mediaBox.x + fracLeft * mediaBox.width;
    cropY = mediaBox.y + (1 - fracBottom) * mediaBox.height;
    cropW = (fracRight - fracLeft) * mediaBox.width;
    cropH = (fracBottom - fracTop) * mediaBox.height;
  } else if (rotation === 90) {
    // 90° rotation: canvas X maps to PDF Y, canvas Y maps to PDF X (inverted)
    cropX = mediaBox.x + fracTop * mediaBox.width;
    cropY = mediaBox.y + fracLeft * mediaBox.height;
    cropW = (fracBottom - fracTop) * mediaBox.width;
    cropH = (fracRight - fracLeft) * mediaBox.height;
  } else if (rotation === 180) {
    // 180° rotation: both axes inverted
    cropX = mediaBox.x + (1 - fracRight) * mediaBox.width;
    cropY = mediaBox.y + fracTop * mediaBox.height;
    cropW = (fracRight - fracLeft) * mediaBox.width;
    cropH = (fracBottom - fracTop) * mediaBox.height;
  } else if (rotation === 270) {
    // 270° rotation: canvas X maps to PDF Y (inverted), canvas Y maps to PDF X
    cropX = mediaBox.x + (1 - fracBottom) * mediaBox.width;
    cropY = mediaBox.y + (1 - fracRight) * mediaBox.height;
    cropW = (fracBottom - fracTop) * mediaBox.width;
    cropH = (fracRight - fracLeft) * mediaBox.height;
  } else {
    // Fallback: treat as 0°
    cropX = mediaBox.x + fracLeft * mediaBox.width;
    cropY = mediaBox.y + (1 - fracBottom) * mediaBox.height;
    cropW = (fracRight - fracLeft) * mediaBox.width;
    cropH = (fracBottom - fracTop) * mediaBox.height;
  }

  // Apply padding
  cropX -= paddingPt;
  cropY -= paddingPt;
  cropW += 2 * paddingPt;
  cropH += 2 * paddingPt;

  // Clamp to MediaBox
  cropX = Math.max(mediaBox.x, cropX);
  cropY = Math.max(mediaBox.y, cropY);
  cropW = Math.min(cropW, mediaBox.x + mediaBox.width - cropX);
  cropH = Math.min(cropH, mediaBox.y + mediaBox.height - cropY);

  return { x: cropX, y: cropY, width: cropW, height: cropH };
}

/**
 * Crop margins from pages in the current document.
 * @param {'current' | 'all' | 'range'} applyTo - Which pages to crop
 * @param {string} rangeStr - Page range string (only used when applyTo is 'range')
 * @param {number} paddingMm - Padding around content in mm
 * @param {number} threshold - Whiteness threshold (200-255)
 * @returns {Promise<{cropped: number, skipped: number}>}
 */
export async function cropMargins(applyTo, rangeStr, paddingMm, threshold) {
  if (!getActiveDocument()?.pdfDoc) return { cropped: 0, skipped: 0 };

  const cacheKey = getCacheKey();
  const currentBytes = getCachedPdfBytes(cacheKey);
  if (!currentBytes) return { cropped: 0, skipped: 0 };

  const doc = getActiveDocument();
  const oldAnnotations = doc.annotations.map((a) => ({ ...a }));
  const oldRotations = { ...doc.pageRotations };
  const oldPage = doc.currentPage;

  // Determine which pages to process
  const totalPages = doc.pdfDoc.numPages;
  let pageNumbers;
  if (applyTo === "current") {
    pageNumbers = [doc.currentPage];
  } else if (applyTo === "all") {
    pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    pageNumbers = parsePageRange(rangeStr, totalPages);
  }

  if (pageNumbers.length === 0) return { cropped: 0, skipped: 0 };

  const paddingPt = paddingMm * MM_TO_POINTS;

  showLoading("Detecting content bounds...");
  try {
    // First pass: detect bounds for all pages
    const boundsMap = new Map();
    for (const pageNum of pageNumbers) {
      showLoading(`Analyzing page ${pageNum} of ${totalPages}...`);
      const bounds = await detectContentBounds(pageNum, threshold);
      if (bounds) {
        boundsMap.set(pageNum, bounds);
      }
    }

    if (boundsMap.size === 0) {
      return { cropped: 0, skipped: pageNumbers.length };
    }

    // Second pass: apply CropBox via pdf-lib
    showLoading("Applying crop...");
    const pdfDoc = await PDFDocument.load(currentBytes, {
      ignoreEncryption: true,
    });
    const pages = pdfDoc.getPages();

    for (const [pageNum, bounds] of boundsMap) {
      const pdfPage = pages[pageNum - 1];
      const crop = computeCropBox(bounds, pdfPage, paddingPt);
      pdfPage.setCropBox(crop.x, crop.y, crop.width, crop.height);
    }

    const newBytes = new Uint8Array(await pdfDoc.save());

    // Annotations and rotations stay the same — CropBox doesn't change page structure
    const newAnnotations = oldAnnotations;
    const newRotations = { ...oldRotations };
    const targetPage = doc.currentPage;

    await reloadFromBytes(newBytes, newAnnotations, newRotations, targetPage);
    recordPageStructure(
      currentBytes,
      oldAnnotations,
      oldRotations,
      oldPage,
      newBytes,
      newAnnotations,
      newRotations,
      targetPage
    );

    return {
      cropped: boundsMap.size,
      skipped: pageNumbers.length - boundsMap.size,
    };
  } finally {
    hideLoading();
  }
}
