/**
 * High-res page bitmap cache for sharp rendering at high zoom levels.
 *
 * Strategy: when the user zooms in, the vector renderer draws raster images
 * at their native source resolution and upsamples them, causing blur. To
 * match the sharpness of professional PDF viewers, we re-rasterize the
 * entire page via the Rust renderer at a zoom-appropriate DPI and use that
 * bitmap as the page background. The vector layer is then drawn on top so
 * text and lines stay vector-crisp.
 *
 * The cache is keyed by document/lifecycle/content/page revision, path,
 * rotation, density, and quality. Density buckets bound
 * memory growth and limit re-renders to actually-different scales.
 */

import { isTauri, invoke } from '../core/platform.js';
import {
  registerRenderResource,
  touchRenderResource,
  unregisterRenderResource,
  isActiveRenderDocument,
} from './render-resource-budget.js';
import {
  RasterQuality,
  chooseBestRaster,
  createPageRasterKey,
  rasterCanSatisfy,
  serializePageRasterKey,
} from './page-raster.js';
import {
  incrementPerformanceCounter,
  recordPerformanceEvent,
  recordPerformancePeak,
} from './performance-metrics.js';
import {
  recordRejectedRenderPublication,
  releaseStaleRenderResult,
  renderPublicationTokenIsCurrent,
} from './render-publication-token.js';

// Map<key, { bitmap: ImageBitmap, w, h, scale }>
const _cache = new Map();

// In-flight renders so we don't double-fire for the same key
const _pending = new Map(); // key -> Promise
const _pendingOwners = new Map();
const _fileOwners = new Map();
const _fileOwnerGenerations = new Map();
const _fileContentRevisionReaders = new Map();
const _filePageRevisionReaders = new Map();
const _fileGenerations = new Map();
let _globalGeneration = 0;

export const LARGE_DOCUMENT_IDLE_BITMAP_BYTES = 32 * 1024 * 1024;

export function registerPageBitmapCacheOwner(
  filePath,
  documentId,
  lifecycleGeneration = 0,
  pageRevisionReader = null,
  contentRevisionReader = null,
) {
  if (!filePath || !documentId) return;
  _fileOwners.set(filePath, documentId);
  _fileOwnerGenerations.set(filePath, Math.max(0, Number(lifecycleGeneration) || 0));
  if (typeof contentRevisionReader === 'function') {
    _fileContentRevisionReaders.set(filePath, contentRevisionReader);
  }
  if (typeof pageRevisionReader === 'function') {
    _filePageRevisionReaders.set(filePath, pageRevisionReader);
  }
  for (const [key, entry] of _cache) {
    const pageNum = entry?.rasterKey?.filePath === filePath
      ? entry.rasterKey.pageNum
      : _pageNumFromKey(filePath, key);
    if (!pageNum) continue;
    _registerEntry(key, entry, filePath, pageNum);
  }
}

function _legacyKey(filePath, pageNum, rotation, zoomBucket) {
  return `${filePath}:${pageNum}:${(rotation || 0) % 360}:${zoomBucket}`;
}

function _rasterRequest(filePath, pageNum, rotation, targetRasterScale, context = {}) {
  const quality = context.quality === RasterQuality.PREVIEW
    ? RasterQuality.PREVIEW
    : RasterQuality.FINAL;
  const documentId = context.documentId || _fileOwners.get(filePath) || filePath;
  const lifecycleGeneration = Number.isFinite(Number(context.lifecycleGeneration))
    ? Number(context.lifecycleGeneration)
    : (_fileOwnerGenerations.get(filePath) || 0);
  const contentRevisionReader = _fileContentRevisionReaders.get(filePath);
  const contentRevision = Number.isFinite(Number(context.contentRevision))
    ? Number(context.contentRevision)
    : (Number(contentRevisionReader?.()) || 0);
  const revisionReader = _filePageRevisionReaders.get(filePath);
  const pageRevision = Number.isFinite(Number(context.pageRevision))
    ? Number(context.pageRevision)
    : (Number(revisionReader?.(pageNum)) || 0);
  const cssScale = Number(context.cssScale) || Number(targetRasterScale) || 1;
  const devicePixelRatio = Number(context.devicePixelRatio) || 1;
  const target = Number(context.targetRasterScale) || Number(targetRasterScale) || 1;
  const key = createPageRasterKey({
    documentId,
    lifecycleGeneration,
    contentRevision,
    pageRevision,
    filePath,
    pageNum,
    rotation,
    cssScale,
    devicePixelRatio,
    quality,
  });
  return Object.freeze({ key, quality, targetRasterScale: target });
}

