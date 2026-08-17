import { invoke } from '../core/platform.js';
import { OcrCancelledError, createOcrEngine } from './engine.js';
import {
  cancelNativeOcrJob,
  getNativeOcrJobStatus,
  runNativeOcrPage,
} from './native-controller.js';
import { runOcrJob } from './run-job.js';
import {
  createPhaseACompatibilityJob,
  createPhaseACompatibilityNativeRequest,
  toPhaseACompatibilityResult,
} from './phase-a-compat.js';

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function roundMs(value) {
  return Math.max(0, Math.round(value * 100) / 100);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cancelActiveCompatibilityChild(jobId, delayAfterSpawnMs, isSettled) {
  const deadline = Date.now() + 30_000;
  while (!isSettled() && Date.now() < deadline) {
    const status = await getNativeOcrJobStatus(jobId);
    if (status?.found && Number.isInteger(status.childPid) && status.childPid > 0) {
      await delay(delayAfterSpawnMs);
      if (!isSettled()) return cancelNativeOcrJob(jobId);
      return null;
    }
    await delay(10);
  }
  return null;
}

export async function waitForOcrIdleSlot() {
  if (globalThis.scheduler?.postTask) {
    await globalThis.scheduler.postTask(() => {}, { priority: 'background' });
    return 'scheduler.background';
  }
  if (typeof globalThis.requestIdleCallback === 'function') {
    await new Promise((resolve) => globalThis.requestIdleCallback(resolve, { timeout: 1000 }));
    return 'requestIdleCallback';
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return 'setTimeout';
}

export function decodeOcrRasterResponse(response) {
  const bytes = response instanceof Uint8Array ? response : new Uint8Array(response);
  if (bytes.byteLength <= 8) throw new Error('OCR PDFium raster response is empty');
  const header = new DataView(bytes.buffer, bytes.byteOffset, 8);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const expected = width * height * 4;
  if (width <= 0 || height <= 0 || bytes.byteLength - 8 !== expected) {
    throw new Error(`OCR PDFium raster response is invalid (${width}x${height}, ${bytes.byteLength - 8} bytes)`);
  }
  return {
    width,
    height,
    rgba: new Uint8Array(bytes.buffer.slice(bytes.byteOffset + 8, bytes.byteOffset + bytes.byteLength)),
  };
}

export async function rasterizePdfPageForOcr({ path, pageIndex = 0, scale = 2 }) {
  if (typeof path !== 'string' || !path) throw new TypeError('OCR PDF path is required');
  await waitForOcrIdleSlot();
  const started = now();
  const response = await invoke('rasterize_page_for_ocr', {
    path,
    pageIndex,
    scale,
  });
  return {
    image: decodeOcrRasterResponse(response),
    rasterMs: roundMs(now() - started),
  };
}

export async function runOcrPhaseASpike({
  path,
  pageIndex = 0,
  scale = 2,
  cancelAfterMs = null,
  engineFactory = createOcrEngine,
  onLifecycle = null,
  onRunSummary = null,
} = {}) {
  // Test-only/custom engines retain the original in-process path. The shipped
  // Phase A spike always uses the disposable native child boundary below.
  if (engineFactory !== createOcrEngine) {
    return runOcrPhaseAInCurrentProcess({
      path,
      pageIndex,
      scale,
      cancelAfterMs,
      engineFactory,
      onLifecycle,
      onRunSummary,
    });
  }
  const source = { kind: 'pdf-page', path, pageIndex, scale };
  const request = await createPhaseACompatibilityNativeRequest({ source });
  const recognition = runNativeOcrPage({
    sourcePdfPath: path,
    request,
  });
  let settled = false;
  let cancellationTask = null;
  if (Number.isFinite(cancelAfterMs) && cancelAfterMs >= 0) {
    cancellationTask = cancelActiveCompatibilityChild(
      request.jobId,
      cancelAfterMs,
      () => settled,
    );
  }
  let response;
  try {
    response = await recognition;
  } finally {
    settled = true;
    await cancellationTask;
  }
  for (const checkpoint of response?.lifecycle ?? []) onLifecycle?.(checkpoint);
  onRunSummary?.({
    resources: response?.resources ?? null,
    isolation: response?.isolation ?? null,
    cleanup: response?.cleanup ?? null,
    cancellation: response?.cancellation ?? null,
    failure: response?.failure ?? null,
  });
  if (response?.status === 'cancelled') {
    const error = new OcrCancelledError(
      response.cancellation?.message ?? 'OCR cancelled by terminating its application child',
    );
    error.cancellationMethod = response.cancellation?.method ?? 'native-child-process-terminate';
    error.cancellationLatencyMs = response.cancellation?.latencyMs ?? null;
    throw error;
  }
  if (response?.status !== 'completed') {
    const error = new Error(response?.failure?.message ?? 'Isolated OCR child failed');
    error.code = response?.failure?.code ?? 'OCR_NATIVE_CHILD_FAILED';
    throw error;
  }
  return toPhaseACompatibilityResult(response.result, source);
}

export async function runOcrPhaseAInCurrentProcess({
  path,
  pageIndex = 0,
  scale = 2,
  cancelAfterMs = null,
  engineFactory = createOcrEngine,
  onLifecycle = null,
  onRunSummary = null,
} = {}) {
  const { image, rasterMs } = await rasterizePdfPageForOcr({ path, pageIndex, scale });
  onLifecycle?.({
    stage: 'after-pdfium-raster',
    atEpochMs: Date.now(),
    rasterMs,
    rgbaBytes: image.rgba.byteLength,
  });
  onRunSummary?.({
    resources: null,
    isolation: { boundary: 'current-web-content-process', oneJob: true },
  });
  return runOcrWorkerJob({
    image,
    source: { kind: 'pdf-page', path, pageIndex, scale },
    rasterMs,
    cancelAfterMs,
    engineFactory,
    onLifecycle,
  });
}

export async function runOcrWorkerJob({
  image,
  source,
  rasterMs = 0,
  cancelAfterMs = null,
  engineFactory = createOcrEngine,
  onLifecycle = null,
}) {
  const job = await createPhaseACompatibilityJob({ image, source });
  const engine = engineFactory({ onLifecycle });
  let cancellationTimer = null;
  let result;
  try {
    const recognition = engine.recognize({ image, job, rasterMs });
    if (Number.isFinite(cancelAfterMs) && cancelAfterMs >= 0) {
      cancellationTimer = setTimeout(() => {
        engine.cancel(`OCR cancellation probe fired after ${cancelAfterMs} ms`);
      }, cancelAfterMs);
    }
    result = await recognition;
  } finally {
    if (cancellationTimer !== null) clearTimeout(cancellationTimer);
    if (image) image.rgba = null;
    await engine.dispose();
  }
  return toPhaseACompatibilityResult(result, source);
}

export { runOcrJob };

export { OcrCancelledError };
