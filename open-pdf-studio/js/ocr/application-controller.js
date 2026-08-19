// @ts-check

import {
  applyOcrPageResult,
  beginOcrPageAttempt,
  ensureDocumentOcrState,
  isCurrentOcrPageToken,
  markOcrPageStage,
  restoreOcrCommandState,
  selectOcrCommandSnapshot,
  snapshotOcrCommandState,
} from './document-state.js';
import {
  cancelAllNativeOcrJobs,
  cancelNativeOcrDocument,
  cancelNativeOcrJob,
  runNativeOcrPageForDocument,
} from './native-controller.js';
import { assertOcrPageGeometryV1 } from './contracts/page-geometry.v1.js';
import { assertOcrResultV2 } from './contracts/v2.js';
import {
  createOcrCacheKeyFromRequest,
  fingerprintOcrDocument,
  getDefaultOcrResultCache,
  rebindCachedOcrEnvelope,
} from './cache.js';
import { getDefaultOcrModelPackState } from './model-state.js';
import { createApplicationOcrPageRequest } from './application-request.js';
import { recordAppliedOcrCompound } from './undo-commands.js';

export const OCR_APPLICATION_PAGE_STATES = Object.freeze([
  'queued',
  'rasterizing',
  'preprocessing',
  'recognizing',
  'validating',
  'applying',
  'completed',
  'skipped',
  'unsupported',
  'failed',
  'cancelled',
]);

const TERMINAL_PAGE_STATES = new Set(['completed', 'skipped', 'unsupported', 'failed', 'cancelled']);
const WEIGHTED_STAGES = ['queued', 'rasterizing', 'preprocessing', 'recognizing', 'validating', 'applying'];
const activeApplicationControllers = new Set();
const activeDocumentApplicationJobs = new Map();
const CANCELLED_ASYNC_WAIT = Symbol('ocr-cancelled-async-wait');
let applicationJobSequence = 0;

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clone(value) {
  return structuredClone(value);
}

function yieldToEventLoop(_context = null) {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A cancellable FIFO gate shared by default across application controllers. */
export class OcrInferenceGate {
  constructor() {
    this.active = false;
    this.queue = [];
  }

  acquire(applicationJobId) {
    const ticket = {
      applicationJobId,
      cancelled: false,
      released: false,
      resolve: null,
    };
    const release = () => this.release(ticket);
    if (!this.active) {
      this.active = true;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      ticket.resolve = resolve;
      this.queue.push(ticket);
    });
  }

  release(ticket) {
    if (ticket.released) return;
    ticket.released = true;
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next.cancelled) continue;
      next.resolve(() => this.release(next));
      return;
    }
    this.active = false;
  }

  cancel(applicationJobId) {
    const remaining = [];
    for (const ticket of this.queue) {
      if (ticket.applicationJobId === applicationJobId) {
        ticket.cancelled = true;
        ticket.resolve(null);
      } else {
        remaining.push(ticket);
      }
    }
    this.queue = remaining;
  }
}

const defaultInferenceGate = new OcrInferenceGate();

export class OcrStageCostModel {
  constructor(initialCosts = {}) {
    // Seeds come from committed macOS timing evidence. Successful result
    // metrics replace them with an exponential moving average.
    this.costs = {
      queued: 1,
      rasterizing: 50,
      preprocessing: 1,
      recognizing: 800,
      validating: 8,
      applying: 8,
      ...initialCosts,
    };
    this.sampleCount = 0;
  }

  snapshot() {
    return { sampleCount: this.sampleCount, costsMs: clone(this.costs) };
  }

  fractionAtStage(stage) {
    if (TERMINAL_PAGE_STATES.has(stage)) return 1;
    const index = WEIGHTED_STAGES.indexOf(stage);
    if (index < 0) return 0;
    const total = WEIGHTED_STAGES.reduce((sum, name) => sum + this.costs[name], 0);
    const complete = WEIGHTED_STAGES.slice(0, index)
      .reduce((sum, name) => sum + this.costs[name], 0);
    return total > 0 ? complete / total : 0;
  }