function _rasterCacheKey(request) {
  return `raster:${serializePageRasterKey(request.key)}`;
}

function _entryMatchesPage(entry, filePath, pageNum, rotation) {
  if (entry?.rasterKey) {
    return entry.rasterKey.filePath === filePath
      && entry.rasterKey.pageNum === Number(pageNum)
      && entry.rasterKey.rotation === (((Number(rotation) || 0) % 360) + 360) % 360;
  }
  return entry?.filePath === filePath
    && entry?.pageNum === Number(pageNum)
    && entry?.rotation === (((Number(rotation) || 0) % 360) + 360) % 360;
}

function _entriesForPage(filePath, pageNum, rotation) {
  return [..._cache.entries()]
    .filter(([, entry]) => _entryMatchesPage(entry, filePath, pageNum, rotation));
}

function _touchEntry(cacheKey, entry) {
  _cache.delete(cacheKey);
  _cache.set(cacheKey, entry);
  entry.lastUsedAt = globalThis.performance?.now?.() ?? Date.now();
  touchRenderResource(_resourceKey(cacheKey));
  return entry;
}

function _pageNumFromKey(filePath, key) {
  const entry = _cache.get(key);
  if (entry?.rasterKey?.filePath === filePath) return entry.rasterKey.pageNum;
  if (entry?.filePath === filePath) return entry.pageNum;
  const prefix = `${filePath}:`;
  if (!key.startsWith(prefix)) return null;
  const pageNum = Number(key.slice(prefix.length).split(':')[0]);
  return Number.isInteger(pageNum) && pageNum > 0 ? pageNum : null;
}

const _entryBytes = (entry) => Math.max(0, (entry?.w || 0) * (entry?.h || 0) * 4);

const _resourceKey = (key) => `page-bitmap:${key}`;

function _recordDecodedBitmapMemory() {
  recordPerformancePeak(
    'decodedBitmapBytes',
    [..._cache.values()].reduce((sum, entry) => sum + _entryBytes(entry), 0),
  );
}

function _registerEntry(key, entry, filePath, pageNum) {
  registerRenderResource({
    key: _resourceKey(key),
    category: 'javascript',
    documentId: _fileOwners.get(filePath) || filePath,
    bytes: (entry.w || 0) * (entry.h || 0) * 4,
    protected: () => {
      if (typeof window === 'undefined') return false;
      const ownerIsActive = isActiveRenderDocument(_fileOwners.get(filePath) || filePath);
      return (window.__pdfViewport?.filePath === filePath && window.__pdfViewport?.pageNum === pageNum)
        || (ownerIsActive && typeof document !== 'undefined'
          && (() => {
            const wrapper = document.querySelector?.(
              `#continuous-container .page-wrapper[data-page="${pageNum}"]`,
            );
            const activePage = Number(globalThis.window?.__continuousCurrentPage) || 0;
            return wrapper?.dataset?.strictlyVisible === 'true' || activePage === pageNum;
          })());
    },
    release: () => {
      const current = _cache.get(key);
      try { current?.bitmap?.close?.(); } catch {}
      _cache.delete(key);
      _recordDecodedBitmapMemory();
    },
  });
}

function _releaseSupersededRevisionEntries(request) {
  if (!request?.key) return;
  const current = request.key;
  for (const [key, entry] of _cache) {
    const cached = entry?.rasterKey;
    if (!cached
        || cached.documentId !== current.documentId
        || cached.lifecycleGeneration !== current.lifecycleGeneration) continue;
    const obsoleteContent = cached.contentRevision !== current.contentRevision;
    const obsoletePage = cached.pageNum === current.pageNum
      && cached.pageRevision !== current.pageRevision;
    if (!obsoleteContent && !obsoletePage) continue;
    try { entry.bitmap?.close?.(); } catch {}
    _cache.delete(key);
    unregisterRenderResource(_resourceKey(key));
  }
  _recordDecodedBitmapMemory();
}

