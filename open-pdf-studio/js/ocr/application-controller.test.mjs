import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createServer } from 'vite';
import { fakePdfDocument, makeOcrFixture } from './searchable-layer.test-fixtures.mjs';

const dispatchedEvents = [];
globalThis.window = {
  location: new URL('http://localhost/'),
  dispatchEvent(event) {
    dispatchedEvents.push(event.type);
    return true;
  },
};
globalThis.location = globalThis.window.location;

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

const {
  OCR_APPLICATION_PAGE_STATES,
  OcrApplicationController,
  OcrInferenceGate,
  cancelAllApplicationOcrJobs,
  cancelApplicationOcrDocument,
} = await vite.ssrLoadModule('/js/ocr/application-controller.js');
const {
  summarizeOcrApplicationPerformance,
  validateOcrApplicationPerformanceSummary,
} = await vite.ssrLoadModule('/js/ocr/application-performance.js');
const {
  beginOcrPageAttempt,
  createDocumentOcrState,
  getPendingOcrTextItems,
  resetDocumentOcrGeneration,
} = await vite.ssrLoadModule('/js/ocr/document-state.js');
const { nativePageRequest } = await vite.ssrLoadModule('/js/ocr/native-controller.js');
const {
  correctRecognizedOcrText,
  removeApplicationOwnedOcr,
} = await vite.ssrLoadModule('/js/ocr/undo-commands.js');
const { state } = await vite.ssrLoadModule('/js/core/state.js');
const {
  LIFECYCLE_TRANSITION_POLICIES,
  replaceDocumentPdfProxy,
} = await vite.ssrLoadModule('/js/core/document-lifecycle.js');
const { redo, undo } = await vite.ssrLoadModule('/js/core/undo-manager.js');
const {
  textCacheSnapshot,
  writePageTextCache,
} = await vite.ssrLoadModule('/js/search/text-cache.js');

after(async () => {
  state.documents.splice(0, state.documents.length);
  state.activeDocumentIndex = -1;
  await vite.close();
});

function makeDocument(id, pageTextItems) {
  const pdfDoc = fakePdfDocument(pageTextItems);
  return {
    id,
    lifecycleGeneration: 0,
    pdfDoc,
    currentPage: 1,
    viewMode: 'single',
    scale: 1,
    annotations: [],
    selectedAnnotations: [],
    selectedAnnotation: null,
    textEdits: [],
    pageRotations: {},
    undoStack: [],
    redoStack: [],
    savedUndoStackLength: 0,
    modified: false,
    ocr: createDocumentOcrState(id),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requestFactory(fixtures) {
  return async ({ document, token, pageNumber, attempt }) => {
    const fixture = makeOcrFixture({
      documentId: document.id,
      documentGeneration: token.documentGeneration,
      pageId: token.pageId,
      pageRevision: token.pageRevision,
      pageIndex: pageNumber - 1,
      pageCount: document.pdfDoc.numPages,
      requestId: `request-${pageNumber}-${token.pageRevision}-${attempt}`,
    });
    fixture.result.jobId = `job-${pageNumber}-${token.pageRevision}-${attempt}`;
    const request = nativePageRequest({
      jobId: fixture.result.jobId,
      requestId: fixture.result.requestId,
      engineId: fixture.result.engine.engineId,
      modelPack: structuredClone(fixture.result.engine.modelPack),
      document: structuredClone(fixture.result.document),
      page: {
        id: fixture.result.page.id,
        index: fixture.result.page.index,
        revision: fixture.result.page.revision,
        sourceRasterId: fixture.result.sourceRaster.id,
      },
      recognitionConfigurationHash: structuredClone(fixture.result.recognitionConfigurationHash),
      recognitionOptions: {
        languagePolicy: { mode: 'automatic', languages: [], scripts: [] },
        includeWords: false,
        orientation: { mode: 'none', degrees: null },
        deskew: false,
        preprocessing: { mode: 'none', operations: [] },
        rasterDpi: 72,
        maximumPixels: 16_000_000,
        maximumSide: 8192,
        timeoutMs: 30_000,
      },
      documentPolicy: {
        skipMeaningfulExistingText: true,
        forceRerun: false,
        replaceApplicationOwnedOcrOnly: true,
        keepCompletedPages: true,
      },
      scheduler: { priority: 'background', execution: 'one-page-child' },
      createdAt: new Date().toISOString(),
    });
    fixtures.set(request.jobId, fixture);
    return request;
  };
}

function completedRunPage(fixtures, onRun = null) {
  return async ({ request }) => {
    await onRun?.(request);
    const fixture = fixtures.get(request.jobId);
    return {
      outcome: { status: 'completed', result: fixture.result },
      pageGeometry: fixture.pageGeometry,
    };
  };
}

function startJob(controller, document, fixtures, overrides = {}) {
  return controller.startDocumentJob({
    document,
    sourcePdfPath: '/parent-only-test-source.pdf',
    createPageRequest: requestFactory(fixtures),
    useCache: false,
    ...overrides,
  });
}

test('multi-page orchestration serializes inference and records one compound OCR command', async () => {
  const document = makeDocument('document-serial', [[], [], []]);
  const fixtures = new Map();
  const progress = [];
  let active = 0;
  let maximumActive = 0;
  const controller = new OcrApplicationController({
    runPage: completedRunPage(fixtures, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    }),
  });

  const summary = await startJob(controller, document, fixtures, {
    onProgress: (event) => progress.push(event),
  }).completion;

  assert.equal(maximumActive, 1);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.counts.completed, 3);
  assert.deepEqual(summary.appliedPageNumbers, [1, 2, 3]);
  assert.equal(summary.stageCosts.sampleCount, 3);
  assert.equal(document.undoStack.length, 1);
  assert.equal(document.undoStack[0].type, 'ocrApplyCompound');
  assert.deepEqual(document.undoStack[0].pageNumbers, [1, 2, 3]);
  assert.deepEqual(OCR_APPLICATION_PAGE_STATES, [
    'queued', 'rasterizing', 'preprocessing', 'recognizing', 'validating', 'applying',
    'completed', 'skipped', 'unsupported', 'failed', 'cancelled',
  ]);
  assert.ok(['queued', 'rasterizing', 'preprocessing', 'recognizing', 'validating', 'applying']
    .every((stage) => progress.some((event) => event.pageState === stage)));
  assert.ok(progress.every((event, index) => index === 0 ||
    event.documentFraction >= progress[index - 1].documentFraction));
  controller.dispose();
});

