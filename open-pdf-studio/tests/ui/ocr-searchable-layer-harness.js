import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { state } from '/js/core/state.ts';
import { createDocument } from '/js/core/stores/document-helpers.ts';
import {
  acceptOcrLineCorrection,
  applyOcrPageResult,
  beginOcrPageAttempt,
  recordOcrExistingTextAssessment,
} from '/js/ocr/document-state.js';
import { assessMeaningfulPdfText } from '/js/ocr/existing-text.js';
import {
  OCR_ENGINE_CONTRACT,
  OCR_RESULT_CONTRACT,
  createOcrPageGeometryV1,
  migrateOcrResultToCurrent,
} from '/js/ocr/contracts/production.js';
import {
  clearSinglePageTextLayer,
  clearTextLayers,
  createTextLayer,
  injectPendingOcrTextSpans,
} from '/js/text/text-layer.js';
import { performSearch, replaceCurrentMatch } from '/js/search/find-controller.js';
import { highlightResults } from '/js/search/find-bar.js';
import { extractPageText } from '/js/search/text-extraction.js';
import { invalidateTextCache } from '/js/search/text-cache.js';
import { markDocumentSaved } from '/js/ui/chrome/tabs.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';
const modelPack = await fetch('/ocr/pp-ocrv6-small/manifest.json').then((response) => response.json());
const root = document.getElementById('test-root');
let requestSequence = 0;
let mainDocument = null;

function hash(character) {
  return { algorithm: 'sha256', value: character.repeat(64) };
}

function phaseAEngine() {
  return {
    contract: OCR_ENGINE_CONTRACT,
    schemaVersion: 1,
    engineId: 'paddleocr-pp-ocrv6-small-onnx-wasm',
    adapterVersion: '0.1.0',
    provider: 'PaddleOCR',
    model: {
      family: 'PP-OCRv6', tier: 'small',
      detection: 'PP-OCRv6_small_det_onnx', recognition: 'PP-OCRv6_small_rec_onnx',
    },
    runtime: { name: 'onnxruntime-web', version: '1.27.0', executionProvider: 'wasm', offline: true },
    capabilities: { textDetection: true, textRecognition: true, wordBoxes: false, pdfWriting: false },
  };
}

function fixtureFor(doc, token, pageNum, lines) {
  requestSequence += 1;
  const requestId = `ui-request-${requestSequence}`;
  const width = 612;
  const height = 792;
  const v1 = {
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: 1,
    requestId,
    engine: phaseAEngine(),
    source: {
      kind: 'pdf-page', path: '/test-only-ui-fixture.pdf', pageIndex: pageNum - 1,
      widthPx: width, heightPx: height, scale: 1,
    },
    text: lines.map((line) => line.text).join('\n'),
    lines: lines.map((line) => ({
      id: line.id,
      text: line.text,
      confidence: line.confidence ?? 0.95,
      boundingBox: { x: line.x, y: line.y, width: line.width, height: line.height },
      polygon: [
        [line.x, line.y], [line.x + line.width, line.y],
        [line.x + line.width, line.y + line.height], [line.x, line.y + line.height],
      ],
    })),
    metrics: {
      workerStartupMs: 1, modelStartupMs: 1, rasterMs: 1,
      detectionMs: 1, recognitionMs: 1, totalOcrMs: 5,
    },
    warnings: [],
  };
  const result = migrateOcrResultToCurrent(v1, {
    modelPack,
    documentId: doc.id,
    documentFingerprint: hash('a'),
    documentRevision: 0,
    documentGeneration: token.documentGeneration,
    documentPageCount: doc.pdfDoc.numPages,
    pageId: token.pageId,
    pageRevision: token.pageRevision,
    sourceRasterId: `ui-raster-${pageNum}-${token.pageRevision}`,
    sourceRasterFingerprint: hash('b'),
    rasterDpi: 72,
    recognitionConfigurationHash: hash('c'),
    requestId,
    jobId: `ui-job-${requestSequence}`,
  });
  const pageGeometry = createOcrPageGeometryV1({
    geometryId: `ui-geometry-${pageNum}-${token.pageRevision}`,
    document: result.document,
    page: { id: result.page.id, index: result.page.index, revision: result.page.revision },
    boxes: {
      mediaBox: { coordinateSpace: 'pdf-default-user-space', x: 0, y: 0, width, height },
      cropBox: { coordinateSpace: 'pdf-default-user-space', x: 0, y: 0, width, height },
      bleedBox: null, trimBox: null, artBox: null,
    },
    userUnit: 1,
    userUnitProvenance: 'pdf-default',
    intrinsicRotationDegrees: 0,
    applicationRotationDegrees: 0,
    requestedDpi: 72,
    sourceRaster: result.sourceRaster,
    annotationsExcluded: true,
    formsExcluded: true,
  });
  return { result, pageGeometry };
}