// Compute the zoom bucket (power of 2) to render at, given a target scale.
// We round UP to the next power of 2 so we always have at least the requested
// resolution.
//
// WHOLE-PAGE callers must clamp the quantized result with
// computeCappedWholePageScale(). Clamping only the input is insufficient:
// targetScale=5 with a 5.17 cap rounds up to bucket=8 and silently exceeds a
// 4096 px axis again.
//
// For TILE bitmaps the caller passes viewport.zoom * dpr unbounded. Here
// the bucket can grow with zoom — but the tile bitmap pixel size is bounded
// by the VISIBLE viewport region (typically 600-1000 px on each axis at
// css scale), so even at bucket=64 the tile stays well under PDFium's limit.
//
// Before this change the bucket was capped at 16, which meant every zoom
// above 8x shared the same cache key. The first tile rendered at that
// bucket "owned" it; subsequent zooms within the bucket got the SAME
// (lower-zoom) tile drawn stretched at higher css zoom — the user
// reported this as "zoom > 600% suddenly picks a worse-resolution tile".
export function computeZoomBucket(targetScale) {
  if (!Number.isFinite(targetScale) || targetScale <= 0) return 0.125;
  // ─── SUB-1 BUCKETS (huge-page first-paint speedup) ─────────────────────
  // Without these the orchestrator always renders at scale=1.0 for any
  // zoom ≤ 1.0, which on a 5156×2384 pt construction page = 5157×2384 px
  // bitmap = 46 MB and 3+ s of PDFium CPU. At fit-zoom (~0.13) the user
  // is only displaying a 1005×465 px viewport — rendering at scale=0.25
  // gives a 1289×596 px bitmap that downsamples crisply, while saving
  // 500-1000 ms PDFium time and ~95 % of memory per cached bitmap.
  if (targetScale <= 0.125) return 0.125;
  if (targetScale <= 0.25) return 0.25;
  if (targetScale <= 0.5) return 0.5;
  if (targetScale <= 1) return 1;
  if (targetScale <= 2) return 2;
  if (targetScale <= 4) return 4;
  if (targetScale <= 8) return 8;
  if (targetScale <= 16) return 16;
  if (targetScale <= 32) return 32;
  if (targetScale <= 64) return 64;
  return 128;
}

/** Quantize for reuse without ever exceeding a whole-page bitmap axis cap. */
export function computeCappedWholePageScale(targetScale, maximumScale) {
  const bucket = computeZoomBucket(targetScale);
  const cap = Number(maximumScale);
  return Number.isFinite(cap) && cap > 0 ? Math.min(bucket, cap) : bucket;
}

export function getCachedBitmap(filePath, pageNum, rotation, zoomBucket, context = null) {
  if (context) {
    const request = _rasterRequest(filePath, pageNum, rotation, zoomBucket, context);
    const exactKey = _rasterCacheKey(request);
    const exact = _cache.get(exactKey);
    if (exact) return _touchEntry(exactKey, exact);
    const candidate = chooseBestRaster(
      _entriesForPage(filePath, pageNum, rotation).map(([, entry]) => entry),
      request,
    );
    if (candidate) {
      const candidateKey = _entriesForPage(filePath, pageNum, rotation)
        .find(([, entry]) => entry === candidate)?.[0];
      if (candidateKey) _touchEntry(candidateKey, candidate);
      incrementPerformanceCounter('rasterReused');
      recordPerformanceEvent('raster:reused', {
        pageNum,
        scale: candidate.actualRasterScale,
        devicePixelRatio: context.devicePixelRatio || 1,
        quality: candidate.quality,
        ownerGeneration: request.key.lifecycleGeneration,
        rasterKey: serializePageRasterKey(candidate.rasterKey),
      });
      return candidate;
    }
    return null;
  }

  const legacyKey = _legacyKey(filePath, pageNum, rotation, zoomBucket);
  const legacy = _cache.get(legacyKey);
  if (legacy) return _touchEntry(legacyKey, legacy);
  const match = _entriesForPage(filePath, pageNum, rotation)
    .find(([, entry]) => Math.abs(Number(entry.actualRasterScale ?? entry.scale) - Number(zoomBucket)) < 0.0001);
  return match ? _touchEntry(match[0], match[1]) : null;
}

/**
 * Zet een EXTERN gebouwde bitmap (bv. de progressieve accumulator) in de cache
 * onder dezelfde key als ensureBitmap, zodat zoom/pan/re-visit op deze pagina
 * cache-hits blijven (getBestAvailableBitmap vindt hem net als een normale
 * whole-page render). Sluit een eventuele vorige bitmap onder deze key.
 */
