// @ts-check

import {
  OCR_APPLICATION_PAGE_STATES,
  OcrApplicationController,
} from './application-controller.js';
import { getDefaultOcrModelPackState } from './model-state.js';

/** @typedef {import('../types/ocr.js').OcrDocumentJobSummary} OcrDocumentJobSummary */
/** @typedef {import('../types/ocr.js').OcrWorkflowJobState} OcrWorkflowJobState */
/** @typedef {import('../types/ocr.js').OcrWorkflowSnapshot} OcrWorkflowSnapshot */

function clone(value) {
  return structuredClone(value);
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
  constructor({ controller = null, modelState = getDefaultOcrModelPackState() } = {}) {
    this.modelState = modelState;
    this.controller = controller ?? new OcrApplicationController({ modelState });
    /** @type {Map<string, {handle: any, token: symbol, suppressPublications: boolean, cancellationPromise: Promise<any> | null}>} */
    this.activeJobs = new Map();
    /** @type {Map<string, OcrWorkflowJobState>} */
    this.states = new Map();
    this.listeners = new Set();
    this.closedDocuments = new Set();
    this.applicationClosing = false;
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

  publish() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* observers cannot alter OCR execution */ }
    }
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

    this.activeJobs.set(document.id, {
      handle,
      token,
      suppressPublications: false,
      cancellationPromise: null,
    });
    const started = typeof handle.summary === 'function' ? handle.summary() : null;
    const pages = started?.pages ?? input.pageNumbers.map((pageNumber) => ({
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
      failureDetails: [],
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
    this.states.set(document.id, state);
    this.publish();

    Promise.resolve(handle.completion).then(
      (summary) => this.finish(document.id, token, summary),
      (error) => this.fail(document.id, token, error),
    );
    return handle;
  }

  recordProgress(documentId, token, event) {
    const active = this.activeJobs.get(documentId);
    const state = this.states.get(documentId);
    if (!active || active.token !== token || active.suppressPublications || !state || state.jobId !== event.jobId) return;
    state.status = state.cancellationRequested ? 'cancelling' : 'running';
    state.progress = Math.max(state.progress, Number(event.documentFraction) || 0);
    const page = state.pages.find((entry) => entry.pageNumber === event.pageNumber);
    if (page) {
      page.state = event.pageState;
      page.fraction = Math.max(page.fraction, Number(event.pageFraction) || 0);
      page.attempts = event.attempts;
      page.retries = event.retries;
      page.failure = event.failure ? clone(event.failure) : null;
      if (event.failure) {
        state.failureDetails = [
          ...state.failureDetails.filter((failure) => failure.pageNumber !== event.pageNumber),
          { pageNumber: event.pageNumber, ...clone(event.failure) },
        ];
      }
      state.currentPageNumber = page.pageNumber;
      state.currentPageState = page.state;
      state.counts = pageCounts(state.pages);
    }
    this.publish();
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
    this.publish();
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
    this.publish();
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
      this.publish();
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
        this.publish();
      }
    }
    try {
      const summaries = await this.controller.cancelDocument(documentId, reason);
      const current = this.activeJobs.get(documentId);
      if (!active || current === active) this.activeJobs.delete(documentId);
      this.states.delete(documentId);
      this.publish();
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
      this.publish();
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
      this.publish();
      return summaries;
    } catch (error) {
      for (const active of this.activeJobs.values()) active.suppressPublications = false;
      this.publish();
      throw error;
    }
  }
}

// One production service and one production controller live for the app lifetime.
export const ocrWorkflowService = new OcrWorkflowService();

export function cancelOcrWorkflowDocument(documentId, reason = 'document-close') {
  if (typeof documentId !== 'string' || documentId.length === 0) return Promise.resolve([]);
  return ocrWorkflowService.closeDocument(documentId, reason);
}

export function cancelAllOcrWorkflows(reason = 'application-close') {
  return ocrWorkflowService.closeApplication(reason);
}
