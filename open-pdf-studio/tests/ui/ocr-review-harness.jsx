import { render } from 'solid-js/web';

import { state } from '/js/core/state.ts';
import {
  applyOcrPageResult,
  beginOcrPageAttempt,
  createDocumentOcrState,
  getOwnedOcrTextItems,
} from '/js/ocr/document-state.js';
import { createOcrPageGeometryV1 } from '/js/ocr/contracts/page-geometry.v1.js';
import { ocrWorkflowService } from '/js/ocr/workflow-service.js';
import OcrReviewPanel from '/js/solid/components/left-panel/panels/OcrReviewPanel.jsx';
import { setActiveTab } from '/js/solid/stores/leftPanelStore.js';

const MODEL_PACK = {
  contract: 'open-pdf-studio.ocr.model-pack',
  schemaVersion: 1,
  packId: 'paddleocr-pp-ocrv6-small-macos',
  packVersion: '1.0.0',
  assets: {
    detection: 'd'.repeat(64),
    recognition: 'e'.repeat(64),
    dictionary: 'f'.repeat(64),
  },
};

function fingerprint(character) {
  return { algorithm: 'sha256', value: character.repeat(64) };
}

function engineDescriptor({ alternatives = false } = {}) {
  return {
    contract: 'open-pdf-studio.ocr.engine',
    schemaVersion: 2,
    engineId: alternatives ? 'review-alternatives-test-engine' : 'paddleocr-pp-ocrv6-small-onnx-wasm',
    adapterVersion: '0.1.0',
    provider: alternatives ? 'Review Test Engine' : 'PaddleOCR',
    model: {
      family: 'PP-OCRv6',
      tier: 'small',
      detection: 'PP-OCRv6_small_det_onnx',
      recognition: 'PP-OCRv6_small_rec_onnx',
    },
    modelPack: structuredClone(MODEL_PACK),
    runtime: {
      name: 'onnxruntime-web',
      version: '1.27.0',
      executionProvider: 'wasm',
      offline: true,
    },
    capabilities: {
      textDetection: true,
      textRecognition: true,
      lineResults: true,
      linePolygons: true,
      lineBaselines: false,
      wordResults: false,
      wordPolygons: false,
      alternatives,
      languageDetection: false,
      writingDirectionDetection: false,
      preprocessingMetadata: false,
      nativePdfWriting: false,
    },
  };
}

function pdfDocument(pageCount) {
  return {
    numPages: pageCount,
    async getPage() {
      return {
        async getTextContent() {
          return { items: [], styles: {} };
        },
      };
    },
  };
}

function documentState(id, pageCount) {
  return {
    id,
    filePath: `/parent/${id}.pdf`,
    fileName: `${id}.pdf`,
    pdfDoc: pdfDocument(pageCount),
    currentPage: 1,
    viewMode: 'continuous',
    scale: 1,
    facingSpread: false,
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

function recognizedLine(line, index, alternativesCapable) {
  const x = 24;
  const y = 30 + index * 28;
  const width = 220;
  const height = 18;
  return {
    id: line.id,
    text: line.text,
    confidence: line.confidence,
    polygon: {
      coordinateSpace: 'source-raster-pixels',
      points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]],
    },
    boundingBox: {
      coordinateSpace: 'source-raster-pixels', x, y, width, height,
    },
    baseline: {
      status: 'unavailable',
      coordinateSpace: 'source-raster-pixels',
      reason: 'engine-did-not-provide',
    },
    ...(alternativesCapable ? { alternatives: structuredClone(line.alternatives ?? []) } : {}),
  };
}

async function applyPage(document, pageNumber, lines, options = {}) {
  const attempt = await beginOcrPageAttempt(document, pageNumber);
  const sourceRaster = {
    id: `raster-${document.id}-${pageNumber}`,
    fingerprint: fingerprint('b'),
    coordinateSpace: 'source-raster-pixels',
    widthPx: 612,
    heightPx: 792,
    dpi: 72,
  };
  const identity = {
    id: document.id,
    fingerprint: fingerprint('a'),
    revision: 0,
    generation: attempt.token.documentGeneration,
    pageCount: document.pdfDoc.numPages,
  };
  const result = {
    contract: 'open-pdf-studio.ocr.result',
    schemaVersion: 2,
    jobId: `job-${document.id}-${pageNumber}`,
    requestId: `request-${document.id}-${pageNumber}`,
    engine: engineDescriptor({ alternatives: options.alternatives === true }),
    document: identity,
    page: {
      id: attempt.token.pageId,
      index: pageNumber - 1,
      revision: attempt.token.pageRevision,
      status: options.status ?? 'completed',
    },
    recognitionConfigurationHash: fingerprint('c'),
    sourceRaster,
    text: lines.map((line) => line.text).join('\n'),
    lines: lines.map((line, index) => recognizedLine(line, index, options.alternatives === true)),
    detectedLanguages: [],
    warnings: structuredClone(options.warnings ?? []),
    unsupportedContentReasons: structuredClone(options.unsupportedContentReasons ?? []),
    preprocessing: { status: 'unknown', operations: [], outputRaster: null, transform: null },
    metrics: {
      workerStartupMs: 1,
      modelStartupMs: 1,
      rasterMs: 1,
      detectionMs: 1,
      recognitionMs: 1,
      totalOcrMs: 5,
    },
  };
  const pageGeometry = createOcrPageGeometryV1({
    geometryId: `geometry-${document.id}-${pageNumber}`,
    document: identity,
    page: { id: attempt.token.pageId, index: pageNumber - 1, revision: attempt.token.pageRevision },
    boxes: {
      mediaBox: { coordinateSpace: 'pdf-default-user-space', x: 0, y: 0, width: 612, height: 792 },
      cropBox: { coordinateSpace: 'pdf-default-user-space', x: 0, y: 0, width: 612, height: 792 },
      bleedBox: null,
      trimBox: null,
      artBox: null,
    },
    userUnit: 1,
    userUnitProvenance: 'pdf-default',
    intrinsicRotationDegrees: 0,
    applicationRotationDegrees: 0,
    requestedDpi: 72,
    sourceRaster,
    annotationsExcluded: true,
    formsExcluded: true,
  });
  const applied = applyOcrPageResult(document, { result, pageGeometry, token: attempt.token });
  if (!applied.applied) throw new Error(`Could not apply fixture: ${applied.reason}`);
  return document.ocr.pages[pageNumber];
}