export function setCachedBitmapEntry(
  filePath,
  pageNum,
  rotation,
  zoomBucket,
  bitmap,
  w,
  h,
  scale,
  context = null,
) {
  const request = context
    ? _rasterRequest(filePath, pageNum, rotation, context.targetRasterScale || zoomBucket, context)
    : null;
  _releaseSupersededRevisionEntries(request);
  const key = request ? _rasterCacheKey(request) : _legacyKey(filePath, pageNum, rotation, zoomBucket);
  const prev = _cache.get(key);
  if (prev && prev.bitmap && prev.bitmap !== bitmap) {
    try { prev.bitmap.close && prev.bitmap.close(); } catch {}
  }
  if (prev && prev.bitmap === bitmap) {
    return _touchEntry(key, prev);
  }
  if (prev && request?.quality === RasterQuality.FINAL) {
    incrementPerformanceCounter('duplicateFinalPublications');
  }
  const entry = {
    bitmap,
    w,
    h,
    scale,
    actualRasterScale: Number(context?.actualRasterScale) || Number(scale) || Number(zoomBucket),
    targetRasterScale: Number(context?.targetRasterScale) || Number(zoomBucket),
    quality: request?.quality || RasterQuality.FINAL,
    key: request?.key || null,
    rasterKey: request?.key || null,
    filePath,
    pageNum: Number(pageNum),
    rotation: (((Number(rotation) || 0) % 360) + 360) % 360,
    lastUsedAt: globalThis.performance?.now?.() ?? Date.now(),
  };
  _cache.set(key, entry);
  _registerEntry(key, entry, filePath, pageNum);
  _recordDecodedBitmapMemory();
  return entry;
}

/**
 * Release a decoded page bitmap once a mounted surface has copied its pixels.
 *
 * The zero-delay task is intentional. Every continuation already waiting on
 * the same coalesced render promise gets to paint during the current microtask
 * checkpoint before the shared bitmap is closed. After that checkpoint the
 * page-local canvas is the single raster owner; keeping the ImageBitmap in the
 * registry would retain an equivalent full-DPR surface until the much later
 * idle-memory pass.
 */
export function releaseCachedBitmapAfterPublication(
  entry,
  { reason = 'mounted-surface-publication' } = {},
) {
  if (!entry || typeof entry !== 'object' || entry.publicationReleaseScheduled) return false;
  entry.publicationReleaseScheduled = true;
  setTimeout(() => {
    let releasedBytes = 0;
    let releasedEntries = 0;
    for (const [key, current] of _cache) {
      if (current !== entry) continue;
      releasedBytes += _entryBytes(current);
      releasedEntries += 1;
      _cache.delete(key);
      unregisterRenderResource(_resourceKey(key));
    }
    if (!releasedEntries) return;
    try { entry.bitmap?.close?.(); } catch {}
    _recordDecodedBitmapMemory();
    incrementPerformanceCounter('publishedBitmapReleases', releasedEntries);
    incrementPerformanceCounter('publishedBitmapReleasedBytes', releasedBytes);
    recordPerformanceEvent('raster:publication-owner-release', {
      pageNum: Number(entry.pageNum) || 0,
      scale: Number(entry.actualRasterScale ?? entry.scale) || 0,
      quality: entry.quality || RasterQuality.FINAL,
      ownerGeneration: Number(entry.rasterKey?.lifecycleGeneration) || 0,
      bytes: releasedBytes,
      entries: releasedEntries,
      reason,
    });
  }, 0);
  return true;
}

/**
 * Forget a registry entry after ImageBitmapRenderingContext has taken pixel
 * ownership. transferFromImageBitmap() detaches the source bitmap, so closing
 * it again is unnecessary; removing the accounting entry synchronously keeps
 * a detached surface from being offered to a later caller.
 */
