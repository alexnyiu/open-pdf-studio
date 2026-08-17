import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  OCR_JOB_CONTRACT,
  OCR_JOB_SCHEMA_VERSION,
} from './contracts/job.v1.js';
import { modelPackIdentity } from './contracts/model-pack.v1.js';
import {
  OCR_WORKER_MESSAGE_CONTRACT,
  OCR_WORKER_MESSAGE_SCHEMA_VERSION,
} from './contracts/worker-message.v1.js';
import {
  OCR_CURRENT_SCHEMA_VERSION,
  OCR_RESULT_CONTRACT,
  assertOcrResultV2,
} from './contracts/v2.js';
import { OcrCancelledError, OcrEngine } from './engine.js';
import {
  PaddleOcrV6SmallAdapter,
  createPaddleOcrEngineDescriptor,
} from './paddleocr/adapter.js';
import { createOcrWorkerRuntime } from './paddleocr/worker-runtime.js';

const manifest = JSON.parse(await readFile(
  new URL('../../public/ocr/pp-ocrv6-small/manifest.json', import.meta.url),
  'utf8',
));

function hash(character) {
  return { algorithm: 'sha256', value: character.repeat(64) };
}

function recognitionJob({
  requestId = 'request-1',
  jobId = 'job-1',
  width = 1,
  height = 1,
  pageRevision = 2,
} = {}) {
  return {
    contract: OCR_JOB_CONTRACT,
    schemaVersion: OCR_JOB_SCHEMA_VERSION,
    jobId,
    requestId,
    engineId: manifest.engineCompatibility.engineId,
    modelPack: modelPackIdentity(manifest),
    document: {
      id: 'document-1',
      fingerprint: hash('a'),
      revision: 4,
      generation: 'document-generation-4',
      pageCount: 3,
    },
    page: {
      id: 'page-1',
      index: 0,
      revision: pageRevision,
      sourceRaster: {
        id: 'raster-1',
        fingerprint: hash('b'),
        coordinateSpace: 'source-raster-pixels',
        widthPx: width,
        heightPx: height,
        dpi: 144,
      },
    },
    recognitionConfigurationHash: hash('c'),
    recognitionOptions: {
      languagePolicy: { mode: 'automatic', languages: [], scripts: [] },
      includeWords: false,
      orientation: { mode: 'none', degrees: null },
      deskew: false,
      preprocessing: { mode: 'none', operations: [] },
      rasterDpi: 144,
      maximumPixels: width * height,
      maximumSide: Math.max(width, height),
      timeoutMs: 30_000,
    },
    documentPolicy: {
      skipMeaningfulExistingText: true,
      forceRerun: false,
      replaceApplicationOwnedOcrOnly: true,
      keepCompletedPages: true,
    },
    scheduler: { priority: 'normal', execution: 'one-page-child' },
    createdAt: '2026-08-16T12:00:00Z',
  };
}

function validResult(job) {
  return {
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: OCR_CURRENT_SCHEMA_VERSION,
    jobId: job.jobId,
    requestId: job.requestId,
    engine: createPaddleOcrEngineDescriptor(manifest),
    document: structuredClone(job.document),
    page: {
      id: job.page.id,
      index: job.page.index,
      revision: job.page.revision,
      status: 'completed',
    },
    recognitionConfigurationHash: structuredClone(job.recognitionConfigurationHash),
    sourceRaster: structuredClone(job.page.sourceRaster),
    text: '',
    lines: [],
    detectedLanguages: [],
    warnings: [],
    unsupportedContentReasons: [],
    preprocessing: { status: 'none', operations: [], outputRaster: null, transform: null },
    metrics: {
      workerStartupMs: 0,
      modelStartupMs: 0,
      rasterMs: 0,
      detectionMs: 0,
      recognitionMs: 0,
      totalOcrMs: 0,
    },
  };
}

function workerEnvelope(type, payload = {}) {
  return {
    contract: OCR_WORKER_MESSAGE_CONTRACT,
    schemaVersion: OCR_WORKER_MESSAGE_SCHEMA_VERSION,
    type,
    ...payload,
  };
}

