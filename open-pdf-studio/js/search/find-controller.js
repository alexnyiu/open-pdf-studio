/**
 * Find Controller - Core search logic for PDF text search.
 * Supports progressive (page-by-page) searching with cancellation
 * and accurate text replacement via the text-edit-tool infrastructure.
 */

import { state, getActiveDocument, getDocumentById } from '../core/state.js';
import {
  createTextEditRecordV2,
  projectTextEditRecord,
  replaceFirstRichTextMatch,
  richTextFromPlainText,
} from '../text/rich-text.js';
import { resolvePackagedFace } from '../text/font-catalog.js';
import { requestFontSubstitutionApproval } from '../text/font-substitution-approval.js';
import { inspectNativeTextSourcesForPage, matchNativeTextSources } from '../text/native-text-provenance.js';
import { executeForDocument } from '../core/undo-manager.js';
import { markDocumentModifiedForDocument } from '../ui/chrome/tabs.js';
import { invalidateTextCache } from './text-cache.js';
import { extractPageText } from './text-extraction.js';

export { extractPageText } from './text-extraction.js';

// Cancellation token for progressive search
let _searchGeneration = 0;

/**
 * Extract text content from all pages (cached)
 */
async function extractAllText(pdfDoc) {
  const doc = getActiveDocument();

  const pagesText = [];
  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    pagesText.push(await extractPageText(pdfDoc, pageNum, doc));
  }

  return pagesText;
}

/**
 * Clear text cache for a document
 */
export function clearTextCache(docId, pageNum) {
  invalidateTextCache(docId, pageNum);
}

/**
 * Search a single page's text data and return matches
 */
function searchPage(pageData, pattern, query) {
  const { pageNum, text, items } = pageData;
  const results = [];

  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const startPos = match.index;
    const endPos = startPos + query.length;

    const matchItems = items.filter(item =>
      (item.startPos < endPos && item.endPos > startPos)
    );

    if (matchItems.length > 0) {
      // Visual anchor (PDF space, Y-up) of the first geometric item, used
      // to order results top-to-bottom on the page rather than in
      // content-stream order.
      const anchorItem = matchItems.find(item => item.geometry?.anchor || item.transform);
      const anchor = anchorItem?.geometry?.anchor;
      results.push({
        pageNum,
        startPos,
        endPos,
        matchText: text.substring(startPos, endPos),
        items: matchItems,
        anchorX: anchor ? anchor.x : anchorItem?.transform?.[4] ?? null,
        anchorY: anchor ? anchor.y : anchorItem?.transform?.[5] ?? null,
        index: 0 // will be re-indexed later
      });
    }
  }

  // Sort visually at discovery time, not just in the final pass: the
  // progressive search picks the initial current match from a page's raw
  // results, and stream order would make "1 of N" land mid-page.
  results.sort(compareResultsVisually);

  return results;
}

/**
 * Order results the way a reader scans the page: by page, then top to
 * bottom (PDF Y is up, so larger anchorY first), then left to right.
 * Content-stream order (startPos) is only the tiebreaker — streams often
 * draw headers/footers/cards out of visual order.
 */
function compareResultsVisually(a, b) {
  if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
  if (a.anchorY != null && b.anchorY != null) {
    if (Math.abs(a.anchorY - b.anchorY) > 2) return b.anchorY - a.anchorY;
    if (a.anchorX != null && b.anchorX != null && a.anchorX !== b.anchorX) {
      return a.anchorX - b.anchorX;
    }
  }
  return a.startPos - b.startPos;
}

/**
 * Build the search regex from query and options
 */
function buildPattern(query, matchCase, wholeWord) {
  const searchQuery = matchCase ? query : query.toLowerCase();
  const wordBoundary = wholeWord ? '\\b' : '';
  const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(wordBoundary + escapedQuery + wordBoundary, matchCase ? 'g' : 'gi');
}

/**
 * Perform a full (non-progressive) search. Used as fallback.
 */
export async function performSearch(query, options = {}) {
  if (!query || !getActiveDocument()?.pdfDoc) return [];

  const { matchCase = false, wholeWord = false } = options;
  state.search.isSearching = true;

  try {
    const pagesText = await extractAllText(getActiveDocument().pdfDoc);
    const pattern = buildPattern(query, matchCase, wholeWord);
    const results = [];

    for (const pageData of pagesText) {
      results.push(...searchPage(pageData, pattern, query));
    }

    results.sort(compareResultsVisually);
    results.forEach((r, i) => r.index = i);

    return results;
  } finally {
    state.search.isSearching = false;
  }
}