export function consumeCachedBitmapAfterTransfer(
  entry,
  { reason = 'bitmaprenderer-transfer' } = {},
) {
  if (!entry || typeof entry !== 'object') return false;
  let releasedBytes = 0;
  let releasedEntries = 0;
  for (const [key, current] of _cache) {
    if (current !== entry) continue;
    releasedBytes += _entryBytes(current);
    releasedEntries += 1;
    _cache.delete(key);
    unregisterRenderResource(_resourceKey(key));
  }
  if (!releasedEntries) return false;
  entry.publicationReleaseScheduled = true;
  _recordDecodedBitmapMemory();
  incrementPerformanceCounter('publishedBitmapReleases', releasedEntries);
  incrementPerformanceCounter('publishedBitmapReleasedBytes', releasedBytes);
  incrementPerformanceCounter('bitmapRendererOwnershipTransfers', releasedEntries);
  recordPerformanceEvent('raster:publication-owner-release', {
    pageNum: Number(entry.pageNum) || 0,
    scale: Number(entry.actualRasterScale ?? entry.scale) || 0,
    quality: entry.quality || RasterQuality.FINAL,
    ownerGeneration: Number(entry.rasterKey?.lifecycleGeneration) || 0,
    bytes: releasedBytes,
    entries: releasedEntries,
    reason,
    transferMethod: 'bitmaprenderer',
  });
  return true;
}

// Find the best available cached bitmap for a target bucket: prefer exact
// match, otherwise the nearest available bucket (lower preferred for speed,
// higher acceptable as fallback during downscale).
export function getBestAvailableBitmap(filePath, pageNum, rotation, targetBucket, context = null) {
  const exact = getCachedBitmap(filePath, pageNum, rotation, targetBucket, context);
  if (exact) return exact;
  if (context) {
    const request = _rasterRequest(filePath, pageNum, rotation, targetBucket, context);
    const candidates = _entriesForPage(filePath, pageNum, rotation)
      .filter(([, entry]) => entry?.rasterKey
        && entry.rasterKey.documentId === request.key.documentId
        && entry.rasterKey.lifecycleGeneration === request.key.lifecycleGeneration
        && entry.rasterKey.pageRevision === request.key.pageRevision)
      .sort(([, left], [, right]) => {
        const leftDistance = Math.abs(Math.log2(left.actualRasterScale) - Math.log2(request.targetRasterScale));
        const rightDistance = Math.abs(Math.log2(right.actualRasterScale) - Math.log2(request.targetRasterScale));
        return leftDistance - rightDistance;
      });
    if (candidates.length) return _touchEntry(candidates[0][0], candidates[0][1]);
  }
  // Search by proximity (in log space) to targetBucket. Includes the higher
  // buckets that computeZoomBucket can now produce so a tile prefetched at
  // scale=1.0 (bucket=1) is still findable as a fallback at zoom 16x or
  // higher (bucket=16 or 32).
  const buckets = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128];
  const sorted = buckets.slice().sort((a, b) =>
    Math.abs(Math.log2(a) - Math.log2(targetBucket)) -
    Math.abs(Math.log2(b) - Math.log2(targetBucket))
  );
  for (const b of sorted) {
    const e = getCachedBitmap(filePath, pageNum, rotation, b, context);
    if (e) return e;
  }
  return null;
}

/**
 * Trigger an async render for the given key. Returns the existing promise if
 * one is already in flight. Resolves to the cached entry (or null on failure).
 */
export function ensureBitmap(filePath, pageNum, rotation, zoomBucket, context = null) {
  return _ensureBitmapAtScale(filePath, pageNum, rotation, zoomBucket, zoomBucket, context);
}

/**
 * Background prefetch: render a small fallback bitmap and cache it under
 * `cacheBucket` so getBestAvailableBitmap finds it as a stretched fallback
 * on first user navigation. Intended for tile-classified pages where the
 * cold PDFium render at full scale=1.0 produces a 50+ MB bitmap (NKD1a's
 * construction drawings). Renders at `prefetchScale` (typically 0.25–0.5)
 * for a much smaller bitmap, cached under `cacheBucket=1` so any later
 * targetBucket finds it via the proximity-sort search.
 */
export function prefetchFallbackBitmap(filePath, pageNum, rotation, prefetchScale, context = null) {
  return _ensureBitmapAtScale(filePath, pageNum, rotation, 1, prefetchScale, {
    ...(context || {}),
    quality: RasterQuality.PREVIEW,
    targetRasterScale: prefetchScale,
  });
}

