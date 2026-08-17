import {
  OCR_ENGINE_CONTRACT,
  OCR_RESULT_CONTRACT,
  OCR_SCHEMA_VERSION,
  assertOcrEngineV1,
  toValidatedOcrResultJson,
} from './contracts/v1.js';
import {
  OCR_JOB_CONTRACT,
  OCR_JOB_SCHEMA_VERSION,
  assertOcrJobV1,
} from './contracts/job.v1.js';
import { assertOcrResultV2 } from './contracts/v2.js';
import { modelPackIdentity } from './contracts/model-pack.v1.js';
import {
  OCR_NATIVE_PAGE_REQUEST_CONTRACT,
  OCR_NATIVE_SCHEMA_VERSION,
  assertNativeOcrPageRequestV1,
} from './contracts/native-job.v1.js';

const MODEL_PACK_URL = '/ocr/pp-ocrv6-small/manifest.json';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
let bundledModelPackPromise = null;
let compatibilityJobSequence = 0;

async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error('WebCrypto SHA-256 is unavailable');
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fingerprint(value) {
  return { algorithm: 'sha256', value };
}

function nextCompatibilityId(prefix) {
  compatibilityJobSequence += 1;
  return `${prefix}-${Date.now()}-${compatibilityJobSequence}`;
}

