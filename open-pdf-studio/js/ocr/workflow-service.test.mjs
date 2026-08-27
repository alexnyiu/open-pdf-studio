import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createServer } from 'vite';

globalThis.window = {
  location: new URL('http://localhost/'),
  __TAURI__: { os: { type: () => 'macos' } },
  dispatchEvent() { return true; },
};
globalThis.location = globalThis.window.location;

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

const {
  OCR_WORKFLOW_PUBLICATION_INTERVAL_MS,
  OcrWorkflowService,
  ocrWorkflowService,
} = await vite.ssrLoadModule('/js/ocr/workflow-service.js');
const {
  OCR_WORKFLOW_PERFORMANCE_CONTRACT,
  runOcrWorkflowPerformanceBenchmark,
} = await vite.ssrLoadModule('/js/ocr/workflow-performance.js');
const {
  OcrApplicationController,
} = await vite.ssrLoadModule('/js/ocr/application-controller.js');
const {
  resolveOcrRecognitionPolicy,
  resolveOcrPageScope,
  retryDocumentOcr,
  startActiveDocumentOcr,
  startDocumentOcr,
} = await vite.ssrLoadModule('/js/ocr/workflow-action.js');
const {
  CORE_OCR_RECOGNITION_UI_PROFILE,
  estimateOcrStorageImpact,
  resolveOcrDialogPageSelection,
  resolveOcrDialogRecognitionPolicy,
} = await vite.ssrLoadModule('/js/ocr/recognition-dialog-model.js');
const { state } = await vite.ssrLoadModule('/js/core/state.js');

