import { state, getActiveDocument } from '../core/state.js';
import { invoke, isTauri } from '../core/platform.js';
import {
  clearEditableMetadataPreload,
  preloadEditableMetadataPage,
  releaseEditableMetadataPage,
  scheduleEditableMetadataPreload,
} from './editable-metadata-preload.js';
import {
  preloadThumbnailPage,
  cancelDocumentThumbnailWork,
  releaseThumbnailPage,
  releasePreloadOnlyThumbnails,
  visibleThumbnailPages,
} from '../ui/panels/left-panel.js';
import { wholeDocumentPreloadPages } from './pdf-preload-controller.js';
import { documentPreloadMode, shouldPreloadEntireDocument } from './preload-policy.js';
import { isPdfForegroundIdle } from './foreground-activity.js';
import { backgroundRenderAdmissionAllowed } from './render-resource-budget.js';
import {
  captureRenderPublicationToken,
  recordRejectedRenderPublication,
  renderPublicationTokenIsCurrent,
} from './render-publication-token.js';
import {
  registerWholePdfPreloadSuspensionListener,
  wholePdfPreloadIsSuspended,
} from './whole-pdf-preload-suspension.js';

export const WHOLE_PDF_PRELOAD_LIMITS = Object.freeze({
  maxPages: 1000,
  maxBytes: 256 * 1024 * 1024,
  maxWorkMs: 120_000,
});

export const ADAPTIVE_PDF_PRELOAD_LIMITS = Object.freeze({
  maxPages: 50,
  maxBytes: 64 * 1024 * 1024,
  maxWorkMs: 30_000,
});

const coordinators = new WeakMap();
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const clock = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

export function wholePdfPreloadOrder(currentPage, totalPages, visiblePages = []) {
  return wholeDocumentPreloadPages(currentPage, totalPages, visiblePages);
}

function status(doc, patch) {
  doc.preloadStatus = Object.freeze({
    state: 'idle',
    completed: 0,
    total: doc.pdfDoc?.numPages || 0,
    retainedBytes: 0,
    limitReason: null,
    ...(doc.preloadStatus || {}),
    documentId: String(doc.id || ''),
    lifecycleGeneration: Number(doc.lifecycleGeneration) || 0,
    pdfDocument: doc.pdfDoc || null,
    contentRevision: Number(doc.revisionState?.contentRevision) || 0,
    livePdfRevision: Number(doc.revisionState?.livePdfRevision) || 0,
    ...patch,
  });
}

function preloadTokenIsCurrent(token, doc) {
  return getActiveDocument() === doc && renderPublicationTokenIsCurrent(token, doc);
}

async function preloadVectorCommands(doc, pageNum, publicationToken) {
  if (!isTauri() || !doc.filePath || state.renderEngineOverride != null) return { bytes: 0 };
  const rotation = Number(doc.pageRotations?.[pageNum]) || 0;
  const vector = await import('./vector-renderer.js');
  if (!preloadTokenIsCurrent(publicationToken, doc)) return { bytes: 0, stale: true };
  if (vector.hasCachedCommands(doc.filePath, pageNum, rotation)) return { bytes: 0 };
  const pageType = await invoke('analyze_page_type', {
    path: doc.filePath,
    pageIndex: pageNum - 1,
    requestId: publicationToken.requestId,
  });
  if (!preloadTokenIsCurrent(publicationToken, doc)) return { bytes: 0, stale: true };
  if (pageType !== 'vector') return { bytes: 0 };
  const result = await invoke('extract_draw_commands', {
    path: doc.filePath,
    pageIndex: pageNum - 1,
    rotation,
    requestId: publicationToken.requestId,
  });
  if (!preloadTokenIsCurrent(publicationToken, doc)) return { bytes: 0, stale: true };
  const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
  const publication = { token: publicationToken, documentState: doc };
  vector.cacheCommands(doc.filePath, pageNum, bytes, rotation, publication);
  await vector.prepareImages(doc.filePath, pageNum, rotation, publication);
  if (!preloadTokenIsCurrent(publicationToken, doc)) return { bytes: 0, stale: true };
  return { bytes: bytes.byteLength };
}

export class WholePdfPreloadCoordinator {
  constructor(doc, limits = WHOLE_PDF_PRELOAD_LIMITS) {
    this.doc = doc;
    this.limits = limits;
    this.generation = 0;
    this.completedPages = new Set();
    this.preloadPages = new Set();
    this.retainedBytes = 0;
    this.workMs = 0;
    this.task = Promise.resolve();
    this.running = false;
    this.pdfIdentity = doc.pdfDoc;
  }

