// Single source of truth for dispatching whole-page PDF renders to the
// chosen engine. Consults state.renderEngineOverride:
//
//   null         → 'render_pdf_page'      (PDFium, the default)
//   'pdfium'     → 'render_pdf_page'      (PDFium, forced)
//   'rust-skia'  → 'render_pdf_page_skia' (open-pdf-render kernel, alpha)
//
// Display callers use renderPdfPageBitmap() so PDFium crosses the GUI IPC
// boundary as compact lossless PNG. renderPdfPage() remains for diagnostics
// and consumers that explicitly need RGBA bytes.
//
// Tile-region rendering (render_pdf_page_region) stays PDFium-only because
// open-pdf-render doesn't have a region renderer yet. The override is
// silently ignored on the tile path; the user-visible engine label still
// reflects the chosen engine for the whole-page bitmap underneath.

import { state } from '../core/state.js';
import { invoke } from '../core/platform.js';
import {
  incrementPerformanceCounter,
  recordPerformanceEvent,
  recordPerformancePeak,
  recordPerformanceSample,
} from './performance-metrics.js';
import { validateRenderStreamDescriptor } from './render-stream-descriptor.js';

const activeRasterTransfers = new Map();
let nextRasterTransferId = 0;

async function decodeStreamedPng(
  url,
  signal,
  expectedWidth,
  expectedHeight,
  expectedBytes,
) {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    mode: 'cors',
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error(`private render stream returned HTTP ${response.status}`);
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'image/png') {
    throw new Error('private render stream returned an unexpected content type');
  }
  if (!response.headers.get('cache-control')?.toLowerCase()?.includes('no-store')) {
    throw new Error('private render stream response is cacheable');
  }
  const blob = await response.blob();
  if (blob.size !== expectedBytes) {
    throw new Error('private render stream returned an inconsistent byte count');
  }
  const bitmap = await createImageBitmap(blob);
  if (signal?.aborted) {
    try { bitmap.close?.(); } catch {}
    throw new DOMException('Raster transfer cancelled', 'AbortError');
  }
  if (bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) {
    try { bitmap.close?.(); } catch {}
    throw new Error('private render stream returned inconsistent PNG dimensions');
  }
  return bitmap;
}

function abortRasterTransfer(record) {
  try { record.controller?.abort?.(); } catch {}
  if (record.image) {
    try { record.image.removeAttribute?.('src'); } catch {}
    record.image = null;
  }
  if (record.token) {
    void invoke('cancel_render_pdf_page_png_transfer', { token: record.token }).catch(() => {});
  }
  try { record.onAbort?.(); } catch {}
}

export function cancelRasterTransfersForFile(filePath) {
  if (!filePath) return 0;
  let cancelled = 0;
  for (const [id, record] of activeRasterTransfers) {
    if (record.path !== filePath) continue;
    abortRasterTransfer(record);
    activeRasterTransfers.delete(id);
    cancelled += 1;
  }
  void invoke('cancel_render_pdf_page_png_transfers_for_path', { path: filePath }).catch(() => {});
  return cancelled;
}

export function cancelAllRasterTransfers() {
  const cancelled = activeRasterTransfers.size;
  for (const record of activeRasterTransfers.values()) abortRasterTransfer(record);
  activeRasterTransfers.clear();
  return cancelled;
}

/**
 * Begin a one-owner PNG stream for a mounted page image. Unlike
 * renderPdfPageBitmap(), this path never materializes a Blob or ImageBitmap in
 * JavaScript. The returned lease must be completed after the image `load`
 * event or cancelled when its immutable document owner becomes stale.
 */
