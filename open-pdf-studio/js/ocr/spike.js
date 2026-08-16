import { invoke } from '../core/platform.js';
import { assertOcrResultV1, toValidatedOcrResultJson } from './contracts/v1.js';
import { OcrCancelledError, createOcrEngine } from './engine.js';

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function roundMs(value) {
  return Math.max(0, Math.round(value * 100) / 100);
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
  const encoded = await invoke('run_ocr_phase_a_isolated', {
    path,
    pageIndex,
    scale,
    cancelAfterMs,
  });
  const response = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
  for (const checkpoint of response?.lifecycle ?? []) onLifecycle?.(checkpoint);
  onRunSummary?.({ resources: response?.resources ?? null, isolation: response?.isolation ?? null });
  if (response?.cancelled) {
    throw new OcrCancelledError(
      response.cancellation?.message ?? 'OCR cancelled by terminating its Worker',
    );
  }
  if (!response?.ok) throw new Error(response?.error ?? 'Isolated OCR child failed');
  return toValidatedOcrResultJson(assertOcrResultV1(response.result));
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
  const engine = engineFactory({ onLifecycle });
  let cancellationTimer = null;
  try {
    const recognition = engine.recognize({
      image,
      source,
      rasterMs,
    });
    if (Number.isFinite(cancelAfterMs) && cancelAfterMs >= 0) {
      cancellationTimer = setTimeout(() => {
        engine.cancel(`OCR Phase A cancellation probe fired after ${cancelAfterMs} ms`);
      }, cancelAfterMs);
    }
    const result = await recognition;
    return toValidatedOcrResultJson(assertOcrResultV1(result));
  } finally {
    if (cancellationTimer !== null) clearTimeout(cancellationTimer);
    if (image) image.rgba = null;
    onLifecycle?.({
      stage: 'immediately-before-engine-disposal',
      atEpochMs: Date.now(),
      livePageBufferReferences: 0,
    });
    await engine.dispose();
    onLifecycle?.({
      stage: 'after-engine-disposal-complete',
      atEpochMs: Date.now(),
      livePageBufferReferences: 0,
    });
  }
}

export { OcrCancelledError };
