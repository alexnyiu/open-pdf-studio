import { preferredScrollBehavior } from '../../core/motion.js';
import {
  state,
  getActiveDocument,
  getDocumentById,
  getPageRotation,
} from '../../core/state.js';
import { drawAnnotation } from '../../annotations/rendering.js';
import { updateAnnotationsList } from './annotations-list.js';
import { updateAttachmentsList } from './attachments.js';
import { updateSignaturesList } from './signatures.js';
import { updateLayersList } from './layers.js';
import { updateFormFieldsList } from './form-fields.js';
import { updateDestinationsList } from './destinations.js';
import { updateTagsList } from './tags.js';
import { updateLinksList } from './links.js';
import { updateBookmarksList } from './bookmarks.js';
import {
  showMessage,
  switchToLeftPanelTab, toggleLeftPanelCollapsed,
  leftPanelActiveTab as activeTab, setLeftPanelActiveTab as setActiveTab,
  setLeftPanelCollapsed as setCollapsed,
  setThumbnailPageCount as setPageCount, setThumbnailActivePage as setActivePage,
  setThumbnailPlaceholderSize as setPlaceholderSize,
  setThumbnailPagePlaceholderSize as setPagePlaceholderSize,
  setThumbnailImage, clearAllThumbnails, removeThumbnailImage,
  getThumbnailContainerRef as getContainerRef,
  thumbnailSelectedPages, selectThumbnailPage,
} from '../../bridge.js';
import { shouldPreloadEntireDocument, shouldPreloadNearby } from '../../pdf/preload-policy.js';
import {
  registerRenderResource,
  touchRenderResource,
  unregisterRenderResource,
} from '../../pdf/render-resource-budget.js';
import { recordPerformancePeak } from '../../pdf/performance-metrics.js';
import { noteDocumentViewMutation } from '../../pdf/view-state-transaction.js';
import {
  captureRenderPublicationToken,
  recordRejectedRenderPublication,
  renderPublicationTokenIsCurrent,
  trackPdfJsRenderTask,
} from '../../pdf/render-publication-token.js';
import { updateThumbnailDocumentOwner } from './thumbnail-document-owner.js';

// Thumbnail scale (relative to actual page size). The thumbnail panel
// displays at ~152 px wide; rendering close to that 1:1 saves PDFium
// work without visible quality loss. 0.14 puts an A4 portrait at
// ~595*0.14 = 83 pt = ~111 px wide; landscape A0 at ~5156*0.14 = 722 pt
// → capped to targetW=140 by the JS-replay path.
const THUMBNAIL_SCALE = 0.14;

// Cache for thumbnail data per document: Map<docId, Map<pageNum, imageDataURL>>
const thumbnailCache = new Map();
const thumbnailPromises = new Map();
const thumbnailRenderTasks = new Map();
const preloadOnlyPages = new Map();
const thumbnailResourceKey = (docId, pageNum, token = null) => [
  'thumbnail',
  docId,
  `g${Number(token?.lifecycleGeneration) || 0}`,
  `c${Number(token?.contentRevision) || 0}`,
  `p${pageNum}`,
  `v${Number(token?.pageRevision) || 0}`,
].join(':');
const thumbnailEntryResourceKey = (docId, pageNum, entry = null) => (
  entry?.resourceKey || thumbnailResourceKey(docId, pageNum, entry?.publicationToken)
);

function recordThumbnailMemory() {
  recordPerformancePeak(
    'thumbnailBytes',
    [...thumbnailCache.values()].reduce((total, cache) => total
      + [...cache.values()].reduce((sum, entry) => sum + (Number(entry?.bytes) || 0), 0), 0),
  );
}

function registerThumbnailResource(doc, pageNum, entry, cache) {
  entry.resourceKey = thumbnailResourceKey(doc.id, pageNum, entry.publicationToken);
  registerRenderResource({
    key: entry.resourceKey,
    category: 'metadata',
    documentId: doc.id,
    bytes: entry.bytes,
    protected: () => getActiveDocument()?.id === doc.id
      && (getActiveDocument()?.currentPage === pageNum || visibleThumbnailPages().includes(pageNum)),
    release: () => {
      const current = cache.get(pageNum);
      revokeThumbnailEntry(current);
      cache.delete(pageNum);
      recordThumbnailMemory();
      preloadOnlyPages.get(doc.id)?.delete(pageNum);
      if (getActiveDocument()?.id === doc.id) removeThumbnailImage(pageNum);
    },
  });
}

// Per-doc per-page generation counter. Bumped on invalidateThumbnail() so a
// stale render-completion (annotations changed mid-flight, rapid re-invalidate)
// can be discarded and not overwrite a newer cache entry. See bumpPageGen /
// pageGenMatches usage below.
const pageGeneration = new Map(); // Map<docId, Map<pageNum, int>>

function owningPageRotation(doc, pageNum) {
  return Number(doc?.pageRotations?.[pageNum]) || 0;
}

function revokeThumbnailEntry(entry) {
  const src = entry?.src;
  if (typeof src === 'string' && src.startsWith('blob:')) URL.revokeObjectURL(src);
}

async function normalizeThumbnailEntry(rendered, generation, publicationToken = null) {
  if (!rendered) return null;
  let src = rendered.src || rendered.dataURL || '';
  let bytes = Number(rendered.bytes) || 0;
  if (src.startsWith('data:') && typeof fetch === 'function'
      && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const blob = await fetch(src).then((response) => response.blob());
      src = URL.createObjectURL(blob);
      bytes = blob.size;
    } catch { /* keep the data URL */ }
  }
  if (!bytes) bytes = Math.ceil(src.length * 0.75);
  return {
    src,
    width: Math.max(1, Math.round(rendered.width || 1)),
    height: Math.max(1, Math.round(rendered.height || 1)),
    bytes,
    generation,
    publicationToken,
  };
}

function bumpPageGen(docId, pageNum) {
  let m = pageGeneration.get(docId);
  if (!m) { m = new Map(); pageGeneration.set(docId, m); }
  const g = (m.get(pageNum) || 0) + 1;
  m.set(pageNum, g);
  return g;
}
function getPageGen(docId, pageNum) {
  return pageGeneration.get(docId)?.get(pageNum) || 0;
}
function pageGenMatches(docId, pageNum, gen) {
  return getPageGen(docId, pageNum) === gen;
}

function thumbnailPublicationIsCurrent(doc, publicationToken) {
  return getDocumentById(doc?.id) === doc
    && renderPublicationTokenIsCurrent(publicationToken, doc);
}

