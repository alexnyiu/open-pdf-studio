import { comparisonGeneration, onComparisonDispose } from './comparison-session.js';
// Compare viewport orchestration.
// Loads each chosen PDF (re-using cached bytes when available), renders the
// requested page from each into an offscreen canvas at a target scale, and
// either lays them side-by-side or composes them into an overlay.
//
// Public API:
//   renderCompareSideBySide(canvasOld, canvasNew, opts)
//   renderCompareOverlay(canvasOut, opts)
//   getDocPageCount(filePath)
//
// Where opts = { oldPath, newPath, oldPage, newPage, scale, offset }

import * as pdfjsLib from 'pdfjs-dist';
import { getCachedPdfBytes } from '../pdf/loader.js';
import { drawHighlights } from './overlay-renderer.js';
import { setChanges, setCompareDetecting, setCompareVisualError } from './compare-store.js';

// Cap detection resolution to keep CPU bounded on huge pages.
const DETECTION_MAX_DIM = 1600;
let _detectTimer = null;
let _detectSeq = 0;
let _cancelDetectionWorker = null;

// Cache of pdfjs documents per filePath used by compare mode only — we don't
// reuse the document loaded by the main viewer because pdf.js transfers the
// underlying buffer; we always slice() bytes from originalBytesCache.
const _docCache = new Map();
const _pendingDocs = new Map();
const _renderTasks = new Set();

// Cache of rasterized ImageData used by change detection. Keyed by
// `${filePath}|${pageNum}|${scale}`. The same OLD rasterization is reused
// across multiple detection passes (only the NEW side changes when the user
// edits offsets, etc.). Capped to a small LRU to bound memory.
const _imageDataCache = new Map();
const _IMG_CACHE_MAX = 6;

// Cache van kant-en-klare detectieresultaten per pagina-paar (LRU). Bladeren
// door een multi-page vergelijking her-diffde voorheen élk bezoek aan een paar
// volledig; met deze cache is terugkeren naar een al bekeken paar direct.
// Sleutel bevat het uitlijnings-offset (en de schaal waarin dat offset is
// uitgedrukt) omdat detectie daarvan afhangt; zonder offset is de schaal
// irrelevant (zoom-only renders slaan detectie sowieso over).
const _changesCache = new Map();
const _CHANGES_CACHE_MAX = 24;

const sourceRevisionIds = new WeakMap();
let nextSourceRevision = 0;
function sourceRevisionKey(filePath) {
  const bytes = getCachedPdfBytes(filePath) || _docCache.get(filePath)?.bytes;
  if (!bytes) return 'missing';
  if (!sourceRevisionIds.has(bytes)) sourceRevisionIds.set(bytes, ++nextSourceRevision);
  return sourceRevisionIds.get(bytes);
}

function _changesCacheKey(opts) {
  const { oldPath, newPath, oldPage, newPage, offset = {}, scale } = opts;
  const dx = offset.dx || 0;
  const dy = offset.dy || 0;
  const rot = offset.rotation || 0;
  const offKey = (dx === 0 && dy === 0 && rot === 0) ? '0' : `${dx},${dy},${rot},${scale || 1.5}`;
  return `${oldPath}|${sourceRevisionKey(oldPath)}|${oldPage}|${newPath}|${sourceRevisionKey(newPath)}|${newPage}|${offKey}`;
}

function _imgCacheGet(key) {
  if (!_imageDataCache.has(key)) return null;
  // LRU bump
  const v = _imageDataCache.get(key);
  _imageDataCache.delete(key);
  _imageDataCache.set(key, v);
  return v;
}
function _imgCacheSet(key, v) {
  if (_imageDataCache.has(key)) _imageDataCache.delete(key);
  _imageDataCache.set(key, v);
  while (_imageDataCache.size > _IMG_CACHE_MAX) {
    const first = _imageDataCache.keys().next().value;
    _imageDataCache.delete(first);
  }
}

