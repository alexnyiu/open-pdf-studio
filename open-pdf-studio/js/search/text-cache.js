// @ts-check
import { projectTextEditRecord } from '../text/rich-text.js';
import { estimateRetainedBytes } from '../core/retained-value-size.js';

/** @typedef {{revisionIdentity: {documentId: string, pageRevision: number, pageNum: number}, signature: string, value: unknown, bytes: number}} PageCacheEntry */

/** @type {Map<string, Map<number, PageCacheEntry>>} */
const documentTextCache = new Map();
// Disposable extraction data only; document edits and in-flight search results
// remain owned by their document/request when an entry is evicted.
export const SEARCH_TEXT_CACHE_BYTE_LIMIT = 32 * 1024 * 1024;
const leastRecentlyUsed = new Map();
let retainedBytes = 0;
const editIndexes = new WeakMap();

function removeEntry(entry) {
  if (!leastRecentlyUsed.delete(entry)) return;
  retainedBytes -= entry.bytes;
  const { documentId, pageNum } = entry.revisionIdentity;
  const pages = documentTextCache.get(documentId);
  pages?.delete(pageNum);
  if (pages?.size === 0) documentTextCache.delete(documentId);
}

function pageEdits(doc, pageNum) {
  const edits = doc?.textEdits || [];
  // Legacy callers without the committed-revision contract keep direct-mutation
  // semantics. Production documents publish every edit/undo through that contract.
  if (!doc?.revisionState) return edits.filter((edit) => edit?.page === pageNum);
  const revision = revisionNumber(doc.revisionState.contentRevision);
  let index = editIndexes.get(doc);
  if (!index || index.edits !== edits || index.length !== edits.length || index.revision !== revision) {
    const byPage = new Map();
    for (const edit of edits) {
      const page = edit?.page;
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page).push(edit);
    }
    index = { edits, length: edits.length, revision, byPage };
    editIndexes.set(doc, index);
  }
  return index.byPage.get(pageNum) || [];
}

function revisionNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function captureTextCacheRevision(doc, pdfDoc, pageNum) {
  if (!doc?.id || !pdfDoc) return null;
  return Object.freeze({
    documentId: String(doc.id),
    lifecycleGeneration: revisionNumber(doc.lifecycleGeneration),
    pdfDocument: pdfDoc,
    contentRevision: revisionNumber(doc.revisionState?.contentRevision),
    livePdfRevision: revisionNumber(doc.revisionState?.livePdfRevision),
    pageRevision: revisionNumber(
      doc.revisionState?.pageContentRevisions?.[pageNum]
      ?? doc.pageRenderRevisions?.[pageNum],
    ),
    pageNum: Number(pageNum),
  });
}

export function textCacheRevisionIsCurrent(revisionIdentity, doc, pdfDoc = doc?.pdfDoc) {
  if (!revisionIdentity || !doc || !pdfDoc) return false;
  const current = captureTextCacheRevision(doc, pdfDoc, revisionIdentity.pageNum);
  return Boolean(current
    && current.documentId === revisionIdentity.documentId
    && current.lifecycleGeneration === revisionIdentity.lifecycleGeneration
    && current.pdfDocument === revisionIdentity.pdfDocument
    && doc.pdfDoc === pdfDoc
    && current.pageRevision === revisionIdentity.pageRevision);
}

export function documentSearchTextRevisionAvailable(doc) {
  const revisions = doc?.revisionState;
  if (!doc?.pdfDoc || !revisions) return false;
  return revisionNumber(revisions.persistedRevision) <= revisionNumber(revisions.livePdfRevision)
    && revisions.saveState !== 'persisted'
    && revisions.saveState !== 'synchronizing'
    && revisions.saveState !== 'saved-refresh-failed';
}

/** @param {unknown} value */
function scalar(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null;
}

/**
 * Build a cheap page-local signature. Text edits are mutable legacy objects,
 * so their searchable fields are included rather than relying on array
 * identity. OCR state has explicit monotonic revisions.
 * @param {any} doc
 * @param {number} pageNum
 */