function thumbnailPublicationIsReusable(doc, pageNum, publicationToken) {
  if (!doc?.id || !publicationToken) return false;
  const pageRevision = Number(doc.revisionState?.pageContentRevisions?.[pageNum]
    ?? doc.pageRenderRevisions?.[pageNum]) || 0;
  return String(publicationToken.documentId || '') === String(doc.id)
    && Number(publicationToken.pageRevision) === pageRevision;
}

// Store pdfDoc references and state for each document
const documentState = new Map(); // { pdfDoc, numPages, nextPage, startPage }

// Priority queue for visible thumbnails (pages that should load first)
let priorityPages = new Set();

// Track the last scroll position to continue loading from there
let lastVisiblePage = 1;

// Per-document thumbnail scroll position: Map<docId, number>
const thumbnailScrollPositions = new Map();

// Scroll debounce timer
let scrollDebounceTimer = null;

// Track if scroll listener is attached
let scrollListenerAttached = false;
let foregroundActivityListenerAttached = false;

// Initialize left panel
export function initLeftPanel() {
  attachScrollListener();
  if (!foregroundActivityListenerAttached) {
    window.addEventListener('opds:pdf-foreground-activity', () => pauseThumbnails(250));
    foregroundActivityListenerAttached = true;
  }
}

// Attach scroll listener to the thumbnails container via store ref
function attachScrollListener() {
  if (scrollListenerAttached) return;
  const tc = getContainerRef();
  if (tc) {
    tc.addEventListener('scroll', handleThumbnailScroll);
    scrollListenerAttached = true;
  } else {
    // Retry until SolidJS sets the ref
    setTimeout(attachScrollListener, 100);
  }
}

// Handle scroll in thumbnails container - debounced
function handleThumbnailScroll() {
  if (scrollDebounceTimer) {
    clearTimeout(scrollDebounceTimer);
  }

  scrollDebounceTimer = setTimeout(() => {
    updateVisiblePriorities();
  }, 100);
}

// Find visible thumbnails and add them to priority queue
function updateVisiblePriorities() {
  const thumbnailsContainer = getContainerRef();
  if (!thumbnailsContainer) return;

  const activeDoc = getActiveDocument();
  if (!activeDoc) return;

  const docCache = thumbnailCache.get(activeDoc.id);
  if (!docCache) return;

  const docState = documentState.get(activeDoc.id);

  const containerRect = thumbnailsContainer.getBoundingClientRect();
  const thumbnails = thumbnailsContainer.querySelectorAll('.thumbnail-item');

  priorityPages.clear();

  let firstVisiblePage = null;

  thumbnails.forEach(thumb => {
    const thumbRect = thumb.getBoundingClientRect();

    const isVisible = (
      thumbRect.top < containerRect.bottom &&
      thumbRect.bottom > containerRect.top
    );

    if (isVisible) {
      const pageNum = parseInt(thumb.dataset.page);

      if (firstVisiblePage === null) {
        firstVisiblePage = pageNum;
      }

      if (!docCache.has(pageNum)) {
        priorityPages.add(pageNum);
      }
    }
  });

  if (firstVisiblePage !== null && docState) {
    lastVisiblePage = firstVisiblePage;
    docState.nextPage = firstVisiblePage;
    docState.startPage = firstVisiblePage;
    docState.wrapped = false;
  }

  if (priorityPages.size > 0) {
    startProcessor();
  }
  if (shouldPreloadEntireDocument(activeDoc, state.preferences)) {
    import('../../pdf/whole-pdf-preload.js').then((module) => module.startWholePdfPreload(activeDoc));
  }
}

// Switch between tabs
export function switchLeftPanelTab(panelId) {
  if (activeTab() !== panelId) noteDocumentViewMutation(getActiveDocument(), ['panels']);
  switchToLeftPanelTab(panelId);
  refreshTabContent(panelId);
}

// Refresh whichever tab is currently active (call after loading a new document)
export function refreshActiveTab() {
  const panelId = activeTab();
  if (panelId && panelId !== 'thumbnails') {
    refreshTabContent(panelId);
  }
}

export function refreshAllTabs() {
  const tabs = ['annotations', 'attachments', 'signatures', 'layers', 'form-fields', 'destinations', 'tags', 'links', 'bookmarks'];
  for (const tab of tabs) {
    refreshTabContent(tab);
  }
}

function refreshTabContent(panelId) {
  if (panelId === 'annotations') {
    updateAnnotationsList();
  } else if (panelId === 'attachments') {
    updateAttachmentsList();
  } else if (panelId === 'signatures') {
    updateSignaturesList();
  } else if (panelId === 'layers') {
    updateLayersList();
  } else if (panelId === 'form-fields') {
    updateFormFieldsList();
  } else if (panelId === 'destinations') {
    updateDestinationsList();
  } else if (panelId === 'tags') {
    updateTagsList();
  } else if (panelId === 'links') {
    updateLinksList();
  } else if (panelId === 'bookmarks') {
    updateBookmarksList();
  }
}

// Toggle panel collapse/expand
export function toggleLeftPanel() {
  noteDocumentViewMutation(getActiveDocument(), ['panels']);
  toggleLeftPanelCollapsed();
}

// Track if processor is running
let processorRunning = false;