test('page summaries retain separate native, validation, apply, lifecycle, and resource metrics', async () => {
  const document = makeDocument('document-performance-evidence', [[]]);
  const fixtures = new Map();
  let clock = 0;
  const controller = new OcrApplicationController({
    clock: () => {
      clock += 2;
      return clock;
    },
    runPage: async ({ request }) => {
      const fixture = fixtures.get(request.jobId);
      return {
        outcome: {
          status: 'completed',
          result: fixture.result,
          lifecycle: [{ event: 'child-spawned', atMs: 3 }],
          resources: { peakRssBytes: 1_048_576 },
        },
        pageGeometry: fixture.pageGeometry,
      };
    },
  });

  const summary = await startJob(controller, document, fixtures).completion;

  assert.deepEqual(summary.pages[0].performance, {
    rasterMs: 1,
    childStartupMs: 1,
    modelStartupMs: 1,
    detectionMs: 1,
    recognitionMs: 1,
    validationMs: 2,
    applyMs: 2,
    totalOcrMs: 5,
    lifecycle: [{ event: 'child-spawned', atMs: 3 }],
    resources: { peakRssBytes: 1_048_576 },
  });
  assert.deepEqual(validateOcrApplicationPerformanceSummary(summary.performance, {
    expectedPageCount: 1,
  }), []);
  assert.deepEqual(summary.performance.stageOrder, [
    'rasterization', 'childStartup', 'modelStartup', 'inference', 'detection',
    'recognition', 'validation', 'apply', 'totalOcr',
  ]);
  assert.deepEqual(summary.performance.stages.inference, {
    source: 'detectionMs + recognitionMs',
    samples: 1,
    totalMs: 2,
    meanMs: 2,
    medianMs: 2,
    p95Ms: 2,
    maxMs: 2,
  });
  assert.equal(summary.performance.resourceLifecycle.pagesWithLifecycle, 1);
  assert.equal(summary.performance.resourceLifecycle.pagesWithResources, 1);
  controller.dispose();
});

test('application performance aggregation has stable stage percentiles and fails closed on gaps', () => {
  const pages = [1, 2, 3, 4].map((pageNumber) => ({
    pageNumber,
    performance: {
      rasterMs: pageNumber,
      childStartupMs: pageNumber + 1,
      modelStartupMs: pageNumber + 2,
      detectionMs: pageNumber * 2,
      recognitionMs: pageNumber * 3,
      validationMs: pageNumber + 3,
      applyMs: pageNumber + 4,
      totalOcrMs: pageNumber * 10,
      lifecycle: [{ stage: 'child-spawned' }],
      resources: { maximumAdapterInstances: 1 },
    },
  }));
  const summary = summarizeOcrApplicationPerformance(pages, {
    prefetch: { requested: 3, used: 3, maxBuffered: 1 },
  });

  assert.deepEqual(summary.stages.rasterization, {
    source: 'rasterMs',
    samples: 4,
    totalMs: 10,
    meanMs: 2.5,
    medianMs: 2,
    p95Ms: 4,
    maxMs: 4,
  });
  assert.deepEqual(summary.stages.inference, {
    source: 'detectionMs + recognitionMs',
    samples: 4,
    totalMs: 50,
    meanMs: 12.5,
    medianMs: 10,
    p95Ms: 20,
    maxMs: 20,
  });
  assert.equal(summary.prefetch.boundedBuffer, true);
  assert.deepEqual(validateOcrApplicationPerformanceSummary(summary, {
    expectedPageCount: 4,
  }), []);

  pages[3].performance.recognitionMs = Number.NaN;
  const incomplete = summarizeOcrApplicationPerformance(pages);
  assert.equal(incomplete.instrumentationAvailable, false);
  assert.match(
    validateOcrApplicationPerformanceSummary(incomplete, { expectedPageCount: 4 }).join(' '),
    /instrumentation is unavailable|sample count is invalid/u,
  );
});

