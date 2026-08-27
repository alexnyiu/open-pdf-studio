import { render } from 'solid-js/web';

import { state } from '/js/core/state.ts';
import { ocrWorkflowService } from '/js/ocr/workflow-service.js';
import DocumentTabs from '/js/solid/components/DocumentTabs.jsx';
import OcrProgressToast from '/js/solid/components/OcrProgressToast.jsx';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function documentState(id, fileName) {
  return {
    id,
    filePath: `/Users/tester/Private/${fileName}`,
    fileName: `/Users/tester/Private/${fileName}`,
    pdfDoc: { numPages: 5 },
    currentPage: 1,
    ocr: {
      documentId: id,
      generation: `generation-${id}`,
      revision: 1,
      pages: {},
      warnings: [],
      dirty: false,
    },
  };
}

function pageSummary(pageNumber, stateName = 'queued', failure = null) {
  return {
    pageNumber,
    state: stateName,
    fraction: ['completed', 'skipped', 'unsupported', 'failed', 'cancelled'].includes(stateName) ? 1 : 0,
    attempts: stateName === 'queued' ? 0 : 1,
    retries: 0,
    retryableFailureSeen: failure?.retryable === true,
    failure,
    staleRejected: false,
    cache: 'disabled',
    retained: stateName === 'completed',
    measuredStageCosts: null,
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

const recognitionPolicy = {
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
};

const documents = [
  documentState('ocr-progress-document-a', 'scan-a.pdf'),
  documentState('ocr-progress-document-b', 'scan-b.pdf'),
];
state.documents = documents;
state.activeDocumentIndex = 0;

let jobSequence = 0;
let current = null;
const starts = [];

ocrWorkflowService.controller.startDocumentJob = (options) => {
  jobSequence += 1;
  const completion = deferred();
  const jobId = `ocr-progress-job-${jobSequence}`;
  const pages = options.pageNumbers.map((pageNumber) => pageSummary(pageNumber));
  const cancellationReasons = [];
  const handle = {
    jobId,
    documentId: options.document.id,
    completion: completion.promise,
    cancel(reason) {
      cancellationReasons.push(reason);
      return completion.promise;
    },
    summary() {
      return {
        jobId,
        documentId: options.document.id,
        status: 'queued',
        progress: 0,
        pages,
        startedAt: '2026-08-18T00:00:00.000Z',
      };
    },
  };
  current = { options, completion, handle, cancellationReasons };
  starts.push(current);
  return handle;
};
ocrWorkflowService.modelState.requireInstalled = async () => modelState();

function start(document = documents[state.activeDocumentIndex]) {
  return ocrWorkflowService.start({
    document,
    sourcePdfPath: document.filePath,
    pageNumbers: [1, 2, 3, 4, 5],
    pageScope: { kind: 'entire-document' },
    recognitionPolicy: structuredClone(recognitionPolicy),
    modelState: modelState(),
    documentRevision: document.ocr.revision,
  });
}

function emit(pageNumber, pageState, documentFraction) {
  const pageFraction = ['completed', 'skipped', 'unsupported', 'failed', 'cancelled'].includes(pageState)
    ? 1
    : documentFraction;
  current.options.onProgress({
    jobId: current.handle.jobId,
    documentId: current.handle.documentId,
    sequence: Date.now(),
    pageNumber,
    pageState,
    pageFraction,
    documentFraction,
    attempts: pageState === 'queued' ? 0 : 1,
    retries: 0,
    failure: pageState === 'failed'
      ? { code: 'OCR_TEST_FAILURE', stage: 'recognizing', retryable: false }
      : null,
  });
}

function terminalPages({ retryable = false } = {}) {
  const failure = {
    code: retryable ? 'OCR_TRANSIENT_TEST_FAILURE' : 'OCR_PERMANENT_TEST_FAILURE',
    stage: 'recognizing',
    retryable,
  };
  return [
    pageSummary(1, 'completed'),
    pageSummary(2, 'skipped'),
    pageSummary(3, 'unsupported'),
    pageSummary(4, 'failed', failure),
    pageSummary(5, 'cancelled'),
  ];
}

function resolveTerminal(status, { retryable = false } = {}) {
  const pages = status === 'completed'
    ? [1, 2, 3, 4, 5].map((pageNumber) => pageSummary(pageNumber, 'completed'))
    : terminalPages({ retryable });
  current.completion.resolve({
    jobId: current.handle.jobId,
    documentId: current.handle.documentId,
    documentGeneration: `generation-${current.handle.documentId}`,
    status,
    progress: 1,
    cancellationReason: status === 'cancelled' ? 'user-cancelled' : null,
    keepCompletedPages: true,
    startedAt: '2026-08-18T00:00:00.000Z',
    finishedAt: '2026-08-18T00:00:02.000Z',
    counts: {},
    pages,
    stageCosts: { sampleCount: 0, costsMs: {} },
    appliedPageNumbers: pages.filter((page) => page.state === 'completed').map((page) => page.pageNumber),
    rolledBackPageNumbers: [],
  });
}

const root = document.getElementById('test-root');
render(() => <><DocumentTabs /><OcrProgressToast /></>, root);

let liveMutations = 0;
const observer = new MutationObserver((records) => {
  liveMutations += records.length;
});

start();
queueMicrotask(() => {
  const liveRegion = document.querySelector('.ocr-progress-live-region');
  if (liveRegion) observer.observe(liveRegion, { childList: true, characterData: true, subtree: true });
  window.__ocrProgressHarnessReady = true;
});

window.__ocrProgressHarness = {
  emit,
  resolveTerminal,
  startFailure(retryable) {
    start();
    resolveTerminal('failed', { retryable });
  },
  switchDocument(index) {
    state.activeDocumentIndex = index;
  },
  resetLiveMutations() {
    liveMutations = 0;
  },
  liveMutations() {
    return liveMutations;
  },
  snapshot() {
    const active = ocrWorkflowService.status(documents[0].id);
    return {
      active,
      retainedHandle: ocrWorkflowService.activeJobs.get(documents[0].id)?.handle === current?.handle,
      cancellationReasons: current?.cancellationReasons ?? [],
      startCount: starts.length,
      fullSnapshot: ocrWorkflowService.snapshot(),
    };
  },
};