after(async () => {
  state.documents.splice(0, state.documents.length);
  state.activeDocumentIndex = -1;
  await vite.close();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDocument(id = 'workflow-document', pageCount = 4) {
  return {
    id,
    filePath: '/parent/source.pdf',
    fileName: 'source.pdf',
    pdfDoc: { numPages: pageCount },
    currentPage: 2,
    ocr: { documentId: id, generation: `generation-${id}`, revision: 7, pages: {}, warnings: [], dirty: false },
  };
}

function modelState() {
  return {
    status: 'installed',
    identity: { packId: 'test-pack', packVersion: '1.0.0' },
    manifest: { packId: 'test-pack' },
    error: null,
  };
}

function pageSummary(pageNumber, stateName = 'completed', failure = null) {
  return {
    pageNumber,
    state: stateName,
    fraction: ['completed', 'skipped', 'unsupported', 'failed', 'cancelled'].includes(stateName) ? 1 : 0,
    attempts: 1,
    retries: 0,
    retryableFailureSeen: false,
    failure,
    staleRejected: false,
    cache: 'disabled',
    retained: stateName === 'completed',
    measuredStageCosts: null,
  };
}

function terminalSummary({ jobId, documentId, status = 'completed', pages = [pageSummary(2)] }) {
  return {
    jobId,
    documentId,
    documentGeneration: `generation-${documentId}`,
    status,
    progress: 1,
    cancellationReason: status === 'cancelled' ? 'user-cancelled' : null,
    keepCompletedPages: true,
    startedAt: '2026-08-18T00:00:00.000Z',
    finishedAt: '2026-08-18T00:00:01.000Z',
    counts: {},
    pages,
    stageCosts: { sampleCount: 0, costsMs: {} },
    appliedPageNumbers: status === 'completed' ? pages.map((page) => page.pageNumber) : [],
    rolledBackPageNumbers: [],
  };
}

function fakeHandle(documentId, jobId = `job-${documentId}`) {
  const completion = deferred();
  const cancellations = [];
  const handle = {
    jobId,
    documentId,
    completion: completion.promise,
    cancel(reason) {
      cancellations.push(reason);
      return completion.promise;
    },
    summary() {
      return {
        jobId,
        documentId,
        status: 'running',
        progress: 0,
        pages: [pageSummary(2, 'queued')],
        startedAt: '2026-08-18T00:00:00.000Z',
      };
    },
  };
  return { handle, completion, cancellations };
}

function startInput(document, overrides = {}) {
  return {
    document,
    sourcePdfPath: document.filePath,
    pageNumbers: [document.currentPage],
    pageScope: { kind: 'current-page' },
    recognitionPolicy: {
      existingText: 'skip',
      keepCompletedPages: true,
      useCache: false,
      maximumRetries: 1,
      recognitionOptions: {
        languagePolicy: { mode: 'automatic', languages: [], scripts: [] },
        includeWords: false,
        orientation: { mode: 'none', degrees: null },
        deskew: false,
        preprocessing: { mode: 'none', operations: [] },
        rasterDpi: 144,
        maximumPixels: 16_000_000,
        maximumSide: 8192,
        timeoutMs: 30_000,
      },
    },
    modelState: modelState(),
    documentRevision: document.ocr.revision,
    ...overrides,
  };
}

test('the normal macOS application action owns a production controller and calls startDocumentJob', async () => {
  const document = makeDocument('production-action-document');
  document.fileName = '/private/customer/source.pdf';
  const fake = fakeHandle(document.id, 'production-action-job');
  const originalStart = ocrWorkflowService.controller.startDocumentJob;
  const originalRequireInstalled = ocrWorkflowService.modelState.requireInstalled;
  let received = null;

  assert.ok(ocrWorkflowService.controller instanceof OcrApplicationController);
  ocrWorkflowService.controller.startDocumentJob = (options) => {
    received = options;
    return fake.handle;
  };
  ocrWorkflowService.modelState.requireInstalled = async () => modelState();
  state.documents.push(document);
  state.activeDocumentIndex = 0;

  try {
    const returned = await startActiveDocumentOcr();
    assert.equal(returned, fake.handle);
    assert.equal(received.document, document);
    assert.equal(received.sourcePdfPath, document.filePath);
    assert.deepEqual(received.pageNumbers, [2]);
    assert.equal(received.documentRevision, 7);
    assert.equal(received.force, false);
    assert.equal(received.keepCompletedPages, true);
    assert.equal(ocrWorkflowService.activeJobs.get(document.id).handle, fake.handle);
    assert.doesNotThrow(() => structuredClone(ocrWorkflowService.status(document.id)));
    assert.equal(ocrWorkflowService.status(document.id).documentName, 'source.pdf');
    assert.equal(ocrWorkflowService.status(document.id).currentPageNumber, 2);
    assert.equal(ocrWorkflowService.status(document.id).currentPageState, 'queued');
    assert.equal(ocrWorkflowService.status(document.id).counts.completed, 0);
    assert.doesNotMatch(JSON.stringify(ocrWorkflowService.snapshot()), /\/private\/customer/);

    fake.completion.resolve(terminalSummary({ jobId: fake.handle.jobId, documentId: document.id }));
    await fake.handle.completion;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ocrWorkflowService.activeJobs.has(document.id), false);
    assert.equal(ocrWorkflowService.status(document.id).terminalSummary.status, 'completed');
    assert.equal(ocrWorkflowService.status(document.id).currentPageState, 'completed');
    assert.equal(ocrWorkflowService.status(document.id).counts.completed, 1);
  } finally {
    ocrWorkflowService.controller.startDocumentJob = originalStart;
    ocrWorkflowService.modelState.requireInstalled = originalRequireInstalled;
    ocrWorkflowService.activeJobs.delete(document.id);
    ocrWorkflowService.states.delete(document.id);
    state.documents.splice(0, state.documents.length);
    state.activeDocumentIndex = -1;
  }
});

test('owner-explicit OCR start survives tab switches and rejects a detached owner after await', async () => {
  const first = makeDocument('owner-start-first');
  const second = makeDocument('owner-start-second');
  state.documents.splice(0, state.documents.length, first, second);
  state.activeDocumentIndex = 0;
  const owner = state.documents[0];
  const modelCheck = deferred();
  let received = null;
  const workflow = {
    requireCurrentModelState: () => modelCheck.promise,
    start(input) { received = input; return { jobId: 'owner-start-job' }; },
  };

  const starting = startDocumentOcr(owner.id, { workflow });
  state.activeDocumentIndex = 1;
  modelCheck.resolve(modelState());
  await starting;

  assert.equal(received.document, owner);
  assert.deepEqual(received.pageNumbers, [2]);

  const detachedCheck = deferred();
  let detachedStarts = 0;
  const detachedStart = startDocumentOcr(owner.id, {
    workflow: {
      requireCurrentModelState: () => detachedCheck.promise,
      start() { detachedStarts += 1; },
    },
  });
  state.documents.splice(0, 1);
  detachedCheck.resolve(modelState());
  await assert.rejects(detachedStart, (error) => error.code === 'OCR_DOCUMENT_OWNER_CHANGED');
  assert.equal(detachedStarts, 0);
  state.documents.splice(0, state.documents.length);
  state.activeDocumentIndex = -1;
});

test('owner-explicit retry reuses the failed owner settings instead of the active tab', async () => {
  const owner = makeDocument('owner-retry-first');
  const active = makeDocument('owner-retry-second');
  state.documents.splice(0, state.documents.length, owner, active);
  state.activeDocumentIndex = 1;
  let received = null;
  const recognitionPolicy = resolveOcrRecognitionPolicy({ maximumRetries: 2, useCache: false });
  const previous = {
    status: 'failed',
    finishedAt: '2026-08-26T00:00:00.000Z',
    failureDetails: [{ pageNumber: 1, code: 'OCR_TRANSIENT', stage: 'recognizing', retryable: true }],
    pageScope: { kind: 'range', startPage: 1, endPage: 3 },
    recognitionPolicy,
  };
  const workflow = {
    status(documentId) { return documentId === owner.id ? previous : null; },
    requireCurrentModelState: async () => modelState(),
    start(input) { received = input; return { jobId: 'owner-retry-job' }; },
  };

  await retryDocumentOcr(owner.id, { workflow });

  assert.equal(received.document, owner);
  assert.deepEqual(received.pageNumbers, [1, 2, 3]);
  assert.deepEqual(received.pageScope, previous.pageScope);
  assert.deepEqual(received.recognitionPolicy, previous.recognitionPolicy);
  state.documents.splice(0, state.documents.length);
  state.activeDocumentIndex = -1;
});

test('workflow state publishes progress, failure details, and handle-backed user cancellation', async () => {
  const document = makeDocument('state-document');
  const fake = fakeHandle(document.id, 'state-job');
  let startOptions = null;
  const controller = {
    startDocumentJob(options) {
      startOptions = options;
      return fake.handle;
    },
    cancelDocument: async () => [],
    cancelAll: async () => [],
  };
  const service = new OcrWorkflowService({ controller, modelState: { requireInstalled: async () => modelState() } });
  const snapshots = [];
  const unsubscribe = service.subscribe((snapshot) => snapshots.push(snapshot));

  service.start(startInput(document));
  assert.throws(
    () => service.start(startInput(document)),
    (error) => error.code === 'OCR_DOCUMENT_JOB_ACTIVE' && error.retryable === false,
  );
  startOptions.onProgress({
    jobId: fake.handle.jobId,
    documentId: document.id,
    pageNumber: 2,
    pageState: 'recognizing',
    pageFraction: 0.4,
    documentFraction: 0.4,
    attempts: 1,
    retries: 0,
    failure: null,
  });
  assert.equal(service.status(document.id).pages[0].state, 'recognizing');
  assert.equal(service.status(document.id).progress, 0.4);
  await new Promise((resolve) => setTimeout(resolve, OCR_WORKFLOW_PUBLICATION_INTERVAL_MS + 20));
  assert.ok(snapshots.length >= 3);

  const cancellation = service.cancel(document.id);
  const duplicateCancellation = service.cancel(document.id);
  assert.deepEqual(fake.cancellations, ['user-cancelled']);
  assert.equal(service.status(document.id).cancellationAvailable, false);
  assert.equal(service.status(document.id).cancellationRequested, true);
  assert.equal(service.status(document.id).status, 'cancelling');
  assert.equal(service.status(document.id).finishedAt, null);

  const failure = { code: 'OCR_ENGINE_FAILURE', stage: 'recognizing', retryable: false };
  fake.completion.resolve(terminalSummary({
    jobId: fake.handle.jobId,
    documentId: document.id,
    status: 'failed',
    pages: [pageSummary(2, 'failed', failure)],
  }));
  await cancellation;
  await duplicateCancellation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(service.status(document.id).failureDetails, [{ pageNumber: 2, ...failure }]);
  assert.equal(service.status(document.id).terminalSummary.status, 'failed');
  assert.equal(service.status(document.id).terminalSummary.keepCompletedPages, true);
  assert.equal(service.activeJobs.has(document.id), false);
  unsubscribe();
});

test('workflow deltas coalesce progress, keep O(1) page indexes, and stop after cancellation', async () => {
  const document = makeDocument('delta-document');
  const fake = fakeHandle(document.id, 'delta-job');
  let startOptions = null;
  const service = new OcrWorkflowService({
    controller: {
      startDocumentJob(options) { startOptions = options; return fake.handle; },
      cancelDocument: async () => [],
      cancelAll: async () => [],
    },
    modelState: { requireInstalled: async () => modelState() },
  });
  const updates = [];
  const unsubscribe = service.subscribeUpdates((update) => updates.push(update));
  service.start(startInput(document));

  for (let sequence = 1; sequence <= 50; sequence += 1) {
    startOptions.onProgress({
      jobId: fake.handle.jobId,
      documentId: document.id,
      sequence,
      pageNumber: 2,
      pageState: 'recognizing',
      pageFraction: sequence / 100,
      documentFraction: sequence / 100,
      attempts: 1,
      retries: 0,
      failure: null,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, OCR_WORKFLOW_PUBLICATION_INTERVAL_MS + 20));

  const progressDeltas = updates.filter((update) => update.kind === 'progress' && update.progress > 0);
  assert.equal(progressDeltas.length, 1);
  assert.equal(progressDeltas[0].progress, 0.5);
  assert.deepEqual(progressDeltas[0].pages.map((page) => page.pageNumber), [2]);
  assert.equal(service.activeJobs.get(document.id).pageIndex.get(2).fraction, 0.5);
  assert.ok(service.publicationMetrics().clonedBytes > 0);

  for (let sequence = 51; sequence <= 60; sequence += 1) {
    startOptions.onProgress({
      jobId: fake.handle.jobId,
      documentId: document.id,
      sequence,
      pageNumber: 2,
      pageState: 'recognizing',
      pageFraction: sequence / 100,
      documentFraction: sequence / 100,
      attempts: 1,
      retries: 0,
      failure: null,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, OCR_WORKFLOW_PUBLICATION_INTERVAL_MS + 20));
  const publicationMetrics = service.publicationMetrics();
  assert.equal(publicationMetrics.ordinaryDeliveryBatches, 2);
  assert.ok(publicationMetrics.minimumOrdinaryDeliveryIntervalMs
    >= OCR_WORKFLOW_PUBLICATION_INTERVAL_MS);
  assert.ok(publicationMetrics.maximumOrdinaryDeliveryHz <= 10);

  const cancellation = service.cancel(document.id);
  const publicationsAfterCancel = updates.length;
  startOptions.onProgress({
    jobId: fake.handle.jobId,
    documentId: document.id,
    sequence: 61,
    pageNumber: 2,
    pageState: 'completed',
    pageFraction: 1,
    documentFraction: 1,
    attempts: 1,
    retries: 0,
    failure: null,
  });
  await new Promise((resolve) => setTimeout(resolve, OCR_WORKFLOW_PUBLICATION_INTERVAL_MS + 20));
  assert.equal(updates.length, publicationsAfterCancel);
  assert.equal(service.status(document.id).status, 'cancelling');

  fake.completion.resolve(terminalSummary({
    jobId: fake.handle.jobId,
    documentId: document.id,
    status: 'cancelled',
    pages: [pageSummary(2, 'cancelled')],
  }));
  await cancellation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates.at(-1).terminal, true);
  unsubscribe();
});

test('page failures bypass progress coalescing while ordinary progress remains queued', async () => {
  const document = makeDocument('immediate-failure-document');
  const fake = fakeHandle(document.id, 'immediate-failure-job');
  let startOptions = null;
  const service = new OcrWorkflowService({
    controller: {
      startDocumentJob(options) { startOptions = options; return fake.handle; },
      cancelDocument: async () => [],
      cancelAll: async () => [],
    },
    modelState: { requireInstalled: async () => modelState() },
  });
  const updates = [];
  const unsubscribe = service.subscribeUpdates((update) => updates.push(update));
  service.start(startInput(document));
  const publicationsAfterStart = updates.length;

  startOptions.onProgress({
    jobId: fake.handle.jobId,
    documentId: document.id,
    sequence: 1,
    pageNumber: 2,
    pageState: 'recognizing',
    pageFraction: 0.4,
    documentFraction: 0.4,
    attempts: 1,
    retries: 0,
    failure: null,
  });
  assert.equal(updates.length, publicationsAfterStart,
    'ordinary progress must remain coalesced');

  const failure = { code: 'OCR_PAGE_FAILED', stage: 'recognizing', retryable: true };
  startOptions.onProgress({
    jobId: fake.handle.jobId,
    documentId: document.id,
    sequence: 2,
    pageNumber: 2,
    pageState: 'failed',
    pageFraction: 1,
    documentFraction: 1,
    attempts: 1,
    retries: 1,
    failure,
  });
  assert.equal(updates.length, publicationsAfterStart + 1,
    'failure must publish synchronously instead of waiting for the coalescing timer');
  assert.equal(updates.at(-1).kind, 'delta');
  assert.equal(updates.at(-1).job.currentPageState, 'failed');
  assert.deepEqual(updates.at(-1).job.failureDetails, [{ pageNumber: 2, ...failure }]);
  assert.equal(service.publicationMetrics().ordinaryDeliveryBatches, 0);
  assert.equal(service.publicationMetrics().immediateDeliveryBatches, 2);

  await new Promise((resolve) => setTimeout(resolve, OCR_WORKFLOW_PUBLICATION_INTERVAL_MS + 20));
  assert.equal(updates.length, publicationsAfterStart + 1,
    'the superseded ordinary timer must not publish a duplicate after the failure');
  fake.completion.resolve(terminalSummary({
    jobId: fake.handle.jobId,
    documentId: document.id,
    status: 'failed',
    pages: [pageSummary(2, 'failed', failure)],
  }));
  await fake.handle.completion;
  await new Promise((resolve) => setImmediate(resolve));
  unsubscribe();
});

test('100-page workflow benchmark reports bounded publication and owner-safe cancellation evidence', async () => {
  let performanceTick = 0;
  const report = await runOcrWorkflowPerformanceBenchmark({
    performanceClock: () => {
      performanceTick += 0.005;
      return performanceTick;
    },
  });

  assert.equal(report.contract, OCR_WORKFLOW_PERFORMANCE_CONTRACT);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.fixture.pageCount, 100);
  assert.equal(report.fixture.transitionCount, 600);
  assert.equal(report.metrics.bookkeepingEvents, 600);
  assert.equal(
    report.metrics.maximumPublicationHz,
    1000 / OCR_WORKFLOW_PUBLICATION_INTERVAL_MS,
  );
  assert.ok(report.metrics.averagePublicationHz <= 10);
  assert.ok(report.metrics.bookkeepingCpuPercent < 1);
  assert.ok(report.metrics.clonedBytes > 0);
  assert.ok(report.metrics.clonedBytes < 250_000);
  assert.deepEqual(report.checks, {
    publicationAtMost10Hz: true,
    bookkeepingBelow1Percent: true,
    progressMonotonic: true,
    noLatePublicationAfterCancel: true,
  });
  assert.equal(report.passed, true);
});

test('document and application close use controller cancellation and suppress late document state', async () => {
  const document = makeDocument('closing-document');
  const fake = fakeHandle(document.id, 'closing-job');
  const calls = [];
  let childReaped = false;
  const controller = {
    startDocumentJob: () => fake.handle,
    async cancelDocument(documentId, reason) {
      calls.push(['document', documentId, reason]);
      await fake.handle.cancel(reason);
      childReaped = true;
      return [];
    },
    async cancelAll(reason) {
      calls.push(['application', reason]);
      return [];
    },
  };
  const service = new OcrWorkflowService({ controller, modelState: { requireInstalled: async () => modelState() } });
  service.start(startInput(document));
  const closing = service.closeDocument(document.id);
  let closingSettled = false;
  void closing.then(() => { closingSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closingSettled, false);
  assert.equal(childReaped, false);
  fake.completion.resolve(terminalSummary({
    jobId: fake.handle.jobId,
    documentId: document.id,
    status: 'cancelled',
    pages: [pageSummary(2, 'cancelled')],
  }));
  await closing;
  assert.equal(childReaped, true);
  assert.deepEqual(calls[0], ['document', document.id, 'document-close']);
  assert.equal(service.status(document.id), null);
  assert.equal(service.activeJobs.has(document.id), false);
  assert.throws(
    () => service.start(startInput(document)),
    (error) => error.code === 'OCR_DOCUMENT_CLOSED' && error.retryable === false,
  );

  await service.closeApplication();
  assert.deepEqual(calls[1], ['application', 'application-close']);
});

test('application close waits for every retained production handle to become terminal', async () => {
  const firstDocument = makeDocument('application-close-first');
  const secondDocument = makeDocument('application-close-second');
  const first = fakeHandle(firstDocument.id);
  const second = fakeHandle(secondDocument.id);
  const handles = new Map([
    [firstDocument.id, first],
    [secondDocument.id, second],
  ]);
  let childrenReaped = false;
  const controller = {
    startDocumentJob: ({ document }) => handles.get(document.id).handle,
    cancelDocument: async () => [],
    async cancelAll(reason) {
      await Promise.all([...handles.values()].map(({ handle }) => handle.cancel(reason)));
      childrenReaped = true;
      return [];
    },
  };
  const service = new OcrWorkflowService({ controller, modelState: { requireInstalled: async () => modelState() } });
  service.start(startInput(firstDocument));
  service.start(startInput(secondDocument));

  const closing = service.closeApplication();
  let closingSettled = false;
  void closing.then(() => { closingSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closingSettled, false);
  assert.equal(childrenReaped, false);
  assert.deepEqual(first.cancellations, ['application-close']);
  assert.deepEqual(second.cancellations, ['application-close']);

  first.completion.resolve(terminalSummary({
    jobId: first.handle.jobId,
    documentId: firstDocument.id,
    status: 'cancelled',
    pages: [pageSummary(2, 'cancelled')],
  }));
  second.completion.resolve(terminalSummary({
    jobId: second.handle.jobId,
    documentId: secondDocument.id,
    status: 'cancelled',
    pages: [pageSummary(2, 'cancelled')],
  }));
  await closing;
  assert.equal(childrenReaped, true);
  assert.deepEqual(service.snapshot().jobsByDocumentId, {});
});

test('the application action resolves page scopes and stays disabled off macOS', async () => {
  assert.deepEqual(resolveOcrPageScope({ kind: 'current-page' }, { currentPage: 3, pageCount: 5 }), [3]);
  assert.deepEqual(resolveOcrPageScope({ kind: 'range', startPage: 2, endPage: 4 }, { currentPage: 1, pageCount: 5 }), [2, 3, 4]);
  assert.deepEqual(resolveOcrPageScope({ kind: 'entire-document' }, { currentPage: 1, pageCount: 3 }), [1, 2, 3]);

  const originalType = window.__TAURI__.os.type;
  let modelChecks = 0;
  window.__TAURI__.os.type = () => 'windows';
  try {
    await assert.rejects(
      startActiveDocumentOcr({
        document: makeDocument('windows-document'),
        workflow: {
          async requireCurrentModelState() { modelChecks += 1; return modelState(); },
          start() { throw new Error('must not start'); },
        },
      }),
      (error) => error.code === 'OCR_MACOS_ONLY' && error.retryable === false,
    );
    assert.equal(modelChecks, 0);
  } finally {
    window.__TAURI__.os.type = originalType;
  }
});

test('recognition dialog page scopes reject malformed and out-of-bounds ranges', () => {
  assert.deepEqual(resolveOcrDialogPageSelection({
    scopeKind: 'range', startPage: '2', endPage: '4', currentPage: 1, pageCount: 5,
  }), {
    pageScope: { kind: 'range', startPage: 2, endPage: 4 },
    pageNumbers: [2, 3, 4],
  });
  for (const [startPage, endPage] of [['', '2'], ['2.5', '3'], ['4', '2'], ['0', '2'], ['2', '6']]) {
    assert.throws(
      () => resolveOcrDialogPageSelection({
        scopeKind: 'range', startPage, endPage, currentPage: 1, pageCount: 5,
      }),
      (error) => error.code === 'OCR_PAGE_RANGE_INVALID',
    );
  }
});

test('recognition dialog exposes unavailable options truthfully and never sends them', () => {
  assert.deepEqual(CORE_OCR_RECOGNITION_UI_PROFILE, {
    recognitionMode: 'automatic-multilingual',
    specificLanguageSelection: false,
    automaticOrientation: false,
    deskew: false,
    offline: true,
  });
  const policy = resolveOcrDialogRecognitionPolicy({
    existingText: 'force-rerun',
    keepCompletedPages: true,
  });
  assert.equal(policy.existingText, 'force-rerun');
  assert.equal(policy.keepCompletedPages, true);
  assert.deepEqual(policy.recognitionOptions.languagePolicy, {
    mode: 'automatic', languages: [], scripts: [],
  });
  assert.deepEqual(policy.recognitionOptions.orientation, { mode: 'none', degrees: null });
  assert.equal(policy.recognitionOptions.deskew, false);
  assert.throws(
    () => resolveOcrRecognitionPolicy({
      recognitionOptions: { orientation: { mode: 'automatic', degrees: null } },
    }),
    /fixed automatic configuration/,
  );
});

test('recognition dialog reports bundled model and bounded selected-page cache impact', () => {
  const impact = estimateOcrStorageImpact({
    pageCount: 3,
    modelState: {
      status: 'installed',
      manifest: { assets: { detection: { bytes: 10 }, recognition: { bytes: 20 }, dictionary: { bytes: 30 } } },
    },
  });
  assert.equal(impact.modelPackBytes, 60);
  assert.equal(impact.selectedPages, 3);
  assert.ok(impact.estimatedCacheBytes > 0);
  assert.ok(impact.estimatedCacheBytes <= impact.cacheMaximumBytes);
});

test('model verification errors prevent the production start call', async () => {
  let starts = 0;
  await assert.rejects(
    startActiveDocumentOcr({
      document: makeDocument('missing-model-document'),
      workflow: {
        async requireCurrentModelState() {
          throw Object.assign(new Error('missing'), { code: 'OCR_MODEL_MISSING', retryable: true });
        },
        start() { starts += 1; },
      },
    }),
    (error) => error.code === 'OCR_MODEL_MISSING' && error.retryable === true,
  );
  assert.equal(starts, 0);
});
