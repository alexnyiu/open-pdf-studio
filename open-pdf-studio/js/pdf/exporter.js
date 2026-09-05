import i18next from '../i18n/config.js';
const tr = (key, values) => i18next.t(`common:repair.${key}`, values);
import { join, dirname, normalize } from '@tauri-apps/api/path';
import { createOutputJob, captureOutputSource } from './output-job.js';
import { assertOutputRasterSize } from './output-snapshot.js';
import { state, getActiveDocument, getAnnotationBounds } from '../core/state.js';
import { showLoading, hideLoading } from '../ui/chrome/dialogs.js';
import { isTauri, writeBinaryFile, saveFileDialog, openFolderDialog } from '../core/platform.js';
import { renderAnnotationsForPage, renderOutputAnnotations, drawAnnotation } from '../annotations/rendering.js';
import { getPageRotation } from '../core/state.js';
import { PDFDocument } from 'pdf-lib';

/**
 * Parse a page range string like "1-5, 8, 11-13" into an array of page numbers.
 * @param {string} rangeStr - The range string
 * @param {number} totalPages - Total number of pages in the document
 * @returns {number[]} Array of 1-based page numbers, sorted and deduplicated
 */
export function parsePageRange(rangeStr, totalPages) {
  const pages = new Set();
  const parts = rangeStr.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const rangeParts = trimmed.split('-');
    if (rangeParts.length === 2) {
      const start = parseInt(rangeParts[0].trim(), 10);
      const end = parseInt(rangeParts[1].trim(), 10);
      if (isNaN(start) || isNaN(end)) continue;
      const lo = Math.max(1, Math.min(start, end));
      const hi = Math.min(totalPages, Math.max(start, end));
      for (let i = lo; i <= hi; i++) {
        pages.add(i);
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= totalPages) {
        pages.add(num);
      }
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

/**
 * Render a single PDF page + annotations to an off-screen canvas.
 * @param {number} pageNum - 1-based page number
 * @param {number} exportScale - Scale factor (e.g. 300/72 for 300 DPI)
 * @returns {Promise<HTMLCanvasElement>} The rendered canvas
 */
export async function renderPageOffscreen(pageNum, exportScale, owner, signal) {
  if (!owner?.pdfDoc) throw new TypeError('An explicit output document owner is required');
  signal?.throwIfAborted();
  const page = await owner.pdfDoc.getPage(pageNum);
  signal?.throwIfAborted();
  const viewport = page.getViewport({ scale: exportScale, rotation: (page.rotate + (owner.pageRotations?.[pageNum] || 0)) % 360 });
  assertOutputRasterSize(viewport.width, viewport.height);
  const pdfCanvas = document.createElement('canvas');
  pdfCanvas.width = Math.ceil(viewport.width); pdfCanvas.height = Math.ceil(viewport.height);
  const ctx = pdfCanvas.getContext('2d');
  const task = page.render({ canvasContext: ctx, viewport, annotationMode: 0 });
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await task.promise; signal?.throwIfAborted();
    renderOutputAnnotations(ctx, pageNum, owner, exportScale);
    return pdfCanvas;
  } catch (error) { pdfCanvas.width = pdfCanvas.height = 0; throw error; }
  finally { signal?.removeEventListener('abort', cancel); }
}

/**
 * Convert a canvas to a blob of the specified format.
 * @param {HTMLCanvasElement} canvas
 * @param {string} format - 'png' or 'jpeg'
 * @param {number} quality - JPEG quality (0-1)
 * @returns {Promise<Uint8Array>}
 */
export function canvasToBytes(canvas, format, quality) {
  return new Promise((resolve, reject) => {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to convert canvas to blob'));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
      },
      mimeType,
      format === 'jpeg' ? quality : undefined
    );
  });
}

/**
 * Get the base name of the current PDF (without extension).
 */
function getPdfBaseName() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc) return 'document';
  const fileName = doc.fileName || 'document';
  return fileName.replace(/\.pdf$/i, '');
}

/**
 * Export pages as image files (PNG or JPEG).
 * @param {Object} options
 * @param {string} options.format - 'png' or 'jpeg'
 * @param {number} options.quality - JPEG quality (0-1), default 0.92
 * @param {number} options.dpi - Export resolution, default 150
 * @param {number[]} options.pages - Array of 1-based page numbers
 */
export async function exportAsImages({ format = 'png', quality = 0.92, dpi = 150, pages }) {
  if (!getActiveDocument()?.pdfDoc || !isTauri()) return;
  const outputSource = captureOutputSource();
  pages = [...pages];

  const ext = format === 'jpeg' ? 'jpg' : 'png';
  const exportScale = dpi / 72;
  const baseName = getPdfBaseName();

  let outputPath = null;
  let folderPath = null;

  if (pages.length === 1) {
    // Single page: save file dialog
    const defaultName = `${baseName}_page${String(pages[0]).padStart(4, '0')}.${ext}`;
    const filters = format === 'jpeg'
      ? [{ name: 'JPEG Images', extensions: ['jpg', 'jpeg'] }]
      : [{ name: 'PNG Images', extensions: ['png'] }];
    outputPath = await saveFileDialog(defaultName, filters);
    if (!outputPath) return;
  } else {
    // Multiple pages: folder dialog
    folderPath = await openFolderDialog(tr('chooseImageFolder'));
    if (!folderPath) return;
  }

  const job = await createOutputJob(tr('exportImages'), outputSource);

  try {
    for (let i = 0; i < pages.length; i++) {
      const pageNum = pages[i];
      job.progress(tr('exportPage', { page: pageNum, current: i + 1, total: pages.length }), i / pages.length);

      const canvas = await renderPageOffscreen(pageNum, exportScale, job.snapshot, job.signal);
      let bytes;
      try { bytes = await canvasToBytes(canvas, format, quality); } finally { canvas.width = canvas.height = 0; }
      job.check();

      let filePath;
      if (pages.length === 1) {
        filePath = outputPath;
      } else {
        const fileName = `${baseName}_page${String(pageNum).padStart(4, '0')}.${ext}`;
        filePath = await join(folderPath, fileName);
        if (await normalize(await dirname(filePath)) !== await normalize(folderPath)) throw new Error('Invalid export destination');
      }

      job.check();
      await writeBinaryFile(filePath, bytes);
      job.writtenPaths.push(filePath);
    }
    return await job.finish('completed', tr('exportedImages', { count: job.writtenPaths.length }));
  } catch (error) {
    const cancelled = job.signal.aborted;
    await job.finish(cancelled ? 'cancelled' : 'failed', `${cancelled ? tr('cancelled') : error.message}. ${tr('partialImages', { count: job.writtenPaths.length })}`);
    if (!cancelled) throw error;
    return { status: 'cancelled', writtenPaths: [...job.writtenPaths] };
  }
}