function _ensureBitmapAtScale(filePath, pageNum, rotation, cacheBucket, renderScale, context = null) {
  const request = context
    ? _rasterRequest(filePath, pageNum, rotation, context.targetRasterScale || renderScale, context)
    : null;
  const key = request ? _rasterCacheKey(request) : _legacyKey(filePath, pageNum, rotation, cacheBucket);
  const cached = context
    ? getCachedBitmap(filePath, pageNum, rotation, cacheBucket, context)
    : _cache.get(key);
  if (cached) return Promise.resolve(cached);
  if (_pending.has(key)) {
    const owner = _pendingOwners.get(key);
    if (owner) owner.consumers = (Number(owner.consumers) || 1) + 1;
    incrementPerformanceCounter('rasterCoalesced');
    recordPerformanceEvent('raster:coalesced', {
      pageNum,
      scale: renderScale,
      devicePixelRatio: context?.devicePixelRatio || 1,
      quality: request?.quality || RasterQuality.FINAL,
      ownerGeneration: request?.key.lifecycleGeneration || 0,
      rasterKey: request ? serializePageRasterKey(request.key) : key,
    });
    return _pending.get(key);
  }
  if (!isTauri() || !filePath) return Promise.resolve(null);
  const expectedGlobalGeneration = _globalGeneration;
  const expectedFileGeneration = _fileGenerations.get(filePath) || 0;
  const expectedOwnerGeneration = request?.key.lifecycleGeneration ?? null;
  const expectedPageRevision = request?.key.pageRevision ?? null;
  const pageRevisionReader = _filePageRevisionReaders.get(filePath);
  const publicationToken = context?.publicationToken || null;
  const publicationDocument = context?.publicationDocument || null;
  const stillCurrent = () => expectedGlobalGeneration === _globalGeneration
    && expectedFileGeneration === (_fileGenerations.get(filePath) || 0)
    && (expectedOwnerGeneration == null
      || expectedOwnerGeneration === (_fileOwnerGenerations.get(filePath) || 0))
    && (expectedPageRevision == null
      || expectedPageRevision === (Number(pageRevisionReader?.(pageNum)) || 0))
    && (!publicationToken
      || renderPublicationTokenIsCurrent(publicationToken, publicationDocument));

  const p = (async () => {
    try {
      // PERF FIX #3: Rust now returns RGBA bytes directly via tauri::ipc::Response.
      // Wire format: [width u32 LE][height u32 LE][rgba bytes...]. No tempfile.
      //
      // Engine selection routed through engine-router so every whole-page
      // render path (here, loader cold-open preview, renderer.js direct
      // calls) honors the same state.renderEngineOverride consistently.
      const { renderPdfPageBitmap } = await import('./engine-router.js');
      const _t0 = performance.now();
      console.log(`[pbc] whole-page START p${pageNum} scale=${renderScale.toFixed(3)}`);
      const rendered = await renderPdfPageBitmap({
        path: filePath,
        pageIndex: pageNum - 1,
        scale: renderScale,
        rotation: rotation || 0,
        cssScale: context?.cssScale || renderScale,
        devicePixelRatio: context?.devicePixelRatio || 1,
        quality: request?.quality || RasterQuality.FINAL,
        ownerGeneration: request?.key.lifecycleGeneration || 0,
        rasterKey: request ? serializePageRasterKey(request.key) : key,
        requestId: publicationToken?.requestId || '',
      });
      if (!stillCurrent()) {
        releaseStaleRenderResult(rendered);
        recordRejectedRenderPublication(publicationToken, 'native-bitmap-returned-stale');
        return null;
      }
      console.log(`[pbc] whole-page KLAAR p${pageNum} scale=${renderScale.toFixed(3)} @${Math.round(performance.now() - _t0)}ms`);
      const { bitmap, width: w, height: h } = rendered;
      if (!stillCurrent()) {
        releaseStaleRenderResult(rendered);
        recordRejectedRenderPublication(publicationToken, 'native-bitmap-before-cache');
        return null;
      }
      import('../solid/stores/engineStatusStore.js')
        .then((m) => m.reportActiveEngine('pdfium', filePath, pageNum))
        .catch(() => {});
      const entry = setCachedBitmapEntry(
        filePath,
        pageNum,
        rotation,
        cacheBucket,
        bitmap,
        w,
        h,
        renderScale,
        request ? {
          ...context,
          quality: request.quality,
          targetRasterScale: request.targetRasterScale,
          actualRasterScale: renderScale,
        } : null,
      );
      entry.coalescedConsumers = Number(_pendingOwners.get(key)?.consumers) || 1;
      return entry;
    } catch (e) {
      console.warn('[page-bitmap-cache] render failed', e);
      return null;
    } finally {
      if (_pending.get(key) === p) {
        _pending.delete(key);
        _pendingOwners.delete(key);
      }
    }
  })();
  _pending.set(key, p);
  _pendingOwners.set(key, { filePath, pageNum, consumers: 1 });
  return p;
}

