// JS-side mirror of the Rust PageTypeCache. The Rust cache makes per-page
// analyze invokes return instantly when warm, but during cold-open the IPC
// queue gets saturated by thumbnail render invokes (~28 for a 28-page PDF)
// — a renderPage's analyze invoke can wait 1+ seconds in queue even though
// the actual Rust work is microseconds.
//
// Populating THIS cache from the analyze_page_type_batch result lets
// renderer.js skip the IPC roundtrip entirely on cache hits. The Rust cache
// is still authoritative for cold misses (first navigation before batch
// completes); this is a perf overlay on top.
//
// Cache keys include logical document/page revision and the 0-indexed Rust
// page index. Values are 'vector' | 'tile'.

const _cache = new Map();
const _owners = new Map();

function _identity(filePath, pageIndex, publicationToken = null) {
  const owner = _owners.get(filePath);
  const pageNum = Number(pageIndex) + 1;
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

function _key(filePath, pageIndex, publicationToken = null) {
  const identity = _identity(filePath, pageIndex, publicationToken);
  return [
    filePath,
    `d${identity.documentId}`,
    `p${pageIndex}`,
    `v${identity.pageRevision}`,
  ].join('::');
}

export function registerPageTypeCacheOwner(
  filePath,
  documentId,
  lifecycleGeneration = 0,
  contentRevisionReader = null,
  pageRevisionReader = null,
) {
  if (!filePath || !documentId) return;
  _owners.set(filePath, {
    documentId,
    lifecycleGeneration: Math.max(0, Number(lifecycleGeneration) || 0),
    contentRevisionReader: typeof contentRevisionReader === 'function' ? contentRevisionReader : null,
    pageRevisionReader: typeof pageRevisionReader === 'function' ? pageRevisionReader : null,
  });
}

export function getCachedPageType(filePath, pageIndex, publicationToken = null) {
  return _cache.get(_key(filePath, pageIndex, publicationToken)) ?? null;
}

export function cachePageType(filePath, pageIndex, type, publicationToken = null) {
  if (type === 'vector' || type === 'tile') {
    _cache.set(_key(filePath, pageIndex, publicationToken), type);
  }
}

/**
 * Populate the cache from an analyze_page_type_batch result.
 * @param {string} filePath
 * @param {string[]} results — array of 'vector' | 'tile' strings, ordered
 *   by page index (0..N-1).
 */
export function cacheBatchResults(filePath, results, publicationToken = null) {
  for (let i = 0; i < results.length; i++) {
    const t = results[i];
    if (t === 'vector' || t === 'tile') _cache.set(_key(filePath, i, publicationToken), t);
  }
}

/** Drop every entry for the given file (call on doc close / file replace). */
export function evictFile(filePath) {
  const prefix = `${filePath}::`;
  for (const k of _cache.keys()) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
  _owners.delete(filePath);
}

export function evictPageTypesForPages(filePath, pages) {
  if (!filePath) return;
  const pageIndices = new Set((pages || []).map((pageNum) => Number(pageNum) - 1)
    .filter((pageIndex) => Number.isSafeInteger(pageIndex) && pageIndex >= 0));
  for (const [key] of _cache) {
    const parts = key.split('::');
    const pagePart = parts.find((part) => /^p\d+$/u.test(part));
    if (key.startsWith(`${filePath}::`) && pageIndices.has(Number(pagePart?.slice(1)))) {
      _cache.delete(key);
    }
  }
}

/** Drop every entry (call on app shutdown or memory pressure). */
export function evictAll() {
  _cache.clear();
  _owners.clear();
}

/** Diagnostic: how many entries are cached right now. */
export function cacheSize() {
  return _cache.size;
}
