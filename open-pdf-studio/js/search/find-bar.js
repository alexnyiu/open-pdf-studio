import { preferredScrollBehavior } from '../core/motion.js';
import i18next from '../i18n/config.js';
const tr = (key, values) => i18next.t(`common:repair.${key}`, values);
import { waitForPageTextSurface } from '../pdf/page-surface-ready.js';
/**
 * Find Bar - UI component for PDF text search
 */

import { state, getActiveDocument } from '../core/state.js';
import { executeSearch, executeProgressiveSearch, findNext, findPrevious, getCurrentResult, clearSearch, getResultsForPage } from './find-controller.js';
import { goToPage, renderPage, renderContinuous } from '../pdf/renderer.js';
import { projectOcrItemToTextLayer } from '../text/text-layer.js';
import {
  setFindBarVisible as setVisible, setFindBarResultsText as setResultsText,
  setFindBarMessageText as setMessageText, setFindBarNotFound as setNotFound,
  setFindBarNavDisabled as setNavDisabled,
  setFindBarSearching as setSearching,
} from '../bridge.js';
import { noteDocumentViewMutation } from '../pdf/view-state-transaction.js';
import { resolvePageSurface } from '../pdf/page-surface-registry.js';

function noteSearchMutation() {
  noteDocumentViewMutation(getActiveDocument(), ['search']);
}

// Debounce timer for search input
let searchDebounceTimer = null;

// Cancel function for the current progressive search
let cancelProgressiveSearch = null;
let searchRequest = 0;
let navigationController = null;

/**
 * Initialize the find bar (no-op, retained for backward compatibility).
 * Event binding is now handled by the Solid.js FindBar component.
 */
let searchListenersInstalled = false;
export function initFindBar() {
  if (searchListenersInstalled) return;
  searchListenersInstalled = true;
  const refresh = event => {
    if (event.detail?.documentId && event.detail.documentId !== String(getActiveDocument()?.id)) return;
    if (!state.search.isOpen || !state.search.query) return;
    searchRequest++; navigationController?.abort(); cancelProgressiveSearch?.();
    clearHighlights(); clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => { if (state.search.isOpen) executeSearchAndUpdate(); }, 100);
  };
  window.addEventListener('opds:page-edit-readiness-cleared', refresh);
  window.addEventListener('opds:document-lifecycle-changed', refresh);
  window.addEventListener('opds:active-document-changed', refresh);
}

/**
 * Open the find bar
 */
export function openFindBar() {
  if (!state.search.isOpen) noteSearchMutation();
  setVisible(true);
  state.search.isOpen = true;

  // If there's existing search text, re-run search
  if (state.search.query) {
    executeSearchAndUpdate();
  }
}

/**
 * Close the find bar
 */
export function closeFindBar() {
  searchRequest++;
  navigationController?.abort();
  clearTimeout(searchDebounceTimer);
  if (state.search.isOpen) noteSearchMutation();
  setVisible(false);
  state.search.isOpen = false;

  // Cancel any in-progress search
  if (cancelProgressiveSearch) {
    cancelProgressiveSearch();
    cancelProgressiveSearch = null;
  }
  setSearching(false);

  // Clear highlights but keep search state
  clearHighlights();
}

/**
 * Toggle the find bar
 */
export function toggleFindBar() {
  if (state.search.isOpen) {
    closeFindBar();
  } else {
    openFindBar();
  }
}

/**
 * Handle search input (called from component)
 * @param {string} value - The current input value
 */