// Generate thumbnails for all pages (sets store signals and starts generation)
export async function generateThumbnails({ restoreScroll = false } = {}) {
  const activeDoc = getActiveDocument();
  if (!activeDoc || !activeDoc.pdfDoc) {
    return;
  }

  const pdfDoc = activeDoc.pdfDoc;
  const docId = activeDoc.id;
  const numPages = pdfDoc.numPages;
  const lifecycleGeneration = Number(activeDoc.lifecycleGeneration) || 0;
  const pageViewRevision = Number(activeDoc.viewMutationState?.fields?.page) || 0;
  const ownerIsCurrent = () => getActiveDocument() === activeDoc
    && activeDoc.pdfDoc === pdfDoc
    && (Number(activeDoc.lifecycleGeneration) || 0) === lifecycleGeneration;

  // Switch the panel owner synchronously. The first-page geometry request
  // must not leave the previous tab's images or page count interactive.
  clearAllThumbnails();
  setPageCount(numPages);
  setActivePage(activeDoc.currentPage || 1);

  // Get first page dimensions for placeholder sizing
  let placeholderWidth = 150;
  let placeholderHeight = Math.round(150 * 1.414);
  try {
    const firstPage = await pdfDoc.getPage(1);
    const extraRot = owningPageRotation(activeDoc, 1);
    const thOpts = { scale: THUMBNAIL_SCALE };
    if (extraRot) thOpts.rotation = (firstPage.rotate + extraRot) % 360;
    const viewport = firstPage.getViewport(thOpts);
    placeholderWidth = Math.round(viewport.width);
    placeholderHeight = Math.round(viewport.height);
  } catch (err) {
    console.warn('[Thumbnails] Could not get first page dimensions:', err);
  }

  if (!ownerIsCurrent()) return;

  // Initialize or update document state
  const priorDocumentState = documentState.get(docId);
  documentState.set(docId, updateThumbnailDocumentOwner(
    priorDocumentState,
    activeDoc,
    pdfDoc,
  ));

  // Initialize cache for this document if needed
  if (!thumbnailCache.has(docId)) {
    thumbnailCache.set(docId, new Map());
  }
  const docCache = thumbnailCache.get(docId);

  // Update Solid store signals - this triggers reactive rendering of ThumbnailItem components
  setPlaceholderSize({ width: placeholderWidth, height: placeholderHeight });

  // Populate store with any already-cached thumbnail data
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    if (docCache.has(pageNum)) {
      setThumbnailImage(pageNum, docCache.get(pageNum));
    }
  }

  // Mark current page as active and restore scroll position
  updateActiveThumbnail(restoreScroll
    && (Number(activeDoc.viewMutationState?.fields?.page) || 0) === pageViewRevision);

  // Ensure scroll listener is attached (Solid may have re-rendered the container)
  scrollListenerAttached = false;
  attachScrollListener();

  // Update priorities based on initially visible thumbnails
  setTimeout(updateVisiblePriorities, 50);

  // Start the processor if not running
  startProcessor();
  if (shouldPreloadEntireDocument(activeDoc, state.preferences)) {
    void import('../../pdf/whole-pdf-preload.js').then((module) => module.startWholePdfPreload(activeDoc));
  }
}

// Pause/resume mechanism: when the user navigates pages, pause thumbnail
// rendering so Rust IPC calls for page rendering aren't blocked.
let _thumbnailsPaused = false;
let _thumbnailPauseTimer = null;

export function pauseThumbnails(settleMs = 250) {
  _thumbnailsPaused = true;
  if (_thumbnailPauseTimer) clearTimeout(_thumbnailPauseTimer);
  // Auto-resume after a short window of no navigation. Was 3000ms — that
  // caused thumbnails to sit idle for ~3s after document open because
  // renderer.js calls pauseThumbnails() on the very first page render.
  // Resume after the shared interaction settle period.
  _thumbnailPauseTimer = setTimeout(() => {
    _thumbnailsPaused = false;
    _thumbnailPauseTimer = null;
    startProcessor();
  }, Math.max(0, Number(settleMs) || 250));
}

// Resume thumbnail rendering immediately. Called by the page renderer once
// its IPC-heavy work (extract_draw_commands / prepareImages) has finished,
// so thumbnails don't have to wait the full pause window on initial load.
export function resumeThumbnails() {
  if (!_thumbnailsPaused) return;
  if (_thumbnailPauseTimer) {
    clearTimeout(_thumbnailPauseTimer);
    _thumbnailPauseTimer = null;
  }
  _thumbnailsPaused = false;
  startProcessor();
}

// True when the thumbnail pipeline is quiet enough that a low-priority page
// prefetch won't contend with VISIBLE-thumbnail generation — the exact
// contention that got the old prefetchAdjacentPages removed. Safe to prefetch
// when: not paused for active navigation, AND no visible (priority) thumbnails
// are still pending. Background (off-screen) thumbnails are low priority and
// fine to yield to a prefetch.
export function isThumbnailPipelineIdle() {
  return !_thumbnailsPaused && priorityPages.size === 0;
}

// Start the thumbnail processor. The previous 250ms delay added a visible
// lag on small documents — once paused-state is honored, the very first
// thumbnail no longer competes with the active-page render, so a tiny
// yield (1 task tick) is enough to let the UI paint the placeholder first.
function startProcessor() {
  if (processorRunning) return;
  processorRunning = true;
  setTimeout(processNextThumbnail, 0);
}

// Process the next thumbnail (prioritizes visible pages, then active document)
async function processNextThumbnail() {
  // If paused (user is navigating), wait and retry
  if (_thumbnailsPaused) {
    processorRunning = false;
    return;
  }

  try {
    const activeDoc = getActiveDocument();
    const activeDocId = activeDoc?.id;

    if (activeDocId && priorityPages.size > 0) {
      const processed = await processPriorityThumbnail(activeDocId);
      if (processed) {
        setTimeout(processNextThumbnail, 0);
        return;
      }
    }

    if (activeDocId && shouldPreloadNearby(state.preferences)
        && !shouldPreloadEntireDocument(activeDoc, state.preferences)) {
      const docState = documentState.get(activeDocId);
      const docCache = thumbnailCache.get(activeDocId);
      const center = activeDoc?.currentPage || 1;
      const directional = [center, center + 1, center + 2, center + 3, center - 1]
        .filter((page) => page >= 1 && page <= (docState?.numPages || 0) && !docCache?.has(page));
      if (directional.length > 0) {
        await preloadThumbnailPage(docState.doc, directional[0], { preloadOnly: false });
        setTimeout(processNextThumbnail, 0);
        return;
      }
    }

    processorRunning = false;
  } catch (err) {
    console.error('[Thumbnails] Processor error:', err);
    processorRunning = false;
    setTimeout(startProcessor, 100);
  }
}

// Process a priority (visible) thumbnail first
async function processPriorityThumbnail(docId) {
  const docState = documentState.get(docId);
  const docCache = thumbnailCache.get(docId);

  if (!docState || !docCache || priorityPages.size === 0) {
    return false;
  }

  const { pdfDoc } = docState;

  const pageNum = priorityPages.values().next().value;
  priorityPages.delete(pageNum);

  if (docCache.has(pageNum)) {
    return priorityPages.size > 0;
  }

  try {
    await preloadThumbnailPage(docState.doc, pageNum, { preloadOnly: false });
    return true;
  } catch (err) {
    console.warn(`[Thumbnails] Error rendering priority page ${pageNum}:`, err);
    return true;
  }
}

