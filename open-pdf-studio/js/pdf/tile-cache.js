// LRU cache for region-tile ImageBitmaps used at high zoom.
// Keys: `${filePath}|p${pageNum}|z${zoomBucket}|r${rotation}|reg${regionBucket}`
// regionBucket = "x,y" in PDF points snapped to 25%-viewport buffer grid.
// Entries participate in the shared byte-aware render budget. Visible tiles
// are protected; old scale buckets and inactive-document tiles are evicted
// before visible final pixels.

import { findBestCoveringTile } from './tile-coverage.js';
import {
  isActiveRenderDocument,
  registerRenderResource,
  touchRenderResource,
  unregisterRenderResource,
} from './render-resource-budget.js';
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

const CACHE = new Map();
const FILE_OWNERS = new Map();

function recordTileMemory() {
  recordPerformancePeak(
    'tileBitmapBytes',
    [...CACHE.values()].reduce((sum, entry) => sum + entry.w * entry.h * 4, 0),
  );
}

export function registerTileCacheOwner(filePath, documentId) {
  if (filePath && documentId) FILE_OWNERS.set(filePath, documentId);
}

function makeKey(filePath, pageNum, zoomBucket, rotation, regionBucket) {
  return `${filePath}|p${pageNum}|z${Math.round(zoomBucket * 10000)}|r${rotation || 0}|reg${regionBucket}`;
}

const resourceKey = (key) => `page-tile:${key}`;

function releaseEntry(key, entry, { unregister = true } = {}) {
  try { entry?.bitmap?.close?.(); } catch {}
  CACHE.delete(key);
  recordTileMemory();
  if (unregister) unregisterRenderResource(resourceKey(key));
}

function registerEntry(key, entry, filePath, pageNum) {
  const documentId = FILE_OWNERS.get(filePath) || filePath;
  registerRenderResource({
    key: resourceKey(key),
    category: 'javascript',
    documentId,
    bytes: Math.max(0, (entry.w || 0) * (entry.h || 0) * 4),
    protected: () => {
      if (typeof window === 'undefined') return false;
      const viewport = window.__pdfViewport;
      if (viewport?.filePath === filePath && viewport?.pageNum === pageNum) return true;
      return isActiveRenderDocument(documentId)
        && Boolean(document.querySelector?.(
          `#continuous-container .page-wrapper[data-page="${pageNum}"] .page-sharp-tile`,
        ));
    },
    release: () => {
      const current = CACHE.get(key);
      if (current) releaseEntry(key, current, { unregister: false });
    },
  });
}

export function tileCacheGet(filePath, pageNum, zoomBucket, rotation, regionBucket) {
  const key = makeKey(filePath, pageNum, zoomBucket, rotation, regionBucket);
  const entry = CACHE.get(key);
  if (entry) {
    CACHE.delete(key);
    CACHE.set(key, entry);
    touchRenderResource(resourceKey(key));
  }
  return entry || null;
}

export function tileCacheFindCovering(filePath, pageNum, rotation, request) {
  const pagePrefix = `${filePath}|p${pageNum}|`;
  const rotationPart = `|r${rotation || 0}|`;
  const candidates = [];

  for (const [key, entry] of CACHE) {
    if (key.startsWith(pagePrefix) && key.includes(rotationPart)) {
      candidates.push({ key, entry, regionMeta: entry.regionMeta });
    }
  }

  const hit = findBestCoveringTile(candidates, request);
  if (!hit) return null;

  CACHE.delete(hit.key);
  CACHE.set(hit.key, hit.entry);
  touchRenderResource(resourceKey(hit.key));
  incrementPerformanceCounter('tileRasterReused');
  return hit.entry;
}

export async function tileCacheSet(
  filePath,
  pageNum,
  zoomBucket,
  rotation,
  regionBucket,
  imageData,
  regionMeta,
  publication = null,
) {
  const key = makeKey(filePath, pageNum, zoomBucket, rotation, regionBucket);
  try {
    const bitmap = await createImageBitmap(imageData);
    if (publication?.token
        && !renderPublicationTokenIsCurrent(publication.token, publication.documentState)) {
      releaseStaleRenderResult(bitmap);
      recordRejectedRenderPublication(publication.token, 'tile-before-cache-insertion');
      return null;
    }
    const replaced = CACHE.get(key);
    if (replaced) releaseEntry(key, replaced);
    const entry = { bitmap, w: imageData.width, h: imageData.height, regionMeta };
    CACHE.set(key, entry);
    registerEntry(key, entry, filePath, pageNum);
    recordTileMemory();
    incrementPerformanceCounter('tileRasterCompleted');
    recordPerformanceEvent('tile-raster:completed', {
      pageNum,
      scale: regionMeta?.renderScale || zoomBucket,
      quality: 'final',
      transferMethod: 'tauri-rgba',
      bytes: imageData.width * imageData.height * 4,
      calls: 1,
    });
    return CACHE.get(key) || null;
  } catch (e) {
    console.warn('[tile-cache] createImageBitmap failed:', e);
  }
}

export function tileCacheClearForFile(filePath) {
  for (const k of Array.from(CACHE.keys())) {
    if (k.startsWith(filePath + '|')) {
      const e = CACHE.get(k);
      releaseEntry(k, e);
    }
  }
}

export function tileCacheClearAll() {
  for (const [key, entry] of CACHE) {
    releaseEntry(key, entry);
  }
  FILE_OWNERS.clear();
}

export function tileCacheSnapshotForTests() {
  return Object.freeze({
    entries: CACHE.size,
    bytes: [...CACHE.values()].reduce((sum, entry) => sum + entry.w * entry.h * 4, 0),
  });
}