const firstDocument = documentState('review-document-a', 3);
const secondDocument = documentState('review-document-b', 1);

await applyPage(firstDocument, 1, [
  { id: 'line-high', text: 'High confidence first', confidence: 0.98 },
  { id: 'line-low', text: 'Low confidence second', confidence: 0.52 },
], {
  warnings: [{
    code: 'review-low-confidence',
    message: 'Review the second line.',
    severity: 'warning',
    entityIds: ['line-low'],
  }],
});
const savedPage = await applyPage(firstDocument, 2, [
  { id: 'line-saved', text: 'Saved owned text', confidence: 0.96 },
]);
savedPage.recognition.ownership = {
  ...savedPage.recognition.ownership,
  stream: 'pdf-owned-invisible-text',
  persisted: true,
  persistedAt: '2026-08-18T00:00:00.000Z',
};
savedPage.review.dirty = false;
await applyPage(firstDocument, 3, [
  { id: 'line-unsupported', text: 'Unsupported table reading', confidence: 0.41 },
], {
  status: 'unsupported',
  unsupportedContentReasons: [{
    id: 'unsupported-table-ui',
    code: 'table',
    message: 'Table reading order is unsupported.',
    polygon: {
      coordinateSpace: 'source-raster-pixels',
      points: [[10, 10], [300, 10], [300, 160], [10, 160]],
    },
  }],
});
await applyPage(secondDocument, 1, [
  {
    id: 'line-alternative',
    text: 'Primary alternative text',
    confidence: 0.86,
    alternatives: [{ text: 'Secondary alternative text', confidence: 0.71 }],
  },
], { alternatives: true });

state.documents = [firstDocument, secondDocument];
state.activeDocumentIndex = 0;
setActiveTab('ocr-review');

let latestStartOptions = null;
let jobSequence = 0;
ocrWorkflowService.modelState.requireInstalled = async () => ({
  status: 'installed',
  manifest: structuredClone(MODEL_PACK),
  identity: { packId: MODEL_PACK.packId, packVersion: MODEL_PACK.packVersion },
  error: null,
});
ocrWorkflowService.controller.startDocumentJob = (options) => {
  latestStartOptions = options;
  jobSequence += 1;
  const jobId = `review-rerun-${jobSequence}`;
  const pages = options.pageNumbers.map((pageNumber) => ({
    pageNumber,
    state: 'completed',
    fraction: 1,
    attempts: 1,
    retries: 0,
    retryableFailureSeen: false,
    failure: null,
    staleRejected: false,
    cache: 'bypassed',
    retained: true,
    measuredStageCosts: null,
  }));
  const summary = {
    jobId,
    documentId: options.document.id,
    documentGeneration: options.document.ocr.generation,
    status: 'completed',
    progress: 1,
    cancellationReason: null,
    keepCompletedPages: true,
    startedAt: '2026-08-18T00:00:00.000Z',
    finishedAt: '2026-08-18T00:00:01.000Z',
    counts: {},
    pages,
    stageCosts: { sampleCount: 0, costsMs: {} },
    appliedPageNumbers: options.pageNumbers,
    rolledBackPageNumbers: [],
  };
  return {
    jobId,
    documentId: options.document.id,
    completion: Promise.resolve(summary),
    cancel: async () => summary,
    summary: () => ({ ...summary, status: 'queued', progress: 0, finishedAt: null }),
  };
};

render(() => <OcrReviewPanel />, document.getElementById('test-root'));

window.__ocrReviewHarness = {
  switchDocument(index) {
    state.activeDocumentIndex = index;
  },
  snapshot() {
    const active = state.documents[state.activeDocumentIndex];
    const reviewDocument = state.documents.find((entry) => entry.id === 'review-document-a');
    return {
      activeDocumentId: active.id,
      currentPage: active.currentPage,
      engineLowText: reviewDocument.ocr.pages[1]?.recognition?.result?.lines?.[1]?.text ?? null,
      correction: reviewDocument.ocr.pages[1]?.review?.corrections?.['line-low']?.correctedText ?? null,
      undoTypes: (reviewDocument.undoStack ?? []).map((command) => command.type),
      redoTypes: (reviewDocument.redoStack ?? []).map((command) => command.type),
      ownedPageCount: Object.values(reviewDocument.ocr.pages)
        .filter((page) => page?.recognition?.ownership?.owner === 'open-pdf-studio').length,
      unsupportedWriterItems: getOwnedOcrTextItems(reviewDocument, 3).length,
      rerun: latestStartOptions ? {
        pageNumbers: latestStartOptions.pageNumbers,
        force: latestStartOptions.force,
        useCache: latestStartOptions.useCache,
      } : null,
    };
  },
};

queueMicrotask(() => {
  window.__ocrReviewHarnessReady = true;
});
