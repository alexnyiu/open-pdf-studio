import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortWasmModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';

import {
  OCR_SCHEMA_VERSION,
  OCR_WORKER_MESSAGE_CONTRACT,
} from '../contracts/v1.js';
import {
  PaddleOcrV6SmallAdapter,
  createSameOriginAssetLoader,
  createSameOriginFetch,
} from './adapter.js';

const MODEL_BASE_URL = new URL('/ocr/pp-ocrv6-small/', globalThis.location.href).href;

ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = {
  wasm: new URL(ortWasmUrl, globalThis.location.href).href,
  mjs: new URL(ortWasmModuleUrl, globalThis.location.href).href,
};

const nativeFetch = globalThis.fetch.bind(globalThis);
const offlineAudit = {
  allowedOrigin: null,
  allowedRequestCount: 0,
  blockedExternalRequestCount: 0,
  blockedOrigins: new Set(),
};
const offlineFetch = createSameOriginFetch(
  globalThis.location.href,
  nativeFetch,
  ({ allowed, allowedOrigin, requestedOrigin }) => {
    offlineAudit.allowedOrigin = allowedOrigin;
    if (allowed) offlineAudit.allowedRequestCount += 1;
    else {
      offlineAudit.blockedExternalRequestCount += 1;
      offlineAudit.blockedOrigins.add(requestedOrigin);
    }
  },
);
globalThis.fetch = offlineFetch;
let offlinePolicySelfTestPassed = false;

let adapterPromise = null;
let adapterLoadCount = 0;
let activeRequestId = null;
let disposing = false;

function lifecycle(stage, detail = {}) {
  post('lifecycle', {
    stage,
    atEpochMs: Date.now(),
    detail: { adapterLoadCount, ...detail },
  });
}

async function loadAdapter() {
  if (!adapterPromise) {
    adapterLoadCount += 1;
    adapterPromise = (async () => {
      try {
        await offlineFetch('https://ocr-offline-probe.invalid/model.onnx');
        throw new Error('Offline OCR fetch policy allowed its external self-test URL');
      } catch (error) {
        if (error?.code !== 'OCR_OFFLINE_NETWORK_BLOCKED') throw error;
        offlinePolicySelfTestPassed = true;
      }
      const response = await offlineFetch(new URL('manifest.json', MODEL_BASE_URL), { cache: 'no-store' });
      if (!response.ok) throw new Error(`Failed to load OCR manifest: HTTP ${response.status}`);
      const manifest = await response.json();
      return new PaddleOcrV6SmallAdapter({
        ort,
        manifest,
        assetBaseUrl: MODEL_BASE_URL,
        loadBinary: createSameOriginAssetLoader(globalThis.location.href),
        onLifecycle: lifecycle,
      });
    })();
  }
  return adapterPromise;
}

function post(type, payload = {}) {
  globalThis.postMessage({
    contract: OCR_WORKER_MESSAGE_CONTRACT,
    schemaVersion: OCR_SCHEMA_VERSION,
    type,
    ...payload,
  });
}

globalThis.onmessage = async (event) => {
  const message = event.data;
  if (!message || message.contract !== OCR_WORKER_MESSAGE_CONTRACT ||
      message.schemaVersion !== OCR_SCHEMA_VERSION) {
    post('error', {
      requestId: message?.requestId ?? 'unknown',
      error: { name: 'OcrProtocolError', code: 'OCR_PROTOCOL_ERROR', message: 'Unsupported OCR Worker request' },
    });
    return;
  }

  if (message.type === 'dispose') {
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
      globalThis.onmessage = null;
      post('disposed', {
        detail: {
          adapterLoadCount,
          onnxSessionsReleased: releaseError === null,
          openCvResourcesReleased: true,
          openCvUsed: false,
          messagePortsClosed: true,
          messagePortsUsed: false,
          offlinePolicyEnforced: globalThis.fetch === offlineFetch,
          offlinePolicySelfTestPassed,
          offlineAllowedOrigin: offlineAudit.allowedOrigin,
          offlineAllowedRequestCount: offlineAudit.allowedRequestCount,
          offlineBlockedExternalRequestCount: offlineAudit.blockedExternalRequestCount,
          offlineBlockedOrigins: [...offlineAudit.blockedOrigins],
        },
      });
      globalThis.close();
    }
    return;
  }

  if (message.type !== 'recognize' || disposing || activeRequestId !== null) {
    post('error', {
      requestId: message?.requestId ?? 'unknown',
      error: { name: 'OcrProtocolError', code: 'OCR_PROTOCOL_ERROR', message: 'Unsupported OCR Worker request' },
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
      requestId: message.requestId,
      image: input,
      source: message.source,
      rasterMs: message.rasterMs,
      workerStartupMs: message.workerStartupMs,
      options: message.options,
    });
    post('result', { requestId: message.requestId, result });
  } catch (error) {
    post('error', {
      requestId: message.requestId,
      error: {
        name: error?.name || 'OcrWorkerError',
        code: error?.code || 'OCR_WORKER_ERROR',
        message: error?.message || String(error),
      },
    });
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
};

lifecycle('offline-fetch-policy-installed', {
  offlinePolicyEnforced: globalThis.fetch === offlineFetch,
  offlinePolicySelfTestPassed,
  offlineAllowedOrigin: offlineAudit.allowedOrigin,
  offlineAllowedRequestCount: offlineAudit.allowedRequestCount,
  offlineBlockedExternalRequestCount: offlineAudit.blockedExternalRequestCount,
});
post('ready');