test('next-page native raster prefetch is bounded and never starts a second inference', async () => {
  const document = makeDocument('document-prefetch', [[], [], []]);
  const fixtures = new Map();
  const prefetchedReceipts = new Map();
  const receivedReceipts = new Map();
  let activeInference = 0;
  let maximumActiveInference = 0;
  let prefetchResolvedDuringInference = false;
  const controller = new OcrApplicationController({
    async prefetchPage({ pageNumber, applicationJobId, documentId }) {
      const receipt = {
        contract: 'open-pdf-studio.ocr.native-raster-prefetch',
        status: 'ready',
        applicationJobId,
        documentId,
        pageIndex: pageNumber - 1,
        token: `prefetch-${pageNumber}`,
        widthPx: 10,
        heightPx: 10,
        byteLength: 400,
        rasterMs: 2,
      };
      prefetchedReceipts.set(pageNumber, receipt);
      await new Promise((resolve) => setImmediate(resolve));
      prefetchResolvedDuringInference ||= activeInference === 1;
      return receipt;
    },
    async runPage({ request, prefetchReceipt }) {
      const pageNumber = request.page.index + 1;
      receivedReceipts.set(pageNumber, prefetchReceipt ?? null);
      activeInference += 1;
      maximumActiveInference = Math.max(maximumActiveInference, activeInference);
      await new Promise((resolve) => setImmediate(resolve));
      activeInference -= 1;
      const fixture = fixtures.get(request.jobId);
      return { outcome: { status: 'completed', result: fixture.result }, pageGeometry: fixture.pageGeometry };
    },
  });

  const summary = await startJob(controller, document, fixtures).completion;

  assert.equal(maximumActiveInference, 1);
  assert.equal(prefetchResolvedDuringInference, true);
  assert.equal(receivedReceipts.get(1), null);
  assert.equal(receivedReceipts.get(2), prefetchedReceipts.get(2));
  assert.equal(receivedReceipts.get(3), prefetchedReceipts.get(3));
  assert.deepEqual(summary.prefetch, {
    requested: 2,
    used: 2,
    discarded: 0,
    failed: 0,
    maxBuffered: 1,
    rasterMs: 4,
    bytesPrepared: 800,
    bytesUsed: 800,
    peakBufferedBytes: 400,
  });
  controller.dispose();
});