async function _getDoc(filePath) {
  const bytes = getCachedPdfBytes(filePath);
  if (!bytes) throw new Error('Compare: no cached bytes for ' + filePath);
  const cached = _docCache.get(filePath);
  if (cached?.bytes === bytes) return cached.doc;
  if (cached) { void cached.doc.destroy(); _docCache.delete(filePath); _imageDataCache.clear(); _changesCache.clear(); }
  const pending = _pendingDocs.get(filePath);
  if (pending?.bytes === bytes) return pending.promise;
  const generation = comparisonGeneration();
  const task = pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: '/pdfjs/web/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdfjs/web/standard_fonts/', isEvalSupported: false, verbosity: 0 });
  const entry = { bytes, task, promise: null };
  entry.promise = task.promise.then(async doc => {
    if (generation !== comparisonGeneration() || getCachedPdfBytes(filePath) !== bytes) {
      await doc.destroy(); throw new DOMException('Comparison source changed', 'AbortError');
    }
    _docCache.set(filePath, { bytes, doc }); return doc;
  }).finally(() => { if (_pendingDocs.get(filePath) === entry) _pendingDocs.delete(filePath); });
  _pendingDocs.set(filePath, entry);
  return entry.promise;
}

// Het compare-eigen pdf.js-document voor een pad — ook gebruikt door de
// tekstvergelijking (text-compare.js) zodat die geen tweede kopie laadt.
export function getCompareDoc(filePath) {
  return _getDoc(filePath);
}

export function clearCompareDocCache() {
  _detectSeq++; clearTimeout(_detectTimer);
  _cancelDetectionWorker?.();
  for (const task of _renderTasks) task.cancel();
  _renderTasks.clear();
  for (const entry of _pendingDocs.values()) void entry.task.destroy().catch(() => {});
  _pendingDocs.clear();
  for (const { doc } of _docCache.values()) {
    try { void doc.destroy().catch(() => {}); } catch {}
  }
  _docCache.clear();
  _imageDataCache.clear();
  _changesCache.clear();
}

export async function getDocPageCount(filePath) {
  if (!filePath) return 0;
  try {
    const d = await _getDoc(filePath);
    return d.numPages;
  } catch {
    return 0;
  }
}

async function _renderPageToCanvas(filePath, pageNum, scale, targetCanvas, fillWhite = true) {
  const generation = comparisonGeneration();
  const doc = await _getDoc(filePath);
  const page = await doc.getPage(Math.max(1, Math.min(doc.numPages, pageNum)));
  const viewport = page.getViewport({ scale });
  targetCanvas.width = Math.ceil(viewport.width);
  targetCanvas.height = Math.ceil(viewport.height);
  const ctx = targetCanvas.getContext('2d');
  if (fillWhite) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  }
  const task = page.render({ canvasContext: ctx, viewport, intent: 'display' });
  _renderTasks.add(task);
  try { await task.promise; } finally { _renderTasks.delete(task); }
  if (generation !== comparisonGeneration()) throw new DOMException('Comparison cancelled', 'AbortError');
  return { width: targetCanvas.width, height: targetCanvas.height, viewport };
}

export async function renderCompareSideBySide(canvasOld, canvasNew, opts) {
  const { oldPath, newPath, oldPage, newPage, scale = 1.5, skipDetection = false } = opts;
  await Promise.all([
    _renderPageToCanvas(oldPath, oldPage, scale, canvasOld),
    _renderPageToCanvas(newPath, newPage, scale, canvasNew),
  ]);
  // Change detection is mode-independent: bboxes live in a fixed detection-px
  // space regardless of whether the pages are shown overlaid or side-by-side.
  // Kick it off here too so side-by-side gets the same red/green/yellow diff
  // highlights and the change list. Skipped on zoom-only re-renders.
  if (!skipDetection) scheduleChangeDetection(opts);
  return { width: canvasNew.width, height: canvasNew.height };
}

/**
 * Render the compare overlay.
 *
 * The base canvas (canvasNew) shows the NEW page rendered NORMALLY — black ink
 * on white background, no tint. The differences between OLD and NEW are then
 * highlighted by translucent colored rectangles drawn on a separate overlay
 * canvas (canvasHighlights). The OLD canvas is kept hidden (still rasterized
 * for change detection only).
 *
 * Returns { width, height } of the rendered surface so the caller can size
 * its DOM containers.
 */