  observe(resultMetrics, { validatingMs = 0, applyingMs = 0 } = {}) {
    if (!resultMetrics || typeof resultMetrics !== 'object') return;
    const measured = {
      rasterizing: Math.max(1, Number(resultMetrics.rasterMs) || 0),
      preprocessing: 1,
      recognizing: Math.max(1, ['workerStartupMs', 'modelStartupMs', 'detectionMs', 'recognitionMs']
        .reduce((sum, key) => sum + (Number(resultMetrics[key]) || 0), 0)),
      validating: Math.max(1, validatingMs),
      applying: Math.max(1, applyingMs),
    };
    const alpha = this.sampleCount === 0 ? 1 : 0.25;
    for (const [stage, value] of Object.entries(measured)) {
      this.costs[stage] = this.costs[stage] * (1 - alpha) + value * alpha;
    }
    this.sampleCount += 1;
  }
}

function failureMetadata(value, fallbackCode, fallbackStage) {
  return {
    code: typeof value?.code === 'string' ? value.code : fallbackCode,
    stage: typeof value?.stage === 'string' ? value.stage : fallbackStage,
    retryable: value?.retryable === true,
  };
}

export class ApplicationOcrJob {
  constructor(controller, options) {
    applicationJobSequence += 1;
    this.controller = controller;
    this.options = options;
    this.jobId = `ocr-document-job-${Date.now()}-${applicationJobSequence}`;
    this.documentId = options.document.id;
    this.documentGeneration = ensureDocumentOcrState(options.document).generation;
    this.status = 'queued';
    this.progress = 0;
    this.progressSequence = 0;
    this.cancelRequested = false;
    this.cancellationReason = null;
    this.resolveCancellation = null;
    this.cancellationSignal = new Promise((resolve) => {
      this.resolveCancellation = resolve;
    });
    this.currentNativeJobId = null;
    this.appliedPageNumbers = [];
    this.rolledBackPageNumbers = [];
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.pages = new Map(options.pageNumbers.map((pageNumber) => [pageNumber, {
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
      token: null,
      request: null,
      measuredStageCosts: null,
    }]));
    this.before = snapshotOcrCommandState(options.document, options.pageNumbers);
    this.completion = null;
  }

  cancel(reason = 'parent-cancelled') {
    return this.controller.cancelJob(this.jobId, reason);
  }

  requestCancellation(reason) {
    if (this.cancelRequested) return false;
    this.cancelRequested = true;
    this.cancellationReason = reason;
    this.resolveCancellation?.();
    this.resolveCancellation = null;
    return true;
  }

  pageSummaries() {
    return [...this.pages.values()].map((page) => ({
      pageNumber: page.pageNumber,
      state: page.state,
      fraction: page.fraction,
      attempts: page.attempts,
      retries: page.retries,
      retryableFailureSeen: page.retryableFailureSeen,
      failure: page.failure ? clone(page.failure) : null,
      staleRejected: page.staleRejected,
      cache: page.cache,
      retained: page.retained,
      measuredStageCosts: page.measuredStageCosts ? clone(page.measuredStageCosts) : null,
    }));
  }

  summary() {
    const pages = this.pageSummaries();
    const counts = Object.fromEntries(OCR_APPLICATION_PAGE_STATES.map((state) => [state, 0]));
    for (const page of pages) counts[page.state] += 1;
    return {
      jobId: this.jobId,
      documentId: this.documentId,
      documentGeneration: this.documentGeneration,
      status: this.status,
      progress: this.progress,
      cancellationReason: this.cancellationReason,
      keepCompletedPages: this.options.keepCompletedPages,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      counts,
      pages,
      stageCosts: this.controller.stageCosts.snapshot(),
      appliedPageNumbers: [...this.appliedPageNumbers],
      rolledBackPageNumbers: [...this.rolledBackPageNumbers],
    };
  }
}

