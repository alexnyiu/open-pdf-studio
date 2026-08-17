import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OcrResultCache,
  OCR_GEOMETRY_PREPROCESSING_VERSION,
  assertOcrCacheEnvelope,
  createOcrCacheEnvelope,
  createOcrCacheKey,
  rebindCachedOcrEnvelope,
} from './cache.js';
import { makeOcrFixture } from './searchable-layer.test-fixtures.mjs';

function fixtureAndKey() {
  const fixture = makeOcrFixture({
    documentId: 'document-cache',
    documentGeneration: 'generation-cache',
    pageId: 'ocr-page-1',
    pageRevision: 4,
  });
  const key = createOcrCacheKey({
    documentFingerprint: fixture.result.document.fingerprint,
    pageIdentity: fixture.result.page.id,
    pageRevision: fixture.result.page.revision,
    modelPackIdentity: fixture.result.engine.modelPack,
    recognitionConfigurationHash: fixture.result.recognitionConfigurationHash,
  });
  return { fixture, key };
}

test('cache envelopes contain only validated OCR result/state and no raw raster bytes', () => {
  const { fixture, key } = fixtureAndKey();
  const envelope = createOcrCacheEnvelope(key, fixture.result, fixture.pageGeometry);
  const serialized = JSON.stringify(envelope);

  assert.equal(assertOcrCacheEnvelope(envelope, key), envelope);
  assert.equal(envelope.cacheFormatVersion, 1);
  assert.equal(key.geometryPreprocessingVersion, OCR_GEOMETRY_PREPROCESSING_VERSION);
  assert.equal(Object.hasOwn(envelope, 'raster'), false);
  assert.equal(serialized.includes('rgba'), false);
  assert.equal(serialized.includes('sourcePdfPath'), false);
  assert.equal(serialized.includes('/test-only-fixture.pdf'), false);
});

test('cache keys bind every document, page, model, configuration, and geometry identity', () => {
  const { key } = fixtureAndKey();

  assert.equal(key.documentFingerprint.value.length, 64);
  assert.equal(key.pageIdentity, 'ocr-page-1');
  assert.equal(key.pageRevision, 4);
  assert.equal(key.modelPackIdentity.packId, 'paddleocr-pp-ocrv6-small-macos');
  assert.equal(key.recognitionConfigurationHash.value.length, 64);
  assert.equal(key.geometryPreprocessingVersion, OCR_GEOMETRY_PREPROCESSING_VERSION);
});

test('cache hits rebind only volatile job identities and preserve recognized content', () => {
  const { fixture, key } = fixtureAndKey();
  const envelope = createOcrCacheEnvelope(key, fixture.result, fixture.pageGeometry);
  const request = {
    jobId: 'job-reopened',
    requestId: 'request-reopened',
    modelPack: structuredClone(key.modelPackIdentity),
    document: {
      ...structuredClone(fixture.result.document),
      id: 'document-reopened',
      generation: 'generation-reopened',
    },
    page: {
      id: key.pageIdentity,
      index: 0,
      revision: key.pageRevision,
      sourceRasterId: 'raster-reopened',
    },
    recognitionConfigurationHash: structuredClone(key.recognitionConfigurationHash),
  };
  const token = {
    documentId: request.document.id,
    documentGeneration: request.document.generation,
    pageId: request.page.id,
    pageNumber: 1,
    pageRevision: request.page.revision,
  };

  const rebound = rebindCachedOcrEnvelope(envelope, request, token);

  assert.equal(rebound.result.jobId, request.jobId);
  assert.equal(rebound.result.document.id, request.document.id);
  assert.equal(rebound.result.sourceRaster.id, request.page.sourceRasterId);
  assert.equal(rebound.result.text, fixture.result.text);
  assert.deepEqual(rebound.result.lines, fixture.result.lines);
});

test('JavaScript cache boundary invalidates corrupt entries and exposes safe clearing', async () => {
  const { fixture, key } = fixtureAndKey();
  const envelope = createOcrCacheEnvelope(key, fixture.result, fixture.pageGeometry);
  envelope.cacheFormatVersion = 99;
  const calls = [];
  const cache = new OcrResultCache({
    maximumBytes: 4096,
    invokeCommand: async (command, arguments_) => {
      calls.push({ command, arguments_ });
      if (command === 'ocr_cache_get') {
        return { status: 'hit', payload: JSON.stringify(envelope), reason: null };
      }
      return { removedEntries: 1, removedBytes: 10, totalBytes: 0 };
    },
  });

  const response = await cache.get(key, { documentId: 'document-cache' });
  await cache.clear();

  assert.deepEqual(response, { status: 'rejected', envelope: null, reason: 'corrupt' });
  assert.deepEqual(calls.map((call) => call.command), [
    'ocr_cache_get',
    'ocr_cache_invalidate_page',
    'ocr_cache_clear',
  ]);
  assert.deepEqual(calls[1].arguments_, {
    documentFingerprint: key.documentFingerprint,
    pageIdentity: key.pageIdentity,
  });
  assert.equal(calls[2].arguments_, undefined);
});

test('cache refuses terminal failed results', () => {
  const { fixture, key } = fixtureAndKey();
  const failed = structuredClone(fixture.result);
  failed.page.status = 'failed';
  failed.text = '';
  failed.lines = [];
  failed.detectedLanguages = [];

  assert.throws(
    () => createOcrCacheEnvelope(key, failed, fixture.pageGeometry),
    /stores only validated successful or unsupported results/,
  );
});
