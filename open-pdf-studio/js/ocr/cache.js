// @ts-check

import { invoke } from '../core/platform.js';
import { assertOcrPageGeometryV1 } from './contracts/page-geometry.v1.js';
import { validateOcrModelPackIdentity } from './contracts/model-pack.v1.js';
import { assertOcrResultV2 } from './contracts/v2.js';

export const OCR_CACHE_FORMAT_VERSION = 1;
export const OCR_GEOMETRY_PREPROCESSING_VERSION = 'ocr-geometry-preprocessing-v1';
export const DEFAULT_OCR_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const MIN_OCR_CACHE_MAX_BYTES = 1024;
const MAX_OCR_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const registeredDocumentCachePages = new Map();

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertFingerprint(value, name) {
  if (!value || value.algorithm !== 'sha256' ||
      typeof value.value !== 'string' || !/^[0-9a-f]{64}$/.test(value.value)) {
    throw new TypeError(`${name} must be a SHA-256 fingerprint`);
  }
  return value;
}

export function assertOcrCacheKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('OCR cache key must be an object');
  }
  const keys = [
    'documentFingerprint', 'pageIdentity', 'pageRevision', 'modelPackIdentity',
    'recognitionConfigurationHash', 'geometryPreprocessingVersion',
  ];
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new TypeError('OCR cache key has unsupported fields');
  }
  assertFingerprint(value.documentFingerprint, 'documentFingerprint');
  assertFingerprint(value.recognitionConfigurationHash, 'recognitionConfigurationHash');
  if (typeof value.pageIdentity !== 'string' || !IDENTIFIER.test(value.pageIdentity)) {
    throw new TypeError('pageIdentity must be an OCR identifier');
  }
  if (!Number.isSafeInteger(value.pageRevision) || value.pageRevision < 0) {
    throw new TypeError('pageRevision must be a non-negative integer');
  }
  const model = validateOcrModelPackIdentity(value.modelPackIdentity, 'modelPackIdentity');
  if (!model.ok) throw new TypeError(`modelPackIdentity is invalid: ${model.issues.join(', ')}`);
  if (typeof value.geometryPreprocessingVersion !== 'string' ||
      !IDENTIFIER.test(value.geometryPreprocessingVersion)) {
    throw new TypeError('geometryPreprocessingVersion must be an OCR identifier');
  }
  return value;
}

export function createOcrCacheKey({
  documentFingerprint,
  pageIdentity,
  pageRevision,
  modelPackIdentity,
  recognitionConfigurationHash,
  geometryPreprocessingVersion = OCR_GEOMETRY_PREPROCESSING_VERSION,
}) {
  return assertOcrCacheKey({
    documentFingerprint: structuredClone(documentFingerprint),
    pageIdentity,
    pageRevision,
    modelPackIdentity: structuredClone(modelPackIdentity),
    recognitionConfigurationHash: structuredClone(recognitionConfigurationHash),
    geometryPreprocessingVersion,
  });
}

export function createOcrCacheKeyFromRequest(request, options = {}) {
  return createOcrCacheKey({
    documentFingerprint: request.document.fingerprint,
    pageIdentity: request.page.id,
    pageRevision: request.page.revision,
    modelPackIdentity: request.modelPack,
    recognitionConfigurationHash: request.recognitionConfigurationHash,
    geometryPreprocessingVersion: options.geometryPreprocessingVersion,
  });
}

function assertResultGeometryIdentity(result, geometry) {
  for (const key of ['id', 'fingerprint', 'revision', 'generation', 'pageCount']) {
    if (!sameJson(result.document[key], geometry.document[key])) {
      throw new TypeError(`cached OCR document identity mismatch at ${key}`);
    }
  }
  for (const key of ['id', 'index', 'revision']) {
    if (!sameJson(result.page[key], geometry.page[key])) {
      throw new TypeError(`cached OCR page identity mismatch at ${key}`);
    }
  }
  for (const key of ['id', 'fingerprint', 'coordinateSpace', 'widthPx', 'heightPx', 'dpi']) {
    if (!sameJson(result.sourceRaster[key], geometry.sourceRaster[key])) {
      throw new TypeError(`cached OCR raster identity mismatch at ${key}`);
    }
  }
}