class FakeWorker {
  constructor({ response = 'result' } = {}) {
    this.response = response;
    this.terminated = false;
    this.messages = [];
    queueMicrotask(() => this.deliver(workerEnvelope('ready')));
  }

  deliver(message) {
    if (this.terminated) return;
    this.onmessage?.({ data: structuredClone(message) });
  }

  postMessage(message, transfer = []) {
    const received = structuredClone(message, { transfer });
    this.lastMessage = received;
    this.messages.push(received);
    if (received.type === 'dispose') {
      queueMicrotask(() => this.deliver(workerEnvelope('disposed', {
        detail: { onnxSessionsReleased: true, messagePortsClosed: true },
      })));
      return;
    }
    if (this.response === 'none') return;
    if (this.response === 'incompatible') {
      queueMicrotask(() => this.deliver({ ...workerEnvelope('result'), schemaVersion: 99 }));
      return;
    }
    const result = validResult(received.job);
    if (this.response === 'identity-mismatch') result.page.revision += 1;
    queueMicrotask(() => this.deliver(workerEnvelope('result', {
      requestId: received.requestId,
      result,
    })));
  }

  terminate() {
    this.terminated = true;
  }
}

function request(options = {}) {
  const job = recognitionJob(options);
  return {
    image: {
      width: job.page.sourceRaster.widthPx,
      height: job.page.sourceRaster.heightPx,
      rgba: new Uint8Array(job.page.sourceRaster.widthPx * job.page.sourceRaster.heightPx * 4).fill(255),
    },
    job,
  };
}

test('OcrEngine returns a production result and disposes its Worker gracefully', async () => {
  const workers = [];
  const lifecycle = [];
  const engine = new OcrEngine({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onLifecycle: (checkpoint) => lifecycle.push(checkpoint),
  });
  const result = await engine.recognize(request());
  assert.equal(assertOcrResultV2(result), result);
  assert.equal(result.schemaVersion, 2);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].lastMessage.type, 'recognize');
  assert.equal(Object.hasOwn(workers[0].lastMessage, 'source'), false);
  await engine.dispose();
  assert.equal(workers[0].messages.at(-1).type, 'dispose');
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].onmessage, null);
  assert.ok(lifecycle.some((checkpoint) => checkpoint.stage === 'worker-disposal-acknowledged'));
  assert.ok(lifecycle.some((checkpoint) => checkpoint.stage === 'worker-terminated' && checkpoint.graceful));
});

test('cancellation terminates the OCR Worker and a later request gets a fresh Worker', async () => {
  const workers = [];
  const engine = new OcrEngine({ workerFactory: () => {
    const worker = new FakeWorker({ response: workers.length > 0 ? 'result' : 'none' });
    workers.push(worker);
    return worker;
  } });

  const pending = engine.recognize(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.cancel(), true);
  await assert.rejects(pending, (error) => error instanceof OcrCancelledError);
  assert.equal(workers[0].terminated, true);

  const result = await engine.recognize(request());
  assert.equal(result.contract, OCR_RESULT_CONTRACT);
  assert.equal(workers.length, 2);
  await engine.dispose();
});

test('cancellation drops listeners and ignores a stale result without retaining request data', async () => {
  const worker = new FakeWorker({ response: 'none' });
  const engine = new OcrEngine({ workerFactory: () => worker });
  const pending = engine.recognize(request());
  await new Promise((resolve) => setImmediate(resolve));
  const staleHandler = worker.onmessage;
  assert.equal(engine.cancel('test cancellation'), true);
  await assert.rejects(pending, OcrCancelledError);
  assert.equal(worker.onmessage, null);
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
  assert.equal(engine.pending.size, 0);

  staleHandler?.({
    data: workerEnvelope('result', {
      requestId: worker.lastMessage.requestId,
      result: validResult(worker.lastMessage.job),
    }),
  });
  assert.equal(engine.pending.size, 0);
  await engine.dispose();
});

test('an incompatible Worker message is rejected before it can resolve application state', async () => {
  const worker = new FakeWorker({ response: 'incompatible' });
  const engine = new OcrEngine({ workerFactory: () => worker });
  await assert.rejects(engine.recognize(request()), /incompatible message/);
  assert.equal(engine.pending.size, 0);
  assert.equal(worker.terminated, true);
  await engine.dispose();
});

