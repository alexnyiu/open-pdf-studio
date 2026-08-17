import {
  OCR_WORKER_MESSAGE_CONTRACT,
  OCR_WORKER_MESSAGE_SCHEMA_VERSION,
  assertOcrResultMatchesJob,
  assertOcrWorkerMessageV1,
} from './contracts/worker-message.v1.js';
import { toValidatedOcrJobV1Json } from './contracts/job.v1.js';

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function workerMessage(type, payload = {}) {
  return {
    contract: OCR_WORKER_MESSAGE_CONTRACT,
    schemaVersion: OCR_WORKER_MESSAGE_SCHEMA_VERSION,
    type,
    ...payload,
  };
}

function protocolError(message) {
  const error = new Error(message);
  error.name = 'OcrProtocolError';
  error.code = 'OCR_PROTOCOL_ERROR';
  return error;
}

export class OcrCancelledError extends Error {
  constructor(message = 'OCR cancelled by terminating its Worker') {
    super(message);
    this.name = 'OcrCancelledError';
    this.code = 'OCR_CANCELLED';
  }
}

function defaultWorkerFactory() {
  return new Worker(new URL('./paddleocr/worker.js', import.meta.url), {
    type: 'module',
    name: 'open-pdf-studio-ocr',
  });
}

export class OcrEngine {
  constructor({ workerFactory = defaultWorkerFactory, onLifecycle = null, disposeTimeoutMs = 2000 } = {}) {
    this.workerFactory = workerFactory;
    this.onLifecycle = typeof onLifecycle === 'function' ? onLifecycle : null;
    this.disposeTimeoutMs = disposeTimeoutMs;
    this.worker = null;
    this.workerReady = null;
    this.workerReadyResolve = null;
    this.workerReadyReject = null;
    this.workerCreatedAt = 0;
    this.workerStartupMs = 0;
    this.pending = new Map();
    this.disposed = false;
    this.disposePromise = null;
    this.disposeResolve = null;
    this.disposeTimer = null;
  }

  emitLifecycle(stage, detail = {}) {
    try {
      this.onLifecycle?.({ stage, atEpochMs: Date.now(), ...detail });
    } catch {
      // Diagnostic callbacks must never affect OCR execution or cleanup.
    }
  }

  ensureWorker() {
    if (this.disposed) throw new Error('OCR engine has been disposed');
    if (this.worker) return this.workerReady;
    this.workerCreatedAt = now();
    const worker = this.workerFactory();
    this.worker = worker;
    this.emitLifecycle('worker-created');
    this.workerReady = new Promise((resolve, reject) => {
      this.workerReadyResolve = resolve;
      this.workerReadyReject = reject;
    });
    worker.onmessage = (event) => {
      if (this.worker !== worker) return;
      this.handleMessage(event.data);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      const error = new Error(event?.message || 'OCR Worker failed');
      this.failWorker(error);
    };
    worker.onmessageerror = () => {
      if (this.worker !== worker) return;
      this.failWorker(new Error('OCR Worker message could not be deserialized'));
    };
    return this.workerReady;
  }

  handleMessage(message) {
    try {
      assertOcrWorkerMessageV1(message, { direction: 'worker-to-parent' });
    } catch (error) {
      this.failWorker(protocolError(`OCR Worker returned an incompatible message: ${error.message}`));
      return;
    }
    if (message.type === 'ready') {
      if (!this.workerReadyResolve) {
        this.failWorker(protocolError('OCR Worker returned an unexpected ready message'));
        return;
      }
      this.workerStartupMs = Math.max(0, now() - this.workerCreatedAt);
      this.workerReadyResolve?.(this.workerStartupMs);
      this.workerReadyResolve = null;
      this.workerReadyReject = null;
      this.emitLifecycle('worker-ready', { workerStartupMs: this.workerStartupMs });
      return;
    }
    if (message.type === 'lifecycle') {
      this.emitLifecycle(message.stage, {
        ...(message.detail ?? {}),
        atEpochMs: message.atEpochMs ?? Date.now(),
      });
      return;
    }
    if (message.type === 'disposed') {
      if (!this.disposed || this.pending.size > 0) {
        this.failWorker(protocolError('OCR Worker disposed outside the requested lifecycle'));
        return;
      }
      this.emitLifecycle('worker-disposal-acknowledged', message.detail ?? {});
      this.finishGracefulDisposal();
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === 'result') {
      try {
        assertOcrResultMatchesJob(message.result, pending.job);
      } catch (error) {
        this.failWorker(protocolError(`OCR Worker result does not match its job: ${error.message}`));
        return;
      }
      this.pending.delete(message.requestId);
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'error') {
      this.pending.delete(message.requestId);
      const error = new Error(message.error?.message || 'OCR Worker request failed');
      error.name = message.error?.name || 'OcrWorkerError';
      error.code = message.error?.code || 'OCR_WORKER_ERROR';
      error.retryable = message.error.retryable;
      pending.reject(error);
      return;
    }
  }