export function assertOcrCacheEnvelope(value, expectedKey = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('OCR cache payload must be an object');
  }
  const keys = ['cacheFormatVersion', 'cachedAt', 'key', 'result', 'pageGeometry', 'state'];
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new TypeError('OCR cache payload has unsupported fields');
  }
  if (value.cacheFormatVersion !== OCR_CACHE_FORMAT_VERSION) {
    throw new TypeError('OCR cache payload version is unsupported');
  }
  if (!Number.isFinite(Date.parse(value.cachedAt))) throw new TypeError('OCR cache timestamp is invalid');
  const key = assertOcrCacheKey(value.key);
  if (expectedKey && !sameJson(key, expectedKey)) throw new TypeError('OCR cache payload key mismatch');
  const result = assertOcrResultV2(value.result);
  const pageGeometry = assertOcrPageGeometryV1(value.pageGeometry);
  if (!['completed', 'partial', 'unsupported'].includes(result.page.status)) {
    throw new TypeError('OCR cache stores only validated successful or unsupported results');
  }
  assertResultGeometryIdentity(result, pageGeometry);
  if (!sameJson(result.document.fingerprint, key.documentFingerprint)) {
    throw new TypeError('OCR cache payload document fingerprint does not match its cache key');
  }
  if (result.page.id !== key.pageIdentity) {
    throw new TypeError('OCR cache payload page identity does not match its cache key');
  }
  if (result.page.revision !== key.pageRevision) {
    throw new TypeError('OCR cache payload page revision does not match its cache key');
  }
  if (!sameJson(result.engine.modelPack, key.modelPackIdentity)) {
    throw new TypeError('OCR cache payload model pack does not match its cache key');
  }
  if (!sameJson(result.recognitionConfigurationHash, key.recognitionConfigurationHash)) {
    throw new TypeError('OCR cache payload recognition configuration does not match its cache key');
  }
  if (!value.state || typeof value.state !== 'object' || Array.isArray(value.state) ||
      Object.keys(value.state).sort().join('\0') !== ['applicationStatus', 'source'].sort().join('\0') ||
      !['completed', 'unsupported'].includes(value.state.applicationStatus) ||
      value.state.source !== 'validated-result') {
    throw new TypeError('OCR cache application state is invalid');
  }
  if (value.state.applicationStatus !==
      (result.page.status === 'unsupported' ? 'unsupported' : 'completed')) {
    throw new TypeError('OCR cache application state does not match the result');
  }
  return value;
}

export function createOcrCacheEnvelope(key, result, pageGeometry) {
  assertOcrCacheKey(key);
  const envelope = {
    cacheFormatVersion: OCR_CACHE_FORMAT_VERSION,
    cachedAt: new Date().toISOString(),
    key: structuredClone(key),
    result: structuredClone(assertOcrResultV2(result)),
    pageGeometry: structuredClone(assertOcrPageGeometryV1(pageGeometry)),
    state: {
      applicationStatus: result.page.status === 'unsupported' ? 'unsupported' : 'completed',
      source: 'validated-result',
    },
  };
  return assertOcrCacheEnvelope(envelope, key);
}

/** Rebind only volatile job/document identities; recognized text and geometry are unchanged. */
export function rebindCachedOcrEnvelope(envelope, request, token) {
  const cached = assertOcrCacheEnvelope(envelope);
  if (!sameJson(cached.key.documentFingerprint, request.document.fingerprint) ||
      cached.key.pageIdentity !== request.page.id ||
      cached.key.pageRevision !== request.page.revision ||
      !sameJson(cached.key.modelPackIdentity, request.modelPack) ||
      !sameJson(cached.key.recognitionConfigurationHash, request.recognitionConfigurationHash) ||
      token.documentId !== request.document.id || token.documentGeneration !== request.document.generation ||
      token.pageId !== request.page.id || token.pageRevision !== request.page.revision) {
    throw new TypeError('Cached OCR cannot be rebound to a different page job');
  }
  const result = structuredClone(cached.result);
  const pageGeometry = structuredClone(cached.pageGeometry);
  result.jobId = request.jobId;
  result.requestId = request.requestId;
  result.document = structuredClone(request.document);
  result.page.id = request.page.id;
  result.page.index = request.page.index;
  result.page.revision = request.page.revision;
  result.sourceRaster.id = request.page.sourceRasterId;
  pageGeometry.geometryId = `cache-${request.jobId}`;
  pageGeometry.document = structuredClone(request.document);
  pageGeometry.page = {
    id: request.page.id,
    index: request.page.index,
    revision: request.page.revision,
  };
  pageGeometry.sourceRaster.id = request.page.sourceRasterId;
  assertOcrResultV2(result);
  assertOcrPageGeometryV1(pageGeometry);
  assertResultGeometryIdentity(result, pageGeometry);
  return { result, pageGeometry, cacheState: structuredClone(cached.state) };
}

