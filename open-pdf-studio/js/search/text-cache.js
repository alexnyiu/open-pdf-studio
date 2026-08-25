// @ts-check
import { projectTextEditRecord } from '../text/rich-text.js';

/** @typedef {{pdfDoc: object, signature: string, value: unknown}} PageCacheEntry */

/** @type {Map<string, Map<number, PageCacheEntry>>} */
const documentTextCache = new Map();

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
  const edits = (doc?.textEdits || [])
    .filter((edit) => edit?.page === pageNum)
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
  if (!entry || entry.pdfDoc !== pdfDoc || entry.signature !== pageTextSignature(doc, pageNum)) {
    return null;
  }
  return entry.value;
}

/**
 * @param {any} doc
 * @param {object} pdfDoc
 * @param {number} pageNum
 * @param {unknown} value
 */
export function writePageTextCache(doc, pdfDoc, pageNum, value) {
  if (!doc?.id || !pdfDoc) return value;
  let byPage = documentTextCache.get(doc.id);
  if (!byPage) {
    byPage = new Map();
    documentTextCache.set(doc.id, byPage);
  }
  byPage.set(pageNum, {
    pdfDoc,
    signature: pageTextSignature(doc, pageNum),
    value,
  });
  return value;
}

/**
 * Invalidates one affected page, or all pages when pageNum is omitted.
 * @param {string | undefined | null} docId
 * @param {number | undefined} pageNum
 */
export function invalidateTextCache(docId, pageNum = undefined) {
  if (!docId) return;
  if (pageNum === undefined) {
    documentTextCache.delete(docId);
    return;
  }
  const byPage = documentTextCache.get(docId);
  byPage?.delete(pageNum);
  if (byPage?.size === 0) documentTextCache.delete(docId);
}

/** Test/diagnostic-only immutable cache inventory. */
export function textCacheSnapshot() {
  return [...documentTextCache.entries()].map(([documentId, byPage]) => Object.freeze({
    documentId,
    pages: Object.freeze([...byPage.keys()].sort((a, b) => a - b)),
  }));
}