  isForegroundIdle() {
    return isPdfForegroundIdle()
      && backgroundRenderAdmissionAllowed()
      && !state.isDrawing
      && !state.isEditingText;
  }

  effectiveLimits() {
    return documentPreloadMode(state.preferences) === 'adaptive'
      ? ADAPTIVE_PDF_PRELOAD_LIMITS
      : this.limits;
  }

  cancel({ release = false, reason = 'cancelled' } = {}) {
    this.generation += 1;
    this.running = false;
    status(this.doc, { state: reason === 'preference-off' ? 'cancelled' : 'paused' });
    if (release) {
      cancelDocumentThumbnailWork(this.doc);
      const keep = [this.doc.currentPage, ...visibleThumbnailPages()];
      releasePreloadOnlyThumbnails(this.doc, keep);
      void import('./vector-renderer.js').then((vector) => {
        for (const pageNum of this.preloadPages) {
          if (!keep.includes(pageNum) && this.doc.filePath) vector.invalidatePageCache(this.doc.filePath, pageNum);
        }
      });
      this.preloadPages = new Set(keep.filter((page) => this.preloadPages.has(page)));
      clearEditableMetadataPreload(this.doc);
      if (reason === 'preference-off' && getActiveDocument() === this.doc && this.doc.pdfDoc) {
        void scheduleEditableMetadataPreload(this.doc.currentPage, 1, {
          editTextActive: state.currentTool === 'editText',
        });
      }
    }
  }

  start() {
    if (!this.doc?.pdfDoc || !shouldPreloadEntireDocument(this.doc, state.preferences)) return Promise.resolve();
    if (this.pdfIdentity !== this.doc.pdfDoc) {
      this.cancel({ release: true, reason: 'reload' });
      this.completedPages.clear();
      this.preloadPages.clear();
      this.retainedBytes = 0;
      this.workMs = 0;
      this.pdfIdentity = this.doc.pdfDoc;
    }
    if (this.running) return this.task;
    const generation = ++this.generation;
    const total = this.doc.pdfDoc.numPages;
    const order = wholePdfPreloadOrder(this.doc.currentPage, total, visibleThumbnailPages());
    status(this.doc, { state: 'running', total, limitReason: null });
    this.running = true;
    this.task = this.task.catch(() => {}).then(() => this.run(order, generation)).finally(() => {
      if (generation === this.generation) this.running = false;
    });
    return this.task;
  }