async function applyOwnedResult(doc, pageNum, lines, force = false) {
  const attempt = await beginOcrPageAttempt(doc, pageNum, { force });
  if (attempt.skipped) return { attempt, applied: null };
  const fixture = fixtureFor(doc, attempt.token, pageNum, lines);
  return {
    attempt,
    applied: applyOcrPageResult(doc, { ...fixture, token: attempt.token }),
  };
}

async function loadPdf({ pageCount = 1, nativeText = false } = {}) {
  const source = await PDFDocument.create();
  const font = nativeText ? await source.embedFont(StandardFonts.Helvetica) : null;
  for (let index = 0; index < pageCount; index += 1) {
    const page = source.addPage([612, 792]);
    if (nativeText && index === 0) {
      page.drawText('Meaningful native contract text', { x: 40, y: 720, size: 16, font });
    }
  }
  const bytes = await source.save({ useObjectStreams: false });
  return pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
}

function activateDocument(doc) {
  const index = state.documents.indexOf(doc);
  if (index === -1) {
    state.documents = [...state.documents, doc];
    state.activeDocumentIndex = state.documents.length - 1;
  } else {
    state.activeDocumentIndex = index;
  }
  state.currentTool = 'select';
}

async function renderLayer(doc, pageNum, scale, rotation, container) {
  const page = await doc.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale, rotation });
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;
  return createTextLayer(page, viewport, container, pageNum);
}

async function renderContinuousLayers(doc, scale = 1, pageOneRotation = 0) {
  clearTextLayers();
  root.replaceChildren();
  root.id = 'continuous-container';
  doc.viewMode = 'continuous';
  for (let pageNum = 1; pageNum <= doc.pdfDoc.numPages; pageNum += 1) {
    const wrapper = document.createElement('section');
    wrapper.className = 'page-wrapper';
    wrapper.dataset.page = String(pageNum);
    root.appendChild(wrapper);
    await renderLayer(doc, pageNum, scale, pageNum === 1 ? pageOneRotation : 0, wrapper);
  }
}

async function renderSingleLayer(doc, scale = 1, rotation = 0) {
  clearTextLayers();
  root.replaceChildren();
  root.id = 'test-root';
  doc.viewMode = 'single';
  doc.currentPage = 1;
  const container = document.createElement('section');
  container.id = 'canvas-container';
  root.appendChild(container);
  return renderLayer(doc, 1, scale, rotation, container);
}

function ocrSpans(layer) {
  return [...layer.querySelectorAll('span[data-ocr-owner="open-pdf-studio"]')];
}

async function cacheInvalidationProbe() {
  const counters = new Map();
  const pdfDoc = {
    numPages: 2,
    async getPage(pageNum) {
      return {
        async getTextContent() {
          counters.set(pageNum, (counters.get(pageNum) || 0) + 1);
          return { items: [], styles: {} };
        },
      };
    },
  };
  const doc = createDocument(null);
  doc.pdfDoc = pdfDoc;
  await extractPageText(pdfDoc, 1, doc);
  await extractPageText(pdfDoc, 2, doc);
  await applyOwnedResult(doc, 1, [
    { id: 'cache-line', text: 'Cache changed', x: 30, y: 50, width: 120, height: 14 },
  ]);
  await extractPageText(pdfDoc, 2, doc);
  await extractPageText(pdfDoc, 1, doc);
  invalidateTextCache(doc.id);
  return [counters.get(1), counters.get(2)];
}