export async function beginPdfPageImageStream({
  path,
  pageIndex,
  scale,
  rotation = 0,
  cssScale = scale,
  devicePixelRatio = 1,
  quality = 'final',
  ownerGeneration = 0,
  rasterKey = '',
  requestId = '',
}) {
  if (state?.renderEngineOverride === 'rust-skia') return null;
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  incrementPerformanceCounter('rasterRequested');
  recordPerformanceEvent('raster:requested', {
    pageNum: Number(pageIndex) + 1,
    scale,
    cssScale,
    devicePixelRatio,
    quality,
    ownerGeneration,
    rasterKey,
    requestId,
    transferMethod: 'direct-dom-png-stream',
  });
  const transferId = `${requestId || rasterKey || `${path}:${pageIndex}`}:image:${++nextRasterTransferId}`;
  const controller = new AbortController();
  const activeTransfer = { path, token: null, controller, image: null, onAbort: null };
  activeRasterTransfers.set(transferId, activeTransfer);
  let descriptor = null;
  let finished = false;

  const finish = (published, reason = null) => {
    if (finished) return false;
    finished = true;
    activeRasterTransfers.delete(transferId);
    const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
    if (published) {
      incrementPerformanceCounter('rasterCompleted');
      incrementPerformanceCounter('rasterTransferCalls');
      incrementPerformanceCounter('rasterTransferBytes', descriptor?.bytes || 0);
      incrementPerformanceCounter('directImageStreamPublishes');
      recordPerformancePeak('streamResponseBytes', descriptor?.bytes || 0);
      recordPerformanceSample('rasterTransferMs', elapsed);
      recordPerformanceEvent('raster:completed', {
        pageNum: Number(pageIndex) + 1,
        scale,
        cssScale,
        devicePixelRatio,
        quality,
        ownerGeneration,
        rasterKey,
        transferMethod: 'direct-dom-png-stream',
        bytes: descriptor?.bytes || 0,
        calls: 1,
        elapsedMs: elapsed,
      });
    } else {
      incrementPerformanceCounter('rasterCancelled');
      recordPerformanceEvent('raster:cancelled', {
        pageNum: Number(pageIndex) + 1,
        scale,
        cssScale,
        devicePixelRatio,
        quality,
        ownerGeneration,
        rasterKey,
        transferMethod: 'direct-dom-png-stream',
        bytes: descriptor?.bytes || 0,
        calls: descriptor ? 1 : 0,
        reason,
      });
    }
    return true;
  };
  activeTransfer.onAbort = () => finish(false, 'owner-cancelled');

  try {
    const rawDescriptor = await invoke('begin_render_pdf_page_png', {
      path, pageIndex, scale, rotation, preferStream: true, requestId,
    });
    descriptor = validateRenderStreamDescriptor(rawDescriptor);
    activeTransfer.token = descriptor.token;
    if (controller.signal.aborted) {
      await invoke('cancel_render_pdf_page_png_transfer', { token: descriptor.token }).catch(() => {});
      throw new DOMException('Raster transfer cancelled', 'AbortError');
    }
  } catch (error) {
    if (descriptor?.token) {
      await invoke('cancel_render_pdf_page_png_transfer', { token: descriptor.token }).catch(() => {});
    }
    finish(false, error?.name === 'AbortError' ? 'owner-cancelled' : 'descriptor-failed');
    throw error;
  }

  return Object.freeze({
    ...descriptor,
    attach(image) {
      if (finished || !image) return false;
      activeTransfer.image = image;
      return true;
    },
    complete() {
      activeTransfer.image = null;
      return finish(true);
    },
    cancel(reason = 'owner-cancelled') {
      if (finished) return false;
      abortRasterTransfer(activeTransfer);
      return finish(false, reason);
    },
  });
}

/**
 * Render one whole page via the user-selected engine.
 * @param {{path:string, pageIndex:number, scale:number, rotation?:number}} args
 * @returns {Promise<Uint8Array>} `[w:u32 LE][h:u32 LE][rgba…]` wire format
 */
