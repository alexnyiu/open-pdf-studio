// @ts-check

import {
  OCR_APPLICATION_PAGE_STATES,
  OcrApplicationController,
} from './application-controller.js';
import { getDefaultOcrModelPackState } from './model-state.js';

/** @typedef {import('../types/ocr.js').OcrDocumentJobSummary} OcrDocumentJobSummary */
/** @typedef {import('../types/ocr.js').OcrWorkflowJobState} OcrWorkflowJobState */
/** @typedef {import('../types/ocr.js').OcrWorkflowSnapshot} OcrWorkflowSnapshot */
/** @typedef {import('../types/ocr.js').OcrWorkflowUpdate} OcrWorkflowUpdate */

// Use the upper end of the release-hardening 100-125 ms delivery window.
// Scheduling at exactly 100 ms can be observed as 99 ms by a millisecond
// clock when a platform timer lands on the adjacent tick, which violates the
// externally measured no-more-than-10-Hz contract despite correct coalescing.
export const OCR_WORKFLOW_PUBLICATION_INTERVAL_MS = 125;

function clone(value) {
  return structuredClone(value);
}

function highResolutionNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function documentDisplayName(document, sourcePdfPath) {
  const candidate = typeof document?.fileName === 'string' && document.fileName.trim()
    ? document.fileName
    : sourcePdfPath;
  const name = typeof candidate === 'string'
    ? candidate.split(/[\\/]/).filter(Boolean).at(-1)
    : null;
  return name || 'Untitled.pdf';
}

/** @returns {Record<import('../types/ocr.js').OcrApplicationPageState, number>} */
function pageCounts(pages) {
  const counts = /** @type {Record<import('../types/ocr.js').OcrApplicationPageState, number>} */ (
    Object.fromEntries(OCR_APPLICATION_PAGE_STATES.map((state) => [state, 0]))
  );
  for (const page of pages) {
    if (Object.hasOwn(counts, page.state)) counts[page.state] += 1;
  }
  return counts;
}

function terminalFocusPage(pages, status) {
  const preferredState = status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : null;
  return pages.find((page) => page.state === preferredState)
    ?? pages.find((page) => page.state === 'failed' || page.state === 'cancelled')
    ?? pages.at(-1)
    ?? null;
}

function publicFailure(error, fallbackCode = 'OCR_WORKFLOW_FAILED', fallbackStage = 'application') {
  return {
    pageNumber: null,
    code: typeof error?.code === 'string' ? error.code : fallbackCode,
    stage: typeof error?.stage === 'string' ? error.stage : fallbackStage,
    retryable: error?.retryable === true,
  };
}

function summaryFailures(summary) {
  return summary.pages
    .filter((page) => page.failure)
    .map((page) => ({ pageNumber: page.pageNumber, ...clone(page.failure) }));
}

/**
 * Application-lifetime owner for production OCR jobs. The controller and its
 * returned handles stay here; UI stores receive only cloneable status data.
 */
export class OcrWorkflowService {
  constructor({
    controller = null,
    modelState = getDefaultOcrModelPackState(),
    publicationIntervalMs = OCR_WORKFLOW_PUBLICATION_INTERVAL_MS,
    clock = () => Date.now(),
    performanceClock = highResolutionNow,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
  } = {}) {
    this.modelState = modelState;
    this.controller = controller ?? new OcrApplicationController({ modelState });
    /** @type {Map<string, {handle: any, token: symbol, suppressPublications: boolean, cancellationPromise: Promise<any> | null, pageIndex: Map<number, any>, failureMap: Map<number, any>, lastSequence: number}>} */
    this.activeJobs = new Map();
    /** @type {Map<string, OcrWorkflowJobState>} */
    this.states = new Map();
    this.listeners = new Set();
    this.updateListeners = new Set();
    this.closedDocuments = new Set();
    this.applicationClosing = false;
    this.publicationIntervalMs = Math.max(100, Number(publicationIntervalMs) || OCR_WORKFLOW_PUBLICATION_INTERVAL_MS);
    this.clock = clock;
    this.performanceClock = performanceClock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.publicationTimer = null;
    this.lastPublicationAt = null;
    this.pendingSnapshotPublication = false;
    /** @type {Map<string, {documentId: string, removed: boolean, terminal: boolean, progressPageNumbers: Set<number>}>} */
    this.pendingUpdates = new Map();
    this.publicationStats = {
      startedAt: new Date().toISOString(),
      publications: 0,
      snapshotPublications: 0,
      deltaPublications: 0,
      deliveryBatches: 0,
      ordinaryDeliveryBatches: 0,
      immediateDeliveryBatches: 0,
      minimumOrdinaryDeliveryIntervalMs: null,
      bookkeepingEvents: 0,
      bookkeepingMs: 0,
      clonedBytes: 0,
      lastPublishedAt: null,
    };
    this.publicationStartedAt = this.clock();
    this.lastOrdinaryDeliveryAt = null;
  }