// Composite plugin/Solid-store annotations on top of a rendered thumbnail
// dataURL. Returns a new dataURL with annotations overlayed. If the page has
// no annotations, returns the input dataURL unchanged (zero-cost early-exit).
async function overlayAnnotationsOnDataURL(dataURL, pageNum, width, height, scale, doc) {
  // Overlay the OWNING document's annotations, not the active one's (see
  // renderThumbnailToDataURL) — otherwise a background thumbnail got the
  // active document's annotations painted on it.
  if (!doc) doc = getActiveDocument();
  const annotations = (doc?.annotations || []).filter(a => a.page === pageNum);
  if (annotations.length === 0) return dataURL;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataURL;
    });
    ctx.drawImage(img, 0, 0, width, height);
    ctx.save();
    ctx.scale(scale, scale);
    annotations.forEach(a => {
      try { drawAnnotation(ctx, a); }
      catch (e) {
        // Tolerant: 1 broken annotation mag thumb niet breken — wel loggen
        // zodat plugin-bugs niet stilletjes verdwijnen in productie.
        console.warn(`[Thumbnails] drawAnnotation failed page ${pageNum} id=${a?.id ?? '?'} type=${a?.type ?? '?'}:`, e);
      }
    });
    ctx.restore();
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch (e) {
    console.warn(`[Thumbnails] overlay failed for page ${pageNum}:`, e);
    return dataURL;
  }
}

async function expectedThumbnailSize(pdfDoc, pageNum, doc, publicationToken = null) {
  const page = await pdfDoc.getPage(pageNum);
  if (publicationToken && !thumbnailPublicationIsCurrent(doc, publicationToken)) {
    recordRejectedRenderPublication(publicationToken, 'thumbnail-size-after-page');
    return null;
  }
  const rotation = (page.rotate + owningPageRotation(doc, pageNum)) % 360;
  const viewport = page.getViewport({ scale: 1, rotation });
  const scale = 140 / Math.max(1, viewport.width);
  const size = {
    width: 140,
    height: Math.max(1, Math.round(viewport.height * scale)),
  };
  if (doc) {
    if (!doc.thumbnailDims) doc.thumbnailDims = {};
    doc.thumbnailDims[pageNum] = {
      width: size.width,
      height: size.height,
      rotation,
    };
  }
  if (getActiveDocument()?.id === doc?.id) setPagePlaceholderSize(pageNum, size);
  return { ...size, viewport, rotation };
}

async function renderCompleteWorkerThumbnail(pdfDoc, pageNum, doc, publicationToken) {
  if (!doc?.filePath || !window.__TAURI__) return null;
  const expected = await expectedThumbnailSize(pdfDoc, pageNum, doc, publicationToken);
  if (!expected) return null;
  const renderWidth = 280;
  const renderScale = Math.max(0.008, Math.min(0.75, renderWidth / Math.max(1, expected.viewport.width)));
  const { renderPdfPageBitmap } = await import('../../pdf/engine-router.js');
  const rendered = await renderPdfPageBitmap({
    path: doc.filePath,
    pageIndex: pageNum - 1,
    scale: renderScale,
    rotation: owningPageRotation(doc, pageNum),
    requestId: publicationToken?.requestId || '',
  });
  if (!thumbnailPublicationIsCurrent(doc, publicationToken)) {
    try { rendered?.bitmap?.close?.(); } catch {}
    recordRejectedRenderPublication(publicationToken, 'thumbnail-native-result-stale');
    return null;
  }
  const { bitmap, width: sourceWidth, height: sourceHeight } = rendered;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    try { bitmap?.close?.(); } catch {}
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = expected.width;
  canvas.height = expected.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  try { bitmap.close?.(); } catch {}
  const dataURL = canvas.toDataURL('image/jpeg', 0.78);
  const composited = await overlayAnnotationsOnDataURL(
    dataURL,
    pageNum,
    canvas.width,
    canvas.height,
    canvas.width / expected.viewport.width,
    doc,
  );
  return { dataURL: composited, width: canvas.width, height: canvas.height };
}