export async function renderPdfPage({ path, pageIndex, scale, rotation = 0 }) {
  const command = (state?.renderEngineOverride === 'rust-skia')
    ? 'render_pdf_page_skia'
    : 'render_pdf_page';
  return invoke(command, { path, pageIndex, scale, rotation });
}

function bitmapFromRgbaResponse(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.length <= 8) throw new Error('renderer returned an empty RGBA response');
  const header = new DataView(bytes.buffer, bytes.byteOffset, 8);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const length = width * height * 4;
  if (!width || !height || length !== bytes.length - 8) {
    throw new Error('renderer returned inconsistent RGBA dimensions');
  }
  return createImageBitmap(new ImageData(
    new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, length),
    width,
    height,
  )).then((bitmap) => ({ bitmap, width, height, encoding: 'rgba' }));
}

/**
 * Render directly to an ImageBitmap. PDFium uses a compact lossless PNG IPC
 * payload so page-sized RGBA response buffers do not accumulate in the macOS
 * GUI allocator. The diagnostic Skia override keeps its existing RGBA wire
 * contract and is normalized here.
 */
export async function renderPdfPageBitmap({
  path,
  pageIndex,
  scale,
  rotation = 0,
  cssScale = scale,
  devicePixelRatio = 1,
  quality = 'final',
  ownerGeneration = 0,
  rasterKey = '',
  requestId = '',
}) {
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  incrementPerformanceCounter('rasterRequested');
  recordPerformanceEvent('raster:requested', {
    pageNum: Number(pageIndex) + 1,
    scale,
    cssScale,
    devicePixelRatio,
    quality,
    ownerGeneration,
    rasterKey,
    requestId,
  });
  if (state?.renderEngineOverride === 'rust-skia') {
    try {
      const result = await bitmapFromRgbaResponse(await invoke('render_pdf_page_skia', {
        path, pageIndex, scale, rotation, requestId,
      }));
      const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
      incrementPerformanceCounter('rasterCompleted');
      recordPerformanceSample('rasterTransferMs', elapsed);
      recordPerformanceEvent('raster:completed', {
        pageNum: Number(pageIndex) + 1,
        scale,
        cssScale,
        devicePixelRatio,
        quality,
        ownerGeneration,
        rasterKey,
        requestId,
        transferMethod: 'tauri-rgba',
        bytes: result.width * result.height * 4,
        calls: 1,
        elapsedMs: elapsed,
      });
      return result;
    } catch (error) {
      incrementPerformanceCounter('rasterCancelled');
      recordPerformanceEvent('raster:cancelled', {
        pageNum: Number(pageIndex) + 1,
        scale,
        quality,
        ownerGeneration,
        rasterKey,
        requestId,
        transferMethod: 'tauri-rgba',
      });
      throw error;
    }
  }
  const transferId = `${requestId || rasterKey || `${path}:${pageIndex}`}:${++nextRasterTransferId}`;
  const controller = new AbortController();
  const activeTransfer = { path, token: null, controller };
  activeRasterTransfers.set(transferId, activeTransfer);
  let transferMethod = 'loopback-png-stream';
  let totalBytes = 0;
  let expectedWidth = 0;
  let expectedHeight = 0;
  let calls = 0;
  let bitmap = null;
  try {
    let transfer = await invoke('begin_render_pdf_page_png', {
      path, pageIndex, scale, rotation, preferStream: true, requestId,
    });
    activeTransfer.token = transfer?.token || null;
    if (controller.signal.aborted) {
      if (activeTransfer.token) {
        await invoke('cancel_render_pdf_page_png_transfer', { token: activeTransfer.token }).catch(() => {});
      }
      throw new DOMException('Raster transfer cancelled', 'AbortError');
    }
    const validateDescriptor = () => {
      totalBytes = Number(transfer?.bytes) || 0;
      expectedWidth = Number(transfer?.width) || 0;
      expectedHeight = Number(transfer?.height) || 0;
      if (!transfer?.token || totalBytes <= 0 || expectedWidth <= 0 || expectedHeight <= 0) {
        throw new Error('renderer returned an invalid PNG transfer descriptor');
      }
    };
    validateDescriptor();

    if (transfer.url) {
      try {
        calls = 1;
        bitmap = await decodeStreamedPng(
          transfer.url,
          controller.signal,
          expectedWidth,
          expectedHeight,
          totalBytes,
        );
        recordPerformancePeak('streamResponseBytes', totalBytes);
      } catch (streamError) {
        if (controller.signal.aborted) throw streamError;
        const streamFailure = streamError?.message || String(streamError);
        recordPerformanceEvent('raster:stream-fallback', {
          pageNum: Number(pageIndex) + 1,
          ownerGeneration,
          rasterKey,
          reason: streamFailure,
        });
        console.warn(`[render-stream] falling back to 16 KiB invoke chunks: ${streamFailure}`);
        await invoke('cancel_render_pdf_page_png_transfer', { token: transfer.token }).catch(() => {});
        // The 16 KiB invoke path remains a complete recovery route when the
        // private loopback stream is unavailable or rejected by the WebView.
        transferMethod = 'tauri-png-chunks-fallback';
        transfer = await invoke('begin_render_pdf_page_png', {
          path, pageIndex, scale, rotation, preferStream: false, requestId,
        });
        activeTransfer.token = transfer?.token || null;
        validateDescriptor();
      }
    } else {
      transferMethod = 'tauri-png-chunks-fallback';
    }

    if (!bitmap) {
      const chunks = [];
      recordPerformancePeak('transferBufferBytes', totalBytes);
      let offset = 0;
      calls = 0;
      while (offset < totalBytes) {
        const raw = await invoke('read_render_pdf_page_png_chunk', {
          token: transfer.token, offset,
        });
        calls += 1;
        const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const expected = Math.min(Number(transfer.chunkBytes) || 16 * 1024, totalBytes - offset);
        if (!chunk.length || chunk.length !== expected) {
          throw new Error('renderer returned an inconsistent PNG transfer chunk');
        }
        chunks.push(chunk);
        offset += chunk.length;
      }
      bitmap = await createImageBitmap(new Blob(chunks, { type: 'image/png' }));
    }

    if (bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) {
      try { bitmap.close?.(); } catch {}
      throw new Error('renderer decoded PNG dimensions do not match the transfer');
    }
  } catch (error) {
    if (activeTransfer.token) {
      await invoke('cancel_render_pdf_page_png_transfer', { token: activeTransfer.token }).catch(() => {});
    }
    incrementPerformanceCounter('rasterCancelled');
    recordPerformanceEvent('raster:cancelled', {
      pageNum: Number(pageIndex) + 1,
      scale,
      cssScale,
      devicePixelRatio,
      quality,
      ownerGeneration,
      rasterKey,
      transferMethod,
      bytes: totalBytes,
      calls,
    });
    throw error;
  } finally {
    activeRasterTransfers.delete(transferId);
  }
  const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
  incrementPerformanceCounter('rasterCompleted');
  incrementPerformanceCounter('rasterTransferCalls', calls);
  incrementPerformanceCounter('rasterTransferBytes', totalBytes);
  recordPerformanceSample('rasterTransferMs', elapsed);
  recordPerformanceEvent('raster:completed', {
    pageNum: Number(pageIndex) + 1,
    scale,
    cssScale,
    devicePixelRatio,
    quality,
    ownerGeneration,
    rasterKey,
    transferMethod,
    bytes: totalBytes,
    calls,
    elapsedMs: elapsed,
  });
  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    encoding: 'png',
  };
}

/**
 * Diagnostic: which engine WOULD a whole-page render use right now?
 * Useful for status-bar labels and PERF logging without dispatching a
 * render.
 */
export function currentRenderEngine() {
  return (state?.renderEngineOverride === 'rust-skia') ? 'rust-skia' : 'pdfium';
}
