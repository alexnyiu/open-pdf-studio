import { getActiveDocument } from '../core/state.js';
import { isTauri, invoke } from '../core/platform.js';
import { matchNativeTextSources } from './native-text-matching.js';
export { matchNativeTextSources } from './native-text-matching.js';

const sourceMapsByDocument = new WeakMap();

export async function inspectNativeTextSourcesForPage(pageNum) {
  if (!isTauri()) return null;
  const documentState = getActiveDocument();
  if (!documentState) return null;
  let pageCache = sourceMapsByDocument.get(documentState);
  if (!pageCache) {
    pageCache = new Map();
    sourceMapsByDocument.set(documentState, pageCache);
  }
  if (pageCache.has(pageNum)) return pageCache.get(pageNum);

  const pending = (async () => {
    const loader = await import('../pdf/loader.js');
    const key = documentState.filePath || `__memory__${documentState.id}`;
    const bytes = loader.getCachedPdfBytes(key)
      || loader.getCachedPdfBytes(`__memory__${documentState.id}`);
    if (!bytes?.length) return null;
    return invoke('inspect_native_text_sources', {
      documentBytes: Array.from(bytes),
      pageIndex: pageNum - 1,
    });
  })().catch((error) => {
    console.warn('[native-text] Source inspection failed closed:', error);
    return null;
  });
  pageCache.set(pageNum, pending);
  return pending;
}

export async function attachNativeTextProvenance(textItems, textDivs, pageNum) {
  if (!isTauri()) return 0;
  const sourceMap = await inspectNativeTextSourcesForPage(pageNum);
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
  const sources = [];
  const owners = new Set();
  for (const span of spans || []) {
    let linked;
    try { linked = JSON.parse(span.dataset.nativeTextProvenance || 'null'); }
    catch (_) { return null; }
    if (!Array.isArray(linked) || linked.length === 0) return null;
    for (const source of linked) {
      const owner = `${source.streamObjectId}:${source.operatorIndex}`;
      if (owners.has(owner)) continue;
      owners.add(owner);
      sources.push(source);
    }
  }
  if (sources.length === 0 || sources.some((source) => !source?.eligibility?.eligible)) return null;
  return sources;
}

export function clearNativeTextSourceCache(documentState = null) {
  if (documentState) sourceMapsByDocument.delete(documentState);
}