  /** @returns {OcrWorkflowSnapshot} */
  snapshot() {
    return {
      jobsByDocumentId: Object.fromEntries(
        [...this.states.entries()].map(([documentId, state]) => [documentId, clone(state)]),
      ),
    };
  }

  /** @param {(snapshot: OcrWorkflowSnapshot) => void} listener */
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('OCR workflow listener must be a function');
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /**
   * Delta subscribers receive one initial snapshot, then document-scoped
   * updates. This keeps the Solid bridge from cloning every retained job for
   * each page-stage transition.
   * @param {(update: OcrWorkflowUpdate) => void} listener
   */
  subscribeUpdates(listener) {
    if (typeof listener !== 'function') throw new TypeError('OCR workflow update listener must be a function');
    this.updateListeners.add(listener);
    listener({ kind: 'snapshot', snapshot: this.snapshot() });
    return () => this.updateListeners.delete(listener);
  }

  publicationMetrics() {
    const elapsedMs = Math.max(1, this.clock() - this.publicationStartedAt);
    const minimumInterval = this.publicationStats.minimumOrdinaryDeliveryIntervalMs;
    return {
      ...this.publicationStats,
      elapsedMs,
      publicationsPerSecond: this.publicationStats.publications * 1000 / elapsedMs,
      deliveryBatchesPerSecond: this.publicationStats.deliveryBatches * 1000 / elapsedMs,
      bookkeepingCpuPercent: this.publicationStats.bookkeepingMs * 100 / elapsedMs,
      maximumOrdinaryDeliveryHz: Number.isFinite(minimumInterval) && minimumInterval > 0
        ? 1000 / minimumInterval
        : 0,
    };
  }

  recordPublication(payload, kind) {
    this.publicationStats.publications += 1;
    this.publicationStats[`${kind}Publications`] += 1;
    this.publicationStats.lastPublishedAt = new Date().toISOString();
    try {
      this.publicationStats.clonedBytes += new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    } catch {
      // Metrics must never interfere with progress delivery.
    }
  }

  emit(listener, value) {
    try { listener(value); } catch { /* observers cannot alter OCR execution */ }
  }

  recordDeliveryBatch({ immediate }) {
    this.publicationStats.deliveryBatches += 1;
    if (immediate) {
      this.publicationStats.immediateDeliveryBatches += 1;
      return;
    }
    this.publicationStats.ordinaryDeliveryBatches += 1;
    const deliveredAt = this.clock();
    if (this.lastOrdinaryDeliveryAt !== null) {
      const interval = Math.max(0, deliveredAt - this.lastOrdinaryDeliveryAt);
      const current = this.publicationStats.minimumOrdinaryDeliveryIntervalMs;
      this.publicationStats.minimumOrdinaryDeliveryIntervalMs = current === null
        ? interval
        : Math.min(current, interval);
    }
    this.lastOrdinaryDeliveryAt = deliveredAt;
  }

