/**
 * Find Controller - Core search logic for PDF text search.
 * Supports progressive (page-by-page) searching with cancellation
 * and accurate text replacement via the text-edit-tool infrastructure.
 */

import { state, getActiveDocument } from '../core/state.js';
import { projectTextEditRecord, replaceFirstRichTextMatch } from '../text/rich-text.js';
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

/**
 * Replace a match in base PDF content.
 *
 * Strategy: find the DOM span via dataset.itemIndex, read all PDF metadata
 * from span data attributes, and create a text edit that covers exactly
 * the span's area with the replaced text.
 */
/**
 * Replace text directly in the PDF content stream using pdf-lib.
 * This modifies the actual PDF data — no overlays, no white rectangles.
 */
let _replacing = false;

async function replaceInPdfContent(doc, result, replaceText) {
  if (_replacing) return null;
  _replacing = true;
  try {
    if (!doc.filePath) return null;

    const loaderMod = await import('../pdf/loader.js');
    const pdfBytes = loaderMod.getCachedPdfBytes(doc.filePath);
    if (!pdfBytes) return null;

    const pdfLib = await import('pdf-lib');
    const pdfLibDoc = await pdfLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const matchText = result.matchText;
    let replaced = false;

    for (const [ref, obj] of pdfLibDoc.context.enumerateIndirectObjects()) {
      if (replaced) break;
      if (!(obj instanceof pdfLib.PDFRawStream)) continue;

      try {
        const sub = obj.dict?.get(pdfLib.PDFName.of('Subtype'));
        if (sub === pdfLib.PDFName.of('Image')) continue;
      } catch (_) { continue; }

      try {
        const decoded = pdfLib.decodePDFRawStream(obj).decode();
        const content = pdfLib.arrayAsString(decoded);

        if (content.includes(matchText)) {
          const newContent = content.replace(matchText, replaceText);
          if (newContent !== content) {
            const newStream = pdfLibDoc.context.flateStream(newContent);
            pdfLibDoc.context.assign(ref, newStream);
            replaced = true;
          }
        }
      } catch (_) {}
    }

    if (!replaced) return null;

    const newBytes = await pdfLibDoc.save();
    const newBytesArr = new Uint8Array(newBytes);
    loaderMod.setCachedPdfBytes(doc.filePath, newBytesArr);

    // Reload pdf.js document
    const pdfjsLib = await import('pdfjs-dist');
    doc.pdfDoc = await pdfjsLib.getDocument({
      data: newBytesArr.slice(),
      cMapUrl: '/pdfjs/web/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/web/standard_fonts/',
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
    doc._sharedPdfLibDoc = null;
    doc._sharedPdfLibDocPromise = null;
    doc.modified = true;

    return { type: 'pdfContent', oldText: matchText, newText: replaceText };
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
