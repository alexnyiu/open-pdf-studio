import {
  OCR_SCHEMA_VERSION,
  OCR_WORKER_MESSAGE_CONTRACT,
  assertOcrResultV1,
} from './contracts/v1.js';

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function makeRequestId() {
  return globalThis.crypto?.randomUUID?.() ??
    `ocr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
    this.worker = this.workerFactory();
    this.emitLifecycle('worker-created');
    this.workerReady = new Promise((resolve, reject) => {
      this.workerReadyResolve = resolve;
      this.workerReadyReject = reject;
    });
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event?.message || 'OCR Worker failed');
      this.failWorker(error);
    };
    this.worker.onmessageerror = () => {
      this.failWorker(new Error('OCR Worker message could not be deserialized'));
    };
    return this.workerReady;
  }

  handleMessage(message) {
    if (!message || message.contract !== OCR_WORKER_MESSAGE_CONTRACT ||
        message.schemaVersion !== OCR_SCHEMA_VERSION) {
      this.failWorker(new Error('OCR Worker returned an incompatible message'));
      return;
    }
    if (message.type === 'ready') {
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
      this.emitLifecycle('worker-disposal-acknowledged', message.detail ?? {});
      this.finishGracefulDisposal();
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === 'result') {
      try {
        pending.resolve(assertOcrResultV1(message.result));
      } catch (error) {
        pending.reject(error);
      }
      return;
    }
    if (message.type === 'error') {
      const error = new Error(message.error?.message || 'OCR Worker request failed');
      error.name = message.error?.name || 'OcrWorkerError';
      error.code = message.error?.code || 'OCR_WORKER_ERROR';
      pending.reject(error);
      return;
    }
    pending.reject(new Error(`Unknown OCR Worker message type: ${message.type}`));
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

  async recognize({ image, source, rasterMs = 0, options = {} }) {
    if (!image || !(image.rgba instanceof Uint8Array || image.rgba instanceof Uint8ClampedArray)) {
      throw new TypeError('OCR recognize requires an RGBA byte image');
    }
    if (!source || source.kind !== 'pdf-page') {
      throw new TypeError('OCR recognize requires a pdf-page source');
    }
    await this.ensureWorker();
    const requestId = makeRequestId();
    const rgba = image.rgba.byteOffset === 0 && image.rgba.byteLength === image.rgba.buffer.byteLength
      ? image.rgba
      : image.rgba.slice();
    const promise = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    this.worker.postMessage({
      contract: OCR_WORKER_MESSAGE_CONTRACT,
      schemaVersion: OCR_SCHEMA_VERSION,
      type: 'recognize',
      requestId,
      image: {
        width: image.width,
        height: image.height,
        rgba: rgba.buffer,
      },
      source,
      rasterMs,
      workerStartupMs: this.workerStartupMs,
      options,
    }, [rgba.buffer]);
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
    this.worker.postMessage({
      contract: OCR_WORKER_MESSAGE_CONTRACT,
      schemaVersion: OCR_SCHEMA_VERSION,
      type: 'dispose',
    });
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