test('a valid result envelope with stale page identity is rejected before application state', async () => {
  const worker = new FakeWorker({ response: 'identity-mismatch' });
  const engine = new OcrEngine({ workerFactory: () => worker });
  await assert.rejects(engine.recognize(request()), /does not match its job/);
  assert.equal(engine.pending.size, 0);
  assert.equal(worker.terminated, true);
  await engine.dispose();
});

class Tensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
  }
}

function deterministicAdapter() {
  const adapter = new PaddleOcrV6SmallAdapter({
    ort: { InferenceSession: {}, Tensor },
    manifest,
    assetBaseUrl: 'http://127.0.0.1/ocr/',
  });
  const detection = new Float32Array(8 * 8);
  for (let y = 2; y <= 4; y += 1) {
    for (let x = 1; x <= 6; x += 1) detection[y * 8 + x] = 0.9;
  }
  const recognition = new Float32Array(3 * 4);
  [1, 0, 2].forEach((character, step) => { recognition[step * 4 + character] = 0.95; });
  adapter.detector = {
    outputNames: ['output'],
    run: async () => ({ output: new Tensor('float32', detection, [1, 1, 8, 8]) }),
    release: async () => {},
  };
  adapter.recognizer = {
    outputNames: ['output'],
    run: async () => ({ output: new Tensor('float32', recognition, [1, 3, 4]) }),
    release: async () => {},
  };
  adapter.characters = ['blank', 'O', 'K', ' '];
  return adapter;
}

class InProcessWorker {
  constructor() {
    this.terminated = false;
    this.closed = false;
    this.runtime = createOcrWorkerRuntime({
      createAdapter: async () => deterministicAdapter(),
      postMessage: (message) => {
        const data = structuredClone(message);
        queueMicrotask(() => {
          if (!this.terminated) this.onmessage?.({ data });
        });
      },
      close: () => { this.closed = true; },
    });
    queueMicrotask(() => this.runtime.start());
  }

  postMessage(message, transfer = []) {
    const data = structuredClone(message, { transfer });
    queueMicrotask(() => {
      if (!this.terminated) this.runtime.handleMessage(data);
    });
  }

  terminate() {
    this.terminated = true;
  }
}

test('deterministic adapter -> Worker protocol -> OcrEngine returns a validated production result', async () => {
  const worker = new InProcessWorker();
  const lifecycle = [];
  const engine = new OcrEngine({
    workerFactory: () => worker,
    onLifecycle: (checkpoint) => lifecycle.push(checkpoint),
  });
  const input = request({ requestId: 'integration-request-1', jobId: 'integration-job-1', width: 32, height: 32 });
  const result = await engine.recognize({ ...input, rasterMs: 3.5 });

  assert.equal(assertOcrResultV2(result), result);
  assert.equal(result.text, 'OK');
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].text, 'OK');
  assert.equal(result.lines[0].polygon.coordinateSpace, 'source-raster-pixels');
  assert.equal(result.lines[0].polygon.points.length, 4);
  assert.deepEqual(result.lines[0].baseline, {
    status: 'unavailable',
    coordinateSpace: 'source-raster-pixels',
    reason: 'engine-did-not-provide',
  });
  for (const key of ['words', 'alternatives', 'detectedLanguage', 'detectedWritingDirection']) {
    assert.equal(Object.hasOwn(result.lines[0], key), false);
  }
  assert.deepEqual(result.detectedLanguages, []);
  assert.deepEqual(result.preprocessing, {
    status: 'none', operations: [], outputRaster: null, transform: null,
  });
  assert.deepEqual(result.engine.modelPack, modelPackIdentity(manifest));
  assert.equal(result.engine.capabilities.wordResults, false);
  assert.equal(result.engine.capabilities.languageDetection, false);
  assert.equal(JSON.stringify(result).includes('/fixture.pdf'), false);
  assert.equal(input.image.rgba.byteLength, 0);
  assert.ok(lifecycle.some((checkpoint) => checkpoint.stage === 'worker-input-buffer-reference-dropped'));

  await engine.dispose();
  assert.equal(worker.closed, true);
  assert.equal(worker.terminated, true);
});
