import assert from 'node:assert/strict';
import test from 'node:test';

import { OCR_ENGINE_CONTRACT, OCR_RESULT_CONTRACT, OCR_WORKER_MESSAGE_CONTRACT } from './contracts/v1.js';
import { OcrCancelledError, OcrEngine } from './engine.js';

function validResult(requestId) {
  return {
    contract: OCR_RESULT_CONTRACT,
    schemaVersion: 1,
    requestId,
    engine: {
      contract: OCR_ENGINE_CONTRACT,
      schemaVersion: 1,
      engineId: 'fake',
      adapterVersion: '0.1.0',
      provider: 'fake',
      model: { family: 'fake', tier: 'small', detection: 'det', recognition: 'rec' },
      runtime: { name: 'fake', version: '1', executionProvider: 'wasm', offline: true },
      capabilities: { textDetection: true, textRecognition: true, wordBoxes: false, pdfWriting: false },
    },
    source: { kind: 'pdf-page', path: '/fixture.pdf', pageIndex: 0, widthPx: 1, heightPx: 1, scale: 2 },
    text: '',
    lines: [],
    metrics: { workerStartupMs: 0, modelStartupMs: 0, rasterMs: 0, detectionMs: 0, recognitionMs: 0, totalOcrMs: 0 },
    warnings: [],
  };
}

class FakeWorker {
  constructor({ respond = true } = {}) {
    this.respond = respond;
    this.terminated = false;
    queueMicrotask(() => this.onmessage?.({
      data: { contract: OCR_WORKER_MESSAGE_CONTRACT, schemaVersion: 1, type: 'ready' },
    }));
  }

  postMessage(message) {
    this.lastMessage = message;
    this.messages ??= [];
    this.messages.push(message);
    if (message.type === 'dispose') {
      queueMicrotask(() => this.onmessage?.({
        data: {
          contract: OCR_WORKER_MESSAGE_CONTRACT,
          schemaVersion: 1,
          type: 'disposed',
          detail: { onnxSessionsReleased: true, messagePortsClosed: true },
        },
      }));
      return;
    }
    if (!this.respond) return;
    queueMicrotask(() => this.onmessage?.({
      data: {
        contract: OCR_WORKER_MESSAGE_CONTRACT,
        schemaVersion: 1,
        type: 'result',
        requestId: message.requestId,
        result: validResult(message.requestId),
      },
    }));
  }

  terminate() {
    this.terminated = true;
  }
}

const request = () => ({
  image: { width: 1, height: 1, rgba: new Uint8Array([255, 255, 255, 255]) },
  source: { kind: 'pdf-page', path: '/fixture.pdf', pageIndex: 0, scale: 2 },
});

test('application-owned Worker returns a contract-validated result and disposes it gracefully', async () => {
  const workers = [];
  const lifecycle = [];
  const engine = new OcrEngine({ workerFactory: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, onLifecycle: (checkpoint) => lifecycle.push(checkpoint) });
  const result = await engine.recognize(request());
  assert.equal(result.contract, OCR_RESULT_CONTRACT);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].lastMessage.type, 'recognize');
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
    const worker = new FakeWorker({ respond: workers.length > 0 });
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
  const worker = new FakeWorker({ respond: false });
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
    data: {
      contract: OCR_WORKER_MESSAGE_CONTRACT,
      schemaVersion: 1,
      type: 'result',
      requestId: worker.lastMessage.requestId,
      result: validResult(worker.lastMessage.requestId),
    },
  });
  assert.equal(engine.pending.size, 0);
  await engine.dispose();
});
