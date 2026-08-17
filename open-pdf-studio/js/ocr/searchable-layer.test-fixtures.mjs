import { readFile } from 'node:fs/promises';

import {
  OCR_ENGINE_CONTRACT,
  OCR_RESULT_CONTRACT,
  createOcrPageGeometryV1,
  migrateOcrResultToCurrent,
} from './contracts/production.js';

const modelPack = JSON.parse(await readFile(
  new URL('../../public/ocr/pp-ocrv6-small/manifest.json', import.meta.url),
  'utf8',
));

export function hash(character) {
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
      family: 'PP-OCRv6',
      tier: 'small',
      detection: 'PP-OCRv6_small_det_onnx',
      recognition: 'PP-OCRv6_small_rec_onnx',
    },
    runtime: {
      name: 'onnxruntime-web',
      version: '1.27.0',
      executionProvider: 'wasm',
      offline: true,
    },
    capabilities: {
      textDetection: true,
      textRecognition: true,
      wordBoxes: false,
      pdfWriting: false,
    },
  };
}

export function makeOcrFixture({
  documentId,
  documentGeneration,
  pageId,
  pageRevision,
  pageIndex = 0,
  pageCount = 1,
  lines = [
    { id: 'line-1', text: 'First searchable line', x: 36, y: 48, width: 180, height: 16 },
    { id: 'line-2', text: 'Second searchable line', x: 36, y: 76, width: 200, height: 16 },
  ],
  width = 612,
  height = 792,
  requestId = `request-${pageRevision}`,
} = {}) {
  const v1 = {
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: 1,
    requestId,
    engine: phaseAEngine(),
    source: {
      kind: 'pdf-page',
      path: '/test-only-fixture.pdf',
      pageIndex,
      widthPx: width,
      heightPx: height,
      scale: 1,
    },
    text: lines.map((line) => line.text).filter(Boolean).join('\n'),
    lines: lines.map((line) => ({
      id: line.id,
      text: line.text,
      confidence: line.confidence ?? 0.94,
      boundingBox: { x: line.x, y: line.y, width: line.width, height: line.height },
      polygon: [
        [line.x, line.y],
        [line.x + line.width, line.y],
        [line.x + line.width, line.y + line.height],
        [line.x, line.y + line.height],
      ],
    })),
    metrics: {
      workerStartupMs: 1,
      modelStartupMs: 1,
      rasterMs: 1,
      detectionMs: 1,
      recognitionMs: 1,
      totalOcrMs: 5,
    },
    warnings: [],
  };
  const result = migrateOcrResultToCurrent(v1, {
    modelPack,
    documentId,
    documentFingerprint: hash('a'),
    documentRevision: 0,
    documentGeneration,
    documentPageCount: pageCount,
    pageId,
    pageRevision,
    sourceRasterId: `raster-${pageIndex + 1}-${pageRevision}`,
    sourceRasterFingerprint: hash('b'),
    rasterDpi: 72,
    recognitionConfigurationHash: hash('c'),
    requestId,
    jobId: `job-${pageIndex + 1}-${pageRevision}`,
  });
  const pageGeometry = createOcrPageGeometryV1({
    geometryId: `geometry-${pageIndex + 1}-${pageRevision}`,
    document: result.document,
    page: {
      id: result.page.id,
      index: result.page.index,
      revision: result.page.revision,
    },
    boxes: {
      mediaBox: { coordinateSpace: 'pdf-default-user-space', x: 0, y: 0, width, height },
      cropBox: { coordinateSpace: 'pdf-default-user-space', x: 0, y: 0, width, height },
      bleedBox: null,
      trimBox: null,
      artBox: null,
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

export function fakePdfDocument(pageTextItems, counters = new Map()) {
  const pages = Array.isArray(pageTextItems[0]) ? pageTextItems : [pageTextItems];
  return {
    numPages: pages.length,
    async getPage(pageNum) {
      return {
        async getTextContent() {
          counters.set(pageNum, (counters.get(pageNum) || 0) + 1);
          return { items: pages[pageNum - 1] || [], styles: {} };
        },
      };
    },
  };
}