export async function renderCompareOverlay(canvasOld, canvasNew, opts, canvasHighlights = null) {
  const { newPath, newPage, scale = 1.5, skipDetection = false } = opts;

  // Render NEW normally — this is the visible base layer. The OLD page is
  // never drawn into a visible canvas in overlay mode (only rasterized for
  // change detection below). This avoids one full PDF.js render pass on
  // every zoom step, which was the dominant cost.
  await _renderPageToCanvas(newPath, newPage, scale, canvasNew);

  // Size the highlights canvas to match NEW; the actual rectangles are drawn
  // separately by paintHighlights() once changes are detected.
  if (canvasHighlights) {
    canvasHighlights.width = canvasNew.width;
    canvasHighlights.height = canvasNew.height;
    const ctx = canvasHighlights.getContext('2d');
    ctx.clearRect(0, 0, canvasHighlights.width, canvasHighlights.height);
  }

  // Kick off async, debounced change detection on a separately rasterized copy
  // of both pages. Visual rendering is not blocked. Skipped when the caller
  // knows only zoom (which doesn't affect detection results) has changed.
  if (!skipDetection) scheduleChangeDetection(opts);

  return { width: canvasNew.width, height: canvasNew.height };
}

/**
 * Paint diff highlights onto an overlay canvas. Pure presentation — the change
 * list itself is computed elsewhere (change-detector.js / scheduleChangeDetection).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array} changes
 * @param {Object} opts — { ratio, visibleTypes, selected }
 */
export function paintHighlights(canvas, changes, opts) {
  drawHighlights(canvas, changes, opts);
}

/**
 * Off-screen rasterize both pages to plain black-on-white at a bounded
 * resolution and run detectChanges(). Result is pushed into the compare-store.
 * Debounced so rapid zoom/offset changes don't spam the work.
 */
export function scheduleChangeDetection(opts) {
  setCompareVisualError(null);
  if (_detectTimer) {
    clearTimeout(_detectTimer);
    _detectTimer = null;
  }
  const seq = ++_detectSeq;
  _cancelDetectionWorker?.();
  const key = _changesCacheKey(opts);
  const cached = _changesCache.get(key);
  if (cached) {
    // LRU-bump en direct toepassen — geen debounce nodig voor een cache-hit,
    // zodat bladeren naar een al bekeken paar meteen de juiste lijst toont.
    _changesCache.delete(key);
    _changesCache.set(key, cached);
    setChanges(cached);
    setCompareDetecting(false);
    return;
  }
  setCompareDetecting(true);
  _detectTimer = setTimeout(async () => {
    _detectTimer = null;
    try {
      const result = await runChangeDetection(opts, seq);
      // Drop result if a newer detection has been queued.
      if (seq !== _detectSeq) return;
      _changesCache.set(key, result);
      while (_changesCache.size > _CHANGES_CACHE_MAX) {
        _changesCache.delete(_changesCache.keys().next().value);
      }
      setChanges(result);
      setCompareDetecting(false);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[compare] change detection failed', err);
      if (seq === _detectSeq) {
        setChanges([]);
        setCompareVisualError(err.message || 'Comparison failed');
        setCompareDetecting(false);
      }
    }
  }, 200);
}

async function _rasterizeForDetection(filePath, pageNum, detectScale) {
  const generation = comparisonGeneration();
  const key = `${filePath}|${sourceRevisionKey(filePath)}|${pageNum}|${detectScale}`;
  const cached = _imgCacheGet(key);
  if (cached) return cached;
  const c = document.createElement('canvas');
  await _renderPageToCanvas(filePath, pageNum, detectScale, c);
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  const entry = { width: c.width, height: c.height, data };
  c.width = c.height = 0;
  if (generation !== comparisonGeneration()) throw new DOMException('Comparison cancelled', 'AbortError');
  _imgCacheSet(key, entry);
  return entry;
}