// Render a single page thumbnail — prefers replaying JS-cached vector commands
// (already extracted by the main viewer) for ~3-6× speedup; falls back to the
// Rust backend, then PDF.js. Reusing the cache avoids re-parsing the PDF
// content stream + IPC + JPEG encode + base64 round-trip.
async function renderThumbnailToDataURL(pdfDoc, pageNum, doc, publicationToken) {
  if (!pdfDoc || !Number.isInteger(pageNum) || pageNum < 1 || pageNum > pdfDoc.numPages) return null;
  const _th0 = performance.now();

  // `doc` is the document that owns `pdfDoc`, passed by the thumbnail processor.
  // The old code always used getActiveDocument() here, so a background
  // document's thumbnails were rendered against the ACTIVE document's file
  // path (and annotations) — one file's pages leaked into another's panel when
  // several documents were open. Only fall back to the active doc for legacy
  // direct callers that don't pass one.
  if (!doc) doc = getActiveDocument();
  // ── Fast path: JS replay of cached vector commands ────────────────────────
  // Only viable if the main viewer has already populated the cache for this
  // page (e.g. user navigated to it once, or it was prefetched).
  try {
    if (doc?.filePath) {
      const vr = await import('../../pdf/vector-renderer.js');
      const rotation = owningPageRotation(doc, pageNum);
      if (vr.hasCachedCommands(doc.filePath, pageNum, rotation)) {
        const dims = vr.getCachedPageDimensions(doc.filePath, pageNum, rotation);
        console.log(`[thumb] p${pageNum} JS-replay: dims=`, dims, `rotation=${rotation}`);
        if (dims && dims.w > 0 && dims.h > 0) {
          // Target 200 px wide thumbnail (matches Rust path).
          // For LANDSCAPE pages (w > h), 200 px wide stays under common UI
          // limits. For PORTRAIT pages (h > w), 200 px wide may produce a
          // thumbnail taller than the panel — but downstream layout handles
          // that. The original sizing is preserved here for compatibility.
          const targetW = 140;
          const scale = targetW / dims.w;
          const w = Math.max(1, Math.round(dims.w * scale));
          const h = Math.max(1, Math.round(dims.h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          // Paint white background so transparency doesn't bleed to JPEG.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          // Replay the cached vector commands at the thumbnail scale.
          // renderVectorPage applies its own Y-flip + MediaBox-origin shift
          // — caller transform is just (scale, scale) with zero translation.
          vr.renderVectorPage(ctx, doc.filePath, pageNum, { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }, rotation);
          console.log(`[thumb] p${pageNum} JS-replay rendered: canvas=${w}x${h} scale=${scale.toFixed(4)}`);
          // Blanco-vangnet: op pagina's met een gecentreerde MediaBox
          // (x0/y0 negatief, AutoCAD/InDesign-export) plaatst de replay de
          // content buiten het canvas — de hoofdweergave maskeert dat met een
          // PDFium-bitmap eronder, maar de thumbnail blijft dan wit. Sample de
          // canvas; is hij (vrijwel) leeg terwijl er wél commando's waren, val
          // dan door naar het Rust-pad dat via PDFium correct rendert.
          let _blank = true;
          try {
            const _d = ctx.getImageData(0, 0, w, h).data;
            let _ink = 0;
            for (let k = 0; k < _d.length; k += 4 * 7) {
              if (!(_d[k] > 245 && _d[k + 1] > 245 && _d[k + 2] > 245)) { _ink++; if (_ink > 8) break; }
            }
            _blank = _ink <= 8;
          } catch { _blank = false; /* sampling faalt → vertrouw de replay */ }
          if (_blank) {
            console.log(`[thumb] p${pageNum} JS-replay leeg → val terug op Rust-pad`);
          } else {
            const dataURL = canvas.toDataURL('image/jpeg', 0.7);
            // Overlay annotations on top (same as Rust path).
            try {
              const composited = await overlayAnnotationsOnDataURL(dataURL, pageNum, w, h, scale, doc);
              return { dataURL: composited, width: w, height: h };
            } catch {
              return { dataURL, width: w, height: h };
            }
          }
        }
      }
    }
  } catch (_) { /* fall through to Rust path */ }

  try {
    const complete = await renderCompleteWorkerThumbnail(
      pdfDoc,
      pageNum,
      doc,
      publicationToken,
    );
    if (complete) return complete;
  } catch (error) {
    console.warn(`[Thumbnails] Worker thumbnail failed for page ${pageNum}:`, error);
  }

  // ── Zware pagina's: thumbnail uit de progressieve whole-page-bitmap ──────
  // render_thumbnail is een SYNC in-proc command: op een zwaar CAD-blad
  // blokkeert het de IPC-lane seconden (alle andere invokes wachten) en
  // parst het het blad DUBBEL naast de worker (~1 GB extra). De progressieve
  // render cachet een volledige bitmap — downschalen daarvan is gratis. Nog
  // geen bitmap? Dan geen thumbnail; de progressieve run roept na afloop
  // invalidateThumbnail aan zodat hij alsnog verschijnt.
  try {
    if (doc?.filePath) {
      const prog = await import('../../pdf/progressive-render.js');
      const ptc = await import('../../pdf/page-type-cache.js');
      // 'tile'-geclassificeerde pagina's dragen zware raster/beeld-XObjects
      // (bv. een 35 MP JPEG). page_content_size ziet alleen de content-stream
      // (~0 MB voor zo'n blad) dus isHeavyPage mist ze — maar de in-proc
      // render_thumbnail hieronder decodeert hun beelden op VOLLE resolutie in
      // het hoofdproces (~1 GB per blad; over meerdere bladen → heap-corruptie
      // en crash tijdens openen). Route ze daarom net als zware pagina's via de
      // worker-pool (aparte processen, crash-geïsoleerd), NIET in-proc.
      const _isTile = ptc.getCachedPageType(doc.filePath, pageNum - 1) === 'tile';
      if (_isTile || await prog.isHeavyPage(doc.filePath, pageNum)) {
        const pbc = await import('../../pdf/page-bitmap-cache.js');
        const rotation = owningPageRotation(doc, pageNum);
        const best = pbc.getBestAvailableBitmap(doc.filePath, pageNum, rotation, 1);
        if (best && best.bitmap) {
          const targetW = 140;
          const s = targetW / best.w;
          const w = Math.max(1, Math.round(best.w * s));
          const h = Math.max(1, Math.round(best.h * s));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(best.bitmap, 0, 0, w, h);
          const dataURL = canvas.toDataURL('image/jpeg', 0.7);
          const widthPt = doc.pageDims?.[pageNum]?.widthPt;
          const overlayScale = widthPt ? w / widthPt : null;
          if (overlayScale) {
            try {
              const composited = await overlayAnnotationsOnDataURL(dataURL, pageNum, w, h, overlayScale, doc);
              console.log(`[thumb] p${pageNum} uit prog-bitmap (${w}x${h})`);
              return { dataURL: composited, width: w, height: h };
            } catch { /* val terug op kale bitmap hieronder */ }
          }
          console.log(`[thumb] p${pageNum} uit prog-bitmap (${w}x${h}, zonder overlay)`);
          return { dataURL, width: w, height: h };
        }
        // Nog geen prog-bitmap (pagina niet in beeld geweest) → render een
        // KLEINE whole-page bitmap via de worker-pool (snel, off-thread, geen
        // dubbele in-proc parse). Zo verschijnen ALLE thumbnails binnen enkele
        // seconden i.p.v. pas na een bezoek aan elke pagina.
        try {
          const widthPt = doc.pageDims?.[pageNum]?.widthPt || 2000;
          // Render op ~2x thumbnailbreedte (scherpe AA op dun lijnwerk), daarna
          // downschalen naar 140 px.
          const renderW = 280;
          const thumbScale = Math.max(0.008, Math.min(0.5, renderW / widthPt));
          const { renderPdfPageBitmap } = await import('../../pdf/engine-router.js');
          const rendered = await renderPdfPageBitmap({
            path: doc.filePath,
            pageIndex: pageNum - 1,
            scale: thumbScale,
            rotation,
            requestId: publicationToken?.requestId || '',
          });
          if (rendered?.bitmap && rendered.width > 0 && rendered.height > 0) {
              const { bitmap, width: rw, height: rh } = rendered;
              const targetW = 140;
              const s = targetW / rw;
              const w = Math.max(1, Math.round(rw * s));
              const h = Math.max(1, Math.round(rh * s));
              const canvas = document.createElement('canvas');
              canvas.width = w; canvas.height = h;
              const ctx = canvas.getContext('2d');
              ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
              ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
              ctx.drawImage(bitmap, 0, 0, w, h);
              try { bitmap.close?.(); } catch {}
              const dataURL = canvas.toDataURL('image/jpeg', 0.7);
              const oScale = doc.pageDims?.[pageNum]?.widthPt ? w / doc.pageDims[pageNum].widthPt : null;
              if (oScale) {
                try {
                  const composited = await overlayAnnotationsOnDataURL(dataURL, pageNum, w, h, oScale, doc);
                  console.log(`[thumb] p${pageNum} via pool-render (${w}x${h})`);
                  return { dataURL: composited, width: w, height: h };
                } catch { /* val terug op kale bitmap */ }
              }
              console.log(`[thumb] p${pageNum} via pool-render (${w}x${h}, zonder overlay)`);
              return { dataURL, width: w, height: h };
          }
        } catch (e) {
          console.log(`[thumb] p${pageNum} pool-thumb faalde: ${String(e).slice(0, 80)}`);
        }
        return null;
      }
    }
  } catch { /* val door naar het normale pad */ }

  // Last native fallback. It renders complete page content; stale
  // completions are rejected by the owning document's page generation.
  if (doc?.filePath && window.__TAURI__) {
    try {
      const { invoke } = window.__TAURI__.core;
      // Pass the in-session user rotation so the Rust render matches the main
      // view. Without it, a rotated page's thumbnail stayed unrotated until the
      // rotation was baked into the PDF (save + reload) — the other thumbnail
      // paths (vector replay, prog-bitmap, PDF.js fallback) already rotate.
      const extraRot = owningPageRotation(doc, pageNum);
      const result = await invoke('render_thumbnail', {
        path: doc.filePath,
        pageIndex: pageNum - 1,
        maxWidth: 140,
        rotation: extraRot || 0,
        skipImages: false,
        requestId: publicationToken?.requestId || '',
      });
      const data = JSON.parse(result);
      // Plugin/Solid-store annotations zijn niet in de PDF tot save; overlay
      // ze hier zodat thumbnail dezelfde inhoud toont als hoofdcanvas.
      // Scale = thumbnail-pixels / PDF-pt = data.width / pageWidthPt.
      try {
        const page = await pdfDoc.getPage(pageNum);
        // Rotated render → rotated dims; match the viewport so the overlay
        // scale stays correct (PDF.js rotation overrides the page default).
        const vpOpts = { scale: 1 };
        if (extraRot) vpOpts.rotation = (page.rotate + extraRot) % 360;
        const viewport = page.getViewport(vpOpts);
        const scale = data.width / viewport.width;
        const composited = await overlayAnnotationsOnDataURL(data.dataURL, pageNum, data.width, data.height, scale, doc);
        return { dataURL: composited, width: data.width, height: data.height };
      } catch {
        return { dataURL: data.dataURL, width: data.width, height: data.height };
      }
    } catch (e) {
      console.warn(`[Thumbnails] Rust render failed for page ${pageNum}:`, e);
      // Fall through to PDF.js fallback
    }
  }

  // Fallback: PDF.js rendering
  console.log(`[PERF-THUMB] page ${pageNum}: PDF.js fallback START`);
  let renderTask = null;
  let timeoutId = null;

  try {
    const renderPromise = (async () => {
      const page = await pdfDoc.getPage(pageNum);
      const extraRot = owningPageRotation(doc, pageNum);
      const baseOpts = { scale: 1 };
      if (extraRot) baseOpts.rotation = (page.rotate + extraRot) % 360;
      const baseViewport = page.getViewport(baseOpts);
      const trOpts = { scale: 280 / Math.max(1, baseViewport.width) };
      if (extraRot) trOpts.rotation = (page.rotate + extraRot) % 360;
      const viewport = page.getViewport(trOpts);

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      renderTask = trackPdfJsRenderTask(publicationToken, doc, page.render({
        canvasContext: ctx,
        viewport: viewport,
        annotationMode: 0
      }));
      const taskKey = `${doc?.id || 'unknown'}:${pageNum}:${publicationToken?.requestId || 'legacy'}`;
      thumbnailRenderTasks.set(taskKey, renderTask);
      await renderTask.promise;
      thumbnailRenderTasks.delete(taskKey);

      const output = document.createElement('canvas');
      output.width = 140;
      output.height = Math.max(1, Math.round(baseViewport.height * (140 / baseViewport.width)));
      const outputCtx = output.getContext('2d');
      outputCtx.fillStyle = '#fff';
      outputCtx.fillRect(0, 0, output.width, output.height);
      outputCtx.imageSmoothingEnabled = true;
      outputCtx.imageSmoothingQuality = 'high';
      outputCtx.drawImage(canvas, 0, 0, output.width, output.height);

      // Overlay plugin/Solid-store annotations op dezelfde ctx vóór toDataURL.
      // viewport.width = pdfPtWidth * THUMBNAIL_SCALE, dus scale-factor naar
      // PDF-pt-coordsysteem = THUMBNAIL_SCALE.
      try {
        // Use the owning document's annotations (not the active one's) — same
        // cross-document leak as the other thumbnail paths.
        const docAnn = doc || getActiveDocument();
        const annotations = (docAnn?.annotations || []).filter(a => a.page === pageNum);
        if (annotations.length > 0) {
          outputCtx.save();
          const annotationScale = output.width / baseViewport.width;
          outputCtx.scale(annotationScale, annotationScale);
          annotations.forEach(a => {
            try { drawAnnotation(outputCtx, a); }
            catch (e) {
              console.warn(`[Thumbnails] drawAnnotation failed (PDF.js path) page ${pageNum} id=${a?.id ?? '?'} type=${a?.type ?? '?'}:`, e);
            }
          });
          outputCtx.restore();
        }
      } catch (e) {
        console.warn(`[Thumbnails] PDF.js overlay failed for page ${pageNum}:`, e);
      }

      return {
        dataURL: output.toDataURL('image/jpeg', 0.78),
        width: output.width,
        height: output.height
      };
    })();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        try { renderTask?.cancel(); } catch { /* ignore */ }
        reject(new Error('Render timeout'));
      }, 10000);
    });
    const result = await Promise.race([renderPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    console.log(`[PERF-THUMB] page ${pageNum}: PDF.js fallback DONE: ${(performance.now() - _th0).toFixed(0)}ms`);
    return result;
  } catch (err) {
    for (const key of thumbnailRenderTasks.keys()) {
      if (key.startsWith(`${doc?.id || 'unknown'}:${pageNum}:`)) thumbnailRenderTasks.delete(key);
    }
    if (timeoutId) clearTimeout(timeoutId);
    try { renderTask?.cancel(); } catch { /* ignore */ }
    console.warn(`[PERF-THUMB] page ${pageNum}: PDF.js fallback FAILED (${(performance.now() - _th0).toFixed(0)}ms):`, err.message);
    return null;
  }
}