async function loadBundledModelPack() {
  if (!bundledModelPackPromise) {
    bundledModelPackPromise = (async () => {
      const url = new URL(MODEL_PACK_URL, globalThis.location?.href ?? 'http://127.0.0.1/');
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Failed to load OCR manifest: HTTP ${response.status}`);
      return response.json();
    })();
  }
  return bundledModelPackPromise;
}

function legacyEngineFromProduction(engine) {
  return assertOcrEngineV1({
    contract: OCR_ENGINE_CONTRACT,
    schemaVersion: OCR_SCHEMA_VERSION,
    engineId: engine.engineId,
    adapterVersion: engine.adapterVersion,
    provider: engine.provider,
    model: structuredClone(engine.model),
    runtime: structuredClone(engine.runtime),
    capabilities: {
      textDetection: engine.capabilities.textDetection,
      textRecognition: engine.capabilities.textRecognition,
      wordBoxes: false,
      pdfWriting: false,
    },
  });
}

export async function createPhaseACompatibilityJob({
  image,
  source,
  modelPack = null,
}) {
  if (!image || !(image.rgba instanceof Uint8Array || image.rgba instanceof Uint8ClampedArray)) {
    throw new TypeError('OCR compatibility job requires an RGBA byte image');
  }
  if (!source || source.kind !== 'pdf-page' || typeof source.path !== 'string' || !source.path) {
    throw new TypeError('OCR compatibility job requires a PDF page source');
  }
  const pack = modelPack ?? await loadBundledModelPack();
  const rasterDigest = await sha256(image.rgba);
  const documentDigest = await sha256(`phase-a-evidence-document:${source.path}`);
  const configurationDigest = await sha256(JSON.stringify({
    pack: modelPackIdentity(pack),
    scale: source.scale,
    rasterDpi: source.scale * 72,
    includeWords: false,
    orientation: 'none',
    deskew: false,
    preprocessing: 'none',
  }));
  const suppliedJobId = typeof source.jobId === 'string' && IDENTIFIER.test(source.jobId)
    ? source.jobId
    : null;
  const jobId = suppliedJobId ?? `phase-a-job-${rasterDigest.slice(0, 32)}`;
  const requestDigest = await sha256(`${jobId}:${rasterDigest}:${source.pageIndex}`);
  const pixels = image.width * image.height;
  return assertOcrJobV1({
    contract: OCR_JOB_CONTRACT,
    schemaVersion: OCR_JOB_SCHEMA_VERSION,
    jobId,
    requestId: `phase-a-request-${requestDigest.slice(0, 32)}`,
    engineId: pack.engineCompatibility.engineId,
    modelPack: modelPackIdentity(pack),
    document: {
      id: `phase-a-document-${documentDigest.slice(0, 32)}`,
      fingerprint: fingerprint(documentDigest),
      revision: 0,
      generation: `phase-a-generation-${documentDigest.slice(0, 32)}`,
      pageCount: source.pageIndex + 1,
    },
    page: {
      id: `phase-a-page-${source.pageIndex}`,
      index: source.pageIndex,
      revision: 0,
      sourceRaster: {
        id: `phase-a-raster-${rasterDigest.slice(0, 32)}`,
        fingerprint: fingerprint(rasterDigest),
        coordinateSpace: 'source-raster-pixels',
        widthPx: image.width,
        heightPx: image.height,
        dpi: source.scale * 72,
      },
    },
    recognitionConfigurationHash: fingerprint(configurationDigest),
    recognitionOptions: {
      languagePolicy: { mode: 'automatic', languages: [], scripts: [] },
      includeWords: false,
      orientation: { mode: 'none', degrees: null },
      deskew: false,
      preprocessing: { mode: 'none', operations: [] },
      rasterDpi: source.scale * 72,
      maximumPixels: pixels,
      maximumSide: Math.max(image.width, image.height),
      timeoutMs: 30_000,
    },
    documentPolicy: {
      skipMeaningfulExistingText: false,
      forceRerun: true,
      replaceApplicationOwnedOcrOnly: true,
      keepCompletedPages: true,
    },
    scheduler: { priority: 'background', execution: 'one-page-child' },
    createdAt: new Date().toISOString(),
  });
}

/**
 * Evaluator-only adapter from the preserved Phase A call shape to the stable
 * native controller request. The local path is hashed here and is never added
 * to the request that crosses into the disposable child.
 */
export async function createPhaseACompatibilityNativeRequest({ source, modelPack = null }) {
  if (!source || source.kind !== 'pdf-page' || typeof source.path !== 'string' || !source.path) {
    throw new TypeError('OCR compatibility request requires a PDF page source');
  }
  if (!Number.isSafeInteger(source.pageIndex) || source.pageIndex < 0 ||
      !Number.isFinite(source.scale) || source.scale < 0.5 || source.scale > 4) {
    throw new TypeError('OCR compatibility request has invalid page raster settings');
  }
  const pack = modelPack ?? await loadBundledModelPack();
  const packIdentity = modelPackIdentity(pack);
  const documentDigest = await sha256(`phase-a-evidence-document:${source.path}`);
  const configurationDigest = await sha256(JSON.stringify({
    pack: packIdentity,
    scale: source.scale,
    rasterDpi: source.scale * 72,
    includeWords: false,
    orientation: 'none',
    deskew: false,
    preprocessing: 'none',
  }));
  const rasterIdentityDigest = await sha256(
    `${documentDigest}:${source.pageIndex}:${source.scale}:annotation-free`,
  );
  return assertNativeOcrPageRequestV1({
    contract: OCR_NATIVE_PAGE_REQUEST_CONTRACT,
    schemaVersion: OCR_NATIVE_SCHEMA_VERSION,
    jobId: nextCompatibilityId('phase-a-job'),
    requestId: nextCompatibilityId('phase-a-request'),
    engineId: pack.engineCompatibility.engineId,
    modelPack: packIdentity,
    document: {
      id: `phase-a-document-${documentDigest.slice(0, 32)}`,
      fingerprint: fingerprint(documentDigest),
      revision: 0,
      generation: `phase-a-generation-${documentDigest.slice(0, 32)}`,
      pageCount: source.pageIndex + 1,
    },
    page: {
      id: `phase-a-page-${source.pageIndex}`,
      index: source.pageIndex,
      revision: 0,
      sourceRasterId: `phase-a-raster-${rasterIdentityDigest.slice(0, 32)}`,
    },
    recognitionConfigurationHash: fingerprint(configurationDigest),
    recognitionOptions: {
      languagePolicy: { mode: 'automatic', languages: [], scripts: [] },
      includeWords: false,
      orientation: { mode: 'none', degrees: null },
      deskew: false,
      preprocessing: { mode: 'none', operations: [] },
      rasterDpi: source.scale * 72,
      maximumPixels: 16_000_000,
      maximumSide: 8192,
      timeoutMs: 30_000,
    },
    documentPolicy: {
      skipMeaningfulExistingText: false,
      forceRerun: true,
      replaceApplicationOwnedOcrOnly: true,
      keepCompletedPages: true,
    },
    scheduler: { priority: 'background', execution: 'one-page-child' },
    createdAt: new Date().toISOString(),
  });
}

export function toPhaseACompatibilityResult(result, source) {
  assertOcrResultV2(result);
  return toValidatedOcrResultJson({
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: OCR_SCHEMA_VERSION,
    requestId: result.requestId,
    engine: legacyEngineFromProduction(result.engine),
    source: {
      kind: 'pdf-page',
      path: source.path,
      pageIndex: source.pageIndex,
      widthPx: result.sourceRaster.widthPx,
      heightPx: result.sourceRaster.heightPx,
      scale: source.scale,
    },
    text: result.text,
    lines: result.lines.map((line) => ({
      id: line.id,
      text: line.text,
      confidence: line.confidence,
      boundingBox: {
        x: line.boundingBox.x,
        y: line.boundingBox.y,
        width: line.boundingBox.width,
        height: line.boundingBox.height,
      },
      polygon: line.polygon.points.map((point) => [...point]),
    })),
    metrics: structuredClone(result.metrics),
    warnings: result.warnings.map((warning) => warning.message),
  });
}

export function validatePhaseACompatibilityResult(result) {
  return toValidatedOcrResultJson(result);
}
