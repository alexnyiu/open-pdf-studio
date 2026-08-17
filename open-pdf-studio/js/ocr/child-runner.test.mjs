import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeNativeOcrChildJob } from './child-runner.js';
import {
  OCR_NATIVE_JOB_CONTRACT,
  OCR_NATIVE_LIMITS,
  OCR_NATIVE_PAGE_REQUEST_CONTRACT,
  OCR_NATIVE_SCHEMA_VERSION,
  assertNativeOcrPageRequestV1,
  materializeNativeOcrJobV1,
} from './contracts/native-job.v1.js';

const sha = (character) => character.repeat(64);

function request() {
  return assertNativeOcrPageRequestV1({
    contract: OCR_NATIVE_PAGE_REQUEST_CONTRACT,
    schemaVersion: OCR_NATIVE_SCHEMA_VERSION,
    jobId: 'job-1',
    requestId: 'request-1',
    engineId: 'paddleocr-pp-ocrv6-small-onnx-wasm',
    modelPack: {
      contract: 'open-pdf-studio.ocr.model-pack',
      schemaVersion: 1,
      packId: 'paddleocr-pp-ocrv6-small-macos',
      packVersion: '1.0.0',
      assets: { detection: sha('a'), recognition: sha('b'), dictionary: sha('c') },
    },
    document: {
      id: 'document-1',
      fingerprint: { algorithm: 'sha256', value: sha('d') },
      revision: 2,
      generation: 'generation-3',
      pageCount: 1,
    },
    page: { id: 'page-1', index: 0, revision: 4, sourceRasterId: 'raster-1' },
    recognitionConfigurationHash: { algorithm: 'sha256', value: sha('e') },
    recognitionOptions: {
      languagePolicy: { mode: 'automatic', languages: [], scripts: [] },
      includeWords: false,
      orientation: { mode: 'none', degrees: null },
      deskew: false,
      preprocessing: { mode: 'none', operations: [] },
      rasterDpi: 144,
      maximumPixels: OCR_NATIVE_LIMITS.maxPixels,
      maximumSide: OCR_NATIVE_LIMITS.maxWidthPx,
      timeoutMs: 30_000,
    },
    documentPolicy: {
      skipMeaningfulExistingText: false,
      forceRerun: true,
      replaceApplicationOwnedOcrOnly: true,
      keepCompletedPages: true,
    },
    scheduler: { priority: 'background', execution: 'one-page-child' },
    createdAt: '2026-08-16T00:00:00.000Z',
  });
}

function metadata() {
  const jobRequest = request();
  const sourceRaster = {
    id: 'raster-1',
    fingerprint: { algorithm: 'sha256', value: sha('f') },
    coordinateSpace: 'source-raster-pixels',
    widthPx: 1,
    heightPx: 1,
    dpi: 144,
  };
  return {
    contract: OCR_NATIVE_JOB_CONTRACT,
    schemaVersion: OCR_NATIVE_SCHEMA_VERSION,
    job: materializeNativeOcrJobV1(jobRequest, sourceRaster),
    raster: { format: 'rgba8', widthPx: 1, heightPx: 1, rowBytes: 4, byteLength: 4 },
    rasterMs: 1.5,
    preprocessingRequest: { mode: 'none', operations: [] },
    limits: {
      maxWidthPx: OCR_NATIVE_LIMITS.maxWidthPx,
      maxHeightPx: OCR_NATIVE_LIMITS.maxHeightPx,
      maxPixels: OCR_NATIVE_LIMITS.maxPixels,
      maxMetadataBytes: OCR_NATIVE_LIMITS.maxMetadataBytes,
      maxRasterBytes: OCR_NATIVE_LIMITS.maxRasterBytes,
      maxResultBytes: OCR_NATIVE_LIMITS.maxResultBytes,
      timeoutMs: 30_000,
    },
    resultFile: { id: 'result-1' },
  };
}

function encodedJob(jobMetadata, rgba) {
  const header = new Uint8Array(12);
  header.set([79, 80, 83, 79, 67, 82, 50, 0]);
  const json = new TextEncoder().encode(JSON.stringify(jobMetadata));
  new DataView(header.buffer).setUint32(8, json.byteLength, true);
  const output = new Uint8Array(header.byteLength + json.byteLength + rgba.byteLength);
  output.set(header);
  output.set(json, header.byteLength);
  output.set(rgba, header.byteLength + json.byteLength);
  return output;
}

test('native child decoder validates the production envelope and owns exact RGBA bytes', () => {
  const payload = encodedJob(metadata(), new Uint8Array([1, 2, 3, 4]));
  const decoded = decodeNativeOcrChildJob(payload);
  assert.equal(decoded.job.jobId, 'job-1');
  assert.deepEqual([...decoded.image.rgba], [1, 2, 3, 4]);
  assert.equal(decoded.image.rgba.byteOffset, 0);
  assert.equal(decoded.image.rgba.byteLength, decoded.image.rgba.buffer.byteLength);
  assert.equal(JSON.stringify(decoded.metadata).includes('.pdf'), false);
});

test('native child decoder rejects truncated and dimension-mismatched buffers', () => {
  assert.throws(() => decodeNativeOcrChildJob(new Uint8Array(4)), /truncated/);
  const invalid = metadata();
  invalid.raster.widthPx = 2;
  const payload = encodedJob(invalid, new Uint8Array([1, 2, 3, 4]));
  assert.throws(() => decodeNativeOcrChildJob(payload), /validation failed|inconsistent/);
});

test('native request and child envelope reject source paths and unknown keys', () => {
  assert.throws(
    () => assertNativeOcrPageRequestV1({ ...request(), sourcePdfPath: '/private/input.pdf' }),
    /sourcePdfPath is not allowed/,
  );
  const invalid = metadata();
  invalid.job.source = { path: '/private/input.pdf' };
  assert.throws(
    () => decodeNativeOcrChildJob(encodedJob(invalid, new Uint8Array([1, 2, 3, 4]))),
    /source is not allowed/,
  );
});