  emitSnapshot() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) this.emit(listener, snapshot);
    const update = /** @type {OcrWorkflowUpdate} */ ({ kind: 'snapshot', snapshot });
    for (const listener of this.updateListeners) this.emit(listener, update);
    this.recordPublication(snapshot, 'snapshot');
  }

  emitDocumentUpdate(pending) {
    const state = pending.removed ? null : this.states.get(pending.documentId) ?? null;
    const active = this.activeJobs.get(pending.documentId);
    const progressPages = state && active && pending.progressPageNumbers?.size > 0
      ? [...pending.progressPageNumbers]
        .map((pageNumber) => active.pageIndex.get(pageNumber))
        .filter(Boolean)
        .map((page) => clone(page))
      : [];
    const update = /** @type {OcrWorkflowUpdate} */ (progressPages.length > 0 && !pending.terminal
      ? {
        kind: 'progress',
        documentId: pending.documentId,
        jobId: state.jobId,
        sequence: active.lastSequence,
        status: state.status,
        progress: state.progress,
        pages: progressPages,
        counts: clone(state.counts),
        currentPageNumber: state.currentPageNumber,
        currentPageState: state.currentPageState,
        failureDetails: clone(state.failureDetails),
        cancellationAvailable: state.cancellationAvailable,
        cancellationRequested: state.cancellationRequested,
      }
      : {
        kind: 'delta',
        documentId: pending.documentId,
        job: state ? clone(state) : null,
        terminal: pending.terminal,
      });
    for (const listener of this.updateListeners) this.emit(listener, update);
    this.recordPublication(update, 'delta');
    if (this.listeners.size > 0) {
      const snapshot = this.snapshot();
      for (const listener of this.listeners) this.emit(listener, snapshot);
      this.recordPublication(snapshot, 'snapshot');
    }
  }

  flushPublications({ immediate = false } = {}) {
    if (this.publicationTimer !== null) {
      this.clearTimer(this.publicationTimer);
      this.publicationTimer = null;
    }
    if (!this.pendingSnapshotPublication && this.pendingUpdates.size === 0) return;
    const publishSnapshot = this.pendingSnapshotPublication;
    const updates = [...this.pendingUpdates.values()];
    this.pendingSnapshotPublication = false;
    this.pendingUpdates.clear();
    if (!immediate) this.lastPublicationAt = this.clock();

    if (publishSnapshot) {
      this.emitSnapshot();
      this.recordDeliveryBatch({ immediate });
      return;
    }

    for (const pending of updates) this.emitDocumentUpdate(pending);
    this.recordDeliveryBatch({ immediate });
  }

  schedulePublication() {
    if (this.publicationTimer !== null) return;
    const elapsed = this.lastPublicationAt === null
      ? 0
      : this.clock() - this.lastPublicationAt;
    const delay = Math.max(0, this.publicationIntervalMs - elapsed);
    this.publicationTimer = this.setTimer(() => {
      this.publicationTimer = null;
      this.flushPublications();
    }, delay);
  }

  /** Queue a full snapshot or one document delta. Terminal events bypass coalescing. */
  publish(documentId = null, {
    immediate = false,
    removed = false,
    terminal = false,
    progressPageNumber = null,
  } = {}) {
    if (documentId !== null && (immediate || terminal)) {
      if (this.listeners.size === 0 && this.updateListeners.size === 0) {
        this.pendingUpdates.delete(documentId);
        return;
      }
      this.pendingUpdates.delete(documentId);
      // The immediate state is the subscriber's fresh baseline. Delay the
      // next ordinary progress delta by the full coalescing window rather than
      // scheduling a zero-delay first batch immediately after job start.
      this.lastPublicationAt = this.clock();
      this.emitDocumentUpdate({
        documentId,
        removed,
        terminal,
        progressPageNumbers: new Set(),
      });
      this.recordDeliveryBatch({ immediate: true });
      if (this.pendingUpdates.size === 0 && !this.pendingSnapshotPublication && this.publicationTimer !== null) {
        this.clearTimer(this.publicationTimer);
        this.publicationTimer = null;
      }
      return;
    }
    if (documentId === null) {
      this.pendingSnapshotPublication = true;
      this.pendingUpdates.clear();
    } else if (!this.pendingSnapshotPublication) {
      const pending = this.pendingUpdates.get(documentId) ?? {
        documentId,
        removed,
        terminal,
        progressPageNumbers: new Set(),
      };
      pending.removed ||= removed;
      pending.terminal ||= terminal;
      if (Number.isSafeInteger(progressPageNumber)) pending.progressPageNumbers.add(progressPageNumber);
      this.pendingUpdates.set(documentId, pending);
    }
    if (this.listeners.size === 0 && this.updateListeners.size === 0) {
      this.pendingSnapshotPublication = false;
      this.pendingUpdates.clear();
      return;
    }
    if (immediate || terminal) this.flushPublications({ immediate: true });
    else this.schedulePublication();
  }

  /** @param {string} documentId @returns {OcrWorkflowJobState | null} */
  status(documentId) {
    const value = this.states.get(documentId);
    return value ? clone(value) : null;
  }

  /** Resolve and verify the current bundled model state before a job starts. */
  async requireCurrentModelState() {
    return this.modelState.requireInstalled();
  }

  /** Current cloneable model-pack verification state for production UI. */
  modelStatus() {
    return this.modelState.getState();
  }

  /** @param {(state: any) => void} listener */
  subscribeModelStatus(listener) {
    if (typeof listener !== 'function') throw new TypeError('OCR model listener must be a function');
    listener(this.modelStatus());
    return this.modelState.subscribe(listener);
  }

  /** Re-run bundled model-pack verification without exposing the pack owner. */
  refreshModelStatus({ force = false } = {}) {
    return this.modelState.refresh({ force });
  }

  /**
   * @param {{
   *   document: any,
   *   sourcePdfPath: string,
   *   pageNumbers: number[],
   *   pageScope: import('../types/ocr.js').OcrPageScope,
   *   recognitionPolicy: import('../types/ocr.js').OcrWorkflowRecognitionPolicy,
   *   modelState: any,
   *   documentRevision: number,
   * }} input
   */
  start(input) {
    const { document } = input;
    if (!document || typeof document.id !== 'string') {
      throw Object.assign(new TypeError('OCR workflow requires a loaded document'), {
        code: 'OCR_DOCUMENT_UNAVAILABLE', retryable: false,
      });
    }
    if (this.applicationClosing || this.closedDocuments.has(document.id)) {
      throw Object.assign(new Error('The OCR document lifecycle is closing'), {
        code: this.applicationClosing ? 'OCR_APPLICATION_CLOSING' : 'OCR_DOCUMENT_CLOSED',
        retryable: false,
      });
    }
    if (this.activeJobs.has(document.id)) {
      throw Object.assign(new Error('An OCR job is already active for this document'), {
        code: 'OCR_DOCUMENT_JOB_ACTIVE', retryable: false,
      });
    }
    if (input.modelState?.status !== 'installed' || !input.modelState.manifest) {
      throw Object.assign(new Error('The bundled OCR model is unavailable'), {
        code: input.modelState?.error?.code ?? 'OCR_MODEL_UNAVAILABLE',
        retryable: input.modelState?.error?.retryable === true,
      });
    }

    const token = Symbol(`ocr-workflow-${document.id}`);
    const onProgress = (event) => this.recordProgress(document.id, token, event);
    const handle = this.controller.startDocumentJob({
      document,
      sourcePdfPath: input.sourcePdfPath,
      pageNumbers: [...input.pageNumbers],
      modelPack: input.modelState.manifest,
      recognitionOptions: input.recognitionPolicy.recognitionOptions,
      documentRevision: input.documentRevision,
      force: input.recognitionPolicy.existingText === 'force-rerun',
      keepCompletedPages: input.recognitionPolicy.keepCompletedPages,
      useCache: input.recognitionPolicy.useCache,
      maximumRetries: input.recognitionPolicy.maximumRetries,
      onProgress,
    });
    if (!handle || typeof handle.jobId !== 'string' || !handle.completion || typeof handle.cancel !== 'function') {
      throw new TypeError('OCR controller returned an invalid application job handle');
    }

    const started = typeof handle.summary === 'function' ? handle.summary() : null;
    const pages = started?.pages?.length ? started.pages : input.pageNumbers.map((pageNumber) => ({
      pageNumber,
      state: 'queued',
      fraction: 0,
      attempts: 0,
      retries: 0,
      retryableFailureSeen: false,
      failure: null,
      staleRejected: false,
      cache: 'not-checked',
      retained: false,
      measuredStageCosts: null,
      performance: null,
    }));
    /** @type {OcrWorkflowJobState} */
    const state = {
      jobId: handle.jobId,
      documentId: document.id,
      documentName: documentDisplayName(document, input.sourcePdfPath),
      status: started?.status === 'queued' ? 'queued' : 'running',
      progress: started?.progress ?? 0,
      pages,
      counts: pageCounts(pages),
      currentPageNumber: pages[0]?.pageNumber ?? null,
      currentPageState: pages[0]?.state ?? 'queued',
      terminalSummary: null,
      failureDetails: summaryFailures({ pages }),
      cancellationAvailable: true,
      cancellationRequested: false,
      pageScope: clone(input.pageScope),
      recognitionPolicy: clone(input.recognitionPolicy),
      model: {
        status: input.modelState.status,
        identity: input.modelState.identity ? clone(input.modelState.identity) : null,
      },
      startedAt: started?.startedAt ?? new Date().toISOString(),
      finishedAt: null,
    };
    const failureMap = new Map(
      pages.filter((page) => page.failure)
        .map((page) => [page.pageNumber, { pageNumber: page.pageNumber, ...clone(page.failure) }]),
    );
    this.activeJobs.set(document.id, {
      handle,
      token,
      suppressPublications: false,
      cancellationPromise: null,
      pageIndex: new Map(pages.map((page) => [page.pageNumber, page])),
      failureMap,
      lastSequence: 0,
    });
    this.states.set(document.id, state);
    this.publish(document.id, { immediate: true });

    Promise.resolve(handle.completion).then(
      (summary) => this.finish(document.id, token, summary),
      (error) => this.fail(document.id, token, error),
    );
    return handle;
  }

  recordProgress(documentId, token, event) {
    const active = this.activeJobs.get(documentId);
    const state = this.states.get(documentId);
    if (!active || active.token !== token || active.suppressPublications || !state ||
        state.jobId !== event.jobId || state.cancellationRequested) return;
    if (Number.isSafeInteger(event.sequence)) {
      if (event.sequence <= active.lastSequence) return;
      active.lastSequence = event.sequence;
    }
    const bookkeepingStarted = this.performanceClock();
    state.status = state.cancellationRequested ? 'cancelling' : 'running';
    state.progress = Math.max(state.progress, Number(event.documentFraction) || 0);
    const page = active.pageIndex.get(event.pageNumber);
    if (page) {
      const previousState = page.state;
      page.state = event.pageState;
      page.fraction = Math.max(page.fraction, Number(event.pageFraction) || 0);
      page.attempts = event.attempts;
      page.retries = event.retries;
      page.failure = event.failure ? clone(event.failure) : null;
      if (previousState !== page.state && Object.hasOwn(state.counts, previousState) && Object.hasOwn(state.counts, page.state)) {
        state.counts[previousState] = Math.max(0, state.counts[previousState] - 1);
        state.counts[page.state] += 1;
      }
      if (event.failure) {
        active.failureMap.set(event.pageNumber, { pageNumber: event.pageNumber, ...clone(event.failure) });
        state.failureDetails = [...active.failureMap.values()];
      } else if (active.failureMap.delete(event.pageNumber)) {
        state.failureDetails = [...active.failureMap.values()];
      }
      state.currentPageNumber = page.pageNumber;
      state.currentPageState = page.state;
    }
    this.publish(documentId, {
      immediate: Boolean(event.failure),
      progressPageNumber: event.pageNumber,
    });
    this.publicationStats.bookkeepingEvents += 1;
    this.publicationStats.bookkeepingMs += Math.max(0, this.performanceClock() - bookkeepingStarted);
  }

  /** @param {string} documentId @param {symbol} token @param {OcrDocumentJobSummary} summary */
  finish(documentId, token, summary) {
    const active = this.activeJobs.get(documentId);
    if (!active || active.token !== token) return;
    this.activeJobs.delete(documentId);
    if (active.suppressPublications) return;
    const state = this.states.get(documentId);
    if (!state || state.jobId !== summary.jobId) return;
    state.status = summary.status;
    state.progress = summary.progress;
    state.pages = clone(summary.pages);
    state.counts = pageCounts(state.pages);
    const focusPage = terminalFocusPage(state.pages, summary.status);
    state.currentPageNumber = focusPage?.pageNumber ?? state.currentPageNumber;
    state.currentPageState = focusPage?.state ?? state.currentPageState;
    state.terminalSummary = clone(summary);
    state.failureDetails = summaryFailures(summary);
    state.cancellationAvailable = false;
    state.finishedAt = summary.finishedAt ?? new Date().toISOString();
    this.publish(documentId, { immediate: true, terminal: true });
  }

  fail(documentId, token, error) {
    const active = this.activeJobs.get(documentId);
    if (!active || active.token !== token) return;
    this.activeJobs.delete(documentId);
    if (active.suppressPublications) return;
    const state = this.states.get(documentId);
    if (!state) return;
    state.status = 'failed';
    const failure = publicFailure(error);
    state.failureDetails = [failure];
    const currentPage = state.pages.find((page) => page.pageNumber === state.currentPageNumber)
      ?? state.pages.find((page) => !['completed', 'skipped', 'unsupported', 'failed', 'cancelled'].includes(page.state));
    if (currentPage) {
      currentPage.state = 'failed';
      currentPage.failure = clone(failure);
      state.currentPageNumber = currentPage.pageNumber;
      state.currentPageState = 'failed';
    }
    state.counts = pageCounts(state.pages);
    state.cancellationAvailable = false;
    state.finishedAt = new Date().toISOString();
    this.publish(documentId, { immediate: true, terminal: true });
  }

  /** Cancel the retained application job handle for an explicit user action. */
  async cancel(documentId, reason = 'user-cancelled') {
    const active = this.activeJobs.get(documentId);
    if (!active) return null;
    if (active.cancellationPromise) return active.cancellationPromise;
    const state = this.states.get(documentId);
    if (state) {
      state.status = 'cancelling';
      state.cancellationAvailable = false;
      state.cancellationRequested = true;
      this.publish(documentId, { immediate: true });
    }
    try {
      active.cancellationPromise = Promise.resolve(active.handle.cancel(reason));
    } catch (error) {
      active.cancellationPromise = Promise.reject(error);
    }
    return active.cancellationPromise;
  }

  /** Preserve the established document-close controller/native boundary. */
  async closeDocument(documentId, reason = 'document-close') {
    this.closedDocuments.add(documentId);
    const active = this.activeJobs.get(documentId);
    const state = this.states.get(documentId);
    if (active) {
      active.suppressPublications = true;
      if (state) {
        state.status = 'cancelling';
        state.cancellationAvailable = false;
        state.cancellationRequested = true;
        this.publish(documentId, { immediate: true });
      }
    }
    try {
      const summaries = await this.controller.cancelDocument(documentId, reason);
      const current = this.activeJobs.get(documentId);
      if (!active || current === active) this.activeJobs.delete(documentId);
      this.states.delete(documentId);
      this.publish(documentId, { immediate: true, removed: true, terminal: true });
      return summaries;
    } catch (error) {
      this.closedDocuments.delete(documentId);
      if (this.activeJobs.get(documentId) === active) active.suppressPublications = false;
      if (state) {
        const failure = publicFailure(error, 'OCR_DOCUMENT_CLOSE_CANCELLATION_FAILED', 'cancelling');
        state.status = 'failed';
        state.failureDetails = [failure];
        state.cancellationAvailable = false;
        state.finishedAt = new Date().toISOString();
      }
      this.publish(documentId, { immediate: true, terminal: true });
      throw error;
    }
  }

  /** Preserve the established application-close controller/native boundary. */
  async closeApplication(reason = 'application-close') {
    this.applicationClosing = true;
    for (const active of this.activeJobs.values()) active.suppressPublications = true;
    try {
      const summaries = await this.controller.cancelAll(reason);
      this.activeJobs.clear();
      this.states.clear();
      this.publish(null, { immediate: true, terminal: true });
      return summaries;
    } catch (error) {
      for (const active of this.activeJobs.values()) active.suppressPublications = false;
      this.publish(null, { immediate: true, terminal: true });
      throw error;
    }
  }
}

// One production service and one production controller live for the app lifetime.
export const ocrWorkflowService = new OcrWorkflowService();

export function getOcrWorkflowStatus(documentId) {
  if (typeof documentId !== 'string' || documentId.length === 0) return null;
  return ocrWorkflowService.status(documentId);
}

export function cancelOcrWorkflow(documentId, reason = 'user-cancelled') {
  if (typeof documentId !== 'string' || documentId.length === 0) return Promise.resolve(null);
  return ocrWorkflowService.cancel(documentId, reason);
}

export function cancelOcrWorkflowDocument(documentId, reason = 'document-close') {
  if (typeof documentId !== 'string' || documentId.length === 0) return Promise.resolve([]);
  return ocrWorkflowService.closeDocument(documentId, reason);
}

export function cancelAllOcrWorkflows(reason = 'application-close') {
  return ocrWorkflowService.closeApplication(reason);
}