export function pageTextSignature(doc, pageNum) {
  const pageOcr = doc?.ocr?.pages?.[pageNum];
  const edits = pageEdits(doc, pageNum)
    .map(projectTextEditRecord)
    .filter((edit) => edit.originalText === '')
    .map((edit) => [
      scalar(edit.id), scalar(edit.newText), scalar(edit.pdfX), scalar(edit.pdfY),
      scalar(edit.fontSize), scalar(edit.lineSpacing),
    ]);
  return JSON.stringify({
    generation: doc?.ocr?.generation || null,
    pageRevision: pageOcr?.pageRevision || 0,
    resultRevision: pageOcr?.recognition?.revision || 0,
    correctionRevision: pageOcr?.review?.revision || 0,
    existingTextRevision: pageOcr?.existingText?.revision || 0,
    existingTextMeaningful: pageOcr?.existingText?.meaningful ?? null,
    edits,
  });
}

/**
 * @param {any} doc
 * @param {object} pdfDoc
 * @param {number} pageNum
 */
export function readPageTextCache(doc, pdfDoc, pageNum) {
  const byPage = documentTextCache.get(doc?.id);
  const entry = byPage?.get(pageNum);
  const current = captureTextCacheRevision(doc, pdfDoc, pageNum);
  // Cache values are page-local immutable data, so an unchanged page can be
  // reused after proxy adoption without retaining the retired proxy itself.
  if (!entry || !current || doc.pdfDoc !== pdfDoc
      || current.documentId !== entry.revisionIdentity.documentId
      || current.pageRevision !== entry.revisionIdentity.pageRevision
      || entry.signature !== pageTextSignature(doc, pageNum)) {
    return null;
  }
  leastRecentlyUsed.delete(entry);
  leastRecentlyUsed.set(entry, true);
  return entry.value;
}

/**
 * @param {any} doc
 * @param {object} pdfDoc
 * @param {number} pageNum
 * @param {unknown} value
 */
export function writePageTextCache(doc, pdfDoc, pageNum, value) {
  if (!doc?.id || !pdfDoc || doc.pdfDoc !== pdfDoc) return value;
  const previous = documentTextCache.get(doc.id)?.get(pageNum);
  if (previous) removeEntry(previous);
  const revision = captureTextCacheRevision(doc, pdfDoc, pageNum);
  const signature = pageTextSignature(doc, pageNum);
  const bytes = estimateRetainedBytes(value) + signature.length * 2 + 128;
  // A very large page remains usable by the current request without making the
  // disposable cache exceed its budget or evicting every useful small page.
  if (bytes > SEARCH_TEXT_CACHE_BYTE_LIMIT) return value;
  while (retainedBytes + bytes > SEARCH_TEXT_CACHE_BYTE_LIMIT && leastRecentlyUsed.size) {
    removeEntry(leastRecentlyUsed.keys().next().value);
  }
  let byPage = documentTextCache.get(doc.id);
  if (!byPage) {
    byPage = new Map();
    documentTextCache.set(doc.id, byPage);
  }
  const entry = {
    revisionIdentity: { documentId: revision.documentId, pageRevision: revision.pageRevision, pageNum },
    signature, value, bytes,
  };
  byPage.set(pageNum, entry);
  leastRecentlyUsed.set(entry, true);
  retainedBytes += bytes;
  return value;
}

/**
 * Invalidates one affected page, or all pages when pageNum is omitted.
 * @param {string | undefined | null} docId
 * @param {number | undefined} pageNum
 */
export function invalidateTextCache(docId, pageNum = undefined) {
  if (!docId) return;
  const byPage = documentTextCache.get(docId);
  if (pageNum === undefined) {
    for (const entry of byPage?.values() || []) removeEntry(entry);
  } else {
    const entry = byPage?.get(pageNum);
    if (entry) removeEntry(entry);
  }
}

/** Test/diagnostic-only immutable cache inventory. */
export function textCacheSnapshot() {
  return [...documentTextCache.entries()].map(([documentId, byPage]) => Object.freeze({
    documentId,
    estimatedBytes: [...byPage.values()].reduce((total, entry) => total + entry.bytes, 0),
    pages: Object.freeze([...byPage.keys()].sort((a, b) => a - b)),
  }));
}