export async function preloadThumbnailPage(doc, pageNum, { preloadOnly = false } = {}) {
  if (!doc?.pdfDoc || !Number.isInteger(pageNum) || pageNum < 1 || pageNum > doc.pdfDoc.numPages) return null;
  if (!thumbnailCache.has(doc.id)) thumbnailCache.set(doc.id, new Map());
  const cache = thumbnailCache.get(doc.id);
  const publicationToken = captureRenderPublicationToken(doc, pageNum, 'thumbnail');
  const cached = cache.get(pageNum);
  if (cached?.publicationToken
      && thumbnailPublicationIsReusable(doc, pageNum, cached.publicationToken)) {
    touchRenderResource(thumbnailEntryResourceKey(doc.id, pageNum, cached));
    return cached;
  }
  if (cached) {
    revokeThumbnailEntry(cached);
    cache.delete(pageNum);
    unregisterRenderResource(thumbnailEntryResourceKey(doc.id, pageNum, cached));
  }
  const key = [
    doc.id,
    pageNum,
    publicationToken.lifecycleGeneration,
    publicationToken.contentRevision,
    publicationToken.pageRevision,
  ].join(':');
  if (thumbnailPromises.has(key)) return thumbnailPromises.get(key);
  const generation = getPageGen(doc.id, pageNum);
  const tokenIsCurrent = () => thumbnailPublicationIsCurrent(doc, publicationToken);
  const promise = (async () => {
    await expectedThumbnailSize(doc.pdfDoc, pageNum, doc, publicationToken);
    if (!tokenIsCurrent()) {
      recordRejectedRenderPublication(publicationToken, 'thumbnail-after-size');
      return null;
    }
    const rendered = await renderThumbnailToDataURL(
      doc.pdfDoc,
      pageNum,
      doc,
      publicationToken,
    );
    if (!tokenIsCurrent()) {
      recordRejectedRenderPublication(publicationToken, 'thumbnail-after-render');
      return null;
    }
    const entry = await normalizeThumbnailEntry(rendered, generation, publicationToken);
    if (!entry || !pageGenMatches(doc.id, pageNum, generation) || !tokenIsCurrent()) {
      revokeThumbnailEntry(entry);
      if (entry) recordRejectedRenderPublication(publicationToken, 'thumbnail-before-cache');
      return null;
    }
    const previous = cache.get(pageNum);
    if (previous) {
      revokeThumbnailEntry(previous);
      unregisterRenderResource(thumbnailEntryResourceKey(doc.id, pageNum, previous));
    }
    cache.set(pageNum, entry);
    recordThumbnailMemory();
    registerThumbnailResource(doc, pageNum, entry, cache);
    if (preloadOnly) {
      if (!preloadOnlyPages.has(doc.id)) preloadOnlyPages.set(doc.id, new Set());
      preloadOnlyPages.get(doc.id).add(pageNum);
    } else {
      preloadOnlyPages.get(doc.id)?.delete(pageNum);
    }
    if (getActiveDocument()?.id === doc.id) setThumbnailImage(pageNum, entry);
    return entry;
  })().finally(() => thumbnailPromises.delete(key));
  thumbnailPromises.set(key, promise);
  return promise;
}

