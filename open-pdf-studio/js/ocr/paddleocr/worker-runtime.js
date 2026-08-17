import {
  OCR_WORKER_MESSAGE_CONTRACT,
  OCR_WORKER_MESSAGE_SCHEMA_VERSION,
  assertOcrResultMatchesJob,
  assertOcrWorkerMessageV1,
} from '../contracts/worker-message.v1.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function envelope(type, payload = {}) {
  return {
    contract: OCR_WORKER_MESSAGE_CONTRACT,
    schemaVersion: OCR_WORKER_MESSAGE_SCHEMA_VERSION,
    type,
    ...payload,
  };
}

function safeRequestId(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : 'protocol-error';
}

function safeIdentifier(value, fallback) {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : fallback;
}

function hasValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function safeErrorMessage(error) {
  const value = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : String(error || 'OCR Worker request failed');
  if (value.length > 4096 || !hasValidUnicode(value)) return 'OCR Worker request failed';
  return value;
}

export function createOcrWorkerRuntime({
  createAdapter,
  postMessage,
  close = () => {},
  getDisposalDetail = () => ({}),
  onDisposed = () => {},
} = {}) {
  if (typeof createAdapter !== 'function') throw new TypeError('OCR Worker runtime requires an adapter factory');
  if (typeof postMessage !== 'function') throw new TypeError('OCR Worker runtime requires a postMessage function');

  let adapterPromise = null;
  let adapterLoadCount = 0;
  let activeRequestId = null;
  let disposing = false;
  let disposed = false;

  function emit(type, payload = {}) {
    const message = assertOcrWorkerMessageV1(envelope(type, payload), {
      direction: 'worker-to-parent',
    });
    postMessage(message);
  }

  function lifecycle(stage, detail = {}) {
    emit('lifecycle', {
      stage,
      atEpochMs: Date.now(),
      detail: { adapterLoadCount, ...detail },
    });
  }

  function postError(requestId, error, {
    name = null,
    code = null,
    retryable = false,
  } = {}) {
    emit('error', {
      requestId: safeRequestId(requestId),
      error: {
        name: safeIdentifier(name ?? error?.name, 'OcrWorkerError'),
        code: safeIdentifier(code ?? error?.code, 'OCR_WORKER_ERROR'),
        message: safeErrorMessage(error),
        retryable,
      },
    });
  }

  async function loadAdapter() {
    if (!adapterPromise) {
      adapterLoadCount += 1;
      adapterPromise = Promise.resolve(createAdapter(lifecycle));
    }
    return adapterPromise;
  }

  async function dispose() {
    if (disposed || disposing) return;
    disposing = true;
    let releaseError = null;
    try {
      const adapter = adapterPromise ? await adapterPromise : null;
      await adapter?.dispose();
    } catch (error) {
      releaseError = error;
    } finally {
      adapterPromise = null;
      activeRequestId = null;
      disposed = true;
      const detail = {
        adapterLoadCount,
        onnxSessionsReleased: releaseError === null,
        openCvResourcesReleased: true,
        openCvUsed: false,
        messagePortsClosed: true,
        messagePortsUsed: false,
        ...getDisposalDetail({ releaseError }),
      };
      emit('disposed', { detail });
      onDisposed();
      close();
    }
  }

  async function recognize(message) {
    if (disposing || disposed || activeRequestId !== null) {
      postError(message.requestId, new Error('OCR Worker is not available for this request'), {
        name: 'OcrProtocolError',
        code: 'OCR_PROTOCOL_ERROR',
      });
      return;
    }

    activeRequestId = message.requestId;
    let input = null;
    try {
      const adapter = await loadAdapter();
      input = {
        width: message.image.width,
        height: message.image.height,
        rgba: new Uint8Array(message.image.rgba),
      };
      const result = await adapter.recognize({
        job: message.job,
        image: input,
        rasterMs: message.rasterMs,
        workerStartupMs: message.workerStartupMs,
      });
      assertOcrResultMatchesJob(result, message.job);
      emit('result', { requestId: message.requestId, result });
    } catch (error) {
      postError(message.requestId, error);
    } finally {
      const releasedBytes = input?.rgba?.byteLength ?? 0;
      if (input) input.rgba = null;
      if (message.image) message.image.rgba = null;
      input = null;
      activeRequestId = null;
      lifecycle('worker-input-buffer-reference-dropped', {
        releasedBytes,
        liveInputBufferReferences: 0,
      });
    }
  }

  async function handleMessage(value) {
    let message;
    try {
      message = assertOcrWorkerMessageV1(value, { direction: 'parent-to-worker' });
    } catch (error) {
      postError(value?.requestId, error, {
        name: 'OcrProtocolError',
        code: 'OCR_PROTOCOL_ERROR',
      });
      return;
    }
    if (message.type === 'dispose') {
      await dispose();
      return;
    }
    await recognize(message);
  }

  function start() {
    if (disposed) throw new Error('OCR Worker runtime has been disposed');
    emit('ready');
  }

  return Object.freeze({
    handleMessage,
    lifecycle,
    start,
  });
}