function rememberCachePage(documentId, key) {
  if (typeof documentId !== 'string') return;
  let context = registeredDocumentCachePages.get(documentId);
  if (!context || !sameJson(context.documentFingerprint, key.documentFingerprint)) {
    context = { documentFingerprint: structuredClone(key.documentFingerprint), pageIdentities: new Set() };
    registeredDocumentCachePages.set(documentId, context);
  }
  context.pageIdentities.add(key.pageIdentity);
}

export class OcrResultCache {
  constructor({
    maximumBytes = DEFAULT_OCR_CACHE_MAX_BYTES,
    invokeCommand = invoke,
  } = {}) {
    if (!Number.isSafeInteger(maximumBytes) ||
        maximumBytes < MIN_OCR_CACHE_MAX_BYTES || maximumBytes > MAX_OCR_CACHE_MAX_BYTES) {
      throw new RangeError('OCR cache maximumBytes is outside the supported range');
    }
    if (typeof invokeCommand !== 'function') throw new TypeError('OCR cache requires an invoke function');
    this.maximumBytes = maximumBytes;
    this.invokeCommand = invokeCommand;
  }

  async get(key, { documentId = null } = {}) {
    const validatedKey = assertOcrCacheKey(key);
    rememberCachePage(documentId, validatedKey);
    const response = await this.invokeCommand('ocr_cache_get', { key: validatedKey });
    if (!response || response.status === 'miss') return { status: 'miss', envelope: null, reason: null };
    if (response.status === 'rejected') {
      return { status: 'rejected', envelope: null, reason: response.reason ?? 'corrupt' };
    }
    if (response.status !== 'hit' || typeof response.payload !== 'string') {
      return { status: 'rejected', envelope: null, reason: 'protocol' };
    }
    try {
      const envelope = assertOcrCacheEnvelope(JSON.parse(response.payload), validatedKey);
      return { status: 'hit', envelope, reason: null };
    } catch {
      await this.invalidatePage(validatedKey.documentFingerprint, validatedKey.pageIdentity);
      return { status: 'rejected', envelope: null, reason: 'corrupt' };
    }
  }

  async put(key, result, pageGeometry, { documentId = null } = {}) {
    const validatedKey = assertOcrCacheKey(key);
    rememberCachePage(documentId, validatedKey);
    const envelope = createOcrCacheEnvelope(validatedKey, result, pageGeometry);
    return this.invokeCommand('ocr_cache_put', {
      key: validatedKey,
      payload: JSON.stringify(envelope),
      maximumBytes: this.maximumBytes,
    });
  }

  async invalidatePage(documentFingerprint, pageIdentity) {
    assertFingerprint(documentFingerprint, 'documentFingerprint');
    if (typeof pageIdentity !== 'string' || !IDENTIFIER.test(pageIdentity)) {
      throw new TypeError('pageIdentity must be an OCR identifier');
    }
    const result = await this.invokeCommand('ocr_cache_invalidate_page', { documentFingerprint, pageIdentity });
    for (const context of registeredDocumentCachePages.values()) {
      if (sameJson(context.documentFingerprint, documentFingerprint)) {
        context.pageIdentities.delete(pageIdentity);
      }
    }
    return result;
  }

  async clear() {
    const result = await this.invokeCommand('ocr_cache_clear');
    registeredDocumentCachePages.clear();
    return result;
  }
}

let defaultCache = null;

export function getDefaultOcrResultCache() {
  if (!defaultCache) defaultCache = new OcrResultCache();
  return defaultCache;
}

export async function fingerprintOcrDocument(path, invokeCommand = invoke) {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('OCR document path is required');
  return assertFingerprint(await invokeCommand('ocr_document_fingerprint', { path }), 'documentFingerprint');
}

export async function invalidateRegisteredDocumentOcrCache(documentId, cache = getDefaultOcrResultCache()) {
  const context = registeredDocumentCachePages.get(documentId);
  if (!context) return [];
  registeredDocumentCachePages.delete(documentId);
  return Promise.all([...context.pageIdentities].map((pageIdentity) =>
    cache.invalidatePage(context.documentFingerprint, pageIdentity)));
}

export function forgetRegisteredDocumentOcrCache(documentId) {
  registeredDocumentCachePages.delete(documentId);
}