test('cancellation discards a pending next-page prefetch without starting another inference', async () => {
  const document = makeDocument('document-prefetch-cancel', [[], []]);
  const fixtures = new Map();
  const prefetchStarted = deferred();
  const prefetchResult = deferred();
  const nativeStarted = deferred();
  const nativeResult = deferred();
  let inferenceCalls = 0;
  const controller = new OcrApplicationController({
    prefetchPage: async () => {
      prefetchStarted.resolve();
      return prefetchResult.promise;
    },
    runPage: async () => {
      inferenceCalls += 1;
      nativeStarted.resolve();
      return nativeResult.promise;
    },
    cancelPage: async () => {
      nativeResult.resolve({ outcome: { status: 'cancelled' }, pageGeometry: null });
    },
  });
  const job = startJob(controller, document, fixtures);
  await Promise.all([prefetchStarted.promise, nativeStarted.promise]);

  const summary = await job.cancel('user-cancelled');
  prefetchResult.resolve({ prefetchedPageNumber: 2 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(summary.status, 'cancelled');
  assert.equal(inferenceCalls, 1);
  assert.deepEqual(summary.pages.map((page) => page.state), ['cancelled', 'cancelled']);
  assert.deepEqual(summary.prefetch, {
    requested: 1,
    used: 0,
    discarded: 1,
    failed: 0,
    maxBuffered: 1,
    rasterMs: 0,
    bytesPrepared: 0,
    bytesUsed: 0,
    peakBufferedBytes: 0,
  });
  controller.dispose();
});

test('a failed next-page prefetch falls back without failing the OCR page', async () => {
  const document = makeDocument('document-prefetch-fallback', [[], []]);
  const fixtures = new Map();
  const receivedReceipts = [];
  const controller = new OcrApplicationController({
    prefetchPage() {
      throw new Error('fixture prefetch failure');
    },
    async runPage({ request, prefetchReceipt }) {
      receivedReceipts.push(prefetchReceipt ?? null);
      const fixture = fixtures.get(request.jobId);
      return { outcome: { status: 'completed', result: fixture.result }, pageGeometry: fixture.pageGeometry };
    },
  });

  const summary = await startJob(controller, document, fixtures).completion;

  assert.equal(summary.status, 'completed');
  assert.deepEqual(receivedReceipts, [null, null]);
  assert.deepEqual(summary.prefetch, {
    requested: 1,
    used: 0,
    discarded: 0,
    failed: 1,
    maxBuffered: 1,
    rasterMs: 0,
    bytesPrepared: 0,
    bytesUsed: 0,
    peakBufferedBytes: 0,
  });
  controller.dispose();
});

test('save/reload proxy replacement synchronously cancels an active OCR owner before apply', async () => {
  const document = makeDocument('document-save-reload-cancel', [[]]);
  document.filePath = '/parent-only-test-source.pdf';
  const originalPdfDocument = document.pdfDoc;
  const replacementPdfDocument = fakePdfDocument([[]]);
  const fixtures = new Map();
  const nativeStarted = deferred();
  const nativeResult = deferred();
  let cancelCalls = 0;
  const controller = new OcrApplicationController({
    runPage: async () => {
      nativeStarted.resolve();
      return nativeResult.promise;
    },
    cancelPage: async () => {
      cancelCalls += 1;
      nativeResult.resolve({ outcome: { status: 'cancelled' }, pageGeometry: null });
    },
  });
  const job = startJob(controller, document, fixtures);
  await nativeStarted.promise;

  const previous = replaceDocumentPdfProxy(
    document,
    replacementPdfDocument,
    LIFECYCLE_TRANSITION_POLICIES.VALIDATED_SAVE_ADOPTION,
  );
  const summary = await job.completion;

  assert.equal(previous, originalPdfDocument);
  assert.equal(document.pdfDoc, replacementPdfDocument);
  assert.equal(document.lifecycleGeneration, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.cancellationReason, 'validated-save-adoption');
  assert.deepEqual(summary.appliedPageNumbers, []);
  assert.equal(document.ocr.pages[1]?.recognition.result ?? null, null);
  controller.dispose();
});

test('an unannounced lifecycle/source replacement is rejected at the post-inference boundary', async () => {
  const document = makeDocument('document-lifecycle-stale-result', [[]]);
  document.filePath = '/parent-only-test-source.pdf';
  const fixtures = new Map();
  const controller = new OcrApplicationController({
    runPage: async ({ request }) => {
      document.lifecycleGeneration += 1;
      document.pdfDoc = fakePdfDocument([[]]);
      const fixture = fixtures.get(request.jobId);
      return { outcome: { status: 'completed', result: fixture.result }, pageGeometry: fixture.pageGeometry };
    },
  });

  const summary = await startJob(controller, document, fixtures).completion;

  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.cancellationReason, 'document-lifecycle-changed');
  assert.equal(summary.pages[0].staleRejected, true);
  assert.equal(summary.pages[0].failure.code, 'OCR_DOCUMENT_LIFECYCLE_CHANGED');
  assert.deepEqual(summary.appliedPageNumbers, []);
  assert.equal(document.ocr.pages[1]?.recognition.result ?? null, null);
  controller.dispose();
});

test('a changed parent source path is rejected before a completed result can apply', async () => {
  const document = makeDocument('document-source-path-stale', [[]]);
  document.filePath = '/parent-only-test-source.pdf';
  const fixtures = new Map();
  const controller = new OcrApplicationController({
    runPage: async ({ request }) => {
      document.filePath = '/replacement-after-save.pdf';
      const fixture = fixtures.get(request.jobId);
      return { outcome: { status: 'completed', result: fixture.result }, pageGeometry: fixture.pageGeometry };
    },
  });

  const summary = await startJob(controller, document, fixtures).completion;

  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.cancellationReason, 'source-identity-changed');
  assert.equal(summary.pages[0].staleRejected, true);
  assert.equal(summary.pages[0].failure.code, 'OCR_SOURCE_IDENTITY_CHANGED');
  assert.deepEqual(summary.appliedPageNumbers, []);
  controller.dispose();
});

test('a later page request cannot replace the captured document fingerprint', async () => {
  const document = makeDocument('document-source-fingerprint-stale', [[], []]);
  const fixtures = new Map();
  const createRequest = requestFactory(fixtures);
  let inferenceCalls = 0;
  const controller = new OcrApplicationController({
    runPage: completedRunPage(fixtures, async () => { inferenceCalls += 1; }),
    prefetchPage: async () => { throw new Error('prefetch intentionally unavailable'); },
  });
  const job = startJob(controller, document, fixtures, {
    createPageRequest: async (input) => {
      const request = await createRequest(input);
      if (input.pageNumber === 2) request.document.fingerprint.value = 'f'.repeat(64);
      return request;
    },
  });

  const summary = await job.completion;

  assert.equal(inferenceCalls, 1);
  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.cancellationReason, 'source-identity-changed');
  assert.equal(summary.pages[1].staleRejected, true);
  assert.equal(summary.pages[1].failure.code, 'OCR_SOURCE_IDENTITY_CHANGED');
  assert.deepEqual(summary.appliedPageNumbers, [1]);
  controller.dispose();
});