export function getCachedThumbnailEntry(doc, pageNum) {
  const entry = doc ? thumbnailCache.get(doc.id)?.get(pageNum) || null : null;
  if (!entry) return null;
  if (!thumbnailPublicationIsReusable(doc, pageNum, entry.publicationToken)) {
    releaseThumbnailPage(doc, pageNum);
    return null;
  }
  touchRenderResource(thumbnailEntryResourceKey(doc.id, pageNum, entry));
  return entry;
}

export function releaseThumbnailPage(doc, pageNum) {
  const cache = doc && thumbnailCache.get(doc.id);
  if (!cache) return;
  const entry = cache.get(pageNum);
  revokeThumbnailEntry(entry);
  cache.delete(pageNum);
  unregisterRenderResource(thumbnailEntryResourceKey(doc.id, pageNum, entry));
  preloadOnlyPages.get(doc.id)?.delete(pageNum);
  if (getActiveDocument()?.id === doc.id) removeThumbnailImage(pageNum);
}

export function cancelDocumentThumbnailWork(doc) {
  if (!doc) return;
  const prefix = `${doc.id}:`;
  for (const [key, task] of thumbnailRenderTasks) {
    if (!key.startsWith(prefix)) continue;
    try { task.cancel(); } catch { /* ignore */ }
    thumbnailRenderTasks.delete(key);
  }
  for (const key of thumbnailPromises.keys()) {
    if (!key.startsWith(prefix)) continue;
    const pageNum = Number(key.slice(prefix.length).split(':')[0]);
    if (Number.isInteger(pageNum)) bumpPageGen(doc.id, pageNum);
  }
}

export function cancelThumbnailWorkForPages(doc, pages) {
  if (!doc?.id) return;
  const selected = new Set((pages || []).map(Number)
    .filter((pageNum) => Number.isSafeInteger(pageNum) && pageNum > 0));
  for (const [key, task] of thumbnailRenderTasks) {
    if (!key.startsWith(`${doc.id}:`)) continue;
    const pageNum = Number(key.slice(`${doc.id}:`.length).split(':')[0]);
    if (!selected.has(pageNum)) continue;
    try { task.cancel(); } catch { /* ignore */ }
    thumbnailRenderTasks.delete(key);
  }
  for (const pageNum of selected) bumpPageGen(doc.id, pageNum);
}

export function visibleThumbnailPages() {
  const container = getContainerRef();
  if (!container) return [];
  const bounds = container.getBoundingClientRect();
  return [...container.querySelectorAll('.thumbnail-item')]
    .filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.top < bounds.bottom && rect.bottom > bounds.top;
    })
    .map((item) => Number(item.dataset.page))
    .filter(Number.isInteger);
}

export function releasePreloadOnlyThumbnails(doc, keepPages = []) {
  const cache = doc && thumbnailCache.get(doc.id);
  const preloadPages = doc && preloadOnlyPages.get(doc.id);
  if (!cache || !preloadPages) return;
  const keep = new Set(keepPages);
  for (const pageNum of [...preloadPages]) {
    if (keep.has(pageNum)) continue;
    const entry = cache.get(pageNum);
    revokeThumbnailEntry(entry);
    cache.delete(pageNum);
    unregisterRenderResource(thumbnailEntryResourceKey(doc.id, pageNum, entry));
    preloadPages.delete(pageNum);
    if (getActiveDocument()?.id === doc.id) removeThumbnailImage(pageNum);
  }
}

