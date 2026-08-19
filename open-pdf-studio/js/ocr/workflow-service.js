// @ts-check

import { OcrApplicationController } from './application-controller.js';
import { getDefaultOcrModelPackState } from './model-state.js';

/** @typedef {import('../types/ocr.js').OcrDocumentJobSummary} OcrDocumentJobSummary */
/** @typedef {import('../types/ocr.js').OcrWorkflowJobState} OcrWorkflowJobState */
/** @typedef {import('../types/ocr.js').OcrWorkflowSnapshot} OcrWorkflowSnapshot */

function clone(value) {
  return structuredClone(value);
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
    /** @type {Map<string, {handle: any, token: symbol, suppressPublications: boolean}>} */
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

    this.activeJobs.set(document.id, { handle, token, suppressPublications: false });
    const started = typeof handle.summary === 'function' ? handle.summary() : null;
    /** @type {OcrWorkflowJobState} */
    const state = {
      jobId: handle.jobId,
      documentId: document.id,
      status: started?.status === 'queued' ? 'queued' : 'running',
      progress: started?.progress ?? 0,
      pages: started?.pages ?? input.pageNumbers.map((pageNumber) => ({
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
      })),
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
    state.status = 'running';
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
    state.failureDetails = [publicFailure(error)];
    state.cancellationAvailable = false;
    state.finishedAt = new Date().toISOString();
    this.publish();
  }

  /** Cancel the retained application job handle for an explicit user action. */
  async cancel(documentId, reason = 'user-cancelled') {
    const active = this.activeJobs.get(documentId);
    if (!active) return null;
    const state = this.states.get(documentId);
    if (state) {
      state.cancellationAvailable = false;
      state.cancellationRequested = true;
      this.publish();
    }
    return active.handle.cancel(reason);
  }

  /** Preserve the established document-close controller/native boundary. */
  async closeDocument(documentId, reason = 'document-close') {
    this.closedDocuments.add(documentId);
    const active = this.activeJobs.get(documentId);
    if (active) active.suppressPublications = true;
    try {
      return await this.controller.cancelDocument(documentId, reason);
    } finally {
      const current = this.activeJobs.get(documentId);
      if (!active || current === active) this.activeJobs.delete(documentId);
      this.states.delete(documentId);
      this.publish();
    }
  }

  /** Preserve the established application-close controller/native boundary. */
  async closeApplication(reason = 'application-close') {
    this.applicationClosing = true;
    for (const active of this.activeJobs.values()) active.suppressPublications = true;
    try {
      return await this.controller.cancelAll(reason);
    } finally {
      this.activeJobs.clear();
      this.states.clear();
      this.publish();
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