test('the default inference gate serializes concurrent document jobs', async () => {
  const firstDocument = makeDocument('document-concurrent-a', [[]]);
  const secondDocument = makeDocument('document-concurrent-b', [[]]);
  const firstFixtures = new Map();
  const secondFixtures = new Map();
  const fixturesByDocument = new Map([
    [firstDocument.id, firstFixtures],
    [secondDocument.id, secondFixtures],
  ]);
  let active = 0;
  let maximumActive = 0;
  const controller = new OcrApplicationController({
    runPage: async ({ request }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      const fixture = fixturesByDocument.get(request.document.id).get(request.jobId);
      return { outcome: { status: 'completed', result: fixture.result }, pageGeometry: fixture.pageGeometry };
    },
  });
  const first = startJob(controller, firstDocument, firstFixtures);
  const second = startJob(controller, secondDocument, secondFixtures);
  assert.throws(
    () => startJob(controller, firstDocument, new Map()),
    (error) => error.code === 'OCR_DOCUMENT_JOB_ACTIVE' && error.retryable === false,
  );

  const summaries = await Promise.all([first.completion, second.completion]);

  assert.equal(maximumActive, 1);
  assert.deepEqual(summaries.map((summary) => summary.status), ['completed', 'completed']);
  controller.dispose();
});

test('meaningful existing document text produces a skipped application summary', async () => {
  const document = makeDocument('document-skip', [[{ str: 'Meaningful existing document text' }]]);
  const fixtures = new Map();
  let inferenceCalls = 0;
  const controller = new OcrApplicationController({
    runPage: async () => { inferenceCalls += 1; },
  });

  const summary = await startJob(controller, document, fixtures).completion;

  assert.equal(summary.status, 'completed');
  assert.equal(summary.counts.skipped, 1);
  assert.equal(summary.pages[0].state, 'skipped');
  assert.equal(inferenceCalls, 0);
  assert.equal(document.undoStack.length, 0);
  controller.dispose();
});

test('only explicitly retryable page failures are retried', async () => {
  const document = makeDocument('document-retry', [[], []]);
  const fixtures = new Map();
  const calls = new Map();
  const controller = new OcrApplicationController({
    runPage: async ({ request }) => {
      const pageNumber = request.page.index + 1;
      calls.set(pageNumber, (calls.get(pageNumber) ?? 0) + 1);
      if (pageNumber === 1 && calls.get(pageNumber) === 1) {
        return {
          outcome: {
            status: 'failed',
            failure: { code: 'OCR_TRANSIENT', stage: 'recognizing', retryable: true },
          },
        };
      }
      if (pageNumber === 2) {
        return {
          outcome: {
            status: 'failed',
            failure: { code: 'OCR_PERMANENT', stage: 'recognizing', retryable: false },
          },
        };
      }
      const fixture = fixtures.get(request.jobId);
      return { outcome: { status: 'completed', result: fixture.result }, pageGeometry: fixture.pageGeometry };
    },
  });

  const summary = await startJob(controller, document, fixtures, { maximumRetries: 2 }).completion;

  assert.equal(summary.status, 'failed');
  assert.deepEqual(Object.fromEntries(calls), { 1: 2, 2: 1 });
  assert.equal(summary.pages[0].retries, 1);
  assert.equal(summary.pages[0].retryableFailureSeen, true);
  assert.equal(summary.pages[1].failure.retryable, false);
  assert.deepEqual(summary.appliedPageNumbers, [1]);
  controller.dispose();
});

test('document-close cancellation keeps completed pages when keep-completed-pages is true', async () => {
  const document = makeDocument('document-close-cancel', [[], [], []]);
  const fixtures = new Map();
  let releaseSecondPage;
  let signalSecondPage;
  const secondPageStarted = new Promise((resolve) => { signalSecondPage = resolve; });
  const nativeDocumentCancels = [];
  const pageCancels = [];
  const controller = new OcrApplicationController({
    runPage: async ({ request }) => {
      if (request.page.index === 1) {
        signalSecondPage();
        return new Promise((resolve) => { releaseSecondPage = resolve; });
      }
      const fixture = fixtures.get(request.jobId);
      return { outcome: { status: 'completed', result: fixture.result }, pageGeometry: fixture.pageGeometry };
    },
    cancelPage: async (jobId) => {
      pageCancels.push(jobId);
      releaseSecondPage({ outcome: { status: 'cancelled' }, pageGeometry: null });
    },
    cancelDocumentNative: async (documentId) => { nativeDocumentCancels.push(documentId); },
  });
  const job = startJob(controller, document, fixtures);
  await secondPageStarted;

  const [[summary]] = await cancelApplicationOcrDocument(document.id, 'document-close');

  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.keepCompletedPages, true);
  assert.equal(summary.cancellationReason, 'document-close');
  assert.deepEqual(summary.pages.map((page) => page.state), ['completed', 'cancelled', 'cancelled']);
  assert.deepEqual(summary.appliedPageNumbers, [1]);
  assert.equal(summary.pages[0].retained, true);
  assert.equal(document.undoStack[0].type, 'ocrApplyCompound');
  assert.equal(pageCancels.length, 1);
  assert.deepEqual(nativeDocumentCancels, [document.id]);
  assert.equal(await job.completion, summary);
  controller.dispose();
});