/**
 * Execute a progressive search: searches current page first for instant
 * feedback, then remaining pages in the background.
 */
export function executeProgressiveSearch(onProgress) {
  const { query, matchCase, wholeWord } = state.search;
  const doc = getActiveDocument();

  if (!query || !doc?.pdfDoc) {
    onProgress([], 0, 0, true);
    return () => {};
  }

  const generation = ++_searchGeneration;
  const pdfDoc = doc.pdfDoc;
  const totalPages = pdfDoc.numPages;
  const currentPage = doc.currentPage || 1;
  const pattern = buildPattern(query, matchCase, wholeWord);

  const allResults = [];
  let searchedCount = 0;

  const pageOrder = [currentPage];
  for (let p = 1; p <= totalPages; p++) {
    if (p !== currentPage) pageOrder.push(p);
  }

  let cancelled = false;

  (async () => {
    for (const pageNum of pageOrder) {
      if (cancelled || generation !== _searchGeneration) return;

      const pageData = await extractPageText(pdfDoc, pageNum, doc);

      if (cancelled || generation !== _searchGeneration) return;

      const pageResults = searchPage(pageData, pattern, query);
      for (const r of pageResults) {
        r.index = allResults.length;
        allResults.push(r);
      }

      searchedCount++;
      onProgress(allResults, searchedCount, totalPages, false);

      if (searchedCount % 5 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (cancelled || generation !== _searchGeneration) return;

    allResults.sort(compareResultsVisually);
    allResults.forEach((r, i) => r.index = i);

    onProgress(allResults, totalPages, totalPages, true);
  })();

  return () => { cancelled = true; };
}

/**
 * Execute a search with the current query and options (legacy sync API)
 */
export async function executeSearch() {
  const { query, matchCase, wholeWord } = state.search;

  if (!query) {
    state.search.results = [];
    state.search.totalMatches = 0;
    state.search.currentIndex = -1;
    return;
  }

  const results = await performSearch(query, { matchCase, wholeWord });

  state.search.results = results;
  state.search.totalMatches = results.length;

  if (results.length > 0) {
    const doc = getActiveDocument();
    const currentPage = doc ? doc.currentPage : 1;
    let firstIndex = results.findIndex(r => r.pageNum >= currentPage);
    if (firstIndex === -1) firstIndex = 0;
    state.search.currentIndex = firstIndex;
  } else {
    state.search.currentIndex = -1;
  }
}

export function findNext() {
  const { results, currentIndex } = state.search;
  if (results.length === 0) return null;
  let nextIndex = currentIndex + 1;
  if (nextIndex >= results.length) nextIndex = 0;
  state.search.currentIndex = nextIndex;
  return results[nextIndex];
}

export function findPrevious() {
  const { results, currentIndex } = state.search;
  if (results.length === 0) return null;
  let prevIndex = currentIndex - 1;
  if (prevIndex < 0) prevIndex = results.length - 1;
  state.search.currentIndex = prevIndex;
  return results[prevIndex];
}

export function getCurrentResult() {
  const { results, currentIndex } = state.search;
  if (currentIndex >= 0 && currentIndex < results.length) {
    return results[currentIndex];
  }
  return null;
}

export function getResultsForPage(pageNum) {
  return state.search.results.filter(r => r.pageNum === pageNum);
}

export function clearSearch() {
  state.search.query = '';
  state.search.results = [];
  state.search.totalMatches = 0;
  state.search.currentIndex = -1;
}

export function didSearchWrap(direction) {
  const { results, currentIndex } = state.search;
  if (results.length === 0) return false;
  if (direction === 'next') return currentIndex === 0;
  return currentIndex === results.length - 1;
}

// ==================== Replace helpers ====================

function findAnnotationForMatch(doc, result) {
  return doc.annotations.find(a => {
    if (!a.text || a.page !== result.pageNum) return false;
    return a.text.includes(result.matchText);
  }) || null;
}

function findTextEditForMatch(doc, result) {
  if (!doc.textEdits) return null;
  return doc.textEdits.find(e => {
    if (e.page !== result.pageNum) return false;
    return projectTextEditRecord(e).newText.includes(result.matchText);
  }) || null;
}

function replaceInAnnotation(doc, result, replaceText) {
  const ann = findAnnotationForMatch(doc, result);
  if (!ann || !ann.text) return null;

  const oldText = ann.text;
  const matchText = result.matchText;
  const searchQuery = state.search.matchCase ? matchText : matchText.toLowerCase();
  const annText = state.search.matchCase ? ann.text : ann.text.toLowerCase();

  const idx = annText.indexOf(searchQuery);
  if (idx === -1) return null;

  ann.text = ann.text.substring(0, idx) + replaceText + ann.text.substring(idx + matchText.length);
  ann.modifiedAt = new Date().toISOString();

  return { type: 'annotation', id: ann.id, oldText, newText: ann.text };
}

function replaceInTextEdit(doc, result, replaceText) {
  if (!doc.textEdits) return null;
  const edit = findTextEditForMatch(doc, result);
  if (!edit) return null;

  if (edit.schema === 'open-pdf-studio.text-edit-record' && edit.version === 2) {
    const oldText = projectTextEditRecord(edit).newText;
    const replacement = replaceFirstRichTextMatch(edit.richText, result.matchText, replaceText, {
      matchCase: state.search.matchCase,
    });
    if (!replacement) return null;
    edit.richText = replacement;
    edit.revision += 1;
    return { type: 'textEdit', id: edit.id, oldText, newText: projectTextEditRecord(edit).newText };
  }
  if (!edit.newText) return null;

  const oldText = edit.newText;
  const matchText = result.matchText;
  const searchQuery = state.search.matchCase ? matchText : matchText.toLowerCase();
  const editText = state.search.matchCase ? edit.newText : edit.newText.toLowerCase();

  const idx = editText.indexOf(searchQuery);
  if (idx === -1) return null;

  edit.newText = edit.newText.substring(0, idx) + replaceText + edit.newText.substring(idx + matchText.length);

  return { type: 'textEdit', id: edit.id, oldText, newText: edit.newText };
}

let _replacing = false;

async function replaceInPdfContent(doc, result, replaceText) {
  if (_replacing) return null;
  _replacing = true;
  const ownerGeneration = Number(doc.lifecycleGeneration) || 0;
  const ownerPdfDocument = doc.pdfDoc;
  const isCurrentOwner = () => getActiveDocument() === doc
    && getDocumentById(doc.id) === doc
    && doc.pdfDoc === ownerPdfDocument
    && (Number(doc.lifecycleGeneration) || 0) === ownerGeneration;
  try {
    if (!isCurrentOwner()) return null;
    const page = await doc.pdfDoc?.getPage(result.pageNum);
    if (!isCurrentOwner()) return null;
    const textContent = await page?.getTextContent();
    if (!isCurrentOwner()) return null;
    const sourceMap = await inspectNativeTextSourcesForPage(result.pageNum);
    if (!isCurrentOwner()) return null;
    if (!textContent || !sourceMap?.runs?.length) return null;
    const textItems = textContent.items.filter((item) => item.str !== undefined);
    const mappings = matchNativeTextSources(textItems, sourceMap.runs);
    const itemIndexes = [...new Set((result.items || [])
      .filter((item) => item.source === 'native')
      .map((item) => item.itemIndex))];
    if (itemIndexes.length === 0 || itemIndexes.some((index) => !mappings.has(index))) return null;

    const sources = itemIndexes.flatMap((index) => mappings.get(index));
    const sourceOwners = new Set(sources.map((source) => `${source.streamObjectId}:${source.operatorIndex}`));
    if (sourceOwners.size !== sources.length) return null;
    const overlaps = (doc.textEdits || []).some((record) => (record.sourceProvenance || [])
      .some((source) => sourceOwners.has(`${source.streamObjectId}:${source.operatorIndex}`)));
    if (overlaps) return null;

    const sourceText = sources.map((source) => source.decodedText).join('');
    const haystack = state.search.matchCase ? sourceText : sourceText.toLowerCase();
    const needle = state.search.matchCase ? result.matchText : result.matchText.toLowerCase();
    const matchIndex = haystack.indexOf(needle);
    if (matchIndex < 0) return null;
    const replacementText = sourceText.slice(0, matchIndex)
      + replaceText + sourceText.slice(matchIndex + result.matchText.length);

    const baselines = sources.map((source) => Number(source.geometry?.[1]));
    const fontSize = Math.max(Number(sources[0].fontSize) || 12, 1);
    if (baselines.some((baseline) => Math.abs(baseline - baselines[0]) > fontSize * 0.5)) return null;
    const x = Math.min(...sources.map((source) => Number(source.geometry?.[0]) || 0));
    const right = Math.max(...sources.map((source) => (Number(source.geometry?.[0]) || 0) + (Number(source.geometry?.[2]) || 0)));
    const sourceFont = sources[0].fontName || 'Unknown font';
    const face = resolvePackagedFace(sourceFont, false, false);
    const substitution = await requestFontSubstitutionApproval({
      documentState: doc,
      sourceFonts: [sourceFont],
      sampleText: sourceText,
      scope: 'findReplace',
    });
    if (!substitution || !isCurrentOwner()) return null;
    const style = {
      faceId: face.id, size: fontSize, color: '#000000', bold: false, italic: false,
      underline: false, strikeout: false, baselineAdvance: fontSize * 1.2,
    };
    const region = { x, y: baselines[0] - fontSize, baseline: baselines[0], width: right - x, height: fontSize * 1.3, rotation: 0 };
    const original = richTextFromPlainText(sourceText, style, region);
    const richText = richTextFromPlainText(replacementText, style, region);
    const record = createTextEditRecordV2({
      id: `native-replace-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      page: result.pageNum,
      richText,
      original,
      sourceProvenance: sources,
      substitution,
    });
    if (!doc.textEdits) doc.textEdits = [];
    doc.textEdits.push(record);
    executeForDocument(doc, { type: 'addTextEdit', textEdit: structuredClone(record) });
    markDocumentModifiedForDocument(doc);
    return { type: 'textEdit', id: record.id, oldText: sourceText, newText: replacementText };
  } catch (err) {
    console.error('[replaceInPdfContent]', err);
    return null;
  } finally {
    _replacing = false;
  }
}

function replaceAllInAnnotationText(doc, ann, matches, replaceText) {
  const oldText = ann.text;
  if (!oldText) return 0;

  const pattern = buildPattern(state.search.query, state.search.matchCase, state.search.wholeWord);
  ann.text = oldText.replace(pattern, replaceText);
  ann.modifiedAt = new Date().toISOString();

  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(oldText) !== null) count++;

  return count;
}

function replaceAllInTextEditText(doc, edit, matches, replaceText) {
  const oldText = edit.newText;
  if (!oldText) return 0;

  const pattern = buildPattern(state.search.query, state.search.matchCase, state.search.wholeWord);
  edit.newText = oldText.replace(pattern, replaceText);

  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(oldText) !== null) count++;

  return count;
}

// ==================== Replace exports ====================

/**
 * Replace the current search match.
 */
export async function replaceCurrentMatch(replaceText) {
  const result = getCurrentResult();
  if (!result) return null;
  // Pending OCR review corrections have their own immutable-result state.
  // The legacy Find/Replace path writes PDF content and must not be used for
  // this unsaved searchable-layer phase.
  if (result.items?.some((item) => item.source === 'ocr')) return null;

  const doc = getActiveDocument();
  if (!doc) return null;

  // Try annotation text first
  const replaced = replaceInAnnotation(doc, result, replaceText);
  if (replaced) return replaced;

  // Try existing text edits
  const replacedEdit = replaceInTextEdit(doc, result, replaceText);
  if (replacedEdit) return replacedEdit;

  // Base PDF content — create text edit via text-edit-tool infrastructure
  const replacedPdf = await replaceInPdfContent(doc, result, replaceText);
  if (replacedPdf) return replacedPdf;

  return null;
}

/**
 * Replace all search matches.
 */
export async function replaceAllMatches(replaceText) {
  const doc = getActiveDocument();
  if (!doc) return 0;

  const results = [...state.search.results];
  let count = 0;

  const annReplacements = new Map();
  const editReplacements = new Map();
  const pdfContentResults = [];

  for (const result of results) {
    if (result.items?.some((item) => item.source === 'ocr')) continue;
    const ann = findAnnotationForMatch(doc, result);
    if (ann) {
      if (!annReplacements.has(ann.id)) annReplacements.set(ann.id, []);
      annReplacements.get(ann.id).push(result);
      continue;
    }

    const edit = findTextEditForMatch(doc, result);
    if (edit) {
      if (!editReplacements.has(edit.id)) editReplacements.set(edit.id, []);
      editReplacements.get(edit.id).push(result);
      continue;
    }

    pdfContentResults.push(result);
  }

  for (const [annId, matches] of annReplacements) {
    const ann = doc.annotations.find(a => a.id === annId);
    if (!ann || !ann.text) continue;
    count += replaceAllInAnnotationText(doc, ann, matches, replaceText);
  }

  for (const [editId, matches] of editReplacements) {
    const edit = doc.textEdits?.find(e => e.id === editId);
    if (!edit) continue;
    count += replaceAllInTextEditText(doc, edit, matches, replaceText);
  }

  // PDF content — process each match individually via text-edit-tool
  for (const result of pdfContentResults) {
    const replaced = await replaceInPdfContent(doc, result, replaceText);
    if (replaced) count++;
  }

  return count;
}
