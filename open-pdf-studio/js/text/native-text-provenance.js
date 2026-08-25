import { getActiveDocument } from '../core/state.js';
import { isTauri, invoke } from '../core/platform.js';
import { matchNativeTextSources } from './native-text-matching.js';
import { collectVisibleNativeTextProvenance } from './native-text-blocks.js';
export { matchNativeTextSources } from './native-text-matching.js';

const sourceMapsByDocument = new WeakMap();

export async function inspectNativeTextSourcesForPage(pageNum) {
  const maps = await inspectNativeTextSourcesForPages([pageNum]);
  return maps.get(pageNum) || null;
}

export async function inspectNativeTextSourcesForPages(pageNums) {
  if (!isTauri()) return new Map();
  const documentState = getActiveDocument();
  if (!documentState) return null;
  let pageCache = sourceMapsByDocument.get(documentState);
  if (!pageCache) {
    pageCache = new Map();
    sourceMapsByDocument.set(documentState, pageCache);
  }
  const requested = [...new Set(pageNums.filter((page) => Number.isInteger(page) && page > 0))];
  const missing = requested.filter((page) => !pageCache.has(page));

  if (missing.length > 0) {
    const batchPending = (async () => {
    const loader = await import('../pdf/loader.js');
    const key = documentState.filePath || `__memory__${documentState.id}`;
    const bytes = loader.getCachedPdfBytes(key)
      || loader.getCachedPdfBytes(`__memory__${documentState.id}`);
    if (!bytes?.length) return null;
    return invoke('inspect_native_text_sources_batch', {
      documentBytes: Array.from(bytes),
      pageIndices: missing.map((page) => page - 1),
    });
  })().catch((error) => {
    console.warn('[native-text] Source inspection failed closed:', error);
    return [];
  });
    missing.forEach((page, index) => pageCache.set(page, batchPending.then((maps) => maps[index] || null)));
  }
  const resolved = await Promise.all(requested.map(async (page) => [page, await pageCache.get(page)]));
  return new Map(resolved);
}

export async function attachNativeTextProvenance(textItems, textDivs, pageNum, sourceMapOverride = null) {
  if (!isTauri()) return 0;
  const sourceMap = sourceMapOverride || await inspectNativeTextSourcesForPage(pageNum);
  if (!sourceMap?.runs?.length) return 0;
  const matches = matchNativeTextSources(textItems, sourceMap.runs);
  for (const [itemIndex, sources] of matches) {
    const span = textDivs[itemIndex];
    if (!span) continue;
    span.dataset.nativeTextProvenance = JSON.stringify(sources);
    span.dataset.nativeTextMarkerIds = sources.map((source) => source.markerId).join(' ');
  }
  return matches.size;
}

export function provenanceForSpans(spans) {
  return collectVisibleNativeTextProvenance(spans);
}

export function clearNativeTextSourceCache(documentState = null) {
  if (documentState) sourceMapsByDocument.delete(documentState);
}

export function discardNativeTextSourcePages(documentState, pageNums) {
  const cache = documentState && sourceMapsByDocument.get(documentState);
  if (!cache) return;
  for (const pageNum of pageNums || []) cache.delete(pageNum);
}