test('cancel before inference removes a queued gate ticket without running the native page', async () => {
  const document = makeDocument('cancel-before-inference', [[]]);
  const fixtures = new Map();
  const inferenceGate = new OcrInferenceGate();
  const releaseBlocker = await inferenceGate.acquire('blocking-document-job');
  let inferenceCalls = 0;
  const controller = new OcrApplicationController({
    inferenceGate,
    runPage: async () => {
      inferenceCalls += 1;
      throw new Error('cancelled queue entry must not reach inference');
    },
  });
  const job = startJob(controller, document, fixtures);
  await waitUntil(() => inferenceGate.queue.some((ticket) => ticket.applicationJobId === job.jobId),
    'OCR job did not enter the inference queue');

  const summary = await job.cancel('user-cancelled');

  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.counts.cancelled, 1);
  assert.equal(inferenceCalls, 0);
  assert.equal(inferenceGate.queue.some((ticket) => ticket.applicationJobId === job.jobId), false);
  assert.equal(getPendingOcrTextItems(document, 1).length, 0);
  releaseBlocker();
  controller.dispose();
});

test('cancel during a delayed cache read settles without applying a late cache hit', async () => {
  const document = makeDocument('cancel-delayed-cache', [[]]);
  const fixtures = new Map();
  const cacheRead = deferred();
  const cacheStarted = deferred();
  let inferenceCalls = 0;
  const controller = new OcrApplicationController({
    cache: {
      get: async () => {
        cacheStarted.resolve();
        return cacheRead.promise;
      },
      put: async () => {},
    },
    runPage: async () => {
      inferenceCalls += 1;
      throw new Error('late cache cancellation must not fall through to inference');
    },
  });
  const job = startJob(controller, document, fixtures, { useCache: true });
  await cacheStarted.promise;

  const summary = await withTimeout(
    job.cancel('user-cancelled'),
    1_000,
    'cache cancellation did not settle',
  );
  assert.equal(summary.status, 'cancelled');
  assert.equal(inferenceCalls, 0);
  assert.equal(getPendingOcrTextItems(document, 1).length, 0);

  cacheRead.resolve({ status: 'hit', envelope: { deliberately: 'late-and-invalid' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getPendingOcrTextItems(document, 1).length, 0);
  assert.equal(document.undoStack.length, 0);
  controller.dispose();
});

test('native inference cancellation stays pending until the child is reaped and rejects a late result', async () => {
  const document = makeDocument('cancel-native-inference', [[]]);
  const fixtures = new Map();
  const nativeRun = deferred();
  const nativeStarted = deferred();
  const cancelCalled = deferred();
  let childReaped = false;
  const controller = new OcrApplicationController({
    runPage: async () => {
      nativeStarted.resolve();
      return nativeRun.promise;
    },
    cancelPage: async () => {
      childReaped = true;
      cancelCalled.resolve();
      return { cleanup: { noChildSurvived: true } };
    },
  });
  const job = startJob(controller, document, fixtures);
  await nativeStarted.promise;

  let cancellationSettled = false;
  const cancellation = job.cancel('user-cancelled').then((summary) => {
    cancellationSettled = true;
    return summary;
  });
  await cancelCalled.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(childReaped, true);
  assert.equal(cancellationSettled, false);

  const fixture = [...fixtures.values()][0];
  nativeRun.resolve({
    outcome: { status: 'completed', result: fixture.result },
    pageGeometry: fixture.pageGeometry,
  });
  const summary = await cancellation;
  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.pages[0].state, 'cancelled');
  assert.equal(getPendingOcrTextItems(document, 1).length, 0);
  assert.equal(document.undoStack.length, 0);
  controller.dispose();
});

test('cancellation rejects a result between validation and application and while applying', async () => {
  for (const cancellationStage of ['validated', 'applying']) {
    const document = makeDocument(`cancel-${cancellationStage}`, [[]]);
    const fixtures = new Map();
    const stageReached = deferred();
    const releaseStage = deferred();
    const controller = new OcrApplicationController({
      runPage: completedRunPage(fixtures),
      yieldControl: ({ stage }) => {
        if (stage === cancellationStage) {
          stageReached.resolve();
          return releaseStage.promise;
        }
        return Promise.resolve();
      },
    });
    const job = startJob(controller, document, fixtures);
    await stageReached.promise;

    const summary = await job.cancel('user-cancelled');
    releaseStage.resolve();

    assert.equal(summary.status, 'cancelled', cancellationStage);
    assert.equal(summary.pages[0].state, 'cancelled', cancellationStage);
    assert.equal(getPendingOcrTextItems(document, 1).length, 0, cancellationStage);
    assert.equal(document.undoStack.length, 0, cancellationStage);
    controller.dispose();
  }
});

test('keep-completed-pages false rolls back completed text when a later page is cancelled', async () => {
  const document = makeDocument('cancel-rollback-completed-pages', [[], []]);
  const fixtures = new Map();
  const secondPageStarted = deferred();
  const secondPageRun = deferred();
  const controller = new OcrApplicationController({
    runPage: async ({ request }) => {
      if (request.page.index === 1) {
        secondPageStarted.resolve();
        return secondPageRun.promise;
      }
      const fixture = fixtures.get(request.jobId);
      return { outcome: { status: 'completed', result: fixture.result }, pageGeometry: fixture.pageGeometry };
    },
    cancelPage: async () => {
      secondPageRun.resolve({ outcome: { status: 'cancelled' }, pageGeometry: null });
    },
  });
  const job = startJob(controller, document, fixtures, { keepCompletedPages: false });
  await secondPageStarted.promise;

  const summary = await job.cancel('user-cancelled');

  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.keepCompletedPages, false);
  assert.deepEqual(summary.appliedPageNumbers, []);
  assert.deepEqual(summary.rolledBackPageNumbers, [1]);
  assert.equal(getPendingOcrTextItems(document, 1).length, 0);
  assert.equal(getPendingOcrTextItems(document, 2).length, 0);
  assert.equal(document.undoStack.length, 0);
  controller.dispose();
});

