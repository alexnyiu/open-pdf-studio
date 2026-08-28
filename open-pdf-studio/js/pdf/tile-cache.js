// LRU cache for region-tile ImageBitmaps used at high zoom.
// Keys include document/lifecycle/content/page revision plus scale, rotation,
// and region, so a tile from an earlier save cannot satisfy the same path.
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

export function registerTileCacheOwner(
  filePath,
  documentId,
  lifecycleGeneration = 0,
  contentRevisionReader = null,
  pageRevisionReader = null,
) {
  if (!filePath || !documentId) return;
  FILE_OWNERS.set(filePath, {
    documentId,
    lifecycleGeneration: Math.max(0, Number(lifecycleGeneration) || 0),
    contentRevisionReader: typeof contentRevisionReader === 'function' ? contentRevisionReader : null,
    pageRevisionReader: typeof pageRevisionReader === 'function' ? pageRevisionReader : null,
  });
}

function revisionIdentity(filePath, pageNum, publicationToken = null) {
  const owner = FILE_OWNERS.get(filePath);
  return {
    documentId: publicationToken?.documentId || owner?.documentId || filePath,
    lifecycleGeneration: Number(publicationToken?.lifecycleGeneration
      ?? owner?.lifecycleGeneration) || 0,
    contentRevision: Number(publicationToken?.contentRevision
      ?? owner?.contentRevisionReader?.()) || 0,
    pageRevision: Number(publicationToken?.pageRevision
      ?? owner?.pageRevisionReader?.(pageNum)) || 0,
  };
}

function makeKey(filePath, pageNum, zoomBucket, rotation, regionBucket, publicationToken = null) {
  const identity = revisionIdentity(filePath, pageNum, publicationToken);
  return [
    filePath,
    `d${identity.documentId}`,
    `g${identity.lifecycleGeneration}`,
    `c${identity.contentRevision}`,
    `p${pageNum}`,
    `v${identity.pageRevision}`,
    `z${Math.round(zoomBucket * 10000)}`,
    `r${rotation || 0}`,
    `reg${regionBucket}`,
  ].join('|');
}

const resourceKey = (key) => `page-tile:${key}`;

function releaseEntry(key, entry, { unregister = true } = {}) {
  try { entry?.bitmap?.close?.(); } catch {}
  CACHE.delete(key);
  recordTileMemory();
  if (unregister) unregisterRenderResource(resourceKey(key));
}

function registerEntry(key, entry, filePath, pageNum) {
  const documentId = FILE_OWNERS.get(filePath)?.documentId || filePath;
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
  const expectedIdentity = revisionIdentity(filePath, pageNum);
  const candidates = [];

  for (const [key, entry] of CACHE) {
    if (entry.filePath === filePath
        && entry.pageNum === Number(pageNum)
        && entry.rotation === (Number(rotation) || 0)
        && entry.documentId === expectedIdentity.documentId
        && entry.lifecycleGeneration === expectedIdentity.lifecycleGeneration
        && entry.contentRevision === expectedIdentity.contentRevision
        && entry.pageRevision === expectedIdentity.pageRevision) {
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
  const identity = revisionIdentity(filePath, pageNum, publication?.token);
  const key = makeKey(filePath, pageNum, zoomBucket, rotation, regionBucket, publication?.token);
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
    const entry = {
      bitmap,
      w: imageData.width,
      h: imageData.height,
      regionMeta,
      filePath,
      pageNum: Number(pageNum),
      rotation: Number(rotation) || 0,
      ...identity,
    };
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
  for (const [k, e] of Array.from(CACHE.entries())) {
    if (e.filePath === filePath) {
      releaseEntry(k, e);
    }
  }
  FILE_OWNERS.delete(filePath);
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