/// Drop ALL bitmap entries for a specific (filePath, pageNum). Use when page
/// content changes (e.g. annotations saved into the PDF stream).
export function invalidatePageBitmaps(filePath, pageNum) {
  _fileGenerations.set(filePath, (_fileGenerations.get(filePath) || 0) + 1);
  for (const k of Array.from(_cache.keys())) {
    const e = _cache.get(k);
    if (!_entryMatchesPage(e, filePath, pageNum, e?.rasterKey?.rotation ?? e?.rotation ?? 0)) continue;
    try { e.bitmap.close && e.bitmap.close(); } catch {}
    _cache.delete(k);
    unregisterRenderResource(_resourceKey(k));
  }
  for (const [key, owner] of _pendingOwners) {
    if (owner.filePath === filePath && owner.pageNum === Number(pageNum)) {
      _pending.delete(key);
      _pendingOwners.delete(key);
    }
  }
  _recordDecodedBitmapMemory();
}

export function clearAllBitmaps() {
  _globalGeneration += 1;
  void import('./engine-router.js').then((module) => module.cancelAllRasterTransfers()).catch(() => {});
  for (const [key, e] of _cache) {
    try { e.bitmap.close && e.bitmap.close(); } catch {}
    unregisterRenderResource(_resourceKey(key));
  }
  _cache.clear();
  _pending.clear();
  _pendingOwners.clear();
  _recordDecodedBitmapMemory();
}

export function clearBitmapsForFile(filePath) {
  if (!filePath) return;
  _fileGenerations.set(filePath, (_fileGenerations.get(filePath) || 0) + 1);
  void import('./engine-router.js')
    .then((module) => module.cancelRasterTransfersForFile(filePath))
    .catch(() => {});
  for (const [key, entry] of _cache) {
    if (entry?.rasterKey?.filePath !== filePath && entry?.filePath !== filePath
        && !key.startsWith(`${filePath}:`)) continue;
    try { entry?.bitmap?.close?.(); } catch {}
    _cache.delete(key);
    unregisterRenderResource(_resourceKey(key));
  }
  for (const [key, owner] of _pendingOwners) {
    if (owner.filePath !== filePath) continue;
    _pending.delete(key);
    _pendingOwners.delete(key);
  }
  _fileOwners.delete(filePath);
  _fileOwnerGenerations.delete(filePath);
  _fileContentRevisionReaders.delete(filePath);
  _filePageRevisionReaders.delete(filePath);
  _recordDecodedBitmapMemory();
}

/**
 * Contract the decoded full-page working set after interaction settles.
 * Visible/current/editor pages retain a usable rendered surface, as does one
 * nearest offscreen page for directional preview. In continuous view the
 * page-local canvas becomes that owner after a raster has been published.
 * Keeping the decoded ImageBitmap after that point would retain the same
 * full-DPR pixels twice, so every cache bucket for a canvas-backed page is
 * released before applying the ordinary idle byte ceiling. Blank canvases
 * that were only allocated for layout do not qualify. Old zoom buckets and
 * distant pages are then released in LRU order.
 */