test('application-close cancellation reaches the active child and native global boundary', async () => {
  const document = makeDocument('application-close-cancel', [[]]);
  const fixtures = new Map();
  let releasePage;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const pageCancels = [];
  let globalCancels = 0;
  const controller = new OcrApplicationController({
    runPage: async () => {
      signalStarted();
      return new Promise((resolve) => { releasePage = resolve; });
    },
    cancelPage: async (jobId) => {
      pageCancels.push(jobId);
      releasePage({ outcome: { status: 'cancelled' }, pageGeometry: null });
    },
    cancelAllNative: async () => { globalCancels += 1; },
  });
  startJob(controller, document, fixtures);
  await started;

  const [[summary]] = await cancelAllApplicationOcrJobs('application-close');

  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.cancellationReason, 'application-close');
  assert.equal(summary.pages[0].state, 'cancelled');
  assert.equal(pageCancels.length, 1);
  assert.equal(globalCancels, 1);
  controller.dispose();
});

test('keep-completed-pages false rolls successful pages back after a later failure', async () => {
  const document = makeDocument('document-rollback', [[], []]);
  const fixtures = new Map();
  const controller = new OcrApplicationController({
    runPage: async ({ request }) => {
      if (request.page.index === 1) {
        return {
          outcome: {
            status: 'failed',
            failure: { code: 'OCR_PAGE_FAILED', stage: 'recognizing', retryable: false },
          },
        };
      }
      const fixture = fixtures.get(request.jobId);
      return { outcome: { status: 'completed', result: fixture.result }, pageGeometry: fixture.pageGeometry };
    },
  });

  const summary = await startJob(controller, document, fixtures, {
    keepCompletedPages: false,
    maximumRetries: 0,
  }).completion;

  assert.equal(summary.status, 'failed');
  assert.deepEqual(summary.appliedPageNumbers, []);
  assert.deepEqual(summary.rolledBackPageNumbers, [1]);
  assert.equal(document.ocr.pages[1], undefined);
  assert.equal(document.undoStack.length, 0);
  controller.dispose();
});

test('stale page results are rejected without restoring over the newer attempt', async () => {
  const document = makeDocument('document-stale-application', [[]]);
  const fixtures = new Map();
  let newerToken;
  const controller = new OcrApplicationController({
    runPage: async ({ request }) => {
      newerToken = (await beginOcrPageAttempt(document, 1)).token;
      const fixture = fixtures.get(request.jobId);
      return { outcome: { status: 'completed', result: fixture.result }, pageGeometry: fixture.pageGeometry };
    },
  });

  const summary = await startJob(controller, document, fixtures).completion;

  assert.equal(summary.status, 'failed');
  assert.equal(summary.pages[0].staleRejected, true);
  assert.equal(summary.pages[0].failure.code, 'OCR_STALE_PAGE');
  assert.equal(document.ocr.pages[1].pageRevision, newerToken.pageRevision);
  assert.equal(document.ocr.pages[1].recognition.result, null);
  controller.dispose();
});

