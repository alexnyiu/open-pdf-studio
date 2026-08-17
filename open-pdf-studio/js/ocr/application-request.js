// @ts-check

import { modelPackIdentity } from './contracts/model-pack.v1.js';
import { OCR_GEOMETRY_PREPROCESSING_VERSION } from './cache.js';
import { nativePageRequest } from './native-controller.js';

export const DEFAULT_OCR_RECOGNITION_OPTIONS = Object.freeze({
  languagePolicy: Object.freeze({ mode: 'automatic', languages: Object.freeze([]), scripts: Object.freeze([]) }),
  includeWords: false,
  orientation: Object.freeze({ mode: 'none', degrees: null }),
  deskew: false,
  preprocessing: Object.freeze({ mode: 'none', operations: Object.freeze([]) }),
  rasterDpi: 144,
  maximumPixels: 16_000_000,
  maximumSide: 8192,
  timeoutMs: 30_000,
});

let requestSequence = 0;

function clone(value) {
  return structuredClone(value);
}

function nextId(prefix) {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Fingerprint(value) {
  if (!globalThis.crypto?.subtle) throw new Error('WebCrypto SHA-256 is unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return {
    algorithm: 'sha256',
    value: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

export function normalizeOcrRecognitionOptions(options = {}) {
  const merged = {
    ...clone(DEFAULT_OCR_RECOGNITION_OPTIONS),
    ...clone(options),
    languagePolicy: { ...clone(DEFAULT_OCR_RECOGNITION_OPTIONS.languagePolicy), ...clone(options.languagePolicy ?? {}) },
    orientation: { ...clone(DEFAULT_OCR_RECOGNITION_OPTIONS.orientation), ...clone(options.orientation ?? {}) },
    preprocessing: { ...clone(DEFAULT_OCR_RECOGNITION_OPTIONS.preprocessing), ...clone(options.preprocessing ?? {}) },
  };
  if (merged.languagePolicy.mode !== 'automatic' || merged.languagePolicy.languages.length > 0 ||
      merged.languagePolicy.scripts.length > 0 || merged.includeWords !== false ||
      merged.orientation.mode !== 'none' || merged.orientation.degrees !== null ||
      merged.deskew !== false || merged.preprocessing.mode !== 'none' ||
      merged.preprocessing.operations.length > 0) {
    throw new TypeError('The installed core OCR model pack accepts only its fixed automatic configuration');
  }
  return merged;
}

/** Build a one-page native request without putting the parent PDF path in it. */
export async function createApplicationOcrPageRequest({
  document,
  token,
  pageNumber,
  documentFingerprint,
  modelPack,
  recognitionOptions = {},
  documentRevision = 0,
  force = false,
  keepCompletedPages = true,
}) {
  const options = normalizeOcrRecognitionOptions(recognitionOptions);
  const identity = modelPackIdentity(modelPack);
  const recognitionConfigurationHash = await sha256Fingerprint(canonicalJson({
    modelPack: identity,
    recognitionOptions: options,
    geometryPreprocessingVersion: OCR_GEOMETRY_PREPROCESSING_VERSION,
  }));
  requestSequence += 1;
  const suffix = `${Date.now()}-${requestSequence}`;
  return nativePageRequest({
    jobId: nextId(`ocr-job-${pageNumber}`),
    requestId: nextId(`ocr-request-${pageNumber}`),
    engineId: modelPack.engineCompatibility.engineId,
    modelPack: identity,
    document: {
      id: document.id,
      fingerprint: clone(documentFingerprint),
      revision: documentRevision,
      generation: token.documentGeneration,
      pageCount: document.pdfDoc.numPages,
    },
    page: {
      id: token.pageId,
      index: pageNumber - 1,
      revision: token.pageRevision,
      sourceRasterId: `ocr-raster-${pageNumber}-${suffix}`,
    },
    recognitionConfigurationHash,
    recognitionOptions: options,
    documentPolicy: {
      skipMeaningfulExistingText: !force,
      forceRerun: force,
      replaceApplicationOwnedOcrOnly: true,
      keepCompletedPages,
    },
    scheduler: { priority: 'background', execution: 'one-page-child' },
    createdAt: new Date().toISOString(),
  });
}
