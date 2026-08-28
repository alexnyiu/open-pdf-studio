import { getActiveDocument } from '../core/state.js';
import { isTauri, invoke } from '../core/platform.js';
import { matchNativeTextSources } from './native-text-matching.js';
import { collectVisibleNativeTextProvenance } from './native-text-blocks.js';
import {
  captureSemanticRevisionIdentity,
  semanticRevisionIdentityIsCurrent,
} from '../core/semantic-revision-identity.js';
export { matchNativeTextSources } from './native-text-matching.js';

const sourceMapsByDocument = new WeakMap();

function revisionNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export const captureNativeTextSourceRevision = captureSemanticRevisionIdentity;
export const nativeTextSourceRevisionIsCurrent = semanticRevisionIdentityIsCurrent;

function expectedRevisionMatches(expectedRevision, documentState) {
  if (!expectedRevision) return true;
  return String(documentState?.id || '') === String(
    expectedRevision.documentId ?? expectedRevision.documentStateId ?? '',
  )
    && revisionNumber(documentState?.lifecycleGeneration)
      === revisionNumber(expectedRevision.lifecycleGeneration)
    && documentState?.pdfDoc === (expectedRevision.pdfDocument ?? expectedRevision.pdfDoc)
    && revisionNumber(documentState?.revisionState?.contentRevision)
      === revisionNumber(expectedRevision.contentRevision)
    && (expectedRevision.livePdfRevision === undefined
      || revisionNumber(documentState?.revisionState?.livePdfRevision)
        === revisionNumber(expectedRevision.livePdfRevision));
}

export async function inspectNativeTextSourcesForPage(
  pageNum,
  documentState = getActiveDocument(),
  expectedRevision = null,
) {
  const maps = await inspectNativeTextSourcesForPages(
    [pageNum],
    documentState,
    expectedRevision,
  );
  return maps.get(pageNum) || null;
}

export async function inspectNativeTextSourcesForPages(
  pageNums,
  documentState = getActiveDocument(),
  expectedRevision = null,
) {
  if (!isTauri()) return new Map();
  if (!documentState?.pdfDoc || !expectedRevisionMatches(expectedRevision, documentState)) {
    return new Map();
  }
  const revisionIdentity = captureNativeTextSourceRevision(documentState);
  let record = sourceMapsByDocument.get(documentState);
  if (!record || !nativeTextSourceRevisionIsCurrent(record.revisionIdentity, documentState)) {
    record = { revisionIdentity, pageCache: new Map() };
    sourceMapsByDocument.set(documentState, record);
  }
  const { pageCache } = record;
  const requested = [...new Set(pageNums.filter((page) => Number.isInteger(page) && page > 0))];
  const missing = requested.filter((page) => !pageCache.has(page));

  if (missing.length > 0) {
    const batchPending = (async () => {
    const loader = await import('../pdf/loader.js');
    if (!nativeTextSourceRevisionIsCurrent(revisionIdentity, documentState)
        || !expectedRevisionMatches(expectedRevision, documentState)) return null;
    const key = documentState.filePath || `__memory__${documentState.id}`;
    const bytes = loader.getCachedPdfBytes(key)
      || loader.getCachedPdfBytes(`__memory__${documentState.id}`);
    if (!bytes?.length) return null;
    const result = await invoke('inspect_native_text_sources_batch', {
      documentBytes: Array.from(bytes),
      pageIndices: missing.map((page) => page - 1),
    });
    return nativeTextSourceRevisionIsCurrent(revisionIdentity, documentState)
      && expectedRevisionMatches(expectedRevision, documentState)
      ? result
      : null;
  })().catch((error) => {
    console.warn('[native-text] Source inspection failed closed:', error);
    return [];
  });
    missing.forEach((page, index) => pageCache.set(
      page,
      batchPending.then((maps) => maps?.[index] || null),
    ));
  }
  const resolved = await Promise.all(requested.map(async (page) => [page, await pageCache.get(page)]));
  if (!nativeTextSourceRevisionIsCurrent(revisionIdentity, documentState)
      || !expectedRevisionMatches(expectedRevision, documentState)) return new Map();
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
  const record = documentState && sourceMapsByDocument.get(documentState);
  if (!record) return;
  for (const pageNum of pageNums || []) record.pageCache.delete(pageNum);
}

export function nativeTextSourceCacheSnapshotForTests(documentState) {
  const record = documentState && sourceMapsByDocument.get(documentState);
  return Object.freeze({
    revisionIdentity: record?.revisionIdentity || null,
    pages: Object.freeze([...(record?.pageCache?.keys() || [])].sort((a, b) => a - b)),
  });
}