test('page revisions do not reuse persistent cache identities after a structure-generation reset', async () => {
  const document = makeDocument('document-structure-revision', [[]]);
  const first = (await beginOcrPageAttempt(document, 1)).token;

  resetDocumentOcrGeneration(document);
  const second = (await beginOcrPageAttempt(document, 1)).token;

  assert.notEqual(second.documentGeneration, first.documentGeneration);
  assert.equal(second.pageId, first.pageId);
  assert.ok(second.pageRevision > first.pageRevision);
});

test('a completed job retains pending OCR on the production reactive document', async () => {
  const document = makeDocument('document-reactive-completion', [[]]);
  state.documents.splice(0, state.documents.length, document);
  state.activeDocumentIndex = 0;
  const activeDocument = state.documents[0];
  const fixtures = new Map();
  const controller = new OcrApplicationController({ runPage: completedRunPage(fixtures) });

  const summary = await startJob(controller, activeDocument, fixtures).completion;

  assert.equal(summary.status, 'completed');
  assert.equal(activeDocument.ocr.pages[1].recognition.ownership?.owner, 'open-pdf-studio');
  assert.equal(getPendingOcrTextItems(activeDocument, 1).length, 2);
  assert.equal(Object.isFrozen(activeDocument.ocr.pages[1].recognition.result), true);
  assert.equal(Object.isFrozen(activeDocument.ocr.pages[1].recognition.result.lines), true);
  assert.throws(() => {
    activeDocument.ocr.pages[1].recognition.result.lines[0].text = 'mutated';
  }, TypeError);
  assert.equal(activeDocument.undoStack[0].type, 'ocrApplyCompound');
  controller.dispose();
  state.documents.splice(0, state.documents.length);
  state.activeDocumentIndex = -1;
});

test('typed OCR undo and redo restore search text, ownership, dirty state, and removal', async () => {
  const document = makeDocument('document-typed-undo', [[]]);
  const fixtures = new Map();
  const controller = new OcrApplicationController({ runPage: completedRunPage(fixtures) });
  await startJob(controller, document, fixtures).completion;
  controller.dispose();

  state.documents.splice(0, state.documents.length, document);
  state.activeDocumentIndex = 0;
  const activeDocument = state.documents[0];
  assert.equal(activeDocument.undoStack[0].type, 'ocrApplyCompound');
  assert.equal(getPendingOcrTextItems(activeDocument, 1).length, 2);
  writePageTextCache(activeDocument, activeDocument.pdfDoc, 1, { text: 'cached' });
  dispatchedEvents.length = 0;
  const beforeUndoRevision = activeDocument.revisionState.contentRevision;

  await undo();

  assert.equal(getPendingOcrTextItems(activeDocument, 1).length, 0);
  assert.equal(activeDocument.ocr.dirty, false);
  assert.equal(activeDocument.modified, true);
  assert.equal(activeDocument.revisionState.contentRevision, beforeUndoRevision + 1);
  assert.ok(
    activeDocument.revisionState.contentRevision > activeDocument.revisionState.persistedRevision,
  );
  assert.equal(textCacheSnapshot().some((entry) => entry.documentId === activeDocument.id), false);
  assert.ok(dispatchedEvents.includes('open-pdf-studio:ocr-page-state-changed'));

  await redo();
  assert.equal(getPendingOcrTextItems(activeDocument, 1).length, 2);
  assert.equal(activeDocument.ocr.pages[1].recognition.ownership.owner, 'open-pdf-studio');
  assert.equal(activeDocument.ocr.dirty, true);
  assert.equal(activeDocument.modified, true);

  correctRecognizedOcrText(activeDocument, 1, 'line-1', 'Corrected through typed command');
  assert.equal(activeDocument.undoStack.at(-1).type, 'ocrCorrectPage');
  assert.equal(getPendingOcrTextItems(activeDocument, 1)[0].text, 'Corrected through typed command');
  await undo();
  assert.equal(getPendingOcrTextItems(activeDocument, 1)[0].text, 'First searchable line');
  await redo();
  assert.equal(getPendingOcrTextItems(activeDocument, 1)[0].text, 'Corrected through typed command');

  const removal = removeApplicationOwnedOcr(activeDocument, [1]);
  assert.equal(removal.command.type, 'ocrRemoveOwned');
  assert.equal(getPendingOcrTextItems(activeDocument, 1).length, 0);
  await undo();
  assert.equal(getPendingOcrTextItems(activeDocument, 1)[0].text, 'Corrected through typed command');
  assert.equal(activeDocument.ocr.pages[1].recognition.ownership.owner, 'open-pdf-studio');
  await redo();
  assert.equal(getPendingOcrTextItems(activeDocument, 1).length, 0);
  assert.equal(activeDocument.ocr.pages[1].recognition.ownership, null);

  state.documents.splice(0, state.documents.length);
  state.activeDocumentIndex = -1;
});