async function run() {
  const blankPdf = await loadPdf({ pageCount: 2 });
  mainDocument = createDocument(null);
  mainDocument.pdfDoc = blankPdf;
  state.documents = [mainDocument];
  state.activeDocumentIndex = 0;
  state.currentTool = 'select';

  const pageOneLines = [
    { id: 'left-1', text: 'Left one', x: 40, y: 50, width: 100, height: 16 },
    { id: 'left-2', text: 'Left two', x: 40, y: 82, width: 100, height: 16 },
    { id: 'right-1', text: 'Right one', x: 330, y: 50, width: 110, height: 16 },
    { id: 'right-2', text: 'Right two', x: 330, y: 82, width: 110, height: 16 },
  ];
  await applyOwnedResult(mainDocument, 1, pageOneLines);
  await applyOwnedResult(mainDocument, 2, [
    { id: 'page-2-line', text: 'Second page unsaved OCR', x: 50, y: 60, width: 200, height: 16 },
  ]);
  markDocumentSaved();
  const pdfSavePreservedOcrDirty = mainDocument.modified && mainDocument.ocr.dirty;
  mainDocument.textEdits.push({
    id: 'application-text-1', page: 2, originalText: '', newText: 'Application added text',
    pdfX: 40, pdfY: 700, pdfWidth: 128, fontSize: 12, spans: [], original: null,
  });

  await renderContinuousLayers(mainDocument, 1, 0);
  const continuousPageCount = root.querySelectorAll('.page-wrapper').length;
  const baseLayer = root.querySelector('.page-wrapper[data-page="1"] .textLayer');
  const baseSpans = ocrSpans(baseLayer);
  const baseIds = baseSpans.map((span) => span.id);
  const baseFontSize = parseFloat(baseSpans[0].style.fontSize);
  const baseTransform = baseSpans[0].style.transform;
  const baseOrder = baseSpans.map((span) => span.textContent);
  const baseAccessibleAndTransparent = baseSpans.every((span) =>
    span.getAttribute('aria-label') === span.textContent &&
    getComputedStyle(span).color === 'rgba(0, 0, 0, 0)');

  const searchResults = await performSearch('Right one');
  const applicationResults = await performSearch('Application added text');
  state.search.results = searchResults;
  state.search.currentIndex = 0;
  state.search.highlightAll = true;
  state.search.isOpen = true;
  const ocrReplaceBlocked = await replaceCurrentMatch('must-not-write-pdf');
  highlightResults();
  const polygonHighlight = baseLayer.querySelector('.search-highlight[data-ocr-line-id="right-1"]');

  await renderContinuousLayers(mainDocument, 2, 0);
  const zoomLayer = root.querySelector('.page-wrapper[data-page="1"] .textLayer');
  const zoomSpans = ocrSpans(zoomLayer);
  const zoomFontSize = parseFloat(zoomSpans[0].style.fontSize);

  await renderContinuousLayers(mainDocument, 1, 90);
  const rotationLayer = root.querySelector('.page-wrapper[data-page="1"] .textLayer');
  const rotationSpans = ocrSpans(rotationLayer);

  const firstSingleLayer = await renderSingleLayer(mainDocument, 1, 0);
  const beforeRerenderIds = ocrSpans(firstSingleLayer).map((span) => span.id);
  clearSinglePageTextLayer();
  const rerenderedLayer = await renderLayer(
    mainDocument,
    1,
    1,
    0,
    document.getElementById('canvas-container'),
  );
  const afterRerenderIds = ocrSpans(rerenderedLayer).map((span) => span.id);
  acceptOcrLineCorrection(mainDocument, 1, 'right-2', 'Right two reviewed');
  const correctionVisible = ocrSpans(rerenderedLayer)
    .some((span) => span.textContent === 'Right two reviewed');
  const engineResultUnchanged = mainDocument.ocr.pages[1].recognition.result.lines
    .find((line) => line.id === 'right-2').text === 'Right two';

  const unknownSpan = document.createElement('span');
  unknownSpan.dataset.ocrOwner = 'third-party';
  unknownSpan.textContent = 'Unknown third-party text';
  rerenderedLayer.appendChild(unknownSpan);
  const replacementLines = pageOneLines.map((line) => ({
    ...line,
    text: line.id === 'right-1' ? 'Right one corrected rerun' : line.text,
  }));
  const forced = await applyOwnedResult(mainDocument, 1, replacementLines, true);
  const forceText = ocrSpans(rerenderedLayer).map((span) => span.textContent);
  const unknownSurvivedForce = rerenderedLayer.contains(unknownSpan);

  const cacheCounts = await cacheInvalidationProbe();

  const nativePdf = await loadPdf({ nativeText: true });
  const nativeDocument = createDocument(null);
  nativeDocument.pdfDoc = nativePdf;
  activateDocument(nativeDocument);
  const nativeLayer = await renderSingleLayer(nativeDocument, 1, 0);
  const defaultNativeAttempt = await beginOcrPageAttempt(nativeDocument, 1);
  const nativeForced = await applyOwnedResult(nativeDocument, 1, [
    { id: 'forced-native-line', text: 'Forced OCR must stay suppressed', x: 40, y: 50, width: 220, height: 16 },
  ], true);
  const vendorNode = document.createElement('span');
  vendorNode.dataset.ocrOwner = 'third-party';
  vendorNode.textContent = 'Vendor text node';
  nativeLayer.appendChild(vendorNode);
  injectPendingOcrTextSpans(nativeLayer, 1);
  const forcedOcrSearch = await performSearch('Forced OCR must stay suppressed');
  const nativeSearch = await performSearch('Meaningful native contract text');

  activateDocument(mainDocument);
  recordOcrExistingTextAssessment(mainDocument, 1, assessMeaningfulPdfText([]));
  const finalLayer = await renderSingleLayer(mainDocument, 1, 0);

  return {
    searchBeforeSave: searchResults.length === 1 && searchResults[0].items[0].source === 'ocr',
    ocrReplaceBlocked: ocrReplaceBlocked === null,
    applicationTextMerged: applicationResults.length === 1,
    geometryHighlight: !!polygonHighlight && polygonHighlight.style.clipPath.startsWith('polygon('),
    accessibleAndTransparent: baseAccessibleAndTransparent,
    baseOrder,
    continuousPages: continuousPageCount,
    zoomRatio: zoomFontSize / baseFontSize,
    zoomStableIds: JSON.stringify(zoomSpans.map((span) => span.id)) === JSON.stringify(baseIds),
    rotationStableIds: JSON.stringify(rotationSpans.map((span) => span.id)) === JSON.stringify(baseIds),
    rotationChangedTransform: rotationSpans[0].style.transform !== baseTransform,
    rerenderStableIds: JSON.stringify(beforeRerenderIds) === JSON.stringify(afterRerenderIds),
    rerenderOwnedCount: afterRerenderIds.length,
    correctionVisible,
    engineResultUnchanged,
    forceApplied: forced.applied?.applied === true,
    forceText,
    unknownSurvivedForce,
    cacheCounts,
    nativeDefaultSkipped: defaultNativeAttempt.skipped && defaultNativeAttempt.reason === 'meaningful-existing-text',
    nativeForceApplied: nativeForced.applied?.applied === true,
    nativeOcrSpanCount: ocrSpans(nativeLayer).length,
    nativeSpanCount: nativeLayer.querySelectorAll('span:not([data-ocr-owner])').length,
    vendorNodeSurvived: nativeLayer.contains(vendorNode),
    forcedOcrSearchCount: forcedOcrSearch.length,
    nativeSearchCount: nativeSearch.length,
    dirtyWithoutPdfWrite: mainDocument.ocr.dirty && mainDocument.modified,
    pdfSavePreservedOcrDirty,
    ocrOutsideTextEdits: !mainDocument.textEdits.some((edit) => Object.hasOwn(edit, 'ocr')),
    finalOwnedCount: ocrSpans(finalLayer).length,
  };
}

function selectPendingOcr() {
  const layer = document.querySelector('#canvas-container .textLayer');
  const spans = ocrSpans(layer);
  const selection = window.getSelection();
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStartBefore(spans[0]);
  range.setEndAfter(spans[spans.length - 1]);
  selection.addRange(range);
  return selection.toString();
}

window.__ocrHarness = { run, selectPendingOcr };
window.__ocrHarnessReady = true;
