import { createOutputJob } from './output-job.js';
import { tempDir, join } from '@tauri-apps/api/path';
import { writeBinaryFile } from '../core/platform.js';
// Background print job: render the selected pages to a temp PDF and spool it
// to the printer, reporting progress through printProgressStore so the print
// dialog can close immediately and the user keeps working.

import { PDFDocument } from 'pdf-lib';
import i18next from '../i18n/config.js';
import { getActiveDocument, getPageRotation } from '../core/state.js';
import { invoke } from '../core/platform.js';
import { renderPageOffscreen, canvasToBytes } from './exporter.js';
import {
  startPrintProgress, updatePrintProgress, finishPrintProgress, failPrintProgress,
} from '../solid/stores/printProgressStore.js';

/**
 * Run a print job in the background. Fire-and-forget: the caller closes the
 * dialog first, this drives the floating progress bar.
 * @param {{ pages:number[], copies:number, printer:string }} opts
 */
export async function runPrintJob({ pages, copies, printer }) {
  let job, tempPath = null;
  try {
    job = await createOutputJob(i18next.t('dialogs:print.progress.preparing'));
    const doc = job.snapshot;
    if (!doc?.pdfDoc) throw new Error(i18next.t('dialogs:print.progress.errNoDocument'));
    const exportScale = 300 / 72;
    const newPdf = await PDFDocument.create();
    // Reserve the last slice of the bar for the spool step.
    const total = pages.length + 1;

    for (let i = 0; i < pages.length; i++) {
      const pageNum = pages[i];
      updatePrintProgress(i18next.t('dialogs:print.progress.renderingPage', { page: pageNum, current: i + 1, total: pages.length }), i / total);
      job.check();
      const canvas = await renderPageOffscreen(pageNum, exportScale, doc, job.signal);
      let jpegBytes;
      try { jpegBytes = await canvasToBytes(canvas, 'jpeg', 0.92); } finally { canvas.width = canvas.height = 0; }
      job.check();
      job.retainEncodedPage(jpegBytes.byteLength);
      const jpegImage = await newPdf.embedJpg(jpegBytes);

      const origPage = await doc.pdfDoc.getPage(pageNum);
      const extraRotation = doc.pageRotations?.[pageNum] || 0;
      const origViewportOpts = { scale: 1 };
      if (extraRotation) origViewportOpts.rotation = (origPage.rotate + extraRotation) % 360;
      const origViewport = origPage.getViewport(origViewportOpts);

      const pdfPage = newPdf.addPage([origViewport.width, origViewport.height]);
      pdfPage.drawImage(jpegImage, { x: 0, y: 0, width: origViewport.width, height: origViewport.height });
    }

    updatePrintProgress(i18next.t('dialogs:print.progress.saving'), pages.length / total);
    const pdfBytes = await newPdf.save();
    job.check();
    tempPath = await join(await tempDir(), `opds-print-${crypto.randomUUID()}.pdf`);
    await writeBinaryFile(tempPath, pdfBytes);
    if (!tempPath) throw new Error(i18next.t('dialogs:print.progress.errTempFile'));

    job.submitted();
    const numCopies = Math.max(1, Number(copies) || 1);
    for (let c = 0; c < numCopies; c++) {
      updatePrintProgress(
        numCopies > 1
          ? i18next.t('dialogs:print.progress.sendingCopy', { current: c + 1, total: numCopies })
          : i18next.t('dialogs:print.progress.sending'),
        (pages.length + c / numCopies) / total
      );
      await invoke('print_pdf', { path: tempPath, printer });
    }

    await job.finish('completed', i18next.t('dialogs:print.progress.sent'));
  } catch (error) {
    if (job) await job.finish(job.signal.aborted ? 'cancelled' : 'failed', job.signal.aborted ? 'Cancelled' : error.message);
    else failPrintProgress(error.message);
  } finally {
    if (tempPath) {
      // Native print has consumed the file before resolving (including failures).
      try { await invoke('delete_file', { path: tempPath }); } catch (error) { console.warn('Print temporary cleanup failed', error); }
    }
  }
}