export function handleSearchInput(value) {
  searchRequest++;
  navigationController?.abort();
  const query = value;
  if (state.search.query !== query) noteSearchMutation();
  state.search.query = query;

  // Cancel any in-progress search
  if (cancelProgressiveSearch) {
    cancelProgressiveSearch();
    cancelProgressiveSearch = null;
  }

  // Debounce search
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }

  if (!query) {
    clearSearch();
    setSearching(false);
    updateUI();
    clearHighlights();
    return;
  }

  // The previous query is already superseded, including during debounce.
  // Do not leave its matches available to navigation or assistive technology.
  state.search.results = [];
  state.search.totalMatches = 0;
  state.search.currentIndex = -1;
  clearHighlights();
  setSearching(true);
  setResultsText(tr('searching'));
  setMessageText('');
  setNotFound(false);
  setNavDisabled(true);

  searchDebounceTimer = setTimeout(() => {
    executeSearchAndUpdate();
  }, 300);
}

/**
 * Handle find next button click
 */
export async function onFindNext() {
  // Cancel any pending debounce and use current query
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }

  if (state.search.results.length === 0) {
    // If no results yet, execute search first
    if (state.search.query) {
      await executeSearchAndUpdate();
    }
    return;
  }

  const result = findNext();
  if (result) {
    await navigateToResult(result);
    updateUI();
    highlightResults();
  }
}

/**
 * Trigger search from external call (e.g., Enter key press before debounce)
 */
export async function triggerSearch() {
  if (state.search.query) {
    await executeSearchAndUpdate();
  }
}

/**
 * Handle find previous button click
 */
export async function onFindPrevious() {
  // Cancel any pending debounce and use current query
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }

  if (state.search.results.length === 0) {
    if (state.search.query) {
      await executeSearchAndUpdate();
    }
    return;
  }

  const result = findPrevious();
  if (result) {
    await navigateToResult(result);
    updateUI();
    highlightResults();
  }
}

/**
 * Handle options change (match case, whole word)
 * @param {{ matchCase: boolean, wholeWord: boolean }} options
 */
export function onOptionsChange(options) {
  if (state.search.matchCase !== options.matchCase
      || state.search.wholeWord !== options.wholeWord) noteSearchMutation();
  state.search.matchCase = options.matchCase;
  state.search.wholeWord = options.wholeWord;

  // Cancel any in-progress search
  if (cancelProgressiveSearch) {
    cancelProgressiveSearch();
    cancelProgressiveSearch = null;
  }

  if (state.search.query) {
    // Reset results before re-searching
    state.search.results = [];
    state.search.totalMatches = 0;
    state.search.currentIndex = -1;
    executeSearchAndUpdate();
  }
}

/**
 * Handle highlight all checkbox change
 * @param {boolean} highlightAll
 */
export function onHighlightChange(highlightAll) {
  if (state.search.highlightAll !== highlightAll) noteSearchMutation();
  state.search.highlightAll = highlightAll;
  highlightResults();
}

/**
 * Execute search and update UI progressively
 */
