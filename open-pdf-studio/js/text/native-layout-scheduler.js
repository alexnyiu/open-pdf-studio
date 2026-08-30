import { layoutExpandableNativeText } from './native-expandable-layout.js';
import { throwIfSaveFaultInjected } from '../pdf/save-fault-injection.js';

let worker = null;
let requestSequence = 0;
let activeRequest = null;
let fallbackGeneration = 0;
const cancellationFallbacks = new Map();
const WORKER_CANCEL_FALLBACK_MS = 250;

function cancellationError() {
  return Object.assign(new Error('Exact text layout was superseded'), {
    code: 'TEXT_LAYOUT_CANCELLED',
  });
}

function ensureWorker() {
  if (worker || typeof Worker === 'undefined') return worker;
  const moduleWorker = new Worker(new URL('./native-layout-worker.js', import.meta.url), {
    type: 'module',
    name: 'open-pdf-studio-native-layout',
  });
  worker = moduleWorker;
  moduleWorker.addEventListener('message', (event) => {
    const message = event.data || {};
    clearCancellationFallback(message.requestId, moduleWorker);
    if (message.type === 'cancelled') return;
    if (worker !== moduleWorker || !activeRequest
        || activeRequest.worker !== moduleWorker
        || message.requestId !== activeRequest.requestId) return;
    const request = activeRequest;
    activeRequest = null;
    if (message.type === 'result') {
      try {
        throwIfSaveFaultInjected('drop-latest-text-layout-result');
        request.resolve({
          fingerprint: message.fingerprint,
          result: message.result,
        });
      } catch (error) {
        request.reject(error);
      }
    }
    else request.reject(Object.assign(new Error(message.error?.message || 'Exact layout worker failed'), {
      code: message.error?.code || 'TEXT_LAYOUT_WORKER_FAILED',
    }));
  });
  moduleWorker.addEventListener('error', (event) => {
    if (worker !== moduleWorker) return;
    clearWorkerCancellationFallbacks(moduleWorker);
    worker = null;
    moduleWorker.terminate();
    const request = activeRequest?.worker === moduleWorker ? activeRequest : null;
    if (request) activeRequest = null;
    request?.reject(Object.assign(new Error(event.message || 'Exact layout worker crashed'), {
      code: 'TEXT_LAYOUT_WORKER_CRASHED',
    }));
  });
  return worker;
}

function clearCancellationFallback(requestId, requestWorker) {
  const fallback = cancellationFallbacks.get(requestId);
  if (!fallback || fallback.worker !== requestWorker) return false;
  clearTimeout(fallback.timer);
  cancellationFallbacks.delete(requestId);
  return true;
}

function clearWorkerCancellationFallbacks(requestWorker) {
  for (const [requestId, fallback] of cancellationFallbacks) {
    if (fallback.worker !== requestWorker) continue;
    clearTimeout(fallback.timer);
    cancellationFallbacks.delete(requestId);
  }
}

function replaceUnresponsiveWorker(requestWorker) {
  if (worker !== requestWorker) return;
  clearWorkerCancellationFallbacks(requestWorker);
  requestWorker.terminate();
  worker = null;
  const current = activeRequest?.worker === requestWorker ? activeRequest : null;
  if (!current) return;
  const replacement = ensureWorker();
  if (!replacement) {
    activeRequest = null;
    current.reject(Object.assign(new Error('Exact layout Worker became unavailable'), {
      code: 'TEXT_LAYOUT_WORKER_CRASHED',
    }));
    return;
  }
  current.worker = replacement;
  replacement.postMessage(current.message);
}

function requestCooperativeCancellation(request) {
  const requestWorker = request.worker;
  if (!requestWorker || requestWorker !== worker) return;
  requestWorker.postMessage({ type: 'cancel', requestId: request.requestId });
  const timer = setTimeout(() => {
    const fallback = cancellationFallbacks.get(request.requestId);
    if (!fallback || fallback.worker !== requestWorker) return;
    cancellationFallbacks.delete(request.requestId);
    // Cooperative checkpoints preserve the module Worker and its shaped-run
    // LRU during normal typing. Termination is only a bounded escape hatch for
    // a synchronous font engine call that cannot reach a checkpoint.
    replaceUnresponsiveWorker(requestWorker);
  }, WORKER_CANCEL_FALLBACK_MS);
  cancellationFallbacks.set(request.requestId, { worker: requestWorker, timer });
}

export function cancelLatestNativeLayout() {
  fallbackGeneration += 1;
  if (!activeRequest) return false;
  const request = activeRequest;
  activeRequest = null;
  requestCooperativeCancellation(request);
  request.reject(cancellationError());
  return true;
}

/** One latest-only exact layout task shared by every editor session. */
export function requestLatestNativeLayout(document, options, fingerprint) {
  cancelLatestNativeLayout();
  const requestId = ++requestSequence;
  const moduleWorker = ensureWorker();
  if (!moduleWorker) {
    const generation = ++fallbackGeneration;
    return layoutExpandableNativeText(document, {
      ...options,
      shouldCancel: () => generation !== fallbackGeneration,
    }).then((result) => {
      throwIfSaveFaultInjected('drop-latest-text-layout-result');
      return { fingerprint, result };
    });
  }
  return new Promise((resolve, reject) => {
    const message = { type: 'layout', requestId, fingerprint, document, options };
    activeRequest = { requestId, fingerprint, resolve, reject, worker: moduleWorker, message };
    moduleWorker.postMessage(message);
  });
}

export function exactLayoutSchedulerState() {
  return { activeTasks: activeRequest ? 1 : 0, requestId: activeRequest?.requestId || null };
}