  failWorker(error) {
    this.workerReadyReject?.(error);
    this.workerReadyResolve = null;
    this.workerReadyReject = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emitLifecycle('worker-error', { message: error.message });
    this.teardownWorker({ terminate: true });
    this.finishDisposePromise();
  }

  teardownWorker({ terminate }) {
    const worker = this.worker;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      if (terminate) worker.terminate();
    }
    this.worker = null;
    this.workerReady = null;
    this.workerReadyResolve = null;
    this.workerReadyReject = null;
    this.workerStartupMs = 0;
  }

  finishDisposePromise() {
    if (this.disposeTimer !== null) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    const resolve = this.disposeResolve;
    this.disposeResolve = null;
    resolve?.();
  }

  finishGracefulDisposal() {
    if (!this.worker) {
      this.finishDisposePromise();
      return;
    }
    this.teardownWorker({ terminate: true });
    this.emitLifecycle('worker-terminated', { reason: 'disposed', graceful: true });
    this.finishDisposePromise();
  }

  async recognize({ image, job, rasterMs = 0 }) {
    const validatedJob = toValidatedOcrJobV1Json(job);
    if (!image || !(image.rgba instanceof Uint8Array || image.rgba instanceof Uint8ClampedArray)) {
      throw new TypeError('OCR recognize requires an RGBA byte image');
    }
    if (!Number.isSafeInteger(image.width) || image.width <= 0 ||
        !Number.isSafeInteger(image.height) || image.height <= 0) {
      throw new TypeError('OCR recognize requires positive integer image dimensions');
    }
    if (image.width !== validatedJob.page.sourceRaster.widthPx ||
        image.height !== validatedJob.page.sourceRaster.heightPx) {
      throw new RangeError('OCR image dimensions must match the job source raster');
    }
    const expectedBytes = image.width * image.height * 4;
    if (!Number.isSafeInteger(expectedBytes) || image.rgba.byteLength !== expectedBytes) {
      throw new RangeError(`OCR image has ${image.rgba.byteLength} RGBA bytes; expected ${expectedBytes}`);
    }
    await this.ensureWorker();
    const requestId = validatedJob.requestId;
    if (this.pending.has(requestId)) throw new Error(`OCR request ${requestId} is already pending`);
    const rgba = image.rgba.byteOffset === 0 && image.rgba.byteLength === image.rgba.buffer.byteLength
      ? image.rgba
      : image.rgba.slice();
    const message = assertOcrWorkerMessageV1(workerMessage('recognize', {
      requestId,
      job: validatedJob,
      image: {
        width: image.width,
        height: image.height,
        rgba: rgba.buffer,
      },
      rasterMs,
      workerStartupMs: this.workerStartupMs,
    }), { direction: 'parent-to-worker' });
    const promise = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, job: validatedJob });
    });
    try {
      this.worker.postMessage(message, [rgba.buffer]);
    } catch (error) {
      this.pending.delete(requestId);
      throw error;
    }
    this.emitLifecycle('input-buffer-transferred', {
      requestId,
      transferredBytes: image.width * image.height * 4,
      senderByteLengthAfterTransfer: rgba.buffer.byteLength,
      ownership: rgba === image.rgba ? 'transferred' : 'copied-and-transferred',
    });
    return promise;
  }

  cancel(reason = 'OCR cancelled by terminating its Worker') {
    if (!this.worker) return false;
    const error = new OcrCancelledError(reason);
    this.workerReadyReject?.(error);
    this.workerReadyResolve = null;
    this.workerReadyReject = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.teardownWorker({ terminate: true });
    this.emitLifecycle('worker-terminated', { reason, graceful: false });
    this.finishDisposePromise();
    return true;
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    if (!this.worker) {
      this.disposePromise = Promise.resolve();
      return this.disposePromise;
    }
    if (this.pending.size > 0 || this.workerReadyResolve) {
      this.cancel('OCR engine disposed during active work');
      this.disposePromise = Promise.resolve();
      return this.disposePromise;
    }
    this.disposePromise = new Promise((resolve) => {
      this.disposeResolve = resolve;
    });
    this.emitLifecycle('before-worker-disposal');
    try {
      this.worker.postMessage(assertOcrWorkerMessageV1(workerMessage('dispose'), {
        direction: 'parent-to-worker',
      }));
    } catch (error) {
      this.teardownWorker({ terminate: true });
      this.emitLifecycle('worker-terminated', {
        reason: 'dispose-message-failed',
        graceful: false,
        message: error?.message ?? String(error),
      });
      this.finishDisposePromise();
      return this.disposePromise;
    }
    this.disposeTimer = setTimeout(() => {
      if (!this.worker) return;
      this.teardownWorker({ terminate: true });
      this.emitLifecycle('worker-terminated', { reason: 'dispose-timeout', graceful: false });
      this.finishDisposePromise();
    }, this.disposeTimeoutMs);
    return this.disposePromise;
  }
}

export function createOcrEngine(options) {
  return new OcrEngine(options);
}