export function trimIdlePageBitmaps({
  filePath,
  maximumBytes = LARGE_DOCUMENT_IDLE_BITMAP_BYTES,
  currentPageNum = null,
  protectedPageNums = [],
} = {}) {
  const emptyResult = Object.freeze({
    beforeBytes: 0,
    afterBytes: 0,
    evictedBytes: 0,
    evictedEntries: 0,
    duplicateBytesEvicted: 0,
    duplicateEntriesEvicted: 0,
  });
  if (!filePath) return emptyResult;
  const entries = [..._cache.entries()]
    .map(([key, entry]) => ({ key, entry, pageNum: _pageNumFromKey(filePath, key) }))
    .filter(({ pageNum }) => pageNum !== null);
  const beforeBytes = entries.reduce((sum, { entry }) => sum + _entryBytes(entry), 0);
  let afterBytes = beforeBytes;
  const targetBytes = Math.max(0, Number(maximumBytes) || 0);

  const current = Number(currentPageNum)
    || (globalThis.window?.__pdfViewport?.filePath === filePath
      ? Number(globalThis.window.__pdfViewport?.pageNum) : 0);
  const protectedPages = new Set(
    protectedPageNums.map(Number).filter((pageNum) => Number.isInteger(pageNum) && pageNum > 0),
  );
  const canvasBackedPages = new Set();
  let mountedDirectionalPreviewReady = false;
  if (isActiveRenderDocument(_fileOwners.get(filePath) || filePath)
      && typeof document !== 'undefined') {
    for (const wrapper of document.querySelectorAll?.('#continuous-container .page-wrapper[data-page]') || []) {
      const pageNum = Number(wrapper.dataset?.page);
      if (!Number.isInteger(pageNum) || pageNum <= 0) continue;
      const canvas = wrapper.querySelector?.('.pdf-canvas');
      const hasPublishedCanvas = (Number(canvas?.width) || 0) > 0
        && (Number(canvas?.height) || 0) > 0
        && (canvas?.dataset?.renderSurface === 'pdf'
          || wrapper.dataset?.rasterQuality === RasterQuality.FINAL
          || wrapper.dataset?.rasterQuality === RasterQuality.PREVIEW);
      if (hasPublishedCanvas) {
        canvasBackedPages.add(pageNum);
        if (wrapper.dataset?.strictlyVisible !== 'true') {
          mountedDirectionalPreviewReady = true;
        }
      } else if (wrapper.dataset?.strictlyVisible === 'true') {
        // Until a raster has actually published, the decoded bitmap remains
        // the only non-thumbnail source that can satisfy this visible page.
        protectedPages.add(pageNum);
      }
    }
  }
  if (current > 0 && !canvasBackedPages.has(current)) protectedPages.add(current);

  let evictedEntries = 0;
  let evictedBytes = 0;
  let duplicateEntriesEvicted = 0;
  let duplicateBytesEvicted = 0;
  const evict = (key, entry, duplicate = false) => {
    if (!_cache.has(key)) return false;
    const bytes = _entryBytes(entry);
    try { entry?.bitmap?.close?.(); } catch {}
    _cache.delete(key);
    unregisterRenderResource(_resourceKey(key));
    afterBytes -= bytes;
    evictedBytes += bytes;
    evictedEntries += 1;
    if (duplicate) {
      duplicateBytesEvicted += bytes;
      duplicateEntriesEvicted += 1;
    }
    return true;
  };

  // The page-local canvas is now the immutable owner of these already-drawn
  // pixels. Release every decoded zoom bucket even when the cache is below
  // its general byte ceiling; otherwise a short, sharp zoom can permanently
  // retain both a canvas backing store and an equivalent ImageBitmap.
  for (const { key, entry, pageNum } of entries) {
    if (canvasBackedPages.has(pageNum)) evict(key, entry, true);
  }

  // Keep one ready page beyond the mounted range. In a tie, prefer the more
  // recently used candidate rather than retaining both directions.
  if (current > 0 && !mountedDirectionalPreviewReady) {
    const preview = entries
      .filter(({ key, pageNum }) => _cache.has(key)
        && !protectedPages.has(pageNum)
        && !canvasBackedPages.has(pageNum))
      .sort((left, right) => Math.abs(left.pageNum - current) - Math.abs(right.pageNum - current))
      .at(0);
    if (preview) protectedPages.add(preview.pageNum);
  }

  // Preserve only the newest cache bucket for each protected page. This
  // intentionally releases stale zoom buckets while keeping the pixels that
  // are currently drawn or most likely to be drawn next.
  const protectedKeys = new Set();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (!protectedPages.has(candidate.pageNum)) continue;
    if ([...protectedKeys].some((key) => _pageNumFromKey(filePath, key) === candidate.pageNum)) continue;
    protectedKeys.add(candidate.key);
  }

  for (const { key, entry } of entries) {
    if (afterBytes <= targetBytes) break;
    if (protectedKeys.has(key)) continue;
    evict(key, entry);
  }
  _recordDecodedBitmapMemory();
  return Object.freeze({
    beforeBytes,
    afterBytes: Math.max(0, afterBytes),
    evictedBytes,
    evictedEntries,
    duplicateBytesEvicted,
    duplicateEntriesEvicted,
  });
}
