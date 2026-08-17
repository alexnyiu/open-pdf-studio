import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortWasmModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';

import {
  PaddleOcrV6SmallAdapter,
  createSameOriginAssetLoader,
  createSameOriginFetch,
} from './adapter.js';
import { createOcrWorkerRuntime } from './worker-runtime.js';

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

const runtime = createOcrWorkerRuntime({
  createAdapter: async (lifecycle) => {
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
  },
  postMessage: (message) => globalThis.postMessage(message),
  close: () => globalThis.close(),
  onDisposed: () => { globalThis.onmessage = null; },
  getDisposalDetail: () => ({
    offlinePolicyEnforced: globalThis.fetch === offlineFetch,
    offlinePolicySelfTestPassed,
    offlineAllowedOrigin: offlineAudit.allowedOrigin,
    offlineAllowedRequestCount: offlineAudit.allowedRequestCount,
    offlineBlockedExternalRequestCount: offlineAudit.blockedExternalRequestCount,
    offlineBlockedOrigins: [...offlineAudit.blockedOrigins],
  }),
});

globalThis.onmessage = (event) => runtime.handleMessage(event.data);
runtime.lifecycle('offline-fetch-policy-installed', {
  offlinePolicyEnforced: globalThis.fetch === offlineFetch,
  offlinePolicySelfTestPassed,
  offlineAllowedOrigin: offlineAudit.allowedOrigin,
  offlineAllowedRequestCount: offlineAudit.allowedRequestCount,
  offlineBlockedExternalRequestCount: offlineAudit.blockedExternalRequestCount,
});
runtime.start();