async function executeSearchAndUpdate() {
  const request = ++searchRequest;
  navigationController?.abort();
  // Cancel any in-progress search
  if (cancelProgressiveSearch) {
    cancelProgressiveSearch();
    cancelProgressiveSearch = null;
  }

  const query = state.search.query;
  if (!query) return;

  // Reset state
  state.search.results = [];
  state.search.totalMatches = 0;
  state.search.currentIndex = -1;

  setSearching(true);
  setResultsText(tr('searching'));
  setMessageText('');
  setNotFound(false);
  setNavDisabled(true);

  let navigatedToFirst = false;
  // Track the matchText of the result we navigated to so we can find it after re-sort
  let navigatedMatchPage = -1;
  let navigatedMatchPos = -1;

  cancelProgressiveSearch = executeProgressiveSearch((results, searchedPages, totalPages, done, outcome = {}) => {
    if (request !== searchRequest || !state.search.isOpen) return;
    if (done && outcome.status && outcome.status !== 'completed') {
      setSearching(false);
      cancelProgressiveSearch = null;
      if (outcome.status === 'superseded' && state.search.query) {
        queueMicrotask(() => { if (request === searchRequest && state.search.isOpen) executeSearchAndUpdate(); });
      } else if (outcome.status === 'failed') {
        setResultsText(tr('searchFailed')); setMessageText(outcome.error || tr('searchRetry'));
        setNavDisabled(true);
      }
      return;
    }
    // Update state
    state.search.results = results;
    state.search.totalMatches = results.length;

    // Set currentIndex to first result on current page (or first overall)
    if (results.length > 0 && state.search.currentIndex === -1) {
      const doc = getActiveDocument();
      const currentPage = doc ? doc.currentPage : 1;
      let firstIndex = results.findIndex(r => r.pageNum >= currentPage);
      if (firstIndex === -1) firstIndex = 0;
      state.search.currentIndex = firstIndex;
    }

    // Update results count with page progress
    if (results.length > 0) {
      const idx = state.search.currentIndex;
      if (done) {
        setResultsText(tr('matchCount', { current: idx + 1, total: results.length }));
      } else {
        setResultsText(tr('partialMatchCount', { count: results.length, current: searchedPages, total: totalPages }));
      }
      setNavDisabled(false);
      setNotFound(false);
    } else if (done) {
      setResultsText(tr('noResults'));
      setNotFound(true);
      setMessageText(tr('phraseNotFound'));
    } else {
      setResultsText(tr('pageProgress', { current: searchedPages, total: totalPages }));
    }

    // Navigate to first result as soon as we have one
    if (!navigatedToFirst && results.length > 0) {
      navigatedToFirst = true;
      const result = getCurrentResult();
      if (result) {
        navigatedMatchPage = result.pageNum;
        navigatedMatchPos = result.startPos;
        navigateToResult(result);
      }
      highlightResults();
    }

    if (done) {
      setSearching(false);
      cancelProgressiveSearch = null;

      if (results.length > 0) {
        // After re-sort by page order, find the result we originally navigated to
        let newIdx = results.findIndex(r =>
          r.pageNum === navigatedMatchPage && r.startPos === navigatedMatchPos
        );
        if (newIdx === -1) {
          const doc = getActiveDocument();
          const currentPage = doc ? doc.currentPage : 1;
          newIdx = results.findIndex(r => r.pageNum >= currentPage);
          if (newIdx === -1) newIdx = 0;
        }
        state.search.currentIndex = newIdx;
        setResultsText(tr('matchCount', { current: newIdx + 1, total: results.length }));
      }
      setMessageText(results.length === 0 && query ? tr('phraseNotFound') : '');
      highlightResults();
    }
  });
}

/**
 * Navigate to a search result
 */
async function navigateToResult(result) {
  if (!result) return;
  navigationController?.abort();
  const controller = new AbortController();
  navigationController = controller;
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  try {
    await goToPage(result.pageNum, { absolute: true, behavior: 'auto' });
    const surface = await waitForPageTextSurface(doc, result.pageNum, { signal: controller.signal });
    if (controller.signal.aborted || getActiveDocument() !== doc || !state.search.isOpen) return;
    highlightResults();
    surface.textLayer.querySelector('.search-highlight.current')?.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    const { populateDocInfo } = await import('../solid/stores/propertiesStore.js');
    if (!controller.signal.aborted && getActiveDocument() === doc) await populateDocInfo();
  } catch (error) {
    if (error.name !== 'AbortError') setMessageText(error.message);
  }
}

/**
 * Scroll to a specific match on the current page
 */
function scrollToMatch(result) {
  if (!result || !result.items || result.items.length === 0) return;

  // Find the highlight element for the current match
  const highlights = document.querySelectorAll('.search-highlight.current');
  if (highlights.length > 0) {
    highlights[0].scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center', inline: 'center' });
  }
}

/**
 * Update the find bar UI via store signals
 */
function updateUI() {
  const { results, currentIndex, totalMatches, query } = state.search;

  // Update results count
  if (totalMatches > 0) {
    setResultsText(tr('matchCount', { current: currentIndex + 1, total: totalMatches }));
  } else if (query) {
    setResultsText(tr('noResults'));
  } else {
    setResultsText('');
  }

  // Update message
  if (query && totalMatches === 0) {
    setMessageText(tr('phraseNotFound'));
  } else {
    setMessageText('');
  }

  // Update not-found state (drives input + message styling)
  setNotFound(!!query && totalMatches === 0);

  // Update nav button disabled state
  setNavDisabled(totalMatches === 0);
}