export class OcrApplicationController {
  constructor({
    runPage = runNativeOcrPageForDocument,
    cancelPage = cancelNativeOcrJob,
    cancelDocumentNative = cancelNativeOcrDocument,
    cancelAllNative = cancelAllNativeOcrJobs,
    cache = getDefaultOcrResultCache(),
    modelState = getDefaultOcrModelPackState(),
    fingerprintDocument = fingerprintOcrDocument,
    stageCosts = new OcrStageCostModel(),
    inferenceGate = defaultInferenceGate,
    clock = nowMs,
    yieldControl = yieldToEventLoop,
  } = {}) {
    this.runPage = runPage;
    this.cancelPage = cancelPage;
    this.cancelDocumentNative = cancelDocumentNative;
    this.cancelAllNative = cancelAllNative;
    this.cache = cache;
    this.modelState = modelState;
    this.fingerprintDocument = fingerprintDocument;
    this.stageCosts = stageCosts;
    this.inferenceGate = inferenceGate;
    this.clock = clock;
    this.yieldControl = yieldControl;
    this.jobs = new Map();
    activeApplicationControllers.add(this);
  }

  startDocumentJob({
    document,
    sourcePdfPath,
    pageNumbers = null,
    createPageRequest = null,
    documentFingerprint = null,
    modelPack = null,
    recognitionOptions = {},
    documentRevision = 0,
    force = false,
    keepCompletedPages = true,
    useCache = true,
    maximumRetries = 1,
    onProgress = null,
  }) {
    if (!document || typeof document.id !== 'string' || !document.pdfDoc) {
      throw new TypeError('Application OCR requires a loaded document');
    }
    if (typeof sourcePdfPath !== 'string' || sourcePdfPath.length === 0) {
      throw new TypeError('Application OCR requires a parent-side PDF path');
    }
    const pages = pageNumbers ?? Array.from({ length: document.pdfDoc.numPages }, (_, index) => index + 1);
    if (!Array.isArray(pages) || pages.length === 0 ||
        pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > document.pdfDoc.numPages) ||
        new Set(pages).size !== pages.length) {
      throw new TypeError('Application OCR pageNumbers must uniquely identify loaded pages');
    }
    if (!Number.isSafeInteger(maximumRetries) || maximumRetries < 0 || maximumRetries > 3) {
      throw new RangeError('Application OCR maximumRetries must be between 0 and 3');
    }
    if (createPageRequest !== null && typeof createPageRequest !== 'function') {
      throw new TypeError('Application OCR createPageRequest must be a function');
    }
    if (activeDocumentApplicationJobs.has(document.id)) {
      throw Object.assign(new Error('An OCR application job is already active for this document'), {
        code: 'OCR_DOCUMENT_JOB_ACTIVE',
        retryable: false,
      });
    }
    const options = {
      document,
      sourcePdfPath,
      pageNumbers: [...pages],
      createPageRequest,
      documentFingerprint,
      modelPack,
      recognitionOptions,
      documentRevision,
      force: force === true,
      keepCompletedPages: keepCompletedPages !== false,
      useCache: useCache !== false,
      maximumRetries,
      onProgress: typeof onProgress === 'function' ? onProgress : null,
    };
    const job = new ApplicationOcrJob(this, options);
    this.jobs.set(job.jobId, job);
    activeDocumentApplicationJobs.set(document.id, job);
    job.completion = this.runJob(job).finally(() => {
      this.jobs.delete(job.jobId);
      if (activeDocumentApplicationJobs.get(document.id) === job) {
        activeDocumentApplicationJobs.delete(document.id);
      }
    });
    return job;
  }

  transition(job, page, state, detail = {}) {
    if (!OCR_APPLICATION_PAGE_STATES.includes(state)) {
      throw new TypeError('Application OCR page state is unsupported');
    }
    page.state = state;
    page.fraction = Math.max(page.fraction, this.stageCosts.fractionAtStage(state));
    if (detail.failure) page.failure = clone(detail.failure);
    if (page.token && ['queued', 'rasterizing', 'preprocessing', 'recognizing', 'validating', 'applying'].includes(state)) {
      markOcrPageStage(job.options.document, page.token, state);
    }
    const average = [...job.pages.values()].reduce((sum, entry) => sum + entry.fraction, 0) / job.pages.size;
    job.progress = Math.max(job.progress, average);
    job.progressSequence += 1;
    try {
      job.options.onProgress?.({
        jobId: job.jobId,
        documentId: job.documentId,
        sequence: job.progressSequence,
        pageNumber: page.pageNumber,
        pageState: state,
        pageFraction: page.fraction,
        documentFraction: job.progress,
        attempts: page.attempts,
        retries: page.retries,
        failure: page.failure ? clone(page.failure) : null,
        stageCosts: this.stageCosts.snapshot(),
      });
    } catch {
      // Progress observers cannot affect OCR execution.
    }
  }

  async waitForCancellable(job, promise) {
    const settled = await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ status: 'fulfilled', value }),
        (error) => ({ status: 'rejected', error }),
      ),
      job.cancellationSignal.then(() => ({ status: 'cancelled' })),
    ]);
    if (settled.status === 'cancelled') return CANCELLED_ASYNC_WAIT;
    if (settled.status === 'rejected') throw settled.error;
    return settled.value;
  }

  async cancellationWindow(job, page, stage) {
    const result = await this.waitForCancellable(job, this.yieldControl({
      jobId: job.jobId,
      documentId: job.documentId,
      pageNumber: page?.pageNumber ?? null,
      stage,
    }));
    return result === CANCELLED_ASYNC_WAIT || job.cancelRequested;
  }

  cancelCurrentAttempt(job, page, pageBefore = null) {
    if (!job.cancelRequested) return false;
    this.restoreCurrentAttempt(job, page, pageBefore);
    if (!TERMINAL_PAGE_STATES.has(page.state)) this.transition(job, page, 'cancelled');
    return true;
  }

  async prepareDefaults(job) {
    const options = job.options;
    if (options.createPageRequest) return !job.cancelRequested;
    if (!options.documentFingerprint) {
      const fingerprint = await this.waitForCancellable(
        job,
        this.fingerprintDocument(options.sourcePdfPath),
      );
      if (fingerprint === CANCELLED_ASYNC_WAIT) return false;
      options.documentFingerprint = fingerprint;
    }
    if (!options.modelPack) {
      const model = await this.waitForCancellable(job, this.modelState.requireInstalled());
      if (model === CANCELLED_ASYNC_WAIT) return false;
      options.modelPack = model.manifest;
    }
    options.createPageRequest = (input) => createApplicationOcrPageRequest({
      ...input,
      documentFingerprint: options.documentFingerprint,
      modelPack: options.modelPack,
      recognitionOptions: options.recognitionOptions,
      documentRevision: options.documentRevision,
      force: options.force,
      keepCompletedPages: options.keepCompletedPages,
    });
    return !job.cancelRequested;
  }

  async runJob(job) {
    job.status = 'running';
    try {
      const prepared = await this.prepareDefaults(job);
      if (!prepared) {
        for (const page of job.pages.values()) {
          if (!TERMINAL_PAGE_STATES.has(page.state)) this.transition(job, page, 'cancelled');
        }
        job.status = 'cancelled';
        job.progress = 1;
        job.finishedAt = new Date().toISOString();
        return job.summary();
      }
    } catch (error) {
      const failure = failureMetadata(error, 'OCR_MODEL_OR_FINGERPRINT_UNAVAILABLE', 'preparing');
      for (const page of job.pages.values()) {
        this.transition(job, page, job.cancelRequested ? 'cancelled' : 'failed',
          job.cancelRequested ? {} : { failure });
      }
      job.status = job.cancelRequested ? 'cancelled' : 'failed';
      job.finishedAt = new Date().toISOString();
      return job.summary();
    }

    for (const pageNumber of job.options.pageNumbers) {
      const page = job.pages.get(pageNumber);
      if (job.cancelRequested) {
        this.transition(job, page, 'cancelled');
        continue;
      }
      if (ensureDocumentOcrState(job.options.document).generation !== job.documentGeneration) {
        page.staleRejected = true;
        this.transition(job, page, 'failed', {
          failure: { code: 'OCR_STALE_JOB', stage: 'scheduling', retryable: false },
        });
        continue;
      }
      try {
        await this.runPageEntry(job, page);
      } catch (error) {
        this.restoreCurrentAttempt(job, page);
        this.transition(job, page, 'failed', {
          failure: failureMetadata(error, 'OCR_PAGE_ORCHESTRATION_FAILED', 'scheduling'),
        });
      }
    }

    for (const page of job.pages.values()) {
      if (!TERMINAL_PAGE_STATES.has(page.state)) this.transition(job, page, 'cancelled');
    }
    const failed = [...job.pages.values()].some((page) => page.state === 'failed');
    const cancelled = job.cancelRequested || [...job.pages.values()].some((page) => page.state === 'cancelled');
    const hasTerminalProblem = failed || cancelled;
    if (hasTerminalProblem && !job.options.keepCompletedPages && job.appliedPageNumbers.length > 0) {
      const rollback = selectOcrCommandSnapshot(job.before, job.appliedPageNumbers);
      restoreOcrCommandState(job.options.document, rollback, { restoreDocumentState: false });
      job.rolledBackPageNumbers = [...job.appliedPageNumbers];
      for (const pageNumber of job.appliedPageNumbers) job.pages.get(pageNumber).retained = false;
      job.appliedPageNumbers = [];
    } else if (job.appliedPageNumbers.length > 0) {
      recordAppliedOcrCompound(job.options.document, job.before, job.appliedPageNumbers);
      for (const pageNumber of job.appliedPageNumbers) job.pages.get(pageNumber).retained = true;
    }
    job.status = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
    job.progress = 1;
    job.finishedAt = new Date().toISOString();
    return job.summary();
  }

  async runPageEntry(job, page) {
    const { document } = job.options;
    const pageBefore = selectOcrCommandSnapshot(job.before, [page.pageNumber]);
    let attempt;
    try {
      attempt = await beginOcrPageAttempt(document, page.pageNumber, { force: job.options.force });
    } catch (error) {
      this.transition(job, page, 'failed', {
        failure: failureMetadata(error, 'OCR_PAGE_PREPARATION_FAILED', 'scheduling'),
      });
      return;
    }
    if (attempt.skipped) {
      if (attempt.reason === 'stale-before-attempt') {
        page.staleRejected = true;
        this.transition(job, page, 'failed', {
          failure: { code: 'OCR_STALE_PAGE', stage: 'scheduling', retryable: false },
        });
      } else if (attempt.reason === 'existing-text-unverified') {
        this.transition(job, page, 'failed', {
          failure: { code: 'OCR_EXISTING_TEXT_UNVERIFIED', stage: 'validating', retryable: false },
        });
      } else {
        this.transition(job, page, 'skipped');
      }
      return;
    }
    page.token = attempt.token;

    for (let attemptIndex = 0; attemptIndex <= job.options.maximumRetries; attemptIndex += 1) {
      if (job.cancelRequested) {
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'cancelled');
        return;
      }
      page.attempts += 1;
      this.transition(job, page, 'queued');
      let request;
      try {
        request = await this.waitForCancellable(
          job,
          job.options.createPageRequest({
            document,
            token: page.token,
            pageNumber: page.pageNumber,
            attempt: attemptIndex,
          }),
        );
        if (request === CANCELLED_ASYNC_WAIT || job.cancelRequested) {
          this.cancelCurrentAttempt(job, page, pageBefore);
          return;
        }
        page.request = request;
      } catch (error) {
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'failed', {
          failure: failureMetadata(error, 'OCR_REQUEST_INVALID', 'scheduling'),
        });
        return;
      }

      let cacheKey;
      try {
        cacheKey = createOcrCacheKeyFromRequest(request);
      } catch (error) {
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'failed', {
          failure: failureMetadata(error, 'OCR_CACHE_KEY_INVALID', 'scheduling'),
        });
        return;
      }
      if (job.options.useCache && !job.options.force && attemptIndex === 0) {
        try {
          const cached = await this.waitForCancellable(
            job,
            this.cache.get(cacheKey, { documentId: document.id }),
          );
          if (cached === CANCELLED_ASYNC_WAIT || job.cancelRequested) {
            this.cancelCurrentAttempt(job, page, pageBefore);
            return;
          }
          page.cache = cached.status;
          if (cached.status === 'hit') {
            this.transition(job, page, 'validating');
            if (await this.cancellationWindow(job, page, 'validating')) {
              this.cancelCurrentAttempt(job, page, pageBefore);
              return;
            }
            const validatingStarted = this.clock();
            const rebound = rebindCachedOcrEnvelope(cached.envelope, request, page.token);
            const validatingMs = this.clock() - validatingStarted;
            if (await this.cancellationWindow(job, page, 'validated')) {
              this.cancelCurrentAttempt(job, page, pageBefore);
              return;
            }
            await this.applyValidatedPage(
              job,
              page,
              rebound.result,
              rebound.pageGeometry,
              validatingMs,
              pageBefore,
            );
            return;
          }
        } catch {
          page.cache = 'error';
        }
        if (this.cancelCurrentAttempt(job, page, pageBefore)) return;
      } else {
        page.cache = job.options.useCache ? 'bypassed' : 'disabled';
      }

      this.transition(job, page, 'rasterizing');
      if (await this.cancellationWindow(job, page, 'rasterizing')) {
        this.cancelCurrentAttempt(job, page, pageBefore);
        return;
      }
      this.transition(job, page, 'preprocessing');
      if (await this.cancellationWindow(job, page, 'preprocessing')) {
        this.cancelCurrentAttempt(job, page, pageBefore);
        return;
      }
      const releaseInference = await this.inferenceGate.acquire(job.jobId);
      if (!releaseInference || job.cancelRequested) {
        releaseInference?.();
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'cancelled');
        return;
      }
      let prepared;
      try {
        this.transition(job, page, 'recognizing');
        job.currentNativeJobId = request.jobId;
        prepared = await this.runPage({
          document,
          sourcePdfPath: job.options.sourcePdfPath,
          request,
          token: page.token,
        });
      } catch (error) {
        const failure = failureMetadata(error, 'OCR_PAGE_RUN_FAILED', 'recognizing');
        if (failure.retryable && attemptIndex < job.options.maximumRetries && !job.cancelRequested) {
          page.retryableFailureSeen = true;
          page.retries += 1;
          continue;
        }
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, job.cancelRequested ? 'cancelled' : 'failed', { failure });
        return;
      } finally {
        job.currentNativeJobId = null;
        releaseInference();
      }
      const outcome = prepared?.outcome;
      if (!outcome) {
        page.staleRejected = true;
        this.transition(job, page, 'failed', {
          failure: { code: 'OCR_STALE_PAGE', stage: 'validating', retryable: false },
        });
        return;
      }
      if (outcome.status === 'cancelled' || job.cancelRequested) {
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'cancelled');
        return;
      }
      if (outcome.status === 'stale') {
        page.staleRejected = true;
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'failed', {
          failure: failureMetadata(outcome.failure, 'OCR_STALE_PAGE', 'validating'),
        });
        return;
      }
      if (outcome.status === 'failed') {
        const failure = failureMetadata(outcome.failure, 'OCR_PAGE_FAILED', 'recognizing');
        if (failure.retryable && attemptIndex < job.options.maximumRetries) {
          page.retryableFailureSeen = true;
          page.retries += 1;
          continue;
        }
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'failed', { failure });
        return;
      }

      this.transition(job, page, 'validating');
      if (await this.cancellationWindow(job, page, 'validating')) {
        this.cancelCurrentAttempt(job, page, pageBefore);
        return;
      }
      const validatingStarted = this.clock();
      let result;
      let pageGeometry;
      try {
        result = assertOcrResultV2(outcome.result);
        if (!['completed', 'partial', 'unsupported'].includes(result.page.status)) {
          throw new TypeError('Application OCR accepts only successful or unsupported completed results');
        }
        pageGeometry = assertOcrPageGeometryV1(prepared.pageGeometry);
      } catch (error) {
        const failure = failureMetadata(error, 'OCR_RESULT_INVALID', 'validating');
        this.restoreCurrentAttempt(job, page, pageBefore);
        this.transition(job, page, 'failed', { failure });
        return;
      }
      const validatingMs = this.clock() - validatingStarted;
      if (await this.cancellationWindow(job, page, 'validated')) {
        this.cancelCurrentAttempt(job, page, pageBefore);
        return;
      }
      if (!await this.applyValidatedPage(job, page, result, pageGeometry, validatingMs, pageBefore)) return;
      if (job.options.useCache) {
        try {
          await this.cache.put(cacheKey, result, pageGeometry, { documentId: document.id });
          page.cache = 'stored';
        } catch {
          page.cache = 'write-failed';
        }
      }
      return;
    }
  }

  restoreCurrentAttempt(job, page, pageBefore = null) {
    if (!page.token || !isCurrentOcrPageToken(job.options.document, page.token)) return false;
    const snapshot = pageBefore ?? selectOcrCommandSnapshot(job.before, [page.pageNumber]);
    return restoreOcrCommandState(job.options.document, snapshot, { restoreDocumentState: false });
  }

  async applyValidatedPage(job, page, result, pageGeometry, validatingMs, pageBefore) {
    if (this.cancelCurrentAttempt(job, page, pageBefore)) return false;
    if (!isCurrentOcrPageToken(job.options.document, page.token) ||
        ensureDocumentOcrState(job.options.document).generation !== job.documentGeneration) {
      page.staleRejected = true;
      this.transition(job, page, 'failed', {
        failure: { code: 'OCR_STALE_PAGE', stage: 'applying', retryable: false },
      });
      return false;
    }
    this.transition(job, page, 'applying');
    if (await this.cancellationWindow(job, page, 'applying')) {
      this.cancelCurrentAttempt(job, page, pageBefore);
      return false;
    }
    const applyingStarted = this.clock();
    let stateUpdate;
    try {
      stateUpdate = applyOcrPageResult(job.options.document, { result, pageGeometry, token: page.token });
    } catch (error) {
      this.restoreCurrentAttempt(job, page, pageBefore);
      this.transition(job, page, 'failed', {
        failure: failureMetadata(error, 'OCR_RESULT_INVALID', 'applying'),
      });
      return false;
    }
    const applyingMs = this.clock() - applyingStarted;
    if (!stateUpdate.applied) {
      page.staleRejected = true;
      this.restoreCurrentAttempt(job, page, pageBefore);
      this.transition(job, page, 'failed', {
        failure: { code: 'OCR_STALE_PAGE', stage: 'applying', retryable: false },
      });
      return false;
    }
    this.stageCosts.observe(result.metrics, { validatingMs, applyingMs });
    page.measuredStageCosts = this.stageCosts.snapshot();
    job.appliedPageNumbers.push(page.pageNumber);
    this.transition(job, page, result.page.status === 'unsupported' ? 'unsupported' : 'completed');
    return true;
  }

  async cancelJob(jobId, reason = 'parent-cancelled') {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (!job.requestCancellation(reason)) return job.completion;
    this.inferenceGate.cancel(job.jobId);
    for (const page of job.pages.values()) {
      if (page.state === 'queued' && !page.token) this.transition(job, page, 'cancelled');
    }
    if (job.currentNativeJobId) {
      try { await this.cancelPage(job.currentNativeJobId); } catch { /* native exit hook is authoritative */ }
    }
    return job.completion;
  }

  async cancelDocument(documentId, reason = 'document-close') {
    const jobs = [...this.jobs.values()].filter((job) => job.documentId === documentId);
    const completions = jobs.map((job) => this.cancelJob(job.jobId, reason));
    try { await this.cancelDocumentNative(documentId); } catch { /* native exit hook is authoritative */ }
    return Promise.all(completions);
  }

  async cancelAll(reason = 'application-close') {
    const completions = [...this.jobs.values()].map((job) => this.cancelJob(job.jobId, reason));
    try { await this.cancelAllNative(); } catch { /* native RunEvent hook is authoritative */ }
    return Promise.all(completions);
  }

  dispose() {
    if (this.jobs.size > 0) throw new Error('Cannot dispose an OCR controller with active jobs');
    activeApplicationControllers.delete(this);
  }
}

export async function cancelApplicationOcrDocument(documentId, reason = 'document-close') {
  if (typeof documentId !== 'string' || documentId.length === 0) return [];
  if (activeApplicationControllers.size === 0) {
    try { await cancelNativeOcrDocument(documentId); } catch { /* document close continues */ }
    return [];
  }
  return Promise.all([...activeApplicationControllers].map((controller) =>
    controller.cancelDocument(documentId, reason)));
}

export async function cancelAllApplicationOcrJobs(reason = 'application-close') {
  if (activeApplicationControllers.size === 0) {
    try { await cancelAllNativeOcrJobs(); } catch { /* native RunEvent hook is authoritative */ }
    return [];
  }
  return Promise.all([...activeApplicationControllers].map((controller) => controller.cancelAll(reason)));
}