// Show page properties dialog
export async function showPageProperties(pageNum) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  try {
    const page = await doc.pdfDoc.getPage(pageNum);
    const rotation = getPageRotation(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const widthPt = viewport.width;
    const heightPt = viewport.height;
    const widthMm = (widthPt / 72 * 25.4).toFixed(1);
    const heightMm = (heightPt / 72 * 25.4).toFixed(1);
    const widthIn = (widthPt / 72).toFixed(2);
    const heightIn = (heightPt / 72).toFixed(2);
    const totalRotation = (page.rotate + (rotation || 0)) % 360;

    const msg = `Page ${pageNum}\n\n` +
      `Size: ${widthPt.toFixed(0)} x ${heightPt.toFixed(0)} pt\n` +
      `Size: ${widthMm} x ${heightMm} mm\n` +
      `Size: ${widthIn} x ${heightIn} in\n` +
      `Rotation: ${totalRotation}\u00B0`;

    if (window.__TAURI__?.dialog?.message) {
      await window.__TAURI__.dialog.message(msg, { title: 'Page Properties', kind: 'info' });
    } else {
      showMessage(msg);
    }
  } catch (err) {
    console.error('Error showing page properties:', err);
  }
}

// Invalidate and re-render a single page's thumbnail (e.g. after rotation)
export function invalidateThumbnail(pageNum) {
  const activeDoc = getActiveDocument();
  if (!activeDoc) return;
  const docCache = thumbnailCache.get(activeDoc.id);
  if (docCache) {
    const entry = docCache.get(pageNum);
    revokeThumbnailEntry(entry);
    docCache.delete(pageNum);
    unregisterRenderResource(thumbnailEntryResourceKey(activeDoc.id, pageNum, entry));
  }
  // Bump generation: any in-flight render for this page will discard its
  // result on completion (see pageGenMatches in process*Thumbnail).
  bumpPageGen(activeDoc.id, pageNum);
  // Remove from Solid store so component shows loading spinner
  removeThumbnailImage(pageNum);
  // Re-add to priority queue and restart processor
  priorityPages.add(pageNum);
  startProcessor();
}

// Invalidate several pages' thumbnails at once (e.g. after "Clear All" or a
// bulk annotation edit spanning multiple pages). Cheaper than N single calls:
// one processor restart at the end instead of per page.
export function invalidateThumbnails(pageNums) {
  const activeDoc = getActiveDocument();
  if (!activeDoc || !pageNums) return;
  const docCache = thumbnailCache.get(activeDoc.id);
  let any = false;
  for (const pageNum of pageNums) {
    if (!Number.isInteger(pageNum) || pageNum < 1) continue;
    if (docCache) {
      const entry = docCache.get(pageNum);
      revokeThumbnailEntry(entry);
      docCache.delete(pageNum);
      unregisterRenderResource(thumbnailEntryResourceKey(activeDoc.id, pageNum, entry));
    }
    bumpPageGen(activeDoc.id, pageNum);
    removeThumbnailImage(pageNum);
    priorityPages.add(pageNum);
    any = true;
  }
  if (any) startProcessor();
}

/** Clear owner-scoped thumbnail pages without touching warm neighbours. */
export function clearThumbnailsForPages(documentId, pages) {
  const docId = String(documentId || '');
  if (!docId) return;
  const cache = thumbnailCache.get(docId);
  const active = getActiveDocument()?.id === docId;
  for (const pageNum of new Set((pages || []).map(Number))) {
    if (!Number.isSafeInteger(pageNum) || pageNum < 1) continue;
    const entry = cache?.get(pageNum);
    revokeThumbnailEntry(entry);
    cache?.delete(pageNum);
    unregisterRenderResource(thumbnailEntryResourceKey(docId, pageNum, entry));
    preloadOnlyPages.get(docId)?.delete(pageNum);
    bumpPageGen(docId, pageNum);
    if (active) removeThumbnailImage(pageNum);
  }
}

// Clear thumbnail cache for a specific document
export function clearThumbnailCache(docId) {
  if (docId) {
    for (const [pageNum, entry] of thumbnailCache.get(docId)?.entries() || []) {
      revokeThumbnailEntry(entry);
      unregisterRenderResource(thumbnailEntryResourceKey(docId, pageNum, entry));
    }
    thumbnailCache.delete(docId);
    documentState.delete(docId);
    preloadOnlyPages.delete(docId);
    pageGeneration.delete(docId);
  }
}

// Save thumbnail scroll position for the current document
export function saveThumbnailScrollPosition() {
  const doc = getActiveDocument();
  if (!doc) return;
  const container = getContainerRef();
  if (container) {
    thumbnailScrollPositions.set(doc.id, container.scrollTop);
  }
}

// Update which thumbnail is marked as active
export function updateActiveThumbnail(restoreScroll = false, selectionPage = null) {
  const doc = getActiveDocument();
  const newPage = doc ? doc.currentPage : 1;
  setActivePage(newPage);

  // Keep the thumbnail selection in sync with the active page when the user
  // has a single-page selection (which is the default after a normal click).
  // If they have a multi-page selection (Ctrl/Shift-click), leave it alone so
  // they don't lose their selection while navigating with the wheel/keyboard.
  const sel = thumbnailSelectedPages();
  if (sel.size <= 1) {
    selectThumbnailPage(selectionPage ?? newPage);
  }

  const pageViewRevision = Number(doc?.viewMutationState?.fields?.page) || 0;
  setTimeout(() => {
    if (getActiveDocument() !== doc || doc?.currentPage !== newPage
        || (Number(doc?.viewMutationState?.fields?.page) || 0) !== pageViewRevision) return;
    const container = getContainerRef();
    if (!container) return;

    if (restoreScroll && doc && thumbnailScrollPositions.has(doc.id)) {
      // Restore saved scroll position (tab switch)
      container.scrollTop = thumbnailScrollPositions.get(doc.id);
    } else {
      // Scroll active thumbnail into view (page navigation)
      const activeThumbnail = container.querySelector('.thumbnail-item.active');
      if (activeThumbnail) {
        activeThumbnail.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'nearest' });
      }
    }
  }, 0);
}

// Clear thumbnails (when PDF is closed)
export function clearThumbnails() {
  clearAllThumbnails();
  priorityPages.clear();
}