  async run(order, generation) {
    const runPage = Math.min(
      Math.max(1, Number(this.doc.currentPage) || 1),
      Math.max(1, Number(this.doc.pdfDoc?.numPages) || 1),
    );
    const runToken = captureRenderPublicationToken(this.doc, runPage, 'whole-pdf-preload-run');
    for (const pageNum of order) {
      if (generation !== this.generation || !this.doc.pdfDoc
          || !preloadTokenIsCurrent(runToken, this.doc)) {
        recordRejectedRenderPublication(runToken, 'whole-preload-run-stale');
        return;
      }
      if (!shouldPreloadEntireDocument(this.doc, state.preferences)) {
        this.cancel({ release: true, reason: 'preference-off' });
        return;
      }
      if (getActiveDocument() !== this.doc) {
        status(this.doc, { state: 'paused' });
        return;
      }
      if (this.completedPages.has(pageNum)) continue;
      const limitReason = this.limitReason();
      if (limitReason) {
        status(this.doc, { state: 'limited', limitReason });
        return;
      }
      while (!this.isForegroundIdle()) {
        if (generation !== this.generation || !preloadTokenIsCurrent(runToken, this.doc)) {
          recordRejectedRenderPublication(runToken, 'whole-preload-during-pause');
          return;
        }
        status(this.doc, { state: 'paused' });
        await delay(50);
      }
      if (!preloadTokenIsCurrent(runToken, this.doc)) {
        recordRejectedRenderPublication(runToken, 'whole-preload-after-pause');
        return;
      }
      status(this.doc, { state: 'running' });
      const started = clock();
      const publicationToken = captureRenderPublicationToken(
        this.doc,
        pageNum,
        'whole-pdf-preload-page',
      );
      try {
        const thumbnail = await preloadThumbnailPage(this.doc, pageNum, { preloadOnly: true });
        if (generation !== this.generation || !preloadTokenIsCurrent(publicationToken, this.doc)) {
          releaseThumbnailPage(this.doc, pageNum);
          recordRejectedRenderPublication(publicationToken, 'whole-preload-after-thumbnail');
          return;
        }
        const vector = await preloadVectorCommands(this.doc, pageNum, publicationToken);
        if (generation !== this.generation || vector?.stale
            || !preloadTokenIsCurrent(publicationToken, this.doc)) {
          releaseThumbnailPage(this.doc, pageNum);
          if (this.doc.filePath) {
            const vectorCache = await import('./vector-renderer.js');
            vectorCache.invalidatePageCache(this.doc.filePath, pageNum);
          }
          recordRejectedRenderPublication(publicationToken, 'whole-preload-after-vector');
          return;
        }
        const editable = await preloadEditableMetadataPage(
          this.doc,
          pageNum,
          publicationToken,
        );
        if (generation !== this.generation || !preloadTokenIsCurrent(publicationToken, this.doc)) {
          releaseThumbnailPage(this.doc, pageNum);
          releaseEditableMetadataPage(this.doc, pageNum);
          recordRejectedRenderPublication(publicationToken, 'whole-preload-after-metadata');
          return;
        }
        const pageBytes = (thumbnail?.bytes || 0) + (vector?.bytes || 0) + (editable?.bytes || 0);
        if (this.retainedBytes + pageBytes > this.effectiveLimits().maxBytes) {
          releaseThumbnailPage(this.doc, pageNum);
          releaseEditableMetadataPage(this.doc, pageNum);
          if (this.doc.filePath) {
            const vectorCache = await import('./vector-renderer.js');
            vectorCache.invalidatePageCache(this.doc.filePath, pageNum);
          }
          status(this.doc, { state: 'limited', limitReason: 'bytes' });
          return;
        }
        this.completedPages.add(pageNum);
        this.preloadPages.add(pageNum);
        this.retainedBytes += pageBytes;
      } catch (error) {
        console.warn(`[preload] page ${pageNum} failed:`, error?.message || error);
      } finally {
        if (generation === this.generation
            && preloadTokenIsCurrent(publicationToken, this.doc)) {
          this.workMs += clock() - started;
          status(this.doc, {
            completed: this.completedPages.size,
            retainedBytes: this.retainedBytes,
          });
        }
      }
      await delay(0);
    }
    if (generation === this.generation && preloadTokenIsCurrent(runToken, this.doc)) {
      status(this.doc, { state: 'complete' });
    } else {
      recordRejectedRenderPublication(runToken, 'whole-preload-before-complete');
    }
  }

  limitReason() {
    const limits = this.effectiveLimits();
    if (this.completedPages.size >= limits.maxPages) return 'pages';
    if (this.retainedBytes >= limits.maxBytes) return 'bytes';
    if (this.workMs >= limits.maxWorkMs) return 'time';
    return null;
  }
}

export function wholePdfPreloadStatusIsCurrent(doc) {
  const preloadStatus = doc?.preloadStatus;
  return Boolean(preloadStatus
    && preloadStatus.documentId === String(doc.id || '')
    && preloadStatus.lifecycleGeneration === (Number(doc.lifecycleGeneration) || 0)
    && preloadStatus.pdfDocument === doc.pdfDoc
    && preloadStatus.contentRevision === (Number(doc.revisionState?.contentRevision) || 0)
    && preloadStatus.livePdfRevision === (Number(doc.revisionState?.livePdfRevision) || 0));
}

function coordinatorFor(doc) {
  let coordinator = coordinators.get(doc);
  if (!coordinator) {
    coordinator = new WholePdfPreloadCoordinator(doc);
    coordinators.set(doc, coordinator);
  }
  return coordinator;
}

export function startWholePdfPreload(doc = getActiveDocument()) {
  return doc && !wholePdfPreloadIsSuspended(doc) ? coordinatorFor(doc).start() : Promise.resolve();
}

export function cancelWholePdfPreload(doc = getActiveDocument(), options = {}) {
  const coordinator = doc && coordinators.get(doc);
  coordinator?.cancel(options);
}

export function restartWholePdfPreload(doc = getActiveDocument()) {
  if (!doc) return Promise.resolve();
  const old = coordinators.get(doc);
  old?.cancel({ release: true, reason: 'mutation' });
  coordinators.delete(doc);
  return !wholePdfPreloadIsSuspended(doc) && shouldPreloadEntireDocument(doc, state.preferences)
    ? startWholePdfPreload(doc) : Promise.resolve();
}

registerWholePdfPreloadSuspensionListener((doc, reason) => {
  cancelWholePdfPreload(doc, { release: true, reason });
});
