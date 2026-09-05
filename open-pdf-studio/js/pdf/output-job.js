import i18next from '../i18n/config.js';
import * as pdfjsLib from 'pdfjs-dist';
import { getActiveDocument, imageCache } from '../core/state.js';
import { getCachedPdfBytes } from './loader.js';
import { captureOutputSnapshot, createOutputBufferBudget } from './output-snapshot.js';
import { createSaveDocumentSnapshot } from './save-document-snapshot.js';
import { startPrintProgress, updatePrintProgress, finishPrintProgress, failPrintProgress,
  setPrintCancellation, setPrintOutputPaths } from '../solid/stores/printProgressStore.js';

let activeJob = null;
export function captureOutputSource(documentState = getActiveDocument()) {
  const snapshot = captureOutputSnapshot(documentState, getCachedPdfBytes(documentState?.filePath));
  if (snapshot.needsTextPersistence) {
    snapshot.textPersistenceSnapshot = createSaveDocumentSnapshot({
      documentState, outputPath: documentState.filePath,
      requestedRevision: Number(documentState.revisionState?.contentRevision) || 0,
    });
  }
  snapshot.outputImages = new Map();
  for (const annotation of snapshot.annotations || []) {
    if (annotation.imageId && imageCache.has(annotation.imageId)) {
      snapshot.outputImages.set(annotation.imageId, imageCache.get(annotation.imageId));
    }
    annotation.popupOpen = false; annotation._popupFocused = false;
  }
  return snapshot;
}

export async function createOutputJob(label, source = captureOutputSource()) {
  if (activeJob) throw new Error(i18next.t('common:repair.outputBusy'));
  const snapshot = source;
  const controller = new AbortController();
  const images = snapshot.outputImages || new Map();
  let task = null;
  const bufferBudget = createOutputBufferBudget();
  let completion = null;
  const job = {
    retainEncodedPage(bytes) { job.check(); return bufferBudget.retain(bytes); },
    snapshot, signal: controller.signal, writtenPaths: [], status: 'running',
    check() { controller.signal.throwIfAborted(); },
    progress(message, value) { job.check(); updatePrintProgress(message, value); },
    submitted() { job.check(); job.status = 'submitted'; setPrintCancellation(null); },
    async finish(status, message) {
      if (completion) return completion;
      completion = { status, writtenPaths: [...job.writtenPaths] };
      job.status = status;
      setPrintCancellation(null);
      setPrintOutputPaths([...job.writtenPaths]);
      try {
        if (task) await task.destroy();
        else await snapshot.pdfDoc?.destroy();
      } catch (error) { console.warn('Output resource cleanup failed', error); } finally {
        delete snapshot.bytes; delete snapshot.textPersistenceSnapshot;
        images.clear(); activeJob = null;
        if (status === 'failed') failPrintProgress(message);
        else finishPrintProgress(message);
      }
      return completion;
    },
  };
  activeJob = job;
  startPrintProgress(label);
  setPrintCancellation(() => {
    controller.abort();
    if (task) void task.destroy().catch(() => {});
    updatePrintProgress(i18next.t('common:repair.cancelling'));
  });
  try {
    if (snapshot.needsTextPersistence) {
      const { prepareOutputTextCandidate } = await import('./output-text-candidate.js');
      snapshot.pdfDoc = await prepareOutputTextCandidate(snapshot, controller.signal);
      snapshot.outputPersistedRevision = Number(snapshot.revisionState?.contentRevision) || 0;
    } else {
      task = pdfjsLib.getDocument({ data: snapshot.bytes, cMapUrl: '/pdfjs/web/cmaps/',
        cMapPacked: true, standardFontDataUrl: '/pdfjs/web/standard_fonts/', isEvalSupported: false, verbosity: 0 });
      snapshot.pdfDoc = await task.promise;
    }
    delete snapshot.bytes; delete snapshot.textPersistenceSnapshot;
    job.check(); return job;
  }
  catch (error) { await job.finish(controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? i18next.t('common:repair.cancelled') : error.message); throw error; }
}
