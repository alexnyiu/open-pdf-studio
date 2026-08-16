import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PaddleOcrV6SmallAdapter,
  createSameOriginFetch,
  createSameOriginAssetLoader,
  createPaddleOcrEngineDescriptor,
  decodeCtc,
  detectionMapToLineBoxes,
  prepareDetectionTensor,
} from './adapter.js';

class Tensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

test('PP-OCRv6 detection preprocessing produces BGR NCHW float data', () => {
  const image = { width: 32, height: 32, rgba: new Uint8Array(32 * 32 * 4).fill(255) };
  const prepared = prepareDetectionTensor({ Tensor }, image);
  assert.deepEqual(prepared.tensor.dims, [1, 3, 32, 32]);
  assert.equal(prepared.tensor.type, 'float32');
  assert.ok(prepared.tensor.data.every(Number.isFinite));
});

test('Phase A DB postprocessor groups horizontally separated components into one line', () => {
  const width = 16;
  const height = 8;
  const data = new Float32Array(width * height);
  for (let y = 2; y <= 4; y += 1) {
    for (let x = 1; x <= 4; x += 1) data[y * width + x] = 0.9;
    for (let x = 8; x <= 13; x += 1) data[y * width + x] = 0.8;
  }
  const boxes = detectionMapToLineBoxes({ data, dims: [1, 1, height, width] }, 160, 80);
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].width > 100);
  assert.ok(boxes[0].detectionConfidence > 0.8);
});

test('CTC decoder removes blank and repeated classes', () => {
  const characters = ['blank', 'A', 'B', ' '];
  const classes = characters.length;
  const picks = [1, 1, 0, 2, 3];
  const data = new Float32Array(picks.length * classes);
  picks.forEach((pick, step) => { data[step * classes + pick] = 0.9; });
  const [decoded] = decodeCtc({ data, dims: [1, picks.length, classes] }, characters);
  assert.equal(decoded.text, 'AB ');
  assert.ok(decoded.confidence > 0.89);
});

test('PaddleOCR engine descriptor is offline and cannot write PDFs', () => {
  const engine = createPaddleOcrEngineDescriptor();
  assert.equal(engine.runtime.offline, true);
  assert.equal(engine.capabilities.pdfWriting, false);
});

test('offline asset loader permits local assets and rejects external origins', async () => {
  const fetched = [];
  const loader = createSameOriginAssetLoader('http://127.0.0.1:1420/app', async (url) => {
    fetched.push(url);
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
  });
  await loader('/ocr/model.onnx');
  assert.deepEqual(fetched, ['http://127.0.0.1:1420/ocr/model.onnx']);
  await assert.rejects(loader('https://example.com/model.onnx'), /blocked a non-local asset URL/);
});

test('offline fetch guard covers every request and handles Tauri opaque origins safely', async () => {
  const audit = [];
  const fetched = [];
  const guardedFetch = createSameOriginFetch(
    'tauri://localhost/ocr/worker.js',
    async (url, init) => {
      fetched.push({ url, init });
      return { ok: true };
    },
    (entry) => audit.push(entry),
  );

  await guardedFetch('/ocr/model.onnx', { cache: 'no-store' });
  assert.deepEqual(fetched, [{
    url: 'tauri://localhost/ocr/model.onnx',
    init: { cache: 'no-store' },
  }]);
  await assert.rejects(
    guardedFetch('https://example.com/model.onnx'),
    (error) => error.code === 'OCR_OFFLINE_NETWORK_BLOCKED',
  );
  await assert.rejects(
    guardedFetch('file:///tmp/model.onnx'),
    /blocked a non-local asset URL/,
  );
  assert.deepEqual(audit.map((entry) => entry.allowed), [true, false, false]);
  assert.deepEqual(audit.map((entry) => entry.requestedOrigin), [
    'tauri://localhost',
    'https://example.com',
    'file://',
  ]);
});

test('adapter disposal releases both ONNX sessions and drops model references', async () => {
  const released = [];
  const lifecycle = [];
  const manifest = JSON.parse(await readFile(
    new URL('../../../public/ocr/pp-ocrv6-small/manifest.json', import.meta.url),
    'utf8',
  ));
  const adapter = new PaddleOcrV6SmallAdapter({
    ort: { InferenceSession: {}, Tensor },
    manifest,
    assetBaseUrl: 'http://127.0.0.1/ocr/',
    onLifecycle: (stage, detail) => lifecycle.push({ stage, detail }),
  });
  adapter.detector = { release: async () => released.push('detector') };
  adapter.recognizer = { release: async () => released.push('recognizer') };
  adapter.characters = ['blank'];

  await adapter.dispose();

  assert.deepEqual(released.sort(), ['detector', 'recognizer']);
  assert.equal(adapter.detector, null);
  assert.equal(adapter.recognizer, null);
  assert.equal(adapter.characters, null);
  assert.equal(adapter.ort, null);
  assert.equal(adapter.manifest, null);
  assert.equal(lifecycle[0].stage, 'immediately-before-adapter-disposal');
  assert.equal(lifecycle[1].stage, 'after-ocr-engine-disposal');
  assert.equal(lifecycle[1].detail.onnxSessionsReleased, true);
});