/**
 * Highlight search results on the current page
 */
export function highlightResults() {
  // Clear existing highlights first
  clearHighlights();

  if (!state.search.highlightAll || state.search.results.length === 0) {
    // Still highlight current match even if highlightAll is off
    const currentResult = getCurrentResult();
    if (currentResult && currentResult.pageNum === (getActiveDocument()?.currentPage || 1)) {
      highlightMatch(currentResult, true);
    }
    return;
  }

  // Get results for the current page (or all pages in continuous mode)
  let pageResults;
  if (getActiveDocument()?.viewMode === 'continuous') {
    pageResults = state.search.results;
  } else {
    pageResults = getResultsForPage(getActiveDocument()?.currentPage || 1);
  }

  const currentResult = getCurrentResult();

  // Highlight all matches on the page
  pageResults.forEach(result => {
    const isCurrent = currentResult && result.index === currentResult.index;
    highlightMatch(result, isCurrent);
  });
}

/**
 * Highlight search results on a page.
 *
 * Highlights are positioned from the matched items' own PDF-space geometry
 * (transform/width/height captured at text extraction), NOT from measuring
 * DOM spans. The three text-layer builders (custom single-page PDF.js,
 * stock PDF.js TextLayer in continuous mode, Rust-extracted spans in vector
 * mode) produce different span structures — only one of them carries
 * data-item-index — so any DOM-based lookup breaks on the other two.
 * Item geometry is layer-type independent, and because the rects live in
 * layer-local coordinates they ride along with the viewport's zoom
 * transform instead of needing re-measurement.
 */
function highlightMatch(result, isCurrent) {
  if (!result || !result.items || result.items.length === 0) return;

  const pageNum = result.pageNum;
  const doc = getActiveDocument();

  // Resolve only the mounted layer owned by this document lifecycle and page.
  if (doc?.viewMode !== 'continuous' && doc?.currentPage !== pageNum) return;
  const textLayer = resolvePageSurface(doc, pageNum)?.textLayer || null;
  if (!textLayer) return;

  // Layer-local px per PDF point. Every layer builder sets
  // --total-scale-factor on the layer or an ancestor: 1 in vector mode
  // (layout px = PDF pt, zoom applied via CSS transform), viewport.scale
  // for the PDF.js-built layers (laid out at scaled size).
  const scale = parseFloat(
    getComputedStyle(textLayer).getPropertyValue('--total-scale-factor')
  ) || 1;
  const pageHeightPt = textLayer.offsetHeight / scale;

  for (const item of result.items) {
    if (item.source === 'ocr' && item.geometry?.polygon) {
      const projected = projectOcrItemToTextLayer(textLayer, {
        polygon: item.geometry.polygon,
        pageGeometry: item.geometry.pageGeometry,
      });
      if (!projected || projected.bounds.width <= 0 || projected.bounds.height <= 0) continue;
      const { left, top, width, height } = projected.bounds;
      const clipPoints = projected.points.map(([x, y]) => {
        const localX = 100 * (x - left) / width;
        const localY = 100 * (y - top) / height;
        return `${localX.toFixed(4)}% ${localY.toFixed(4)}%`;
      });
      const highlight = document.createElement('div');
      highlight.className = 'search-highlight' + (isCurrent ? ' current' : '');
      highlight.dataset.resultIndex = result.index;
      highlight.dataset.ocrLineId = item.ocrLineId;
      highlight.style.left = `${left}px`;
      highlight.style.top = `${top}px`;
      highlight.style.width = `${width}px`;
      highlight.style.height = `${height}px`;
      highlight.style.clipPath = `polygon(${clipPoints.join(', ')})`;
      textLayer.appendChild(highlight);
      continue;
    }

    const t = item.transform;
    if (!t) continue; // synthetic (Add Text) items carry no geometry

    const startInItem = Math.max(0, result.startPos - item.startPos);
    const endInItem = Math.min(item.str.length, result.endPos - item.startPos);
    if (endInItem <= startInItem) continue;

    // Partial matches inside an item: slice the run width proportionally
    // by character count. Approximate for proportional fonts, but close
    // enough for a highlight and independent of DOM/font availability.
    const len = item.str.length || 1;
    const itemH = item.height || Math.abs(t[3]) || 10;
    const itemW = item.width || 0;
    const x0 = t[4] + itemW * (startInItem / len);
    const x1 = t[4] + itemW * (endInItem / len);
    // t[5] is the baseline; ascent ≈ 0.8em above it (same convention the
    // vector-mode span builder uses), Y flipped into top-left space.
    const topPt = pageHeightPt - t[5] - itemH * 0.8;

    const highlight = document.createElement('div');
    highlight.className = 'search-highlight' + (isCurrent ? ' current' : '');
    highlight.dataset.resultIndex = result.index;
    highlight.style.left = (x0 * scale) + 'px';
    highlight.style.top = (topPt * scale) + 'px';
    highlight.style.width = (Math.max(x1 - x0, 2) * scale) + 'px';
    highlight.style.height = (itemH * scale) + 'px';
    textLayer.appendChild(highlight);
  }
}