async function runChangeDetection(opts, seq) {
  const { oldPath, newPath, oldPage, newPage, offset = { dx: 0, dy: 0, rotation: 0 } } = opts;
  if (!oldPath || !newPath) return [];

  // Pick a modest scale capped by DETECTION_MAX_DIM so CPU stays bounded.
  // Use NEW page's natural size at scale=1 to set the target dimensions.
  const newDoc = await _getDoc(newPath);
  const np = await newDoc.getPage(Math.max(1, Math.min(newDoc.numPages, newPage)));
  const baseVp = np.getViewport({ scale: 1 });
  const longest = Math.max(baseVp.width, baseVp.height);
  const detectScale = Math.min(1.5, DETECTION_MAX_DIM / longest);

  // Rasterize both at detectScale, reusing cached ImageData when available.
  // This is the hot path on offset/page changes — detection scale is fixed
  // per (path,page), so cache hits are guaranteed across repeated calls.
  const [oldEntry, newEntry] = await Promise.all([
    _rasterizeForDetection(oldPath, oldPage, detectScale),
    _rasterizeForDetection(newPath, newPage, detectScale),
  ]);

  // Apply alignment offset to OLD so detection respects the same alignment as
  // the visual overlay. NEW remains at native position. We blit the cached
  // OLD ImageData into a fresh aligned canvas (cheap drawImage of an
  // ImageBitmap-equivalent vs a full PDF.js re-render).
  const cOldAligned = document.createElement('canvas');
  cOldAligned.width = newEntry.width;
  cOldAligned.height = newEntry.height;
  const aCtx = cOldAligned.getContext('2d');
  aCtx.fillStyle = '#ffffff';
  aCtx.fillRect(0, 0, cOldAligned.width, cOldAligned.height);

  // Materialize cached OLD ImageData onto an offscreen canvas to draw with
  // alignment transform (putImageData ignores transforms).
  const oldRaw = document.createElement('canvas');
  oldRaw.width = oldEntry.width;
  oldRaw.height = oldEntry.height;
  oldRaw.getContext('2d').putImageData(oldEntry.data, 0, 0);

  aCtx.save();
  const visualScale = opts.scale || 1.5;
  const off = {
    dx: (offset.dx || 0) * (detectScale / visualScale),
    dy: (offset.dy || 0) * (detectScale / visualScale),
    rotation: offset.rotation || 0,
  };
  aCtx.translate(off.dx, off.dy);
  if (off.rotation) {
    aCtx.translate(cOldAligned.width / 2, cOldAligned.height / 2);
    aCtx.rotate((off.rotation * Math.PI) / 180);
    aCtx.translate(-cOldAligned.width / 2, -cOldAligned.height / 2);
  }
  aCtx.drawImage(oldRaw, 0, 0);
  aCtx.restore();

  const oldData = aCtx.getImageData(0, 0, cOldAligned.width, cOldAligned.height);
  const newData = newEntry.data;

  cOldAligned.width = cOldAligned.height = oldRaw.width = oldRaw.height = 0;
  if (seq !== _detectSeq) throw new DOMException('Comparison superseded', 'AbortError');
  const changes = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./visual-compare-worker.js', import.meta.url), { type: 'module' });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); worker.terminate();
      if (_cancelDetectionWorker === cancel) _cancelDetectionWorker = null;
      error ? reject(error) : resolve(result);
    };
    const cancel = () => finish(new DOMException('Comparison cancelled', 'AbortError'));
    _cancelDetectionWorker = cancel;
    // Exhaustive raster clustering is bounded in wall time; label fallback honestly.
    const timer = setTimeout(() => finish(null, [{ type: 'modified', x: 0, y: 0,
      width: newData.width, height: newData.height, pixelCount: 0, partial: true }]), 10000);
    worker.onmessage = ({ data }) => {
      if (data.id !== seq) return;
      finish(data.error ? new Error(data.error) : null, data.changes);
    };
    worker.onerror = event => finish(new Error(event.message || 'Comparison worker failed'));
    try {
      // Keep the session's cached image intact; transfer only independently owned buffers.
      const copiedNew = { width: newData.width, height: newData.height, data: newData.data.slice() };
      worker.postMessage({ id: seq, oldData, newData: copiedNew }, [oldData.data.buffer, copiedNew.data.buffer]);
    } catch (error) { finish(error); }
  });
  // Tag the detection scale so the UI can map bbox px back to display px.
  return changes.map(c => ({ ...c, detectScale }));
}

onComparisonDispose(clearCompareDocCache);

export function comparisonRenderResourceSnapshot() {
  return { documents: _docCache.size, pendingDocuments: _pendingDocs.size,
    runningRenders: _renderTasks.size, detectionWorker: _cancelDetectionWorker ? 1 : 0,
    images: _imageDataCache.size, changes: _changesCache.size,
    imageBytes: [..._imageDataCache.values()].reduce((sum, entry) => sum + (entry.data?.data?.byteLength || 0), 0) };
}