/**
 * Export pages as a rasterized PDF (each page is a JPEG image).
 * @param {Object} options
 * @param {number} options.dpi - Export resolution, default 300
 * @param {number[]} options.pages - Array of 1-based page numbers
 */
export async function exportAsRasterPdf({ dpi = 300, pages }) {
  if (!getActiveDocument()?.pdfDoc || !isTauri()) return;
  const outputSource = captureOutputSource();
  pages = [...pages];

  const baseName = getPdfBaseName();
  const defaultName = `${baseName}_raster.pdf`;

  const outputPath = await saveFileDialog(defaultName, [
    { name: 'PDF Files', extensions: ['pdf'] }
  ]);
  if (!outputPath) return;

  const job = await createOutputJob(tr('exportRaster'), outputSource);

  try {
    const exportScale = dpi / 72;
    const newPdf = await PDFDocument.create();

    for (let i = 0; i < pages.length; i++) {
      const pageNum = pages[i];
      job.progress(tr('rasterPage', { page: pageNum, current: i + 1, total: pages.length }), i / pages.length);

      const canvas = await renderPageOffscreen(pageNum, exportScale, job.snapshot, job.signal);
      let jpegBytes;
      try { jpegBytes = await canvasToBytes(canvas, 'jpeg', 0.92); } finally { canvas.width = canvas.height = 0; }
      job.check();

      job.retainEncodedPage(jpegBytes.byteLength);
      const jpegImage = await newPdf.embedJpg(jpegBytes);

      // Get original page dimensions (in PDF points)
      const origPage = await job.snapshot.pdfDoc.getPage(pageNum);
      const extraRotation = job.snapshot.pageRotations?.[pageNum] || 0;
      const origViewportOpts = { scale: 1 };
      if (extraRotation) {
        origViewportOpts.rotation = (origPage.rotate + extraRotation) % 360;
      }
      const origViewport = origPage.getViewport(origViewportOpts);

      const page = newPdf.addPage([origViewport.width, origViewport.height]);
      page.drawImage(jpegImage, {
        x: 0,
        y: 0,
        width: origViewport.width,
        height: origViewport.height,
      });
    }

    const pdfBytes = await newPdf.save();
    job.check();
    await writeBinaryFile(outputPath, pdfBytes);
    job.writtenPaths.push(outputPath);

    // Open the rasterised result in a new tab. Each page is now a flat image,
    // so it renders identically in every viewer/printer — the reliable way to
    // share/print annotated drawings without appearance-stream mismatches.
    try {
      const { createTab } = await import('../ui/chrome/tabs.js');
      const { loadPDF } = await import('./loader.js');
      const { index, doc } = createTab(outputPath);
      await loadPDF(outputPath, index, null, { expectedDocumentId: doc.id, expectedGeneration: Number(doc.lifecycleGeneration) || 0 });
    } catch (e) {
      console.error('Could not open raster PDF in a new tab:', e);
    }
    await job.finish('completed', tr('rasterExported'));
  } catch (error) {
    await job.finish(job.signal.aborted ? 'cancelled' : 'failed', job.signal.aborted ? tr('cancelled') : error.message);
    if (!job.signal.aborted) throw error;
    return null;
  }
  return outputPath;
}

/**
 * Export a single annotation as a PNG image.
 * @param {Object} annotation - The annotation object to export
 */
export async function exportAnnotationAsImage(annotation) {
  if (!annotation || !isTauri()) return;

  const bounds = getAnnotationBounds(annotation);
  if (!bounds) return;

  const exportScale = 3; // 3x for high-res output
  const padding = 10; // padding in annotation units

  const x = bounds.x - padding;
  const y = bounds.y - padding;
  const w = bounds.width + padding * 2;
  const h = bounds.height + padding * 2;

  // Account for line width so strokes aren't clipped
  const lw = annotation.lineWidth ?? 3;
  const extra = lw / 2;

  const canvasW = Math.ceil((w + extra * 2) * exportScale);
  const canvasH = Math.ceil((h + extra * 2) * exportScale);

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  // Transparent background
  ctx.clearRect(0, 0, canvasW, canvasH);

  // Scale and translate so the annotation draws at the correct position
  ctx.save();
  ctx.scale(exportScale, exportScale);
  ctx.translate(-(x - extra), -(y - extra));

  drawAnnotation(ctx, annotation);

  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  const baseName = getPdfBaseName();
  const defaultName = `${baseName}_annotation.png`;

  const outputPath = await saveFileDialog(defaultName, [
    { name: 'PNG Images', extensions: ['png'] }
  ]);
  if (!outputPath) return;

  const bytes = await canvasToBytes(canvas, 'png');
  await writeBinaryFile(outputPath, bytes);
}
