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
  OcrWorkflowService,
  ocrWorkflowService,
} = await vite.ssrLoadModule('/js/ocr/workflow-service.js');
const {
  OcrApplicationController,
} = await vite.ssrLoadModule('/js/ocr/application-controller.js');
const {
  resolveOcrRecognitionPolicy,
  resolveOcrPageScope,
  startActiveDocumentOcr,
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
    fraction: 1,
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

    fake.completion.resolve(terminalSummary({ jobId: fake.handle.jobId, documentId: document.id }));
    await fake.handle.completion;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ocrWorkflowService.activeJobs.has(document.id), false);
    assert.equal(ocrWorkflowService.status(document.id).terminalSummary.status, 'completed');
  } finally {
    ocrWorkflowService.controller.startDocumentJob = originalStart;
    ocrWorkflowService.modelState.requireInstalled = originalRequireInstalled;
    ocrWorkflowService.activeJobs.delete(document.id);
    ocrWorkflowService.states.delete(document.id);
    state.documents.splice(0, state.documents.length);
    state.activeDocumentIndex = -1;
  }
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
  assert.ok(snapshots.length >= 3);

  const cancellation = service.cancel(document.id);
  assert.deepEqual(fake.cancellations, ['user-cancelled']);
  assert.equal(service.status(document.id).cancellationAvailable, false);
  assert.equal(service.status(document.id).cancellationRequested, true);

  const failure = { code: 'OCR_ENGINE_FAILURE', stage: 'recognizing', retryable: false };
  fake.completion.resolve(terminalSummary({
    jobId: fake.handle.jobId,
    documentId: document.id,
    status: 'failed',
    pages: [pageSummary(2, 'failed', failure)],
  }));
  await cancellation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(service.status(document.id).failureDetails, [{ pageNumber: 2, ...failure }]);
  assert.equal(service.status(document.id).terminalSummary.status, 'failed');
  assert.equal(service.status(document.id).terminalSummary.keepCompletedPages, true);
  assert.equal(service.activeJobs.has(document.id), false);
  unsubscribe();
});

test('document and application close use controller cancellation and suppress late document state', async () => {
  const document = makeDocument('closing-document');
  const fake = fakeHandle(document.id, 'closing-job');
  const calls = [];
  const controller = {
    startDocumentJob: () => fake.handle,
    async cancelDocument(documentId, reason) {
      calls.push(['document', documentId, reason]);
      await fake.handle.cancel(reason);
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
  fake.completion.resolve(terminalSummary({
    jobId: fake.handle.jobId,
    documentId: document.id,
    status: 'cancelled',
    pages: [pageSummary(2, 'cancelled')],
  }));
  await closing;
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