/**
 * Clear all search highlights
 */
export function clearHighlights() {
  const highlights = document.querySelectorAll('.search-highlight');
  highlights.forEach(h => h.remove());
}

/**
 * Re-highlight after page render.
 * Uses requestAnimationFrame to ensure the text layer is fully laid out
 * before measuring positions, preventing highlights from flashing at
 * wrong positions during zoom.
 */
export function onPageRendered() {
  if (state.search.isOpen && state.search.results.length > 0) {
    requestAnimationFrame(() => {
      highlightResults();
    });
  }
}

// ==================== Replace handlers ====================

export async function onReplace() {
  try {
    const { replaceCurrentMatch, clearTextCache, getCurrentResult } = await import('./find-controller.js');
    const replaceWith = state.search.replaceQuery || '';

    // Ensure we're on the correct page
    const currentResult = getCurrentResult();
    if (currentResult) {
      const doc = getActiveDocument();
      if (doc && currentResult.pageNum !== doc.currentPage) {
        await navigateToResult(currentResult);
        await new Promise(r => setTimeout(r, 200));
      }
    }

    const replaced = await replaceCurrentMatch(replaceWith);
    if (replaced) {
      const doc = getActiveDocument();
      if (doc) clearTextCache(doc.id);

      if (getActiveDocument()?.viewMode === 'continuous') {
        await renderContinuous();
      } else {
        await renderPage(getActiveDocument()?.currentPage || 1);
      }
      await executeSearchAndUpdate();
    }
  } catch (err) {
    console.error('[onReplace]', err);
  }
}

export async function onReplaceAll() {
  const { replaceAllMatches, clearTextCache } = await import('./find-controller.js');
  const replaceWith = state.search.replaceQuery || '';

  const count = await replaceAllMatches(replaceWith);
  if (count > 0) {
    const doc = getActiveDocument();
    if (doc) clearTextCache(doc.id);

    // Re-render to show the text edits
    if (getActiveDocument()?.viewMode === 'continuous') {
      const { redrawContinuous } = await import('../annotations/rendering.js');
      redrawContinuous();
    } else {
      await renderPage(getActiveDocument()?.currentPage || 1);
    }

    // Re-search
    await executeSearchAndUpdate();

    setMessageText(`Replaced ${count} occurrences`);
  } else {
    setMessageText('No replacements made');
  }
}

export function handleReplaceInput(value) {
  if (state.search.replaceQuery !== value) noteSearchMutation();
  state.search.replaceQuery = value;
}
