import { state, getActiveDocument, getPageRotation, setPageRotation } from '../core/state.js';
import { isTauri, invoke } from '../core/platform.js';
// Always-fresh DOM refs (never stale regardless of init timing or bundler behavior)
function getPdfCanvas() { return document.getElementById('pdf-canvas'); }
function getAnnotationCanvas() { return document.getElementById('annotation-canvas'); }
import { redrawAnnotations, renderAnnotationsForPage } from '../annotations/rendering.js';
import { ensureAnnotationsForPage, hidePdfABar } from './loader.js';
import { updateAllStatus } from '../ui/chrome/status-bar.js';
import { hideProperties } from '../ui/panels/properties-panel.js';
import { updateActiveThumbnail, pauseThumbnails, resumeThumbnails, isThumbnailPipelineIdle, getCachedThumbnailEntry } from '../ui/panels/left-panel.js';
import { createSinglePageTextLayer, clearSinglePageTextLayer, createTextLayer, clearTextLayers, createTextLayerFromRust, releaseTextLayer } from '../text/text-layer.js';
import { createSinglePageLinkLayer, clearSinglePageLinkLayer, createLinkLayer, clearLinkLayers, releaseLinkLayer } from './link-layer.js';
import { createSinglePageFormLayer, clearSinglePageFormLayer, createFormLayer, clearFormLayers, releaseFormLayer, hideFormFieldsBar } from './form-layer.js';
import { clearPdfVectorCache, prefetchPdfVectorGeometry } from '../tools/pdf-snap-extractor.js';
import { clearDetectionCache } from '../tools/pdf-element-detector.js';
import { clearEditableMetadataPreload, scheduleEditableMetadataPreload } from './editable-metadata-preload.js';
import { onPageRendered, clearHighlights } from '../search/find-bar.js';
import { showPagePlaceholder, hidePagePlaceholderWhenReady } from './page-transition.js';
import { rawPdfTextLayerViewportOptions } from '../text/text-edit-appearance.js';
import {
  bumpDocumentViewportRevision,
  cancelPendingDocumentZoom,
} from './document-zoom-scheduler.js';
import { shouldPreloadEntireDocument, shouldPreloadNearby } from './preload-policy.js';
import { ensureDocumentPageGeometryIndex, rebuildDocumentPageGeometryIndex } from './document-performance.js';
import {
  resolveContinuousHorizontalAnchor,
  resolveContinuousVerticalAnchor,
} from './continuous-zoom-anchor.js';
import { createRenderWorkScheduler } from './render-work-scheduler.js';
import { notePdfForegroundActivity, isPdfForegroundIdle } from './foreground-activity.js';
import { getActiveTextEditSession } from '../text/text-edit-session.js';
import { recordForegroundRenderSample } from './render-performance.js';
import {
  incrementPerformanceCounter,
  notePerformanceInteraction,
  recordLatencySinceInteraction,
  recordPerformanceEvent,
  recordPerformancePeak,
  recordPerformanceSample,
} from './performance-metrics.js';
import {
  registerRenderResource,
  touchRenderResource,
  unregisterRenderResource,
  renderResourceBudgetSnapshot,
  backgroundRenderAdmissionAllowed,
} from './render-resource-budget.js';
import {
  clearAllBitmaps,
  clearBitmapsForFile,
  consumeCachedBitmapAfterTransfer,
  computeCappedWholePageScale,
  ensureBitmap,
  getBestAvailableBitmap,
  getCachedBitmap,
  releaseCachedBitmapAfterPublication,
  setCachedBitmapEntry,
} from './page-bitmap-cache.js';
import {
  RasterQuality,
  createPageRasterKey,
  createRenderedSurfaceState,
  renderedSurfaceIsSharp,
  requestedRasterScale,
  serializePageRasterKey,
} from './page-raster.js';
import { planVisiblePageTiles } from './page-tile-plan.js';
import { singlePageOverlaySurfaceDimensions } from './canvas-dpr.js';
import { noteDocumentMutation } from '../core/document-revision-state.runtime.js';
import {
  cancelPdfJsRenderTasksForDocument,
  cancelStalePdfJsRenderTasks,
  captureRenderPublicationToken,
  recordRejectedRenderPublication,
  renderPublicationTokenIsCurrent,
  trackPdfJsRenderTask,
} from './render-publication-token.js';
import {
  tileCacheFindCovering,
  tileCacheGet,
  tileCacheSet,
} from './tile-cache.js';
import { createLowResolutionPreviewKey } from './low-resolution-preview-key.js';
import {
  failPageEditReadiness,
  markPageEditLayerReady,
  pageEditReadinessSatisfied,
} from './page-edit-readiness.js';
import { awaitRequiredPageRenders } from './visible-page-render-barrier.js';

const RENDER_EDIT_READY_LAYERS = Object.freeze(['raster', 'annotations', 'text', 'links', 'forms']);

function markRendererLayerReady(doc, pageNum, layer, publicationToken) {
  return markPageEditLayerReady(doc, pageNum, layer, publicationToken);
}

function failRendererReadiness(doc, pageNum, error, publicationToken) {
  failPageEditReadiness(
    doc,
    pageNum,
    error instanceof Error ? error.message : String(error || 'page render failed'),
    publicationToken,
  );
}

function scheduleBackgroundMetadata(centerPage, direction) {
  const doc = getActiveDocument();
  if (shouldPreloadEntireDocument(doc, state.preferences)) {
    void import('./whole-pdf-preload.js').then(({ startWholePdfPreload }) => startWholePdfPreload());
    return;
  }
  if (!shouldPreloadNearby(state.preferences)) return;
  void scheduleEditableMetadataPreload(centerPage, direction, {
    editTextActive: state.currentTool === 'editText',
  });
}

// Hi-DPI support: render canvases at device pixel ratio for sharp text
export function getCanvasDPR() { return window.devicePixelRatio || 1; }

// Compatibility facade over the one shared byte-aware page bitmap cache.
// Continuous and single-page views therefore cannot retain duplicate decoded
// surfaces for the same (file, page, scale, rotation).
function _bitmapCompatibilityContext(filePath, pageNum, scale) {
  const documentState = state.documents?.find?.((doc) => doc.filePath === filePath);
  if (!documentState?.id) return null;
  return {
    documentId: documentState.id,
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    contentRevision: Number(documentState.revisionState?.contentRevision) || 0,
    pageRevision: Number(documentState.pageRenderRevisions?.[pageNum]) || 0,
    cssScale: scale,
    devicePixelRatio: 1,
    quality: RasterQuality.FINAL,
    targetRasterScale: scale,
    actualRasterScale: scale,
  };
}

export function _bitmapJSCacheGet(key) {
  const [filePath, pageText, scaleText, rotationText] = key.split('|');
  const pageNum = Number(pageText) || 0;
  const scale = (Number(scaleText) || 0) / 10_000;
  const context = _bitmapCompatibilityContext(filePath, pageNum, scale);
  if (!context) return null;
  return getCachedBitmap(
    filePath,
    pageNum,
    Number(rotationText) || 0,
    scale,
    context,
  );
}
export async function _bitmapJSCacheSet(key, imageData, isCurrent = () => true) {
  try {
    const bitmap = await createImageBitmap(imageData);
    if (!isCurrent()) {
      try { bitmap.close?.(); } catch {}
      return false;
    }
    const [filePath, pageText, scaleText, rotationText] = key.split('|');
    const pageNum = Number(pageText) || 0;
    const scale = (Number(scaleText) || 0) / 10_000;
    const context = _bitmapCompatibilityContext(filePath, pageNum, scale);
    if (!context) {
      try { bitmap.close?.(); } catch {}
      return false;
    }
    setCachedBitmapEntry(
      filePath,
      pageNum,
      Number(rotationText) || 0,
      scale,
      bitmap,
      imageData.width,
      imageData.height,
      scale,
      context,
    );
    return true;
  } catch (e) {
    console.warn('[bitmap-cache] createImageBitmap failed:', e);
    return false;
  }
}
export function clearBitmapJSCacheForFile(filePath) {
  // Wipe all entries for this filePath (used on close / save / annotation
  // changes that invalidate the rendered pixels).
  clearBitmapsForFile(filePath);
}
/** Wipe every entry in the JS-side ImageBitmap cache. Exposed for the MCP
 *  `app_clear_caches` test tool so an AI-driven debug loop can rule out
 *  stale cache as a contributor to anomalies. */
export function _clearJSBitmapCache() {
  clearAllBitmaps();
}

// NOTE: an earlier prototype embedded MuPDF WASM rendering helpers here
// (loadMupdf / isMupdfAvailable / getMupdfDocument / renderPageWithMupdf).
// They were never wired up — the active path is the Rust vector renderer
// via `extract_draw_commands` + `vector-renderer.js`, with PDF.js as the
// fallback for raster-only pages. The unused helpers have been removed.
// `mupdf-renderer.js` is still imported once below for `closeDocument()`
// cleanup (no-op when the runtime never loaded the WASM module).

function setupCanvasHiDPI(canvas, width, height) {
  const dpr = getCanvasDPR();
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = Math.floor(width) + 'px';
  canvas.style.height = Math.floor(height) + 'px';
}

// Foreground-render generation counter. Bumped on every renderPage() entry;
// each in-flight invocation captures the value at start, then re-checks after
// each await. If the captured gen differs from the current gen, a newer
// renderPage() has been triggered — the older one must NOT write to the
// shared #pdf-canvas (its scale-N bitmap would clobber the newer scale-M
// result that already landed).
//
// User-visible symptom this fixes: rapid mouse-wheel zoom on raster PDFs
// (BARN) showed the page "springing back and forth" between intermediate
// zoom levels — earlier-started but slower-completing renders were stomping
// over the freshest user-requested zoom level.
let _foregroundRenderGen = 0;

// Returns true if `doc` is no longer the active document. Use this after every
// `await` in render code to abort late completions whose results would corrupt
// the SHARED #pdf-canvas / pdf-viewport singleton with a different document's
// content. Without this, a slow IPC chain (analyze_page_type +
// extract_draw_commands + prepareImages) for tab A can finish AFTER the user
// switched to tab B, then write A's filePath into the viewport singleton,
// making the RAF render loop draw A's pages on B's tab — the ghost/bleed-through
// the user reports when switching tabs rapidly across multiple PDFs.
function _isStaleDoc(doc, publicationToken = null) {
  const current = state.documents[state.activeDocumentIndex];
  const stale = String(current?.id || '') !== String(doc?.id || '')
    || (publicationToken && !renderPublicationTokenIsCurrent(publicationToken, current));
  if (stale && publicationToken) {
    if (String(current?.id || '') !== String(doc?.id || '')) {
      cancelPdfJsRenderTasksForDocument(doc?.id, 'inactive-owner');
    } else {
      cancelStalePdfJsRenderTasks(current);
    }
    recordRejectedRenderPublication(publicationToken);
  }
  return stale;
}


// ─── Main-thread jank detector ───────────────────────────────────────────
// Fires every 500ms. If a tick takes >1s to arrive, the main thread was blocked.
let _jankTimer = null;
let _jankLast = 0;
function _startJankDetector() {
  if (_jankTimer) return;
  _jankLast = performance.now();
  _jankTimer = setInterval(() => {
    const now = performance.now();
    const gap = now - _jankLast;
    if (gap > 1000) {
      console.warn(`[JANK] Main thread was blocked for ${gap.toFixed(0)}ms!`);
    }
    _jankLast = now;
  }, 500);
}
_startJankDetector();

// Render PDF page (single page mode)
export async function renderPage(pageNum, options = {}) {
  // In-flight counter exposed for MCP test harness — `waitForRenderIdle()`
  // polls `window.__pdfRenderInFlight === 0` to know when a synthetic zoom
  // event has fully settled (bitmap painted, tile rendered, state updated).
  if (typeof window !== 'undefined') {
    window.__pdfRenderInFlight = (window.__pdfRenderInFlight || 0) + 1;
  }
  const owner = getActiveDocument();
  const ownerId = owner?.id || null;
  const ownerGeneration = Number(owner?.lifecycleGeneration) || 0;
  const eventPublicationToken = owner?.pdfDoc
    ? captureRenderPublicationToken(owner, pageNum, 'page-rendered-event')
    : null;
  try {
    const result = await _renderPageImpl(pageNum, options);
    const current = getActiveDocument();
    if (current && current.id === ownerId
        && (Number(current.lifecycleGeneration) || 0) === ownerGeneration
        && renderPublicationTokenIsCurrent(eventPublicationToken, current)
        && current.currentPage === pageNum
        && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('opds:page-rendered', {
        detail: {
          documentId: ownerId,
          lifecycleGeneration: ownerGeneration,
          contentRevision: Number(current.revisionState?.contentRevision) || 0,
          pageRevision: Number(current.revisionState?.pageContentRevisions?.[pageNum]) || 0,
          pageNum,
        },
      }));
    }
    return result;
  } finally {
    if (typeof window !== 'undefined') {
      window.__pdfRenderInFlight = Math.max(0, (window.__pdfRenderInFlight || 1) - 1);
    }
  }
}

async function _renderPageImpl(pageNum, { requireEditReady = false } = {}) {
  const _rp0 = performance.now();
  console.log(`[PERF] renderPage(${pageNum}) START`);
  // Clear search highlights immediately to prevent stale highlights
  // from appearing at wrong positions during canvas resize
  clearHighlights();

  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) return;
  const pdfDoc = doc.pdfDoc;
  const scale = doc.scale;

  // Validate page number against THIS document's page count
  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pdfDoc.numPages) return;
  const publicationToken = captureRenderPublicationToken(doc, pageNum, 'single-page');
  const completedLayers = new Set();
  const markLayer = (layer) => {
    if (markRendererLayerReady(doc, pageNum, layer, publicationToken)) completedLayers.add(layer);
  };
  const failReadiness = (error) => failRendererReadiness(doc, pageNum, error, publicationToken);

  // Stamp this invocation with a fresh render-generation. Re-checked after
  // each await before any canvas / viewport mutation — see `_isStaleGen`
  // below. Prevents the rapid-zoom out-of-order race.
  const _renderGen = ++_foregroundRenderGen;
  const _isStaleGen = () => _renderGen !== _foregroundRenderGen;

  const page = await pdfDoc.getPage(pageNum);
  if (_isStaleDoc(doc, publicationToken)) return; // user switched tabs while we awaited PDF.js page
  const extraRotation = getPageRotation(pageNum);
  const viewportOpts = { scale };
  if (extraRotation) {
    viewportOpts.rotation = (page.rotate + extraRotation) % 360;
  }
  const viewport = page.getViewport(viewportOpts);

  // High-zoom safety cap. The browser canvas has a max ~16384 px per axis
  // (Chromium); rendering BARN (1632×1056 pt page) at scale=10 would produce
  // a 16320×10560 buffer = exceeds limit, allocation fails, canvas turns
  // black, user sees "versringen". Cap the Rust render at a safe max-axis
  // and let CSS-stretch the bitmap to the user-requested CSS viewport size
  // (slightly blurry but stable — same approach as Edge/Chrome on heavy zoom).
  //
  // MAX_BITMAP_AXIS_PX chosen at 4096 = well under canvas limits, easy to
  // allocate even on weak hardware, and CSS-stretching from 4096 to e.g.
  // 8000 px is barely noticeable for tex/vector content (1 source pixel
  // covers 2 dest pixels via bilinear).
  const MAX_BITMAP_AXIS_PX = 4096;
  const _pageMaxAxisPt = Math.max(viewport.width, viewport.height) / scale;
  const _maxAllowedScale = MAX_BITMAP_AXIS_PX / _pageMaxAxisPt;
  const _effectiveScale = Math.min(scale, _maxAllowedScale);
  if (_effectiveScale < scale) {
    console.log(`[render] high-zoom safety cap: requested scale=${scale.toFixed(2)}, rendering at ${_effectiveScale.toFixed(2)} (CSS-stretch to viewport)`);
  }

  // Cache page dimensions in PDF points on the doc so plugin annotation
  // handlers can read them synchronously at click time without depending
  // on the pdf-viewport singleton (which is a noop for blank docs whose
  // vector path is gated off by the filePath check).
  if (!doc.pageDims) doc.pageDims = {};
  const [vx0, vy0, vx1, vy1] = page.view;
  doc.pageDims[pageNum] = {
    widthPt: vx1 - vx0,
    heightPt: vy1 - vy0,
    rotation: page.rotate || 0,
  };

  const pdfCanvas = getPdfCanvas();
  const annotationCanvas = getAnnotationCanvas();
  if (!pdfCanvas || !annotationCanvas) return;

  const dpr = getCanvasDPR();
  const bufferW = Math.floor(viewport.width * dpr);
  const bufferH = Math.floor(viewport.height * dpr);

  // Try Rust open-pdf-render first (pure Rust, fast), fall back to PDF.js
  const _t0 = performance.now();
  const _canUseTauri = isTauri();
  const _hasFilePath = !!doc.filePath;
  let _skipBitmapRender = false;
  let _rasterPublicationPending = false;

  // ─── VECTOR VIEWPORT MODE ──────────────────────────────────────────────
  // Extract draw commands once, then hand off to pdf-viewport.js render loop.
  // All zoom/pan is handled by the viewport — no re-rendering needed here.
  // The user-applied page rotation is part of the cache key so a rotated
  // page coexists with its un-rotated version in cache.
  if (_canUseTauri && _hasFilePath) {
    try {
      // Pause thumbnail rendering so Rust backend is free for page rendering
      pauseThumbnails();
      console.log(`[PERF] renderPage(${pageNum}) trying vector path: ${(performance.now() - _rp0).toFixed(0)}ms`);
      const vr = await import('./vector-renderer.js');
      if (_isStaleDoc(doc, publicationToken)) { resumeThumbnails(); return; }
      const userRotation = getPageRotation(pageNum);

      // Engine-override gate: vector path only runs in Auto mode (override===null).
      // If user picked 'pdfium' or 'rust-skia' in the status-bar dropdown,
      // skip Vector entirely — even for pages whose draw-commands are already
      // cached from a previous render. Without this gate, the override only
      // affected the raster engine (PDFium vs Rust-Skia at the worker-pool
      // level) but vector-classified pages still went through the Vector
      // engine, making "Engine: PDFium" appear to do nothing for those pages.
      // BELEID (2026-07-06): PDFium is de basis-engine; het vector-pad
      // (AEC-PDF v1) draait alléén nog met de expliciete diagnose-vlag
      // window.__aecVectorPath. Een null-override uit oude persisted
      // voorkeuren (dropdown-tijdperk) mag het pad niet meer aanzetten —
      // dat gaf o.a. een witte pagina op geroteerde vector-bladen.
      const _vectorAllowed = window.__aecVectorPath === true && state.renderEngineOverride == null;
      if (_vectorAllowed && !vr.hasCachedCommands(doc.filePath, pageNum, userRotation)) {
        console.log(`[PERF] renderPage(${pageNum}) analyze_page_type START: ${(performance.now() - _rp0).toFixed(0)}ms`);
        // JS-side cache check FIRST — populated by analyze_page_type_batch
        // at cold-open. Skips the IPC roundtrip (which can be 1+ second
        // queued behind thumbnail invokes during cold-open) for any page
        // the batch has classified. The Rust cache remains authoritative
        // for the rare cold-miss path below.
        const ptcMod = await import('./page-type-cache.js');
        let pageType = ptcMod.getCachedPageType(doc.filePath, pageNum - 1);
        if (pageType) {
          console.log(`[PERF] renderPage(${pageNum}) analyze_page_type=${pageType} (js-cache): ${(performance.now() - _rp0).toFixed(0)}ms`);
        } else {
          pageType = await invoke('analyze_page_type', { path: doc.filePath, pageIndex: pageNum - 1 });
          if (_isStaleDoc(doc, publicationToken)) { resumeThumbnails(); return; }
          ptcMod.cachePageType(doc.filePath, pageNum - 1, pageType, publicationToken);
          console.log(`[PERF] renderPage(${pageNum}) analyze_page_type=${pageType}: ${(performance.now() - _rp0).toFixed(0)}ms`);
        }
        // BELEID (2026-07-06): PDFium is de basis-engine voor álle weergaven.
        // Het eigen vector-replay-pad (AEC-PDF v1) staat uit tot het per
        // bladklasse bewezen is via de corpus-benchmark — het veroorzaakte
        // o.a. een witte pagina en gedraaide weergave op geroteerde bladen
        // (Originele bestanden/Technische tekening.pdf p1, /Rotate-blad).
        // Diagnose/ontwikkeling: window.__aecVectorPath = true heractiveert.
        if (pageType === 'vector' && !window.__aecVectorPath) {
          pageType = 'raster';
        }
        if (pageType === 'vector') {
          console.log(`[PERF] renderPage(${pageNum}) extract_draw_commands START: ${(performance.now() - _rp0).toFixed(0)}ms`);
          const cmdData = await invoke('extract_draw_commands', {
            path: doc.filePath,
            pageIndex: pageNum - 1,
            rotation: userRotation,
            requestId: publicationToken.requestId,
          });
          if (_isStaleDoc(doc, publicationToken)) { resumeThumbnails(); return; }
          const cmdBytes = cmdData instanceof Uint8Array ? cmdData : new Uint8Array(cmdData);
          console.log(`[PERF] renderPage(${pageNum}) extract_draw_commands DONE (${cmdBytes.length} bytes): ${(performance.now() - _rp0).toFixed(0)}ms`);
          vr.cacheCommands(
            doc.filePath,
            pageNum,
            cmdBytes,
            userRotation,
            { token: publicationToken, documentState: doc },
          );
          // Pre-decode any images in the command buffer (async, must complete before render)
          console.log(`[PERF] renderPage(${pageNum}) prepareImages START: ${(performance.now() - _rp0).toFixed(0)}ms`);
          await vr.prepareImages(
            doc.filePath,
            pageNum,
            userRotation,
            { token: publicationToken, documentState: doc },
          );
          if (_isStaleDoc(doc, publicationToken)) { resumeThumbnails(); return; }
          console.log(`[PERF] renderPage(${pageNum}) prepareImages DONE: ${(performance.now() - _rp0).toFixed(0)}ms`);
        }
      }

      if (_vectorAllowed && vr.hasCachedCommands(doc.filePath, pageNum, userRotation)) {
        const dims = vr.getCachedPageDimensions(doc.filePath, pageNum, userRotation);
        if (dims) {
          const { initViewport, setPage, wireEvents, viewport: pdfVP } = await import('./pdf-viewport.js');
          // CRITICAL: don't write a stale doc's filePath into the viewport
          // singleton. If we do, the RAF render loop will then draw the OLD
          // doc's content on the SHARED #pdf-canvas — that's the ghost the
          // user reports when switching tabs rapidly across multiple PDFs.
          if (_isStaleDoc(doc, publicationToken)) { resumeThumbnails(); return; }

          // Initialize viewport (idempotent — safe to call multiple times).
          // Call redrawAnnotations SYNCHRONOUSLY inside the viewport's RAF tick
          // (a dynamic import().then() would defer to a microtask, lagging
          // annotations one frame behind the PDF during zoom/pan). Use the
          // lightweight=true path so per-frame zoom skips the heavy SolidJS
          // status-bar / list / ribbon updates that would stall the frame.
          initViewport(pdfCanvas, () => redrawAnnotations(true));
          if (!pdfCanvas._vpEventsWired) {
            wireEvents(pdfCanvas);
            pdfCanvas._vpEventsWired = true;
          }
          const container = document.getElementById('pdf-container');
          if (container) container.style.overflow = 'hidden';

          // Load page into viewport (triggers fitToViewport + first render)
          setPage(doc.filePath, pageNum, dims.w, dims.h, dims.x0 || 0, dims.y0 || 0, userRotation);

          // Create text layer for text selection + search
          // Try Rust-extracted text spans first (faster, no PDF.js dependency),
          // fall back to PDF.js text layer if Rust extraction returns empty
          try {
            const canvasContainer = document.getElementById('canvas-container');
            const rustTextOk = await createTextLayerFromRust(
              canvasContainer || container, pageNum, dims.w, dims.h
            );
            if (_isStaleDoc(doc, publicationToken)) { resumeThumbnails(); return; }
            if (!rustTextOk) {
              const page = await pdfDoc.getPage(pageNum);
              if (_isStaleDoc(doc, publicationToken)) { resumeThumbnails(); return; }
              const textViewport = page.getViewport(
                rawPdfTextLayerViewportOptions(page.userUnit),
              );
              await createSinglePageTextLayer(page, textViewport);
              if (_isStaleDoc(doc, publicationToken)) { resumeThumbnails(); return; }
            }
            if (window.__pdfViewport) window.__pdfViewport.dirty = true;
            markLayer('text');
            if (doc.revisionState?.saveState !== 'synchronizing') markLayer('editableMetadata');
          } catch (e) {
            console.warn('[render] Text layer failed:', e);
            failReadiness(e);
          }

          console.log(`[render] ✅ Vector viewport: ${dims.w}x${dims.h} pt, origin=(${dims.x0},${dims.y0})`);
          // Mark page type so the unified render loop knows which branches to run
          if (window.__pdfViewport) window.__pdfViewport.pageType = 'vector';
          _skipBitmapRender = true;
        }
      }

      // ─── RASTER MODE: unified viewport ──────────────────────────────────
      // For raster-classified pages, activate the viewport singleton (same
      // one used by vector mode) and let the unified _render() loop handle
      // paint. The OLD bitmap-mode path further down still runs during this
      // transition; Task 5 will rip it.
      // Raster path runs when:
      //  - vector path didn't already claim the render (_skipBitmapRender),
      //  - AND either there are no cached vector commands, OR the user has
      //    forced a raster engine (override !== null), in which case cached
      //    vector commands must be bypassed.
      const _useRaster = !_skipBitmapRender &&
        (!_vectorAllowed || !vr.hasCachedCommands(doc.filePath, pageNum, userRotation));
      if (_useRaster) {
        const {
          initViewport,
          renderViewportNow,
          setPage,
          wireEvents,
          viewport: pdfVP,
        } =
          await import('./pdf-viewport.js');
        if (_isStaleDoc(doc, publicationToken)) { resumeThumbnails(); return; }

        // Init viewport on the main PDF canvas if not already running.
        initViewport(pdfCanvas, () => redrawAnnotations(true));
        if (!pdfCanvas._vpEventsWired) {
          wireEvents(pdfCanvas);
          pdfCanvas._vpEventsWired = true;
        }

        // Container in fixed-overflow mode — viewport handles pan/zoom now.
        const _rasterContainer = document.getElementById('pdf-container');
        if (_rasterContainer) _rasterContainer.style.overflow = 'hidden';

        // Page dims for the viewport. page.view = [x0, y0, x1, y1] in PRE-
        // rotation user-space coords. The PDFium bitmap is rendered POST-
        // rotation (intrinsic /Rotate is applied by default), so if the PDF
        // has /Rotate=90 or 270 the bitmap's width/height are swapped vs
        // page.view. Match by swapping page.view dims here too — otherwise
        // _render() stretches a portrait bitmap into a landscape rectangle
        // (or vice versa) and the page appears with dims transposed.
        const _x0 = page.view[0], _y0 = page.view[1];
        const _x1 = page.view[2], _y1 = page.view[3];
        const _rawW = _x1 - _x0;
        const _rawH = _y1 - _y0;
        const _intrinsicRot = (page.rotate || 0) % 360;
        const _rotSwap = (_intrinsicRot === 90 || _intrinsicRot === 270);
        const _pageWpt = _rotSwap ? _rawH : _rawW;
        const _pageHpt = _rotSwap ? _rawW : _rawH;
        setPage(
          doc.filePath, pageNum,
          _pageWpt, _pageHpt,
          _x0, _y0,
          getPageRotation(pageNum) || 0
        );

        // Mark as raster so _render() takes the bitmap branch + skips vector
        pdfVP.pageType = 'raster';

        // Kick async bitmap fill — fires viewport.dirty when arrives.
        const _orch = await import('./bitmap-orchestrator.js');
        const rasterPromise = _orch.ensureBitmapForCurrentView();
        if (requireEditReady) {
          await rasterPromise;
          if (_isStaleDoc(doc, publicationToken)) return { ready: false };
          if (!renderViewportNow()) {
            const error = new Error('The synchronized raster viewport did not publish current pixels');
            failReadiness(error);
            return { ready: false };
          }
          markLayer('raster');
        } else {
          _rasterPublicationPending = true;
          void Promise.resolve(rasterPromise).then(() => {
            _rasterPublicationPending = false;
            if (_isStaleDoc(doc, publicationToken)) return;
            if (!renderViewportNow()) {
              failReadiness(new Error('The raster viewport did not publish current pixels'));
              return;
            }
            markLayer('raster');
          }).catch((error) => {
            _rasterPublicationPending = false;
            failReadiness(error);
          });
        }
        // Tile will be ensured on the first zoom change via the _anchorAt hook
        // (Step 4); for the initial fit we let _render() display whatever
        // getBestAvailableBitmap provides immediately.

        console.log(`[render] Raster viewport activated: ${_pageWpt}x${_pageHpt} pt (intrinsic /Rotate=${_intrinsicRot}°)`);
        // The new viewport path now OWNS the canvas (initViewport's
        // _resizeCanvas sets pdfCanvas.width = container size; _render's
        // setTransform scales content). The OLD bitmap path's
        // pdfCanvas.width = pageW*scale assignment is INCOMPATIBLE with
        // this model — leaving it active would thrash the canvas
        // dimensions every frame. So skip the old path now; Task 5
        // physically deletes its code from the file.
        _skipBitmapRender = true;
      }
      // Heavy IPC for the active page is done — let the thumbnail processor
      // resume immediately instead of waiting out the pause window.
      resumeThumbnails();
    } catch (e) {
      console.warn('[render] Vector mode failed:', e);
      // Failure path: still resume so thumbnails don't stay stuck paused.
      resumeThumbnails();
    }
  }

  // Bitmap rendering has moved to the unified viewport model (Task 4):
  // activated above in the raster-mode block; pixel-fill happens via
  // bitmap-orchestrator + drawImage in pdf-viewport.js _render() loop.
  // No predictive resize, no canvas-width mutation, no tile DOM canvas.
  //
  // EXCEPTION: blank in-memory docs (Bestand → Nieuw → A4/A3/etc.) have
  // `doc.filePath === null` and are gated out of BOTH vector AND raster
  // paths above. Without a fallback, pdf-canvas keeps its stale content
  // from the previous document (or remains at its previous oversized
  // dimensions) — the user sees "one big white screen" instead of an A4
  // page. Render directly to pdf-canvas via PDF.js for blank docs.
  if (!_hasFilePath && !_skipBitmapRender) {
    try {
      // Also deactivate the viewport singleton if it's leftover-active from
      // a previously-opened real PDF — its RAF loop would otherwise repaint
      // stale content over our PDF.js render every frame.
      const _vpMod = await import('./pdf-viewport.js');
      if (_vpMod.viewport && _vpMod.viewport.active && _vpMod.viewport.filePath !== doc.filePath) {
        _vpMod.viewport.active = false;
        _vpMod.viewport.filePath = null;
        _vpMod.viewport.currentBitmap = null;
      }

      const dpr = getCanvasDPR();
      pdfCanvas.width = Math.floor(viewport.width * dpr);
      pdfCanvas.height = Math.floor(viewport.height * dpr);
      pdfCanvas.style.width = Math.floor(viewport.width) + 'px';
      pdfCanvas.style.height = Math.floor(viewport.height) + 'px';
      const pdfCtx = pdfCanvas.getContext('2d');
      pdfCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pdfCtx.fillStyle = '#ffffff';
      pdfCtx.fillRect(0, 0, viewport.width, viewport.height);
      const renderTask = trackPdfJsRenderTask(publicationToken, doc, page.render({
        canvasContext: pdfCtx,
        viewport,
        annotationMode: 0,
      }));
      await renderTask.promise;
      if (_isStaleDoc(doc, publicationToken)) return;
      state.renderEngine = 'Raster (PDF.js)';
      markLayer('raster');
    } catch (e) {
      console.warn('[render] Blank-doc PDF.js render failed:', e);
      failReadiness(e);
    }
  }

  // Annotation canvas resize is deferred to just before redrawAnnotations()
  // so the clear+redraw happens in one synchronous block (no blink).

  // Set CSS scale variables for PDF.js text/annotation layers
  const container = document.getElementById('canvas-container');
  if (container) {
    container.style.setProperty('--scale-factor', viewport.scale);
    container.style.setProperty('--total-scale-factor', viewport.scale);
  }

  // Text/link/form layers: skip during vector zoom (expensive PDF.js operations)
  // Only create on first load or page change, not on every zoom
  // A hidden continuous-page layer may still exist after switching back to
  // single-page mode, and a layer for the previous page may still be in the
  // single-page container during navigation. Only this page's layer can make
  // the rebuild unnecessary.
  const currentSinglePageTextLayer = container?.querySelector(
    `.textLayer[data-page="${pageNum}"]`,
  );
  if (requireEditReady || !_skipBitmapRender || !currentSinglePageTextLayer
      || !pageEditReadinessSatisfied(doc, pageNum, {
        requiredLayers: ['text', 'links', 'forms'],
      })) {
    try {
      const textViewport = _skipBitmapRender
        ? page.getViewport(rawPdfTextLayerViewportOptions(page.userUnit))
        : viewport;
      const textLayerResult = await createSinglePageTextLayer(page, textViewport);
      if (_isStaleDoc(doc, publicationToken)) return;
      if (!textLayerResult) throw new Error('The current single-page text layer was not published');
      markLayer('text');
      if (doc.revisionState?.saveState !== 'synchronizing') markLayer('editableMetadata');
    } catch (e) {
      console.warn('Failed to create text layer:', e);
      failReadiness(e);
    }

    try {
      await createSinglePageLinkLayer(page, viewport);
      if (_isStaleDoc(doc, publicationToken)) return;
      markLayer('links');
    } catch (e) {
      console.warn('Failed to create link layer:', e);
      failReadiness(e);
    }

    try {
      await createSinglePageFormLayer(page, viewport);
      if (_isStaleDoc(doc, publicationToken)) return;
      markLayer('forms');
    } catch (e) {
      console.warn('Failed to create form layer:', e);
      failReadiness(e);
    }

    // editText tool: annotation-canvas must drop below the textLayer so
    // text-span clicks reach the span listeners (inline text editing).
    // For the 'select' tool we do NOT set pe:none statically — the dynamic
    // fall-through handler in tools/manager.js (_setSelectFallthroughEnabled)
    // toggles annotation-canvas pointer-events on mousemove based on
    // whether the cursor is over an annotation. Setting pe:none here on
    // first render would block the very first click on an annotation
    // (before any mousemove has fired) — symptom: "annotations visible
    // but not selectable" in raster-engine mode.
    if (state.currentTool === 'editText') {
      annotationCanvas.style.zIndex = '2';
      annotationCanvas.style.pointerEvents = 'none';
      const container = document.getElementById('canvas-container');
      if (container) {
        container.querySelectorAll('.formLayer section, .linkLayer .pdf-link').forEach(el => {
          el.style.pointerEvents = 'none';
        });
      }
    }
  }

  // Ensure annotations for this page are loaded (on-demand if background hasn't reached it yet)
  // Skip heavy operations during vector zoom (only needed on first load / page change)
  if (requireEditReady || !_skipBitmapRender || !document.querySelector('.textLayer')
      || !doc._loadedAnnotationPages.has(pageNum)) {
    console.log(`[PERF] renderPage(${pageNum}) ensureAnnotations START: ${(performance.now() - _rp0).toFixed(0)}ms`);
    await ensureAnnotationsForPage(pageNum);
    if (_isStaleDoc(doc, publicationToken)) return;
    console.log(`[PERF] renderPage(${pageNum}) ensureAnnotations DONE: ${(performance.now() - _rp0).toFixed(0)}ms`);
    if (state.preferences.snapToPdfContent) {
      prefetchPdfVectorGeometry(pageNum);
    }
  }

  // Final stale-doc check before mutating shared canvas — without this, an
  // earlier renderPage() that finished after a tab switch would resize and
  // overwrite the annotation canvas of the now-active document.
  if (_isStaleDoc(doc, publicationToken)) return;

  // Resize annotation canvas and redraw in one synchronous block — no blink.
  // The unified single-page viewport owns a fixed visible host surface and
  // centers the PDF page inside it with offsetX/offsetY. Shrinking the overlay
  // to the scaled page width after Save clips annotations on the centered side
  // and makes them impossible to hit even though the base image is current.
  const overlaySurface = singlePageOverlaySurfaceDimensions({
    viewportActive: Boolean(_skipBitmapRender && window.__pdfViewport?.active && doc.filePath),
    viewportWidth: pdfCanvas.clientWidth,
    viewportHeight: pdfCanvas.clientHeight,
    pageWidth: viewport.width,
    pageHeight: viewport.height,
  });
  setupCanvasHiDPI(annotationCanvas, overlaySurface.width, overlaySurface.height);
  redrawAnnotations();
  markLayer('annotations');

  if (_skipBitmapRender && !completedLayers.has('raster')) {
    const viewportModule = await import('./pdf-viewport.js');
    if (!_isStaleDoc(doc, publicationToken) && viewportModule.renderViewportNow()) {
      markLayer('raster');
    } else if (!_isStaleDoc(doc, publicationToken) && !_rasterPublicationPending) {
      failReadiness(new Error('The vector viewport did not publish current pixels'));
    }
  }

  // Re-apply search highlights after re-render
  onPageRendered();

  // Update status bar
  updateAllStatus();

  // NOTE: prefetchAdjacentPages was removed — it causes Rust backend contention
  // with thumbnail rendering, making the app unresponsive on large files.
  // Annotations are loaded on-demand via ensureAnnotationsForPage() when
  // the user actually navigates to a page.
  recordForegroundRenderSample(doc.performanceProfile, {
    elapsedMs: performance.now() - _rp0,
    surfaceBytes: Math.ceil(viewport.width) * Math.ceil(viewport.height) * 4,
  });
  console.log(`[PERF] renderPage(${pageNum}) TOTAL: ${(performance.now() - _rp0).toFixed(0)}ms`);
  return {
    pageNum,
    ready: pageEditReadinessSatisfied(doc, pageNum, {
      requiredLayers: RENDER_EDIT_READY_LAYERS,
    }),
  };
}

// Render page offscreen and swap canvases atomically to avoid zoom flicker.
// The visible canvas keeps its CSS-scaled content until the new render is done.
export async function renderPageOffscreen(pageNum) {
  clearHighlights();

  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) return;
  const pdfDoc = doc.pdfDoc;
  const scale = doc.scale;

  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pdfDoc.numPages) return;
  const publicationToken = captureRenderPublicationToken(doc, pageNum, 'single-page-offscreen');

  const page = await pdfDoc.getPage(pageNum);
  if (_isStaleDoc(doc, publicationToken)) return;
  const extraRotation = getPageRotation(pageNum);
  const viewportOpts = { scale };
  if (extraRotation) viewportOpts.rotation = (page.rotate + extraRotation) % 360;
  const viewport = page.getViewport(viewportOpts);
  const dpr = getCanvasDPR();

  const pdfCanvas = getPdfCanvas();
  const annotationCanvas = getAnnotationCanvas();
  if (!pdfCanvas || !annotationCanvas) return;

  // RUST-ONLY: this offscreen render path used to dual-fallback to PDF.js.
  // Per project policy ("geen fallback"), Rust failure is now a hard error
  // surfaced via state.renderEngine = 'ERROR' so any rasterizer bug is
  // immediately visible.
  // Deactivate the vector viewport singleton — same reason as renderPage().
  if (window.__pdfViewport) window.__pdfViewport.active = false;

  if (!isTauri() || !doc.filePath) {
    state.renderEngine = 'UNSUPPORTED';
    console.error('[render-offscreen] HARD ERROR: cannot render without Tauri+filePath. NO FALLBACK.');
    return;
  }
  try {
    const { renderPdfPageBitmap } = await import('./engine-router.js');
    const rendered = await renderPdfPageBitmap({
      path: doc.filePath,
      pageIndex: pageNum - 1,
      scale: scale,
      requestId: publicationToken.requestId,
    });
    if (_isStaleDoc(doc, publicationToken)) {
      try { rendered?.bitmap?.close?.(); } catch {}
      return;
    }
    const { bitmap, width: rustW, height: rustH } = rendered;
    pdfCanvas.width = rustW;
    pdfCanvas.height = rustH;
    pdfCanvas.style.width = Math.floor(viewport.width) + 'px';
    pdfCanvas.style.height = Math.floor(viewport.height) + 'px';
    pdfCanvas.getContext('2d').drawImage(bitmap, 0, 0);
    try { bitmap.close?.(); } catch {}
    setupCanvasHiDPI(annotationCanvas, viewport.width, viewport.height);
    state.renderEngine = 'Raster (PDFium)';
  } catch (e) {
    state.renderEngine = 'ERROR';
    console.error('[render-offscreen] HARD ERROR: Rust render threw. NO FALLBACK.', e);
    return;
  }

  // Set CSS scale variables for text/annotation layers
  const container = document.getElementById('canvas-container');
  if (container) {
    container.style.setProperty('--scale-factor', viewport.scale);
    container.style.setProperty('--total-scale-factor', viewport.scale);
  }

  // Create text, link, form layers
  try { await createSinglePageTextLayer(page, viewport); } catch {}
  if (_isStaleDoc(doc, publicationToken)) return;
  try { await createSinglePageLinkLayer(page, viewport); } catch {}
  if (_isStaleDoc(doc, publicationToken)) return;
  try { await createSinglePageFormLayer(page, viewport); } catch {}
  if (_isStaleDoc(doc, publicationToken)) return;

  // Re-apply overlay state — see comment near renderer block ~line 455.
  // Only editText forces pe:none statically; select uses dynamic fallthrough.
  if (state.currentTool === 'editText') {
    annotationCanvas.style.zIndex = '2';
    annotationCanvas.style.pointerEvents = 'none';
  }
  if (state.currentTool === 'select' || state.currentTool === 'editText') {
    if (container) {
      container.querySelectorAll('.formLayer section, .linkLayer .pdf-link').forEach(el => {
        el.style.pointerEvents = 'none';
      });
    }
  }

  await ensureAnnotationsForPage(pageNum);
  if (_isStaleDoc(doc, publicationToken)) return;
  if (state.preferences.snapToPdfContent) prefetchPdfVectorGeometry(pageNum);
  redrawAnnotations();
  onPageRendered();
  updateAllStatus();
}

// Track which pages have been rendered in continuous mode
const _renderedPages = new Set();
let _renderedPagesScale = null; // scale at which pages were rendered
let _continuousObserver = null;
let _continuousWindow = null;
let _continuousSettleTimer = null;
const _continuousRenderScheduler = createRenderWorkScheduler({ concurrency: 1, idleDelayMs: 250 });
const CONTINUOUS_MAX_AXIS_PX = 4096;
const _renderedSurfaceStates = new Map();
const _mountedCanvasByteSizes = new Map();
const _mountedImageByteSizes = new Map();
let _surfacePublicationRevision = 0;

function _surfaceStateKey(documentId, lifecycleGeneration, pageNum, source = 'page') {
  return `${documentId}:${lifecycleGeneration}:${pageNum}:${source}`;
}

function _recordRenderedSurface(doc, pageNum, source, detail) {
  const pagePrefix = `${doc.id}:${Number(doc.lifecycleGeneration) || 0}:${pageNum}:`;
  for (const key of _renderedSurfaceStates.keys()) {
    if (key.startsWith(pagePrefix)) _renderedSurfaceStates.delete(key);
  }
  const stateForSurface = createRenderedSurfaceState({
    ...detail,
    documentId: String(doc.id),
    contentRevision: Number(doc.revisionState?.contentRevision) || 0,
    livePdfRevision: Number(doc.revisionState?.livePdfRevision) || 0,
    pageRevision: Number(doc.revisionState?.pageContentRevisions?.[pageNum]
      ?? doc.pageRenderRevisions?.[pageNum]) || 0,
    pageNum,
    source,
    ownerGeneration: Number(doc.lifecycleGeneration) || 0,
    publicationRevision: ++_surfacePublicationRevision,
  });
  _renderedSurfaceStates.set(
    _surfaceStateKey(doc.id, doc.lifecycleGeneration, pageNum, source),
    stateForSurface,
  );
  recordPerformanceEvent('raster:published', {
    pageNum,
    scale: stateForSurface.actualRasterScale,
    cssScale: stateForSurface.cssScale,
    devicePixelRatio: stateForSurface.devicePixelRatio,
    quality: stateForSurface.quality,
    ownerGeneration: stateForSurface.ownerGeneration,
    publicationRevision: stateForSurface.publicationRevision,
    source,
    sharp: renderedSurfaceIsSharp(stateForSurface),
  });
  return stateForSurface;
}

export function getRenderedSurfaceStates() {
  const active = getActiveDocument();
  if (!active) return [];
  const prefix = `${active.id}:${Number(active.lifecycleGeneration) || 0}:`;
  return [..._renderedSurfaceStates.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => Object.freeze({ key, ...value }));
}

function _mountedCanvasResourceKey(doc, pageNum, surface) {
  return `mounted-canvas:${doc.id}:${Number(doc.lifecycleGeneration) || 0}:${pageNum}:${surface}`;
}

function _mountedImageResourceKey(doc, pageNum) {
  return `mounted-image:${doc.id}:${Number(doc.lifecycleGeneration) || 0}:${pageNum}:pdf`;
}

function _trackMountedCanvas(doc, pageNum, canvas, surface) {
  if (!doc || !canvas) return;
  const key = _mountedCanvasResourceKey(doc, pageNum, surface);
  const bytes = Math.max(0, (canvas.width || 0) * (canvas.height || 0) * 4);
  _mountedCanvasByteSizes.set(key, bytes);
  recordPerformancePeak(
    'mountedCanvasBytes',
    [..._mountedCanvasByteSizes.values()].reduce((sum, value) => sum + value, 0),
  );
  registerRenderResource({
    key,
    category: 'javascript',
    documentId: doc.id,
    bytes,
    protected: () => {
      if (!canvas.isConnected) return false;
      const wrapper = canvas.closest?.('.page-wrapper');
      return wrapper?.dataset?.strictlyVisible === 'true'
        || _activeEditorPageForDocument(doc) === Number(pageNum);
    },
    release: () => {
      if (canvas.isConnected && canvas.closest?.('.page-wrapper')?.dataset?.strictlyVisible === 'true') return;
      canvas.width = 0;
      canvas.height = 0;
      _mountedCanvasByteSizes.delete(key);
      if (surface === 'pdf' || surface.startsWith('sharp')) _renderedPages.delete(Number(pageNum));
    },
  });
}

function _trackMountedRasterImage(doc, pageNum, image) {
  if (!doc || !image) return;
  const key = _mountedImageResourceKey(doc, pageNum);
  const bytes = Math.max(0,
    (Number(image.naturalWidth) || 0) * (Number(image.naturalHeight) || 0) * 4);
  _mountedImageByteSizes.set(key, bytes);
  recordPerformancePeak(
    'mountedImageBytes',
    [..._mountedImageByteSizes.values()].reduce((sum, value) => sum + value, 0),
  );
  registerRenderResource({
    key,
    category: 'javascript',
    documentId: doc.id,
    bytes,
    protected: () => {
      if (!image.isConnected) return false;
      const wrapper = image.closest?.('.page-wrapper');
      return wrapper?.dataset?.strictlyVisible === 'true'
        || _activeEditorPageForDocument(doc) === Number(pageNum);
    },
    release: () => {
      if (image.isConnected
          && image.closest?.('.page-wrapper')?.dataset?.strictlyVisible === 'true') return;
      try { image.removeAttribute('src'); } catch {}
      image.remove();
      _mountedImageByteSizes.delete(key);
      _renderedPages.delete(Number(pageNum));
    },
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('opds:continuous-overlay-backing-change', (event) => {
    const canvas = event.target;
    if (!(canvas instanceof HTMLCanvasElement)
        || !canvas.classList.contains('annotation-canvas')) return;
    const wrapper = canvas.closest?.('#continuous-container .page-wrapper[data-page]');
    const doc = getActiveDocument();
    const pageNum = Number(wrapper?.dataset?.page);
    if (!doc || !Number.isInteger(pageNum) || pageNum <= 0) return;
    canvas.dataset.renderSurface = 'annotation';
    _trackMountedCanvas(doc, pageNum, canvas, 'annotation');
  });
}

function _forgetMountedCanvas(doc, pageNum, canvas, fallbackSurface = 'other') {
  if (!doc || !canvas) return;
  const key = _mountedCanvasResourceKey(
    doc,
    pageNum,
    canvas.dataset?.renderSurface || fallbackSurface,
  );
  unregisterRenderResource(key);
  _mountedCanvasByteSizes.delete(key);
}

function _forgetMountedRasterImage(doc, pageNum, image) {
  if (!doc || !image) return;
  const key = _mountedImageResourceKey(doc, pageNum);
  unregisterRenderResource(key);
  _mountedImageByteSizes.delete(key);
}

function _untrackMountedPageCanvases(doc, pageNum, wrapper) {
  if (!doc) return;
  for (const canvas of wrapper?.querySelectorAll?.('canvas') || []) {
    const surface = canvas.dataset?.renderSurface || (canvas.classList.contains('pdf-canvas')
      ? 'pdf' : canvas.classList.contains('annotation-canvas') ? 'annotation' : 'other');
    _forgetMountedCanvas(doc, pageNum, canvas, surface);
  }
}

function _untrackMountedPageImages(doc, pageNum, wrapper, { release = false } = {}) {
  if (!doc) return;
  for (const image of wrapper?.querySelectorAll?.('.pdf-page-raster') || []) {
    _forgetMountedRasterImage(doc, pageNum, image);
    if (release) {
      try { image.removeAttribute('src'); } catch {}
      image.remove();
    }
  }
}

function _loadContinuousRasterImage(lease) {
  return new Promise((resolve, reject) => {
    const image = document.createElement('img');
    image.className = 'pdf-page-raster';
    image.alt = '';
    image.draggable = false;
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.loading = 'eager';
    if (!lease.attach(image)) {
      reject(new DOMException('Raster stream lease is no longer current', 'AbortError'));
      return;
    }
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
    };
    image.onload = () => {
      cleanup();
      if (image.naturalWidth !== lease.width || image.naturalHeight !== lease.height) {
        try { image.removeAttribute('src'); } catch {}
        reject(new Error('direct raster image dimensions do not match its stream descriptor'));
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      try { image.removeAttribute('src'); } catch {}
      reject(new Error('direct raster image stream failed to decode'));
    };
    image.src = lease.url;
  });
}

function _publishContinuousRasterImage(doc, pageNum, oldCanvas, image, viewport) {
  if (!oldCanvas?.isConnected || !image?.naturalWidth || !image?.naturalHeight) return null;
  const container = oldCanvas.parentElement;
  if (!container) return null;
  const oldImage = container.querySelector('.pdf-page-raster');
  const geometryCanvas = oldCanvas.cloneNode(false);
  geometryCanvas.classList.add('pdf-canvas-geometry');
  geometryCanvas.width = image.naturalWidth;
  geometryCanvas.height = image.naturalHeight;
  geometryCanvas.style.width = `${Math.floor(viewport.width)}px`;
  geometryCanvas.style.height = `${Math.floor(viewport.height)}px`;
  geometryCanvas.style.background = 'transparent';
  geometryCanvas.dataset.renderSurface = 'geometry';
  geometryCanvas.dataset.rasterWidth = String(image.naturalWidth);
  geometryCanvas.dataset.rasterHeight = String(image.naturalHeight);

  image.style.position = 'absolute';
  image.style.inset = '0';
  image.style.width = `${Math.floor(viewport.width)}px`;
  image.style.height = `${Math.floor(viewport.height)}px`;
  image.style.objectFit = 'fill';
  image.style.pointerEvents = 'none';
  image.dataset.renderSurface = 'pdf-image';
  image.dataset.rasterWidth = String(image.naturalWidth);
  image.dataset.rasterHeight = String(image.naturalHeight);

  _forgetMountedCanvas(doc, pageNum, oldCanvas, 'pdf');
  if (oldImage) {
    _forgetMountedRasterImage(doc, pageNum, oldImage);
    try { oldImage.removeAttribute('src'); } catch {}
    oldImage.remove();
  }
  oldCanvas.replaceWith(image, geometryCanvas);
  oldCanvas.width = 0;
  oldCanvas.height = 0;
  _trackMountedRasterImage(doc, pageNum, image);
  return geometryCanvas;
}

function _transferContinuousBitmapToFreshCanvas(
  doc,
  pageNum,
  oldCanvas,
  rasterEntry,
  viewport,
) {
  if (!oldCanvas?.isConnected || !rasterEntry?.bitmap
      || (Number(rasterEntry.coalescedConsumers) || 1) > 1) return null;
  const nextCanvas = oldCanvas.cloneNode(false);
  nextCanvas.classList.remove('pdf-canvas-geometry');
  nextCanvas.width = rasterEntry.w;
  nextCanvas.height = rasterEntry.h;
  nextCanvas.style.width = `${Math.floor(viewport.width)}px`;
  nextCanvas.style.height = `${Math.floor(viewport.height)}px`;
  nextCanvas.dataset.renderSurface = 'pdf';
  let bitmapContext = null;
  try {
    bitmapContext = nextCanvas.getContext('bitmaprenderer');
    if (!bitmapContext?.transferFromImageBitmap) {
      nextCanvas.width = 0;
      nextCanvas.height = 0;
      return null;
    }
    bitmapContext.transferFromImageBitmap(rasterEntry.bitmap);
  } catch {
    nextCanvas.width = 0;
    nextCanvas.height = 0;
    return null;
  }

  _forgetMountedCanvas(doc, pageNum, oldCanvas, 'pdf');
  oldCanvas.replaceWith(nextCanvas);
  oldCanvas.width = 0;
  oldCanvas.height = 0;
  consumeCachedBitmapAfterTransfer(rasterEntry, {
    reason: 'continuous-page-bitmaprenderer',
  });
  return nextCanvas;
}

// Track active continuous page renders for cancellation
const _continuousRenderTasks = new Map(); // pageNum -> RenderTask

// Low-res preview cache for fast initial display
const _lowResCache = new Map(); // `${filePath}|${pageNum}` -> { canvas, scale }
const LOW_RES_SCALE = 0.5; // Render at 50% for fast preview
let _lowResPreloadGeneration = 0;
const _lowResResourceKey = (key) => `low-res:${key}`;

// Cache-key MUST include the document — a bare pageNum key served page N of
// whichever document happened to fill the cache first (wrong preview after a
// tab switch).
// Rotation is part of the key so a rotated page doesn't reuse the pre-rotation
// (old-orientation) preview canvas — that stale preview flashed in the OLD
// orientation on the continuous-view rebuild after rotating (issue #262).
function _lowResKey(pageNum, doc = getActiveDocument()) {
  return createLowResolutionPreviewKey(doc, pageNum);
}

function _storeLowResPreview(cacheKey, entry, doc, pageNum) {
  const old = _lowResCache.get(cacheKey);
  if (old?.canvas && old.canvas !== entry.canvas) {
    old.canvas.width = 0;
    old.canvas.height = 0;
  }
  _lowResCache.set(cacheKey, entry);
  recordPerformancePeak(
    'previewCanvasBytes',
    [..._lowResCache.values()].reduce((sum, preview) =>
      sum + (preview.canvas?.width || 0) * (preview.canvas?.height || 0) * 4, 0),
  );
  registerRenderResource({
    key: _lowResResourceKey(cacheKey),
    category: 'javascript',
    documentId: doc?.id || doc?.filePath || null,
    bytes: (entry.canvas.width || 0) * (entry.canvas.height || 0) * 4,
    protected: () => {
      const active = getActiveDocument();
      return active === doc && (active.currentPage === pageNum || _continuousWindow?.mounted?.has(pageNum));
    },
    release: () => {
      const current = _lowResCache.get(cacheKey);
      if (current?.canvas) {
        current.canvas.width = 0;
        current.canvas.height = 0;
      }
      _lowResCache.delete(cacheKey);
    },
  });
}

// Render a quick low-res preview of a page (fast, <50ms per page)
async function renderLowResPreview(doc, pdfDoc, pageNum, targetWidth, targetHeight) {
  const publicationToken = captureRenderPublicationToken(doc, pageNum, 'low-resolution-preview');
  const cacheKey = _lowResKey(pageNum, doc);
  if (_lowResCache.has(cacheKey)) {
    const entry = _lowResCache.get(cacheKey);
    _lowResCache.delete(cacheKey);
    _lowResCache.set(cacheKey, entry);
    touchRenderResource(_lowResResourceKey(cacheKey));
    return entry.canvas;
  }

  try {
    const { getCachedThumbnailEntry } = await import('../ui/panels/left-panel.js');
    if (_isStaleDoc(doc, publicationToken)) return null;
    const shared = getCachedThumbnailEntry(doc, pageNum);
    if (shared?.src) return null; // wrapper reuses this source directly; do not clone it into another canvas cache
  } catch { /* fall back to a PDF.js low-resolution render */ }

  const page = await pdfDoc.getPage(pageNum);
  if (_isStaleDoc(doc, publicationToken)) return null;
  const extraRotation = Number(doc.pageRotations?.[pageNum]) || 0;
  const vpOpts = { scale: LOW_RES_SCALE };
  if (extraRotation) vpOpts.rotation = (page.rotate + extraRotation) % 360;
  const viewport = page.getViewport(vpOpts);

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');

  try {
    const renderTask = trackPdfJsRenderTask(publicationToken, doc, page.render({
      canvasContext: ctx,
      viewport,
      annotationMode: 0,
    }));
    await renderTask.promise;
  } catch (e) {
    canvas.width = 0;
    canvas.height = 0;
    if (e.name === 'RenderingCancelledException') return null;
    return null;
  }

  if (_isStaleDoc(doc, publicationToken)) {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }
  _storeLowResPreview(cacheKey, {
    canvas,
    scale: LOW_RES_SCALE,
    documentId: doc.id,
    pageNum,
    publicationToken,
  }, doc, pageNum);
  return canvas;
}

function scheduleNearbyLowResPreviews(pdfDoc, centerPage, direction = 1) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc || doc.pdfDoc !== pdfDoc) return;
  if (shouldPreloadEntireDocument(doc, state.preferences)) {
    void import('./whole-pdf-preload.js').then(({ startWholePdfPreload }) => startWholePdfPreload());
    return;
  }
  if (!shouldPreloadNearby(state.preferences)) return;
  const generation = ++_lowResPreloadGeneration;
  const forward = direction < 0 ? -1 : 1;
  const pages = [centerPage, centerPage + forward, centerPage + 2 * forward,
    centerPage + 3 * forward, centerPage - forward]
    .filter((page, index, values) => page >= 1 && page <= pdfDoc.numPages && values.indexOf(page) === index);
  void (async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const page of pages) {
      if (generation !== _lowResPreloadGeneration || !isPdfForegroundIdle()
          || !backgroundRenderAdmissionAllowed()) return;
      if (_lowResCache.has(_lowResKey(page, doc))) continue;
      try { await renderLowResPreview(doc, pdfDoc, page, 0, 0); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  })();
}

// Clear low-res cache (on document close)
export function clearLowResCache() {
  for (const [key, entry] of _lowResCache) {
    if (entry?.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    unregisterRenderResource(_lowResResourceKey(key));
  }
  _lowResCache.clear();
}

export function clearLowResCacheForDocument(doc, pageNums = null) {
  if (!doc?.id) return;
  const pages = pageNums === null ? null : new Set((pageNums || []).map(Number));
  _lowResPreloadGeneration += 1;
  for (const [key, entry] of [..._lowResCache.entries()]) {
    if (entry?.documentId !== doc.id || (pages && !pages.has(Number(entry.pageNum)))) continue;
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    _lowResCache.delete(key);
    unregisterRenderResource(_lowResResourceKey(key));
  }
}

function _continuousOwnerKey(doc) {
  return `${doc?.id || 'none'}:${Number(doc?.lifecycleGeneration) || 0}`;
}

// Schedule one full-quality foreground render. A single scheduler is shared by
// every continuous page so rapid scrolling cannot launch a PDFium render storm.
function renderContinuousPage(pageNum, priority = 100, kind = 'foreground') {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return Promise.resolve();
  if (_renderedPages.has(pageNum)) {
    const wrapper = document.querySelector(
      `#continuous-container .page-wrapper[data-page="${pageNum}"]`,
    );
    const needsVisibleSharpness = wrapper?.dataset?.rasterQuality === RasterQuality.PREVIEW
      && (kind === 'foreground' || wrapper.dataset.strictlyVisible === 'true');
    if (!needsVisibleSharpness && pageEditReadinessSatisfied(doc, pageNum, {
      requiredLayers: RENDER_EDIT_READY_LAYERS,
    })) {
      return Promise.resolve({
        status: 'complete',
        value: { pageNum, ready: true, reused: true },
      });
    }
    _renderedPages.delete(pageNum);
  }
  const ownerKey = _continuousOwnerKey(doc);
  const scaleRevision = Math.round(doc.scale * 10000);
  const densityRevision = Math.round(requestedRasterScale(doc.scale, getCanvasDPR()) * 10000);
  const pageRevision = Number(doc.pageRenderRevisions?.[pageNum]) || 0;
  const publicationToken = captureRenderPublicationToken(doc, pageNum, 'continuous-scheduler');
  let countedAsInFlight = false;
  const releaseInFlight = () => {
    if (!countedAsInFlight) return;
    countedAsInFlight = false;
    if (typeof window !== 'undefined') {
      window.__pdfRenderInFlight = Math.max(0, (window.__pdfRenderInFlight || 1) - 1);
    }
  };
  return _continuousRenderScheduler.schedule({
    key: `${ownerKey}:${pageNum}:${pageRevision}:${scaleRevision}:${densityRevision}`,
    ownerKey,
    priority,
    kind,
    publicationToken,
    publicationDocument: doc,
    onRetire: releaseInFlight,
    run: async ({ isCurrent }) => {
      if (typeof window !== 'undefined') {
        countedAsInFlight = true;
        window.__pdfRenderInFlight = (window.__pdfRenderInFlight || 0) + 1;
      }
      try {
        return await _renderContinuousPageNow(pageNum, isCurrent, kind);
      } finally {
        releaseInFlight();
      }
    },
  }).catch((error) => {
    console.warn(`[render-continuous] scheduled page ${pageNum} failed:`, error);
    failRendererReadiness(doc, pageNum, error, publicationToken);
    return { status: 'failed', reason: error?.message || String(error) };
  });
}

function _continuousRasterContext(doc, pageNum, cssScale, devicePixelRatio, quality, targetRasterScale) {
  return {
    documentId: doc.id,
    lifecycleGeneration: Number(doc.lifecycleGeneration) || 0,
    contentRevision: Number(doc.revisionState?.contentRevision) || 0,
    pageRevision: Number(doc.pageRenderRevisions?.[pageNum]) || 0,
    cssScale,
    devicePixelRatio,
    quality,
    targetRasterScale,
    publicationDocument: doc,
    publicationToken: captureRenderPublicationToken(doc, pageNum, `continuous-raster-${quality}`),
  };
}

async function _ensureContinuousSharpTiles({
  doc,
  pageNum,
  pageWrapper,
  canvasContainer,
  viewport,
  rotation,
  isCurrent,
  expectedScale,
  devicePixelRatio,
  publicationToken,
}) {
  const scrollContainer = document.getElementById('pdf-container');
  if (!scrollContainer || !pageWrapper.isConnected) return false;
  const pageRect = pageWrapper.getBoundingClientRect();
  const viewportRect = scrollContainer.getBoundingClientRect();
  const plans = planVisiblePageTiles({
    pageRect,
    viewportRect,
    cssScale: expectedScale,
    devicePixelRatio,
    pageWidthPt: viewport.width / expectedScale,
    pageHeightPt: viewport.height / expectedScale,
    maxBitmapAxisPx: CONTINUOUS_MAX_AXIS_PX,
    seamOverscanPx: 2,
  });
  if (!plans.length) return false;

  const revision = ++_surfacePublicationRevision;
  const created = [];
  const abort = () => {
    for (const canvas of created) {
      _forgetMountedCanvas(doc, pageNum, canvas, 'sharp-aborted');
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }
    return false;
  };
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    if (_isStaleDoc(doc, publicationToken) || !isCurrent() || !pageWrapper.isConnected
        || doc.scale !== expectedScale || getCanvasDPR() !== devicePixelRatio) return abort();
    const regionBucket = [plan.regionXpt, plan.regionYpt, plan.regionWpt, plan.regionHpt]
      .map((value) => Math.round(value * 1_000) / 1_000).join(',');
    const request = {
      regionXpt: plan.regionXpt,
      regionYpt: plan.regionYpt,
      regionWpt: plan.regionWpt,
      regionHpt: plan.regionHpt,
      requiredScale: plan.targetScale,
    };
    let entry = tileCacheFindCovering(doc.filePath, pageNum, rotation, request)
      || tileCacheGet(doc.filePath, pageNum, plan.targetScale, rotation, regionBucket);

    const tileCanvas = document.createElement('canvas');
    tileCanvas.className = 'page-sharp-tile';
    tileCanvas.dataset.page = String(pageNum);
    tileCanvas.dataset.sharpRevision = String(revision);
    tileCanvas.dataset.renderSurface = `sharp-${revision}-${index}`;
    tileCanvas.dataset.regionXpt = String(plan.regionXpt);
    tileCanvas.dataset.regionYpt = String(plan.regionYpt);
    tileCanvas.dataset.regionWpt = String(plan.regionWpt);
    tileCanvas.dataset.regionHpt = String(plan.regionHpt);
    tileCanvas.style.position = 'absolute';
    tileCanvas.style.left = `${plan.cssLeft}px`;
    tileCanvas.style.top = `${plan.cssTop}px`;
    tileCanvas.style.width = `${plan.cssWidth}px`;
    tileCanvas.style.height = `${plan.cssHeight}px`;
    tileCanvas.style.pointerEvents = 'none';
    tileCanvas.style.zIndex = '1';
    canvasContainer.appendChild(tileCanvas);
    created.push(tileCanvas);

    if (!entry || Number(entry.regionMeta?.renderScale) + 0.01 < plan.targetScale) {
      incrementPerformanceCounter('tileRasterRequested');
      recordPerformanceEvent('tile-raster:requested', {
        pageNum,
        scale: plan.targetScale,
        cssScale: expectedScale,
        devicePixelRatio,
        quality: RasterQuality.FINAL,
        ownerGeneration: Number(doc.lifecycleGeneration) || 0,
      });
      try {
        const { invokeTileRegion } = await import('./progressive-render.js');
        const raw = await invokeTileRegion({
          path: doc.filePath,
          pageIndex: pageNum - 1,
          scale: plan.targetScale,
          rotation,
          regionXPt: plan.regionXpt,
          regionYPt: plan.regionYpt,
          regionWPt: plan.regionWpt,
          regionHPt: plan.regionHpt,
          requestId: publicationToken.requestId,
        });
        if (_isStaleDoc(doc, publicationToken) || !isCurrent() || !pageWrapper.isConnected
            || doc.scale !== expectedScale || getCanvasDPR() !== devicePixelRatio) {
          incrementPerformanceCounter('tileRasterCancelled');
          return abort();
        }
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        if (bytes.length <= 8) throw new Error('empty continuous sharp-tile response');
        const header = new DataView(bytes.buffer, bytes.byteOffset, 8);
        const width = header.getUint32(0, true);
        const height = header.getUint32(4, true);
        const byteLength = width * height * 4;
        if (!width || !height || byteLength !== bytes.length - 8) {
          throw new Error('continuous sharp-tile dimensions do not match response bytes');
        }
        await tileCacheSet(
          doc.filePath,
          pageNum,
          plan.targetScale,
          rotation,
          regionBucket,
          new ImageData(new Uint8ClampedArray(
            bytes.buffer,
            bytes.byteOffset + 8,
            byteLength,
          ), width, height),
          {
            regionXpt: plan.regionXpt,
            regionYpt: plan.regionYpt,
            regionWpt: plan.regionWpt,
            regionHpt: plan.regionHpt,
            renderScale: plan.targetScale,
            quality: RasterQuality.FINAL,
          },
          { token: publicationToken, documentState: doc },
        );
        entry = tileCacheGet(doc.filePath, pageNum, plan.targetScale, rotation, regionBucket);
      } catch (error) {
        incrementPerformanceCounter('tileRasterCancelled');
        recordPerformanceEvent('tile-raster:cancelled', {
          pageNum,
          scale: plan.targetScale,
          quality: RasterQuality.FINAL,
          ownerGeneration: Number(doc.lifecycleGeneration) || 0,
        });
        console.warn(`[render-continuous] sharp tile failed for page ${pageNum}:`, error);
        return abort();
      }
    } else {
      incrementPerformanceCounter('tileRasterReused');
    }

    if (!entry?.bitmap) return abort();
    tileCanvas.width = entry.w;
    tileCanvas.height = entry.h;
    tileCanvas.getContext('2d')?.drawImage(entry.bitmap, 0, 0);
    _trackMountedCanvas(doc, pageNum, tileCanvas, tileCanvas.dataset.renderSurface);
  }

  for (const old of canvasContainer.querySelectorAll('.page-sharp-tile')) {
    if (old.dataset.sharpRevision === String(revision)) continue;
    _forgetMountedCanvas(doc, pageNum, old, 'sharp-old');
    old.width = 0;
    old.height = 0;
    old.remove();
  }
  return created.length === plans.length;
}

// Render a single page inside its mounted wrapper.
async function _renderContinuousPageNow(pageNum, isCurrent = () => true, kind = 'foreground') {
  const pageWrapper = document.querySelector(`#continuous-container .page-wrapper[data-page="${pageNum}"]`);
  if (!pageWrapper) throw new Error(`Required page ${pageNum} is not mounted`);

  const canvasContainer = pageWrapper.querySelector('.canvas-container-cont');
  if (!canvasContainer) throw new Error(`Required page ${pageNum} has no canvas container`);

  // Cancel any in-progress render for this page
  if (_continuousRenderTasks.has(pageNum)) {
    try { _continuousRenderTasks.get(pageNum).cancel(); } catch {}
    _continuousRenderTasks.delete(pageNum);
  }

  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) throw new Error(`Required page ${pageNum} lost its document owner`);
  const publicationToken = captureRenderPublicationToken(doc, pageNum, 'continuous-page');
  const markLayer = (layer) => markRendererLayerReady(doc, pageNum, layer, publicationToken);
  const failReadiness = (error) => failRendererReadiness(doc, pageNum, error, publicationToken);
  const expectedScale = doc.scale;
  const startedAt = performance.now();
  _renderedPages.add(pageNum);
  const page = await doc.pdfDoc.getPage(pageNum);
  if (_isStaleDoc(doc, publicationToken) || !isCurrent() || !pageWrapper.isConnected || doc.scale !== expectedScale) {
    _renderedPages.delete(pageNum);
    return { pageNum, ready: false };
  }
  const extraRotation = getPageRotation(pageNum);
  const vpOpts = { scale: doc.scale };
  if (extraRotation) {
    vpOpts.rotation = (page.rotate + extraRotation) % 360;
  }
  const viewport = page.getViewport(vpOpts);

  canvasContainer.style.setProperty('--scale-factor', viewport.scale);
  canvasContainer.style.setProperty('--total-scale-factor', viewport.scale);

  // Reuse existing canvases if available (zoom re-render), or create new ones
  let pdfCanvasEl = canvasContainer.querySelector('.pdf-canvas');
  let annotationCanvasEl = canvasContainer.querySelector('.annotation-canvas');
  let isNewPage = false;

  if (!pdfCanvasEl) {
    isNewPage = true;
    pdfCanvasEl = document.createElement('canvas');
    pdfCanvasEl.className = 'pdf-canvas';
    pdfCanvasEl.dataset.page = pageNum;
    pdfCanvasEl.style.display = 'block';
    pdfCanvasEl.style.background = 'white';
    canvasContainer.appendChild(pdfCanvasEl);

    // Show a low-res preview immediately while the full render runs. Do not
    // allocate a blank full-DPR backing store when the thumbnail image already
    // supplies the visible placeholder; the final raster gets a fresh surface.
    pdfCanvasEl.style.width = `${Math.floor(viewport.width)}px`;
    pdfCanvasEl.style.height = `${Math.floor(viewport.height)}px`;
    const lowRes = _lowResCache.get(_lowResKey(pageNum));
    if (lowRes) {
      setupCanvasHiDPI(pdfCanvasEl, viewport.width, viewport.height);
      const previewCtx = pdfCanvasEl.getContext('2d');
      previewCtx.drawImage(lowRes.canvas, 0, 0, pdfCanvasEl.width, pdfCanvasEl.height);
    }
  }

  if (!annotationCanvasEl) {
    annotationCanvasEl = document.createElement('canvas');
    annotationCanvasEl.className = 'annotation-canvas';
    annotationCanvasEl.dataset.page = pageNum;
    annotationCanvasEl.style.position = 'absolute';
    annotationCanvasEl.style.top = '0';
    annotationCanvasEl.style.left = '0';
    canvasContainer.appendChild(annotationCanvasEl);
  }

  // Update canvas dimensions for new scale. The annotation canvas may resize
  // immediately (it is redrawn below anyway), but a REUSED pdf-canvas keeps
  // its old bitmap as a CSS-stretched placeholder until the new render lands:
  // resizing a canvas wipes it, and that wipe was exactly the white flash
  // that made zooming in continuous mode unusable.
  annotationCanvasEl.dataset.logicalWidth = String(viewport.width);
  annotationCanvasEl.dataset.logicalHeight = String(viewport.height);
  annotationCanvasEl.style.width = `${Math.floor(viewport.width)}px`;
  annotationCanvasEl.style.height = `${Math.floor(viewport.height)}px`;
  annotationCanvasEl.dataset.renderSurface = 'annotation';
  if (!isNewPage) {
    pdfCanvasEl.style.width = Math.floor(viewport.width) + 'px';
    pdfCanvasEl.style.height = Math.floor(viewport.height) + 'px';
  }
  // Cursor is handled centrally by js/ui/cursor.js — no need to set it here.

  // Only editText forces pe:none statically; select uses dynamic fallthrough.
  // See comment near renderer block ~line 455.
  if (state.currentTool === 'editText') {
    annotationCanvasEl.style.zIndex = '2';
    annotationCanvasEl.style.pointerEvents = 'none';
  }

  // RUST-ONLY: continuous-mode page render. Used to dual-fallback to
  // PDF.js — removed per project policy. Rust failure surfaced via console
  // + state.renderEngine = 'ERROR' (the page stays blank rather than
  // showing a slow-rendered PDF.js fallback that hides the actual Rust bug).
  if (!isTauri() || !doc.filePath) {
    state.renderEngine = 'UNSUPPORTED';
    throw new Error(`Page ${pageNum} cannot render without Tauri and a saved file path`);
  }

  // Logical layout stays in CSS/PDF coordinates. Settled pixels are rendered
  // at CSS scale × monitor DPR; the 4096-axis whole-page cap is preview-only.
  const devicePixelRatio = getCanvasDPR();
  const targetRasterScale = requestedRasterScale(doc.scale, devicePixelRatio);
  const pageMaxAxisPt = Math.max(viewport.width, viewport.height) / doc.scale;
  const maximumWholePageScale = CONTINUOUS_MAX_AXIS_PX / pageMaxAxisPt;
  const renderScale = Math.min(targetRasterScale, maximumWholePageScale);
  const baseQuality = renderScale + 0.01 >= targetRasterScale
    ? RasterQuality.FINAL
    : RasterQuality.PREVIEW;
  const rasterContext = _continuousRasterContext(
    doc,
    pageNum,
    doc.scale,
    devicePixelRatio,
    baseQuality,
    renderScale,
  );

  let rasterEntry = null;
  let directImageLease = null;
  let directRasterImage = null;
  // A large document's settled continuous surface owns the one-use native
  // stream directly. This avoids the otherwise redundant
  // fetch→Blob→ImageBitmap→canvas allocation chain. The shared bitmap
  // registry remains the complete fallback and continues to serve single-page
  // and viewport rendering.
  if (doc.performanceProfile?.largeDocument) {
    try {
      const { beginPdfPageImageStream } = await import('./engine-router.js');
      const rasterKey = serializePageRasterKey(createPageRasterKey({
        documentId: doc.id,
        lifecycleGeneration: Number(doc.lifecycleGeneration) || 0,
        contentRevision: Number(doc.revisionState?.contentRevision) || 0,
        pageRevision: Number(doc.pageRenderRevisions?.[pageNum]) || 0,
        filePath: doc.filePath,
        pageNum,
        rotation: extraRotation || 0,
        cssScale: doc.scale,
        devicePixelRatio,
        quality: baseQuality,
      }));
      directImageLease = await beginPdfPageImageStream({
        path: doc.filePath,
        pageIndex: pageNum - 1,
        scale: renderScale,
        rotation: extraRotation || 0,
        cssScale: doc.scale,
        devicePixelRatio,
        quality: baseQuality,
        ownerGeneration: Number(doc.lifecycleGeneration) || 0,
        rasterKey,
        requestId: publicationToken.requestId,
      });
      if (directImageLease) {
        directRasterImage = await _loadContinuousRasterImage(directImageLease);
        rasterEntry = {
          image: directRasterImage,
          w: directRasterImage.naturalWidth,
          h: directRasterImage.naturalHeight,
        };
      }
    } catch (error) {
      directImageLease?.cancel?.('image-stream-failed');
      directImageLease = null;
      directRasterImage = null;
      console.warn(`[render-continuous] direct image stream failed for page ${pageNum}; using bitmap fallback:`, error);
    }
  }
  if (!rasterEntry) {
    try {
      rasterEntry = await ensureBitmap(
        doc.filePath,
        pageNum,
        extraRotation || 0,
        renderScale,
        rasterContext,
      );
    } catch (error) {
      state.renderEngine = 'ERROR';
      console.error(`[render-continuous] HARD ERROR: page ${pageNum} Rust threw. NO FALLBACK.`, error);
      _renderedPages.delete(pageNum);
      throw error;
    }
  }
  if (_isStaleDoc(doc, publicationToken) || !isCurrent() || !pageWrapper.isConnected
      || doc.scale !== expectedScale || getCanvasDPR() !== devicePixelRatio) {
    directImageLease?.cancel?.('stale-owner');
    if (directRasterImage) {
      try { directRasterImage.removeAttribute('src'); } catch {}
    }
    _renderedPages.delete(pageNum);
    return { pageNum, ready: false };
  }
  if ((!rasterEntry?.bitmap && !rasterEntry?.image) || rasterEntry.w <= 0 || rasterEntry.h <= 0) {
    directImageLease?.cancel?.('empty-raster');
    state.renderEngine = 'ERROR';
    console.error(`[render-continuous] HARD ERROR: page ${pageNum} returned no raster. NO FALLBACK.`);
    _renderedPages.delete(pageNum);
    throw new Error(`Page ${pageNum} returned no raster`);
  }

  if (directRasterImage) {
    const geometryCanvas = _publishContinuousRasterImage(
      doc,
      pageNum,
      pdfCanvasEl,
      directRasterImage,
      viewport,
    );
    if (!geometryCanvas) {
      directImageLease?.cancel?.('publication-failed');
      _renderedPages.delete(pageNum);
      throw new Error(`Page ${pageNum} raster publication failed`);
    }
    pdfCanvasEl = geometryCanvas;
    directImageLease?.complete?.();
    state.renderEngine = 'Raster (PDFium · direct stream)';
  } else {
    const transferredCanvas = _transferContinuousBitmapToFreshCanvas(
      doc,
      pageNum,
      pdfCanvasEl,
      rasterEntry,
      viewport,
    );
    if (transferredCanvas) {
      pdfCanvasEl = transferredCanvas;
    } else {
      pdfCanvasEl.width = rasterEntry.w;
      pdfCanvasEl.height = rasterEntry.h;
      pdfCanvasEl.style.width = `${Math.floor(viewport.width)}px`;
      pdfCanvasEl.style.height = `${Math.floor(viewport.height)}px`;
      pdfCanvasEl.dataset.renderSurface = 'pdf';
      pdfCanvasEl.classList.remove('pdf-canvas-geometry');
      pdfCanvasEl.getContext('2d')?.drawImage(rasterEntry.bitmap, 0, 0);
      releaseCachedBitmapAfterPublication(rasterEntry, {
        reason: 'continuous-page-canvas',
      });
    }
    _trackMountedCanvas(doc, pageNum, pdfCanvasEl, 'pdf');
    state.renderEngine = rasterEntry.lastUsedAt ? 'Raster (PDFium · registry)' : 'Raster (PDFium)';
  }

  let visibleFinal = baseQuality === RasterQuality.FINAL;
  if (!visibleFinal) {
    visibleFinal = await _ensureContinuousSharpTiles({
      doc,
      pageNum,
      pageWrapper,
      canvasContainer,
      viewport,
      rotation: extraRotation || 0,
      isCurrent,
      expectedScale,
      devicePixelRatio,
      publicationToken,
    });
  } else {
    for (const tile of canvasContainer.querySelectorAll('.page-sharp-tile')) {
      _forgetMountedCanvas(doc, pageNum, tile, 'sharp-old');
      tile.width = 0;
      tile.height = 0;
      tile.remove();
    }
  }

  const publishedQuality = visibleFinal ? RasterQuality.FINAL : RasterQuality.PREVIEW;
  pageWrapper.dataset.rasterQuality = publishedQuality;
  pageWrapper.dataset.rasterTargetScale = String(targetRasterScale);
  pageWrapper.dataset.rasterActualScale = String(visibleFinal ? targetRasterScale : renderScale);
  _recordRenderedSurface(
    doc,
    pageNum,
    visibleFinal && baseQuality === RasterQuality.PREVIEW
      ? 'continuous-tile'
      : directRasterImage ? 'continuous-stream' : 'continuous-page',
    {
      targetRasterScale,
      actualRasterScale: visibleFinal ? targetRasterScale : renderScale,
      cssScale: doc.scale,
      devicePixelRatio,
      quality: publishedQuality,
    },
  );
  markLayer('raster');

  const fullQualityPaintedAt = performance.now();
  pageWrapper.querySelectorAll('.page-preview-image, .page-preview-canvas')
    .forEach((preview) => preview.remove());
  recordPerformanceSample(
    visibleFinal
      ? (kind === 'foreground' ? 'foregroundBitmapPaintMs' : 'backgroundBitmapPaintMs')
      : 'previewBitmapPaintMs',
    fullQualityPaintedAt - startedAt,
  );
  if (visibleFinal && kind === 'foreground'
      && Number.isFinite(Number(pageWrapper.dataset.visibleAt))) {
    recordPerformanceSample(
      'fullQualityLatencyMs',
      fullQualityPaintedAt - Number(pageWrapper.dataset.visibleAt),
    );
  }
  incrementPerformanceCounter(visibleFinal ? 'fullQualityPublishes' : 'previewPublishes');

  const semanticLayoutKey = [
    doc.id,
    Number(doc.lifecycleGeneration) || 0,
    Number(doc.revisionState?.contentRevision) || 0,
    Number(doc.revisionState?.livePdfRevision) || 0,
    Number(doc.revisionState?.pageContentRevisions?.[pageNum]
      ?? doc.pageRenderRevisions?.[pageNum]) || 0,
    pageNum,
    Math.round(doc.scale * 10_000),
    extraRotation || 0,
  ].join(':');
  const needsSemanticRebuild = pageWrapper.dataset.semanticLayoutKey !== semanticLayoutKey;
  if (needsSemanticRebuild) {
    // DPR-only raster refreshes keep semantic layers and page coordinates
    // intact. Zoom/rotation/content revisions rebuild them once.
    releaseTextLayer(pageNum);
    releaseLinkLayer(pageNum);
    releaseFormLayer(pageNum);

  // Create text layer
  try {
    const textLayerResult = await createTextLayer(page, viewport, canvasContainer, pageNum);
    if (!textLayerResult) throw new Error(`The current text layer for page ${pageNum} was not published`);
    markLayer('text');
    if (doc.revisionState?.saveState !== 'synchronizing') markLayer('editableMetadata');
  } catch (e) {
    console.warn(`Failed to create text layer for page ${pageNum}:`, e);
    failReadiness(e);
  }
  if (_isStaleDoc(doc, publicationToken) || !isCurrent() || !pageWrapper.isConnected) return { ready: false };

  // Create link layer
  try {
    await createLinkLayer(page, viewport, canvasContainer, pageNum);
    markLayer('links');
  } catch (e) {
    console.warn(`Failed to create link layer for page ${pageNum}:`, e);
    failReadiness(e);
  }
  if (_isStaleDoc(doc, publicationToken) || !isCurrent() || !pageWrapper.isConnected) return { ready: false };

  // Create form layer
  try {
    await createFormLayer(page, viewport, canvasContainer, pageNum);
    markLayer('forms');
  } catch (e) {
    console.warn(`Failed to create form layer for page ${pageNum}:`, e);
    failReadiness(e);
  }
  if (_isStaleDoc(doc, publicationToken) || !isCurrent() || !pageWrapper.isConnected) return { ready: false };

  // Re-apply overlay state for newly created form/link layers
    if (state.currentTool === 'select' || state.currentTool === 'editText') {
      canvasContainer.querySelectorAll('.formLayer section, .linkLayer .pdf-link').forEach(el => {
        el.style.pointerEvents = 'none';
      });
    }
    pageWrapper.dataset.semanticLayoutKey = semanticLayoutKey;
  }

  // Render annotations
  const annotationCtxEl = annotationCanvasEl.getContext('2d');
  renderAnnotationsForPage(annotationCtxEl, pageNum, viewport.width, viewport.height);
  _trackMountedCanvas(doc, pageNum, annotationCanvasEl, 'annotation');
  markLayer('annotations');

  // Re-apply search highlights after re-render
  onPageRendered();

  // Setup mouse events only for new pages (not re-renders)
  if (isNewPage) {
    setupContinuousPageEvents(annotationCanvasEl, pageNum);
  }
  recordForegroundRenderSample(doc.performanceProfile, {
    elapsedMs: performance.now() - startedAt,
    surfaceBytes: (pdfCanvasEl.width || 0) * (pdfCanvasEl.height || 0) * 4,
  });
  const completedAt = performance.now();
  recordPerformanceSample(
    kind === 'foreground' ? 'foregroundRenderMs' : 'backgroundRenderMs',
    completedAt - startedAt,
  );
  recordPerformanceSample('pageInteractiveReadyMs', completedAt - startedAt);
  return {
    pageNum,
    ready: pageEditReadinessSatisfied(doc, pageNum, {
      requiredLayers: RENDER_EDIT_READY_LAYERS,
    }),
  };
}

function _continuousLayout(doc) {
  return doc?.bookSpread ? 'book' : 'continuous';
}

function _activeEditorPageForDocument(doc) {
  const session = getActiveTextEditSession();
  return session?.ownerDocumentId === doc?.id
    && (Number(session.ownerDocumentGeneration) || 0) === (Number(doc.lifecycleGeneration) || 0)
    ? Number(session.pageNum) || null
    : null;
}

function _positionContinuousWrapper(wrapper, rect, scale) {
  wrapper.dataset.baseW = String(rect.width / scale);
  wrapper.dataset.baseH = String(rect.height / scale);
  wrapper.style.left = `${rect.x}px`;
  wrapper.style.top = `${rect.y}px`;
  wrapper.style.width = `${rect.width}px`;
  wrapper.style.height = `${rect.height}px`;
  const canvasContainer = wrapper.querySelector('.canvas-container-cont');
  if (!canvasContainer) return;
  canvasContainer.style.width = `${rect.width}px`;
  canvasContainer.style.height = `${rect.height}px`;
  canvasContainer.querySelectorAll(
    'canvas:not(.page-sharp-tile), .page-preview-image, .pdf-page-raster',
  ).forEach((surface) => {
    surface.style.width = `${rect.width}px`;
    surface.style.height = `${rect.height}px`;
  });
  for (const tile of canvasContainer.querySelectorAll('.page-sharp-tile')) {
    tile.style.left = `${(Number(tile.dataset.regionXpt) || 0) * scale}px`;
    tile.style.top = `${(Number(tile.dataset.regionYpt) || 0) * scale}px`;
    tile.style.width = `${(Number(tile.dataset.regionWpt) || 0) * scale}px`;
    tile.style.height = `${(Number(tile.dataset.regionHpt) || 0) * scale}px`;
  }
}

function _continuousRectWithOffset(rect, continuousState = _continuousWindow) {
  if (!rect) return null;
  return {
    ...rect,
    x: rect.x + (Number(continuousState?.horizontalOffsetPx) || 0),
    y: rect.y + (Number(continuousState?.verticalOffsetPx) || 0),
  };
}

function _hasReusableContinuousBitmap(doc, pageNum) {
  const geometry = doc?.pageGeometryIndex?.byPage?.get(pageNum);
  if (!doc?.filePath || !geometry) return false;
  const dpr = getCanvasDPR();
  const targetScale = requestedRasterScale(doc.scale, dpr);
  const renderScale = Math.min(
    targetScale,
    CONTINUOUS_MAX_AXIS_PX / Math.max(geometry.widthPt, geometry.heightPt),
  );
  const quality = renderScale + 0.01 >= targetScale ? RasterQuality.FINAL : RasterQuality.PREVIEW;
  return Boolean(getCachedBitmap(
    doc.filePath,
    pageNum,
    getPageRotation(pageNum) || 0,
    renderScale,
    _continuousRasterContext(doc, pageNum, doc.scale, dpr, quality, renderScale),
  ));
}

function _createContinuousWrapper(doc, pageNum, rect) {
  const pageWrapper = document.createElement('div');
  pageWrapper.className = 'page-wrapper';
  pageWrapper.dataset.page = String(pageNum);
  pageWrapper.style.position = 'absolute';
  pageWrapper.style.margin = '0';

  const canvasContainer = document.createElement('div');
  canvasContainer.className = 'canvas-container-cont';
  canvasContainer.style.position = 'relative';
  canvasContainer.style.display = 'inline-block';
  canvasContainer.style.background = 'white';
  canvasContainer.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
  pageWrapper.appendChild(canvasContainer);
  _positionContinuousWrapper(pageWrapper, rect, doc.scale);

  // The thumbnail cache is an immediate visual fallback. It is deliberately
  // a DOM image, not another retained canvas copy, and disappears atomically
  // when the current full-quality render publishes.
  const cachedPreview = getCachedThumbnailEntry(doc, pageNum);
  if (cachedPreview?.src) {
    const preview = document.createElement('img');
    preview.className = 'page-preview-image';
    preview.alt = '';
    preview.draggable = false;
    preview.src = cachedPreview.src;
    preview.style.position = 'absolute';
    preview.style.inset = '0';
    preview.style.objectFit = 'fill';
    preview.style.pointerEvents = 'none';
    canvasContainer.appendChild(preview);
    incrementPerformanceCounter('cachedPreviewPaints');
    recordLatencySinceInteraction('cachedPreviewLatencyMs', ['continuous-scroll', 'page-jump']);
  } else if (_lowResCache.get(_lowResKey(pageNum))?.canvas) {
    const preview = _lowResCache.get(_lowResKey(pageNum)).canvas;
    preview.classList.add('page-preview-canvas');
    preview.style.position = 'absolute';
    preview.style.inset = '0';
    preview.style.pointerEvents = 'none';
    canvasContainer.appendChild(preview);
    incrementPerformanceCounter('cachedPreviewPaints');
    recordLatencySinceInteraction('cachedPreviewLatencyMs', ['continuous-scroll', 'page-jump']);
  } else {
    incrementPerformanceCounter('uncachedPageMounts');
  }
  return pageWrapper;
}

function _releaseContinuousWrapper(pageNum, wrapper) {
  const ownerDoc = state.documents.find?.((documentState) =>
    documentState.id === _continuousWindow?.documentId) || getActiveDocument();
  try { _continuousObserver?.unobserve?.(wrapper); } catch {}
  _continuousWindow?.intersecting?.delete(pageNum);
  _renderedPages.delete(pageNum);
  releaseTextLayer(pageNum);
  releaseLinkLayer(pageNum);
  releaseFormLayer(pageNum);
  // A low-resolution cache surface may be temporarily mounted as the visual
  // preview. Detach it without clearing its backing store so the next visit
  // reuses the same allocation rather than retaining a duplicate.
  wrapper.querySelector('.page-preview-canvas')?.remove();
  _untrackMountedPageCanvases(ownerDoc, pageNum, wrapper);
  _untrackMountedPageImages(ownerDoc, pageNum, wrapper, { release: true });
  wrapper.querySelectorAll('canvas:not(.page-preview-canvas)').forEach((canvas) => {
    canvas.width = 0;
    canvas.height = 0;
  });
  wrapper.remove();
  if (ownerDoc) {
    const prefix = `${ownerDoc.id}:${Number(ownerDoc.lifecycleGeneration) || 0}:${pageNum}:`;
    for (const key of _renderedSurfaceStates.keys()) {
      if (key.startsWith(prefix)) _renderedSurfaceStates.delete(key);
    }
  }
  _continuousRenderScheduler.cancelWhere(
    (entry) => entry.ownerKey === _continuousWindow?.ownerKey
      && entry.key.includes(`:${pageNum}:`),
    'page-unmounted',
  );
}

function _untrackContinuousContainer(doc, container) {
  if (!doc || !container) return;
  for (const wrapper of container.querySelectorAll('.page-wrapper[data-page]')) {
    const pageNum = Number(wrapper.dataset.page) || 0;
    _untrackMountedPageCanvases(doc, pageNum, wrapper);
    _untrackMountedPageImages(doc, pageNum, wrapper, { release: true });
  }
}

function _continuousWindowMatches(doc) {
  return _continuousWindow
    && _continuousWindow.documentId === doc?.id
    && _continuousWindow.lifecycleGeneration === (Number(doc.lifecycleGeneration) || 0)
    && _continuousWindow.container?.isConnected;
}

function _teardownContinuousWindow(reason = 'continuous-teardown') {
  if (_continuousSettleTimer) clearTimeout(_continuousSettleTimer);
  _continuousSettleTimer = null;
  _continuousRenderScheduler.cancelWhere(() => true, reason);
  const current = _continuousWindow;
  if (current?.mounted) {
    for (const [pageNum, wrapper] of current.mounted) {
      _releaseContinuousWrapper(pageNum, wrapper);
    }
    current.mounted.clear();
  }
  _continuousWindow = null;
  if (_continuousObserver) {
    _continuousObserver.disconnect();
    _continuousObserver = null;
  }
  if (typeof window !== 'undefined') {
    window.__continuousMountedPageCount = 0;
    window.__continuousMountedPages = [];
  }
}

function _updateContinuousVirtualWindow({
  force = false,
  interactionSettled = false,
  scheduleRenders = true,
} = {}) {
  const doc = getActiveDocument();
  const stateForWindow = _continuousWindow;
  if (!doc || !_continuousWindowMatches(doc) || doc.facingSpread) return;
  const { index, container, scrollContainer, mounted, layout } = stateForWindow;
  const contentWidth = index.contentWidth(doc.scale, layout, scrollContainer.clientWidth);
  container.style.width = `${contentWidth}px`;
  container.style.height = `${index.totalHeight(doc.scale, layout)}px`;
  const protectedPage = _activeEditorPageForDocument(doc);
  const wanted = index.visiblePages({
    scrollTop: scrollContainer.scrollTop,
    viewportHeight: scrollContainer.clientHeight,
    scale: doc.scale,
    layout,
    // Memory pressure first shrinks prefetch distance; it never changes the
    // resolution of a page that is actually visible.
    overscanPx: backgroundRenderAdmissionAllowed() ? scrollContainer.clientHeight * 2 : 0,
    maxPages: 9,
    protectedPages: protectedPage ? [protectedPage] : [],
  });
  const wantedSet = new Set(wanted);
  const strictlyVisible = new Set(index.visiblePages({
    scrollTop: scrollContainer.scrollTop,
    viewportHeight: scrollContainer.clientHeight,
    scale: doc.scale,
    layout,
    overscanPx: 0,
    maxPages: 9,
    protectedPages: protectedPage ? [protectedPage] : [],
  }));

  for (const [pageNum, wrapper] of mounted) {
    if (wantedSet.has(pageNum)) continue;
    _releaseContinuousWrapper(pageNum, wrapper);
    mounted.delete(pageNum);
  }
  const centerPage = index.pageAtOffset(
    scrollContainer.scrollTop + scrollContainer.clientHeight / 2,
    { scale: doc.scale, layout },
  ) || doc.currentPage;
  const direction = stateForWindow.direction || 1;
  const renderOrder = [...wanted].sort((left, right) => {
    const leftVisible = strictlyVisible.has(left) || stateForWindow.intersecting?.has(left);
    const rightVisible = strictlyVisible.has(right) || stateForWindow.intersecting?.has(right);
    if (leftVisible !== rightVisible) return leftVisible ? -1 : 1;
    const leftAhead = Math.sign(left - centerPage) === direction;
    const rightAhead = Math.sign(right - centerPage) === direction;
    if (leftAhead !== rightAhead) return leftAhead ? -1 : 1;
    return Math.abs(left - centerPage) - Math.abs(right - centerPage);
  });
  for (const pageNum of renderOrder) {
    const rect = _continuousRectWithOffset(
      index.pageRect(pageNum, { scale: doc.scale, layout, contentWidth }),
      stateForWindow,
    );
    if (!rect) continue;
    let wrapper = mounted.get(pageNum);
    if (!wrapper) {
      wrapper = _createContinuousWrapper(doc, pageNum, rect);
      mounted.set(pageNum, wrapper);
      container.appendChild(wrapper);
      _continuousObserver?.observe?.(wrapper);
    } else {
      _positionContinuousWrapper(wrapper, rect, doc.scale);
    }
    const isVisible = strictlyVisible.has(pageNum) || stateForWindow.intersecting?.has(pageNum);
    if (isVisible && (force || interactionSettled || wrapper.dataset.strictlyVisible !== 'true')) {
      wrapper.dataset.visibleAt = String(performance.now());
    }
    wrapper.dataset.strictlyVisible = String(isVisible);
    if (force) _renderedPages.delete(pageNum);
  }

  if (scheduleRenders) {
    const coldRenderAllowed = force || interactionSettled || isPdfForegroundIdle();
    for (const pageNum of renderOrder) {
      if (!coldRenderAllowed && !_hasReusableContinuousBitmap(doc, pageNum)) continue;
      void renderContinuousPage(
        pageNum,
        1000 - Math.abs(pageNum - centerPage),
        (strictlyVisible.has(pageNum) || stateForWindow.intersecting?.has(pageNum))
          ? 'foreground' : 'background',
      );
    }
  }
  if (typeof window !== 'undefined') {
    window.__continuousMountedPageCount = mounted.size;
    window.__continuousMountedPages = [...mounted.keys()].sort((a, b) => a - b);
  }
  recordPerformancePeak('mountedPageSurfaces', mounted.size);
}

export function getContinuousRenderResourceStats() {
  const mountedPageSurfaces = _continuousWindow?.mounted?.size
    || (typeof document !== 'undefined'
      ? document.querySelectorAll('#continuous-container .page-wrapper').length : 0);
  return Object.freeze({
    mountedPageSurfaces,
    renderedPages: _renderedPages.size,
    scheduled: _continuousRenderScheduler.snapshot(),
    budget: renderResourceBudgetSnapshot(),
  });
}

/**
 * Contract the settled continuous working set to pages that are actually on
 * screen (plus an offscreen active-editor page). Directional readiness is
 * still provided by the thumbnail/preview cache, so the next page appears
 * immediately without retaining several full-DPR canvases while idle.
 */
export function trimIdleContinuousPageSurfaces() {
  const doc = getActiveDocument();
  const stateForWindow = _continuousWindow;
  if (!doc || !_continuousWindowMatches(doc) || doc.facingSpread) {
    return Object.freeze({ releasedBytes: 0, releasedPages: 0, keptPages: [] });
  }
  const { index, scrollContainer, mounted, layout } = stateForWindow;
  const editorPage = _activeEditorPageForDocument(doc);
  const visible = index.visiblePages({
    scrollTop: scrollContainer.scrollTop,
    viewportHeight: scrollContainer.clientHeight,
    scale: doc.scale,
    layout,
    overscanPx: 0,
    maxPages: 9,
    protectedPages: editorPage ? [editorPage] : [],
  });
  const keep = new Set(visible);
  if (!keep.size && Number.isInteger(Number(doc.currentPage))) keep.add(Number(doc.currentPage));
  if (editorPage) keep.add(editorPage);

  let releasedBytes = 0;
  const releasedPageNums = [];
  for (const [pageNum, wrapper] of [...mounted]) {
    if (keep.has(pageNum)) continue;
    releasedBytes += [...wrapper.querySelectorAll('canvas')].reduce(
      (sum, canvas) => sum + (canvas.width || 0) * (canvas.height || 0) * 4,
      0,
    );
    _releaseContinuousWrapper(pageNum, wrapper);
    mounted.delete(pageNum);
    releasedPageNums.push(pageNum);
  }
  if (typeof window !== 'undefined') {
    window.__continuousMountedPageCount = mounted.size;
    window.__continuousMountedPages = [...mounted.keys()].sort((left, right) => left - right);
  }
  if (releasedPageNums.length) {
    incrementPerformanceCounter('idleContinuousSurfaceEvictions', releasedPageNums.length);
    incrementPerformanceCounter('idleContinuousSurfaceEvictedBytes', releasedBytes);
    recordPerformanceEvent('memory:continuous-surface-trim', {
      releasedBytes,
      releasedPages: releasedPageNums.length,
      pageNums: releasedPageNums.join(','),
      keptPages: [...keep].sort((left, right) => left - right).join(','),
    });
  }
  return Object.freeze({
    releasedBytes,
    releasedPages: releasedPageNums.length,
    keptPages: [...keep].sort((left, right) => left - right),
  });
}

function _scrollContinuousPageIntoView(pageNum, behavior = 'auto') {
  const doc = getActiveDocument();
  const container = document.getElementById('pdf-container');
  if (!doc?.pageGeometryIndex || !container || doc.facingSpread) return false;
  const layout = _continuousLayout(doc);
  const contentWidth = doc.pageGeometryIndex.contentWidth(doc.scale, layout, container.clientWidth);
  const rect = _continuousRectWithOffset(
    doc.pageGeometryIndex.pageRect(pageNum, { scale: doc.scale, layout, contentWidth }),
  );
  if (!rect) return false;
  container.scrollTo({ top: rect.y, left: Math.max(0, rect.x - 20), behavior });
  _updateContinuousVirtualWindow({ interactionSettled: true });
  return true;
}

// Re-render only mounted pages at new scale (keeps stable scroll geometry)
export async function reRenderVisibleContinuousPages() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) return;
  const scale = doc.scale;

  // Mark all pages as needing re-render at new scale
  _renderedPages.clear();
  _renderedPagesScale = scale;

  const continuousContainer = document.getElementById('continuous-container');
  if (!continuousContainer) return;
  if (_continuousWindowMatches(doc) && !doc.facingSpread) {
    _updateContinuousVirtualWindow({ force: true });
    return;
  }
  // Facing view owns at most two wrappers and can use their stored base sizes.
  for (const wrapper of continuousContainer.querySelectorAll('.page-wrapper')) {
    const baseW = Number(wrapper.dataset.baseW) || 612;
    const baseH = Number(wrapper.dataset.baseH) || 792;
    _positionContinuousWrapper(wrapper, {
      x: 0, y: 0, width: baseW * scale, height: baseH * scale,
    }, scale);
    void renderContinuousPage(Number(wrapper.dataset.page), 1000);
  }
}

// ─── Continuous mode: zoom + scroll/page sync ───────────────────────────────

// Instant zoom: resize every page's container + its rendered canvases straight
// to the new scale and re-anchor the scroll in the SAME synchronous frame, so
// the page tracks the wheel/button immediately. The crisp Rust re-render is
// debounced (see continuousZoomBy) and swaps in once the gesture settles. The
// old approach awaited a full re-render BEFORE moving the scroll, which made
// the page lurch and lag a notch behind the wheel (schokkerig + vertraging).
function _applyContinuousZoomInstant(oldScale, anchorInput = null) {
  const doc = getActiveDocument();
  const container = document.getElementById('pdf-container');
  const cont = document.getElementById('continuous-container');
  if (!doc || !container || !cont || !oldScale) return;
  const newScale = doc.scale;
  const factor = newScale / oldScale;
  const containerRect = container.getBoundingClientRect();
  const input = typeof anchorInput === 'object' && anchorInput ? anchorInput : {};
  const localX = Number.isFinite(input.clientX)
    ? input.clientX - containerRect.left
    : container.clientWidth / 2;
  const localY = Number.isFinite(input.clientY)
    ? input.clientY - containerRect.top
    : Number.isFinite(anchorInput) ? Number(anchorInput) : container.clientHeight / 2;

  if (_continuousWindowMatches(doc) && doc.pageGeometryIndex && !doc.facingSpread) {
    const index = doc.pageGeometryIndex;
    const layout = _continuousLayout(doc);
    const oldContentWidth = index.contentWidth(oldScale, layout, container.clientWidth);
    let pageNum = Number(input.pageNum) || null;
    if (!pageNum) {
      const pointed = document.elementFromPoint?.(
        Number.isFinite(input.clientX) ? input.clientX : containerRect.left + localX,
        Number.isFinite(input.clientY) ? input.clientY : containerRect.top + localY,
      )?.closest?.('#continuous-container .page-wrapper');
      pageNum = Number(pointed?.dataset?.page) || null;
    }
    pageNum ||= index.pageAtOffset(container.scrollTop + localY, { scale: oldScale, layout });
    if (!Number.isFinite(input.clientX)) _continuousWindow.horizontalOffsetPx = 0;
    const oldRect = _continuousRectWithOffset(
      index.pageRect(pageNum, { scale: oldScale, layout, contentWidth: oldContentWidth }),
    );
    const pdfX = Number.isFinite(input.pdfX)
      ? input.pdfX
      : (container.scrollLeft + localX - (oldRect?.x || 0)) / oldScale;
    const pdfY = Number.isFinite(input.pdfY)
      ? input.pdfY
      : (container.scrollTop + localY - (oldRect?.y || 0)) / oldScale;
    const newContentWidth = index.contentWidth(newScale, layout, container.clientWidth);
    cont.style.width = `${newContentWidth}px`;
    cont.style.height = `${index.totalHeight(newScale, layout)}px`;
    const nextBaseRect = index.pageRect(pageNum, {
      scale: newScale,
      layout,
      contentWidth: newContentWidth,
    });
    const maximumScrollLeft = Math.max(0, newContentWidth - container.clientWidth);
    const horizontalAnchor = resolveContinuousHorizontalAnchor({
      basePageX: nextBaseRect?.x || 0,
      currentPageOffsetX: _continuousWindow.horizontalOffsetPx,
      pdfX,
      scale: newScale,
      localX,
      maximumScrollLeft,
    });
    container.scrollLeft = horizontalAnchor.scrollLeft;
    // If the page still fits horizontally, scrollLeft cannot represent the
    // negative residual required to keep the PDF point under the fingers.
    // Carry that residual in page-layout space so cursor anchoring remains
    // exact without widening the scroll area or introducing blank margins.
    _continuousWindow.horizontalOffsetPx = horizontalAnchor.pageOffsetX
      + (container.scrollLeft - horizontalAnchor.scrollLeft);
    const maximumScrollTop = Math.max(
      0,
      index.totalHeight(newScale, layout) - container.clientHeight,
    );
    const requestedVerticalAnchor = resolveContinuousVerticalAnchor({
      basePageY: nextBaseRect?.y || 0,
      currentPageOffsetY: _continuousWindow.verticalOffsetPx,
      pdfY,
      scale: newScale,
      localY,
      maximumScrollTop,
    });
    container.scrollTop = requestedVerticalAnchor.requestedScrollTop;
    const verticalAnchor = resolveContinuousVerticalAnchor({
      basePageY: nextBaseRect?.y || 0,
      currentPageOffsetY: _continuousWindow.verticalOffsetPx,
      pdfY,
      scale: newScale,
      localY,
      maximumScrollTop,
      appliedScrollTop: container.scrollTop,
    });
    _continuousWindow.verticalOffsetPx = verticalAnchor.pageOffsetY;
    for (const [mountedPage, wrapper] of _continuousWindow.mounted) {
      const rect = _continuousRectWithOffset(
        index.pageRect(mountedPage, { scale: newScale, layout, contentWidth: newContentWidth }),
      );
      if (rect) _positionContinuousWrapper(wrapper, rect, newScale);
    }
    const nextRect = _continuousRectWithOffset(nextBaseRect);
    if (nextRect) {
      const actualX = containerRect.left + nextRect.x + pdfX * newScale - container.scrollLeft;
      const actualY = containerRect.top + nextRect.y + pdfY * newScale - container.scrollTop;
      recordPerformanceSample(
        'zoomAnchorDriftPx',
        Math.hypot(actualX - (containerRect.left + localX), actualY - (containerRect.top + localY)),
      );
    }
    return Object.freeze({
      documentId: doc.id,
      lifecycleGeneration: Number(doc.lifecycleGeneration) || 0,
      pageNum,
      pdfX,
      pdfY,
      clientX: containerRect.left + localX,
      clientY: containerRect.top + localY,
    });
  }

  const targetY = (container.scrollTop + localY) * factor - localY;
  const targetX = (container.scrollLeft + localX) * factor - localX;
  cont.querySelectorAll('.page-wrapper').forEach(wrapper => {
    const cc = wrapper.querySelector('.canvas-container-cont');
    if (!cc) return;
    const baseW = parseFloat(wrapper.dataset.baseW);
    const baseH = parseFloat(wrapper.dataset.baseH);
    // Exact size from scale-1 base (no drift); fall back to scaling the current
    // box if base dims are somehow missing.
    const w = (baseW && baseH) ? baseW * newScale : (parseFloat(cc.style.width) || cc.offsetWidth) * factor;
    const h = (baseW && baseH) ? baseH * newScale : (parseFloat(cc.style.height) || cc.offsetHeight) * factor;
    cc.style.width = `${w}px`;
    cc.style.height = `${h}px`;
    // Stretch the already-rendered bitmap(s) to the new box immediately; the
    // debounced re-render replaces them with a crisp render at the new scale.
    cc.querySelectorAll('canvas').forEach(cv => {
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    });
  });
  container.scrollTop = Math.max(0, targetY);
  container.scrollLeft = Math.max(0, targetX);
}

let _contRerenderTimer = null;
let _legacyBlankRerenderTimer = null;
let _legacyBlankRerenderOwner = null;

function publishLegacyBlankCrispRender() {
  const expected = _legacyBlankRerenderOwner;
  _legacyBlankRerenderOwner = null;
  if (!expected) return false;
  const doc = getActiveDocument();
  if (!doc || doc.id !== expected.documentId
      || (Number(doc.lifecycleGeneration) || 0) !== expected.lifecycleGeneration
      || doc.currentPage !== expected.pageNum
      || doc.filePath !== null) return false;
  incrementPerformanceCounter('crispRenderRevisions');
  void renderPage(expected.pageNum);
  return true;
}

function scheduleLegacyBlankCrispRender(owner) {
  _legacyBlankRerenderOwner = owner;
  if (_legacyBlankRerenderTimer) clearTimeout(_legacyBlankRerenderTimer);
  _legacyBlankRerenderTimer = setTimeout(() => {
    _legacyBlankRerenderTimer = null;
    publishLegacyBlankCrispRender();
  }, 90);
}

export function finishLegacyBlankZoomGesture() {
  if (!_legacyBlankRerenderTimer) return false;
  clearTimeout(_legacyBlankRerenderTimer);
  _legacyBlankRerenderTimer = null;
  return publishLegacyBlankCrispRender();
}

export function cancelDeferredZoomRenders() {
  if (_contRerenderTimer) clearTimeout(_contRerenderTimer);
  if (_legacyBlankRerenderTimer) clearTimeout(_legacyBlankRerenderTimer);
  _contRerenderTimer = null;
  _legacyBlankRerenderTimer = null;
  _legacyBlankRerenderOwner = null;
}

export function finishContinuousZoomGesture() {
  if (!_contRerenderTimer) return false;
  clearTimeout(_contRerenderTimer);
  _contRerenderTimer = null;
  const doc = getActiveDocument();
  if (doc?.viewMode !== 'continuous') return false;
  incrementPerformanceCounter('crispRenderRevisions');
  void reRenderVisibleContinuousPages();
  return true;
}

// Core continuous zoom: multiply scale by `factor`, apply the instant visual
// zoom, then debounce the crisp re-render. Anchored at anchorY (px within
// #pdf-container) so content under the cursor stays put.
export function continuousZoomBy(factor, anchor = null) {
  const doc = getActiveDocument();
  if (!doc || doc.viewMode !== 'continuous' || !factor) return;
  const old = doc.scale;
  let next = Math.min(24, Math.max(0.05, old * factor));
  next = Math.round(next * 1000) / 1000;
  if (next === old) return;
  doc.scale = next;
  bumpDocumentViewportRevision(doc, 'continuous-zoom');
  notePdfForegroundActivity('continuous-zoom');
  _continuousRenderScheduler.noteInteraction(250);
  _applyContinuousZoomInstant(old, anchor);
  updateAllStatus(); // zoom % tracks the gesture immediately
  if (_contRerenderTimer) clearTimeout(_contRerenderTimer);
  const ownerDocumentId = doc.id;
  const ownerLifecycleGeneration = Number(doc.lifecycleGeneration) || 0;
  _contRerenderTimer = setTimeout(() => {
    _contRerenderTimer = null;
    const owner = getActiveDocument();
    if (!owner || owner.id !== ownerDocumentId
        || (Number(owner.lifecycleGeneration) || 0) !== ownerLifecycleGeneration
        || owner.viewMode !== 'continuous') return;
    incrementPerformanceCounter('crispRenderRevisions');
    reRenderVisibleContinuousPages();
  }, 90);
}

export function continuousZoomByForDocument(
  documentId,
  lifecycleGeneration,
  pageNum,
  factor,
  anchor = null,
) {
  const doc = getActiveDocument();
  if (!doc || doc.id !== documentId
      || (Number(doc.lifecycleGeneration) || 0) !== lifecycleGeneration
      || doc.currentPage !== pageNum
      || doc.viewMode !== 'continuous') return false;
  continuousZoomBy(factor, anchor);
  return true;
}

// Absolute variant voor setZoom/fit/actualSize in de doorlopende weergave:
// doc.scale is al op de nieuwe waarde gezet door de aanroeper; pas de
// instant-zoom toe vanaf oldScale en plan dezelfde debounced crisp re-render
// als continuousZoomBy. (Was een dangling verwijzing: de drie aanroepers
// gooiden een ReferenceError zodat absolute zoom/ware grootte in de
// doorlopende weergave helemaal niets deed.)
async function _continuousRezoom(oldScale) {
  const doc = getActiveDocument();
  if (doc) bumpDocumentViewportRevision(doc, 'continuous-zoom');
  _applyContinuousZoomInstant(oldScale);
  updateAllStatus();
  if (_contRerenderTimer) clearTimeout(_contRerenderTimer);
  _contRerenderTimer = setTimeout(() => {
    _contRerenderTimer = null;
    if (getActiveDocument()?.viewMode !== 'continuous') return;
    incrementPerformanceCounter('crispRenderRevisions');
    reRenderVisibleContinuousPages();
  }, 90);
}

// One discrete zoom step (zoom buttons / keyboard) anchored at anchorY.
export function continuousZoomStep(direction, anchorY = null) {
  continuousZoomBy(direction > 0 ? 1.25 : 0.8, anchorY);
}

// While the user scrolls freely, the page whose center sits closest to the
// viewport center becomes doc.currentPage — status bar and thumbnail
// highlight track the scroll just like explicit navigation does.
let _contScrollSyncBound = false;
function _bindContinuousScrollSync() {
  if (_contScrollSyncBound) return;
  const container = document.getElementById('pdf-container');
  if (!container) return;
  _contScrollSyncBound = true;
  let pendingFrame = 0;
  let lastScrollTop = container.scrollTop;
  let lastScrollFrameAt = 0;
  container.addEventListener('scroll', () => {
    const handlerStartedAt = performance.now();
    const doc = getActiveDocument();
    // Facing toont één spread zonder scroll-navigatie; scroll mag currentPage
    // (het spread-anker) niet naar de rechterpagina verschuiven, anders breekt
    // vorige/volgende. Daarom hier overslaan.
    if (!doc || doc.viewMode !== 'continuous' || doc.facingSpread) return;
    const direction = container.scrollTop >= lastScrollTop ? 1 : -1;
    lastScrollTop = container.scrollTop;
    if (_continuousWindow) _continuousWindow.direction = direction;
    notePerformanceInteraction('continuous-scroll', handlerStartedAt);
    notePdfForegroundActivity('continuous-scroll');
    _continuousRenderScheduler.noteInteraction(250);
    if (_continuousSettleTimer) clearTimeout(_continuousSettleTimer);
    _continuousSettleTimer = setTimeout(() => {
      _continuousSettleTimer = null;
      _updateContinuousVirtualWindow({ interactionSettled: true });
      // requestAnimationFrame may be throttled while a packaged window is
      // unfocused or occluded. The scroll position and virtual window still
      // advance through the settle timer, so resolve currentPage here too;
      // otherwise status/navigation can remain pinned to the old page even
      // after the bottom page is visibly mounted and rendered.
      _syncCurrentPageFromScroll(container);
    }, 250);
    recordPerformanceSample('scrollHandlerMs', performance.now() - handlerStartedAt);
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => {
      const frameStartedAt = performance.now();
      if (lastScrollFrameAt) recordPerformanceSample('scrollFrameIntervalMs', frameStartedAt - lastScrollFrameAt);
      lastScrollFrameAt = frameStartedAt;
      pendingFrame = 0;
      _updateContinuousVirtualWindow();
      _syncCurrentPageFromScroll(container);
      const owner = getActiveDocument();
      if (owner?.viewMode === 'continuous') {
        scheduleNearbyLowResPreviews(owner.pdfDoc, owner.currentPage, direction);
      }
      recordPerformanceSample('scrollFrameWorkMs', performance.now() - frameStartedAt);
    });
  }, { passive: true });
}

function _syncCurrentPageFromScroll(container) {
  const doc = getActiveDocument();
  if (!doc || doc.viewMode !== 'continuous' || doc.facingSpread) return;
  const bestPage = doc.pageGeometryIndex?.pageAtOffset(
    container.scrollTop + container.clientHeight / 2,
    { scale: doc.scale, layout: _continuousLayout(doc) },
  ) || null;
  if (typeof window !== 'undefined' && bestPage) window.__continuousCurrentPage = bestPage;
  if (bestPage && doc.currentPage !== bestPage) {
    const direction = bestPage > doc.currentPage ? 1 : -1;
    doc.currentPage = bestPage;
    updateActiveThumbnail();
    updateAllStatus();
    scheduleBackgroundMetadata(bestPage, direction);
    scheduleNearbyLowResPreviews(doc.pdfDoc, bestPage, direction);
  }
}

// Render all pages (continuous mode) — creates placeholders, lazily renders visible pages
export async function renderContinuous(forceRebuild = false, {
  synchronization = false,
  requiredPages: requestedRequiredPages = [],
} = {}) {
  clearHighlights();
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  if (typeof window !== 'undefined') window.__continuousCurrentPage = doc.currentPage;
  const pdfDoc = doc.pdfDoc;
  const scale = doc.scale;
  const generation = Number(doc.lifecycleGeneration) || 0;
  const continuousContainer = document.getElementById('continuous-container');
  const scrollContainer = document.getElementById('pdf-container');
  if (!continuousContainer || !scrollContainer) return;
  const requiredPages = [];

  try {
    const viewportModule = await import('./pdf-viewport.js');
    viewportModule.ensureDprWatcher();
    viewportModule.suspendViewportBackingStores('continuous-view');
  } catch (error) {
    console.warn('[render-continuous] Failed to suspend hidden viewport surfaces:', error);
    if (window.__pdfViewport) window.__pdfViewport.active = false;
  }
  if (getActiveDocument() !== doc || (Number(doc.lifecycleGeneration) || 0) !== generation) return;

  // A scroll/page update can reuse the virtual shell. Rebuild only when its
  // owner, layout, or lifecycle changed.
  if (!forceRebuild && !doc.facingSpread && _continuousWindowMatches(doc)
      && _continuousWindow.layout === _continuousLayout(doc)
      && _continuousWindow.index === doc.pageGeometryIndex) {
    _updateContinuousVirtualWindow();
    return;
  }

  if (_continuousObserver) {
    _continuousObserver.disconnect();
    _continuousObserver = null;
  }
  _teardownContinuousWindow('continuous-rebuild');
  _untrackContinuousContainer(doc, continuousContainer);
  continuousContainer.querySelectorAll('canvas').forEach((canvas) => {
    canvas.width = 0;
    canvas.height = 0;
  });
  continuousContainer.innerHTML = '';
  clearTextLayers();
  clearLinkLayers();
  clearFormLayers();
  _renderedPages.clear();
  _renderedPagesScale = scale;
  _continuousWindow = null;

  continuousContainer.classList.toggle('book-spread', !!doc.bookSpread);
  continuousContainer.classList.toggle('facing-spread', !!doc.facingSpread);
  continuousContainer.classList.toggle('virtualized', !doc.facingSpread);

  if (doc.facingSpread) {
    continuousContainer.style.display = 'grid';
    continuousContainer.style.width = '';
    continuousContainer.style.height = '';
    for (const pageNum of _spreadPagesFor(_spreadAnchor(doc.currentPage), pdfDoc.numPages)) {
      const page = await pdfDoc.getPage(pageNum);
      if (getActiveDocument() !== doc || (Number(doc.lifecycleGeneration) || 0) !== generation) return;
      const extraRotation = getPageRotation(pageNum);
      const viewport = page.getViewport({
        scale,
        rotation: (page.rotate + extraRotation) % 360,
      });
      const wrapper = _createContinuousWrapper(doc, pageNum, {
        x: 0, y: 0, width: viewport.width, height: viewport.height,
      });
      wrapper.style.position = 'relative';
      wrapper.style.left = '';
      wrapper.style.top = '';
      const rightSide = pageNum === 1 || pageNum % 2 === 1;
      wrapper.style.gridColumn = rightSide ? '2' : '1';
      wrapper.style.justifySelf = rightSide ? 'start' : 'end';
      continuousContainer.appendChild(wrapper);
      requiredPages.push(pageNum);
    }
  } else {
    const index = await ensureDocumentPageGeometryIndex(doc);
    if (!index || getActiveDocument() !== doc || (Number(doc.lifecycleGeneration) || 0) !== generation) return;
    continuousContainer.style.display = 'block';
    continuousContainer.style.position = 'relative';
    _continuousWindow = {
      documentId: doc.id,
      lifecycleGeneration: generation,
      ownerKey: _continuousOwnerKey(doc),
      index,
      layout: _continuousLayout(doc),
      container: continuousContainer,
      scrollContainer,
      mounted: new Map(),
      intersecting: new Set(),
      horizontalOffsetPx: 0,
      verticalOffsetPx: 0,
      synchronizing: synchronization,
    };
    if (typeof IntersectionObserver === 'function') {
      const ownerKey = _continuousWindow.ownerKey;
      _continuousObserver = new IntersectionObserver((entries) => {
        const current = _continuousWindow;
        if (!current || current.ownerKey !== ownerKey) return;
        for (const entry of entries) {
          const pageNum = Number(entry.target?.dataset?.page) || 0;
          if (!pageNum) continue;
          if (entry.isIntersecting) {
            current.intersecting.add(pageNum);
            if (entry.target.dataset.strictlyVisible !== 'true') {
              entry.target.dataset.visibleAt = String(performance.now());
            }
            entry.target.dataset.strictlyVisible = 'true';
            if (!current.synchronizing
                && (isPdfForegroundIdle() || _hasReusableContinuousBitmap(doc, pageNum))) {
              void renderContinuousPage(pageNum, 2_000, 'foreground');
            }
          } else {
            current.intersecting.delete(pageNum);
            entry.target.dataset.strictlyVisible = 'false';
          }
        }
      }, { root: scrollContainer, threshold: 0.01 });
    }
    _updateContinuousVirtualWindow({
      interactionSettled: true,
      scheduleRenders: !synchronization,
    });
    if (!synchronization) {
      requestAnimationFrame(() => _updateContinuousVirtualWindow({ interactionSettled: true }));
    }
    const visiblePages = index.visiblePages({
      scrollTop: scrollContainer.scrollTop,
      viewportHeight: scrollContainer.clientHeight,
      scale: doc.scale,
      layout: _continuousLayout(doc),
      overscanPx: 0,
      maxPages: 9,
    });
    requiredPages.push(...(synchronization ? visiblePages : [doc.currentPage]));
  }

  requiredPages.push(...requestedRequiredPages);
  const normalizedRequiredPages = [...new Set(requiredPages.map(Number)
    .filter((pageNum) => Number.isInteger(pageNum)
      && pageNum > 0
      && pageNum <= pdfDoc.numPages))];
  const barrier = await awaitRequiredPageRenders(normalizedRequiredPages, (pageNum) => (
    renderContinuousPage(pageNum, 2_000, 'foreground')
  ));
  if (getActiveDocument() !== doc) {
    return {
      requiredPages: [],
      renderReadyPages: [],
      semanticReadyPages: [],
      ready: true,
      inactive: true,
    };
  }
  if (_continuousWindowMatches(doc)) {
    _continuousWindow.synchronizing = false;
    requestAnimationFrame(() => _updateContinuousVirtualWindow({ interactionSettled: true }));
  }

  updateAllStatus();
  _bindContinuousScrollSync();
  if (pdfDoc.numPages > 1 && !doc.facingSpread) {
    scheduleNearbyLowResPreviews(pdfDoc, doc.currentPage, 1);
  }
  return {
    requiredPages: barrier.requiredPages,
    renderReadyPages: barrier.completedPages,
    semanticReadyPages: barrier.completedPages,
    ready: barrier.ready,
  };
}

// Setup pointer events for continuous mode pages
function setupContinuousPageEvents(canvas, pageNum) {
  // Store pageNum in dataset for the dispatcher's resolvePointerCoords
  canvas.dataset.page = pageNum;
  // Import event handlers dynamically to avoid circular dependencies
  import('../tools/tool-dispatcher.js').then(({ handlePointerDown, handlePointerMove, handlePointerUp, handleDblClick }) => {
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('dblclick', handleDblClick);
  });
}

// ─── Spread-pariteit (facing/boek) ──────────────────────────────────────────
// Book-conventie: pagina 1 staat alleen (rechts), daarna de paren 2-3, 4-5, …
// De "anker"-pagina van een spread is de LINKERpagina van het paar (even), of
// pagina 1 voor de eerste spread. doc.currentPage bewaart in facing-modus altijd
// dit anker, zodat vorige/volgende deterministisch per spread springen.
function _spreadAnchor(p) {
  if (p <= 1) return 1;
  return (p % 2 === 0) ? p : p - 1; // even = linkerpagina; oneven = rechter → anker links
}
function _spreadPagesFor(anchor, numPages) {
  if (anchor <= 1) return [1];
  const pages = [anchor];
  if (anchor + 1 <= numPages) pages.push(anchor + 1);
  return pages;
}
function _nextSpreadAnchor(anchor, numPages) {
  if (anchor <= 1) return numPages >= 2 ? 2 : 1;
  return anchor + 2 <= numPages ? anchor + 2 : anchor;
}
function _prevSpreadAnchor(anchor) {
  return anchor <= 2 ? 1 : anchor - 2;
}

// Switch view mode
export async function setViewMode(mode) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  const liveViewport = window.__pdfViewport;
  if (doc.viewMode === 'single' && liveViewport?.active && doc.filePath
      && Number.isFinite(Number(liveViewport.zoom)) && Number(liveViewport.zoom) > 0) {
    // The vector viewport updates its zoom synchronously but publishes the
    // mirrored document scale on the next animation frame. A view-mode switch
    // can happen before that frame, so carry the authoritative zoom into the
    // continuous layout before tearing the viewport down.
    doc.scale = Number(liveViewport.zoom);
  }
  cancelPendingDocumentZoom();
  cancelDeferredZoomRenders();

  // 'book' (boekweergave, issue #201) is a LAYOUT VARIANT of continuous:
  // spreads of two pages side by side with page 1 alone on the right, like
  // a real book. Internally doc.viewMode stays 'continuous' so every
  // existing `viewMode === 'continuous'` branch (redraw dispatch, hit
  // testing, search, clipboard, tools, zoom) keeps working unchanged;
  // the doc.bookSpread flag drives the grid layout in renderContinuous().
  //
  // 'facing' (issue #164, 4e modus) toont ÉÉN spread van twee pagina's naast
  // elkaar tegelijk, NIET-doorlopend: vorige/volgende bladert per spread. Ook
  // dit is intern doc.viewMode='continuous' (zelfde per-pagina-canvas/tekstlaag/
  // tool/hit-test-infrastructuur), maar met doc.facingSpread=true i.p.v.
  // bookSpread — zo licht de doorlopend/boek-knop niet op en bouwt
  // renderContinuous alleen de huidige spread i.p.v. alle pagina's.
  if (mode === 'book') {
    doc.viewMode = 'continuous';
    doc.bookSpread = true;
    doc.facingSpread = false;
  } else if (mode === 'facing') {
    doc.viewMode = 'continuous';
    doc.bookSpread = false;
    doc.facingSpread = true;
    // Normaliseer naar het spread-anker zodat navigatie consistent per spread
    // springt (currentPage = linkerpagina van het huidige paar, of 1).
    doc.currentPage = _spreadAnchor(doc.currentPage);
  } else {
    doc.viewMode = mode;
    doc.facingSpread = false;
    if (mode === 'continuous') doc.bookSpread = false;
  }
  bumpDocumentViewportRevision(doc, 'view-mode');
  const singleContainer = document.getElementById('canvas-container');
  const continuousContainer = document.getElementById('continuous-container');
  const pdfContainer = document.getElementById('pdf-container');

  if (doc.viewMode === 'single') {
    _teardownContinuousWindow('single-page-view');
    _untrackContinuousContainer(doc, continuousContainer);
    continuousContainer.querySelectorAll('canvas').forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
    });
    continuousContainer.innerHTML = '';
    singleContainer.style.display = 'inline-block';
    continuousContainer.style.display = 'none';
    await renderPage(doc.currentPage);
  } else {
    singleContainer.style.display = 'none';
    continuousContainer.style.display = (doc.bookSpread || doc.facingSpread) ? 'grid' : 'flex';
    // CRUCIAAL: single-/rasterweergave zet #pdf-container inline op
    // `overflow:hidden` (het viewport-singleton bezit dan de pan/zoom).
    // Doorlopende/boekweergave scrollt juist NATIEF via deze container
    // (scrollTop/scrollIntoView/_continuousRezoom). Zonder deze reset blijft
    // de inline `hidden` staan na één single-render en kan de gebruiker niet
    // meer scrollen — alleen de eerste pagina('s) zijn zichtbaar. Terug naar
    // '' laat de CSS-regel (.main-view > #pdf-container.visible { overflow:auto })
    // het weer overnemen.
    if (pdfContainer) pdfContainer.style.overflow = '';
    await renderContinuous();
    // Stay on the page the user was reading without requiring its wrapper to
    // have been mounted before the jump.
    _scrollContinuousPageIntoView(doc.currentPage);
  }
  scheduleBackgroundMetadata(doc.currentPage, 1);
}

// ─── Adjacent-page prefetch (idle-gated) ────────────────────────────────────
// The original prefetchAdjacentPages was removed (see the renderPage() note)
// because it ran unconditionally and starved visible-thumbnail generation —
// Rust backend contention that froze the app on large files. This version only
// fires after a navigation settles AND the pipeline is genuinely idle, and it
// aborts the instant the user navigates again. It primes the NEXT page's vector
// draw-commands into the same cache renderPage() reads (vr.hasCachedCommands),
// so sequential paging becomes a cache hit instead of a cold Rust extract.
let _prefetchTimer = null;
const PREFETCH_DELAY_MS = 600;       // settle window after a navigation
const PREFETCH_RETRY_MS = 400;       // re-poll cadence while waiting for idle
const PREFETCH_MAX_WAIT_MS = 4000;   // give up after this — never busy-loop

export function schedulePrefetch(centerPage) {
  if (_prefetchTimer) clearTimeout(_prefetchTimer);
  const doc = getActiveDocument();
  if (shouldPreloadEntireDocument(doc, state.preferences)) {
    void import('./whole-pdf-preload.js').then(({ startWholePdfPreload }) => startWholePdfPreload());
    return;
  }
  if (!shouldPreloadNearby(state.preferences)) return;
  _prefetchTimer = setTimeout(() => { _prefetchTimer = null; _runPrefetch(centerPage, 0); }, PREFETCH_DELAY_MS);
  void scheduleEditableMetadataPreload(centerPage, 1, { editTextActive: state.currentTool === 'editText' });
}

// The active doc IFF the user is still parked on `centerPage` (else navigation
// moved on and this prefetch is stale).
function _prefetchDocIfStill(centerPage) {
  const doc = getActiveDocument();
  return doc && doc.pdfDoc && doc.currentPage === centerPage ? doc : null;
}

async function _runPrefetch(centerPage, waited) {
  const doc = _prefetchDocIfStill(centerPage);
  if (!doc) return; // user navigated — the new nav scheduled its own prefetch
  // Don't compete with a foreground render or with visible-thumbnail work.
  // Re-poll for a bounded window (timer-based, never a busy loop), then give up.
  if ((window.__pdfRenderInFlight || 0) > 0 || !isThumbnailPipelineIdle()) {
    if (waited >= PREFETCH_MAX_WAIT_MS) return;
    _prefetchTimer = setTimeout(
      () => { _prefetchTimer = null; _runPrefetch(centerPage, waited + PREFETCH_RETRY_MS); },
      PREFETCH_RETRY_MS,
    );
    return;
  }
  // Forward first (normal reading direction), then backward.
  const targets = [];
  if (centerPage + 1 <= doc.pdfDoc.numPages) targets.push(centerPage + 1);
  if (centerPage - 1 >= 1) targets.push(centerPage - 1);
  for (const pn of targets) {
    if (!_prefetchDocIfStill(centerPage)) return; // user moved — stop starting new IPC
    if (!isThumbnailPipelineIdle()) return;       // visible thumbnails resumed — yield
    try { await _prefetchOnePage(doc, pn, centerPage); }
    catch { /* best-effort: a failed prefetch just means the next nav renders cold */ }
  }
}

// Cache-only mirror of renderPage()'s cold vector path: analyze → extract →
// prepareImages. Never touches #pdf-canvas or the viewport singleton.
async function _prefetchOnePage(doc, pageNum, centerPage) {
  if (!isTauri() || !doc.filePath) return;
  if (state.renderEngineOverride != null) return; // user forced a raster engine
  const publicationToken = captureRenderPublicationToken(doc, pageNum, 'adjacent-vector-preload');
  const isCurrent = () => _prefetchDocIfStill(centerPage) === doc
    && renderPublicationTokenIsCurrent(publicationToken, doc);
  const rotation = getPageRotation(pageNum);
  const vr = await import('./vector-renderer.js');
  if (!isCurrent()) return;
  if (vr.hasCachedCommands(doc.filePath, pageNum, rotation)) return; // already primed
  const ptcMod = await import('./page-type-cache.js');
  let pageType = ptcMod.getCachedPageType(doc.filePath, pageNum - 1);
  if (!pageType) {
    pageType = await invoke('analyze_page_type', {
      path: doc.filePath,
      pageIndex: pageNum - 1,
      requestId: publicationToken.requestId,
    });
    if (!isCurrent()) return;
    ptcMod.cachePageType(doc.filePath, pageNum - 1, pageType, publicationToken);
  }
  if (pageType !== 'vector') return; // raster pages aren't command-cached
  if (!isCurrent()) return;
  const cmdData = await invoke('extract_draw_commands', {
    path: doc.filePath,
    pageIndex: pageNum - 1,
    rotation,
    requestId: publicationToken.requestId,
  });
  if (!isCurrent()) return;
  const cmdBytes = cmdData instanceof Uint8Array ? cmdData : new Uint8Array(cmdData);
  const publication = { token: publicationToken, documentState: doc };
  vr.cacheCommands(doc.filePath, pageNum, cmdBytes, rotation, publication);
  if (!isCurrent()) return;
  await vr.prepareImages(doc.filePath, pageNum, rotation, publication);
  if (!isCurrent()) return;
  console.log(`[prefetch] primed page ${pageNum}`);
}

// Go to specific page
export async function goToPage(pageNum) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  notePerformanceInteraction('page-jump');
  cancelPendingDocumentZoom();
  cancelDeferredZoomRenders();

  if (pageNum < 1) pageNum = 1;
  if (pageNum > doc.pdfDoc.numPages) pageNum = doc.pdfDoc.numPages;

  // Facing-modus (issue #164): niet-doorlopend, navigeert per SPREAD van twee
  // pagina's. Alle bestaande navigatie (statusbalk, ribbon, toetsen, thumbnails,
  // links) loopt via goToPage(currentPage ± 1) / goToPage(n); hier vertalen we
  // die naar spread-stappen zodat élke aanroeper vanzelf per spread bladert.
  if (doc.facingSpread) {
    const numPages = doc.pdfDoc.numPages;
    const curAnchor = _spreadAnchor(doc.currentPage);
    let targetAnchor = _spreadAnchor(pageNum);
    // Een vorige/volgende-knop levert currentPage ± 1: dat landt op de zíjpagina
    // van de huidige spread (zelfde anker). Dat interpreteren we als "spring een
    // hele spread in die richting".
    if (targetAnchor === curAnchor && pageNum !== curAnchor) {
      targetAnchor = pageNum > curAnchor
        ? _nextSpreadAnchor(curAnchor, numPages)
        : _prevSpreadAnchor(curAnchor);
    }
    doc.currentPage = targetAnchor;
    bumpDocumentViewportRevision(doc, 'page');
    hideProperties();
    await renderContinuous();
    updateActiveThumbnail();
    updateAllStatus();
    return;
  }

  const direction = pageNum >= doc.currentPage ? 1 : -1;
  if (doc) doc.currentPage = pageNum;
  bumpDocumentViewportRevision(doc, 'page');
  hideProperties();

  if (doc?.viewMode === 'single') {
    // Instant feedback: blit the page's cached thumbnail as a placeholder over
    // the canvas so the switch feels immediate even while the (possibly cold)
    // render runs. Hidden one frame after renderPage() resolves, so the crisp
    // page has painted underneath. No-op if the thumbnail isn't cached yet.
    const _phGen = showPagePlaceholder(pageNum);
    try {
      await renderPage(pageNum);
    } finally {
      // Keep the placeholder up until the real page content has painted (raster
      // bitmaps fill asynchronously after renderPage resolves) — avoids a blank
      // flash between hiding the thumbnail and the bitmap landing.
      hidePagePlaceholderWhenReady(_phGen);
    }
    const pdfContainer = document.getElementById('pdf-container');
    if (pdfContainer) {
      pdfContainer.scrollTop = 0;
    }
    // Prime the neighbouring pages while the backend is idle so the next
    // sequential nav is a cache hit (skips the cold Rust extract).
    schedulePrefetch(pageNum);
  } else {
    _scrollContinuousPageIntoView(pageNum, 'smooth');
  }
  scheduleBackgroundMetadata(pageNum, direction);
  if (doc.viewMode === 'continuous') scheduleNearbyLowResPreviews(doc.pdfDoc, pageNum, direction);

  // Update active thumbnail in left panel
  updateActiveThumbnail();
}

// Zoom controls.
//
// In vector viewport mode (the modern path) the truth is `viewport.zoom`,
// not `doc.scale` — `_render()` overwrites `doc.scale = viewport.zoom`
// every frame, so any function that mutates `doc.scale` and then re-renders
// via the legacy PDF.js path will have its change immediately stomped.
// We must therefore mutate the viewport directly when it's active, and
// only fall back to the legacy `doc.scale` path otherwise.
export async function legacyZoomByAtPointForDocument(
  documentId,
  lifecycleGeneration,
  pageNum,
  factor,
  clientPoint = null,
) {
  const doc = getActiveDocument();
  if (!doc || doc.id !== documentId
      || (Number(doc.lifecycleGeneration) || 0) !== lifecycleGeneration
      || doc.currentPage !== pageNum
      || doc.viewMode !== 'single'
      || doc.filePath !== null
      || !Number.isFinite(factor)
      || factor <= 0) return false;

  const oldScale = Number(doc.scale) || 1;
  const nextScale = Math.round(Math.min(24, Math.max(0.05, oldScale * factor)) * 1000) / 1000;
  if (nextScale === oldScale) return false;

  const container = document.getElementById('pdf-container');
  const canvas = getPdfCanvas();
  const beforeRect = canvas?.getBoundingClientRect?.() || null;
  const point = clientPoint && Number.isFinite(clientPoint.x) && Number.isFinite(clientPoint.y)
    ? clientPoint
    : beforeRect
      ? { x: beforeRect.left + beforeRect.width / 2, y: beforeRect.top + beforeRect.height / 2 }
      : null;
  const pageFraction = beforeRect && point && beforeRect.width > 0 && beforeRect.height > 0 ? {
    x: (point.x - beforeRect.left) / beforeRect.width,
    y: (point.y - beforeRect.top) / beforeRect.height,
  } : null;

  doc.scale = nextScale;
  bumpDocumentViewportRevision(doc, 'blank-document-zoom');
  // Keep the current bitmap/layers and resize only their CSS boxes during the
  // gesture. The backing stores and canonical annotation geometry remain
  // untouched until one debounced crisp render after fingers lift.
  _foregroundRenderGen += 1;
  if (canvas && beforeRect) {
    const baseWidth = beforeRect.width / oldScale;
    const baseHeight = beforeRect.height / oldScale;
    const nextWidth = baseWidth * nextScale;
    const nextHeight = baseHeight * nextScale;
    const canvasContainer = document.getElementById('canvas-container');
    canvasContainer?.style.setProperty('--scale-factor', nextScale);
    canvasContainer?.style.setProperty('--total-scale-factor', nextScale);
    canvasContainer?.querySelectorAll('canvas').forEach((surface) => {
      surface.style.width = `${nextWidth}px`;
      surface.style.height = `${nextHeight}px`;
    });
    if (container && point && pageFraction) {
      const afterRect = canvas.getBoundingClientRect();
      container.scrollLeft += afterRect.left + pageFraction.x * afterRect.width - point.x;
      container.scrollTop += afterRect.top + pageFraction.y * afterRect.height - point.y;
      const finalRect = canvas.getBoundingClientRect();
      recordPerformanceSample('zoomAnchorDriftPx', Math.hypot(
        finalRect.left + pageFraction.x * finalRect.width - point.x,
        finalRect.top + pageFraction.y * finalRect.height - point.y,
      ));
    }
  }
  scheduleLegacyBlankCrispRender({ documentId, lifecycleGeneration, pageNum });
  updateAllStatus();
  return true;
}

export async function zoomIn() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc) return;
  const vp = window.__pdfViewport;
  // Only delegate to vector viewport if the ACTIVE doc actually uses it.
  // Blank docs (filePath===null) are rendered via PDF.js / legacy path
  // — vp.active may still be true from a previously-opened PDF, but
  // zoomStepAtCenter would mutate that stale page's zoom, not the blank
  // doc's doc.scale → button appears dead from the user's perspective.
  if (vp && vp.active && doc.filePath) {
    const m = await import('./pdf-viewport.js');
    m.zoomStepAtCenter(+1);
    doc.scale = Number(vp.zoom) || doc.scale;
    return;
  }
  if (doc.viewMode === 'continuous') {
    await continuousZoomStep(+1);
    return;
  }
  doc.scale += 0.25;
  await renderPage(doc.currentPage);
}

export async function zoomOut() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc) return;
  const vp = window.__pdfViewport;
  // Same blank-doc guard as zoomIn() — see comment there.
  if (vp && vp.active && doc.filePath) {
    const m = await import('./pdf-viewport.js');
    m.zoomStepAtCenter(-1);
    doc.scale = Number(vp.zoom) || doc.scale;
    return;
  }
  if (doc.viewMode === 'continuous') {
    await continuousZoomStep(-1);
    return;
  }
  // Allow zooming out to 0.05 (5 %) for huge blank pages — A0 (2384×3370 pt)
  // at 0.05 = 119×169 px which fits any reasonable viewport with margin.
  // Floor of 0.1 was visible to the user as "kan niet zo ver uitzoomen om
  // het hele tekeningkader te zien" on A2/A1/A0 blank docs that bypass
  // the vector viewport (filePath===null skips the viewport singleton).
  if (doc.scale > 0.05) {
    if (doc.scale <= 0.2) doc.scale = Math.max(0.05, doc.scale - 0.025);
    else if (doc.scale <= 0.5) doc.scale = Math.max(0.05, doc.scale - 0.1);
    else doc.scale -= 0.25;
    await renderPage(doc.currentPage);
  }
}

export async function setZoom(newScale) {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc) return;
  const vp = window.__pdfViewport;
  // Same blank-doc guard as zoomIn() — see comment there.
  if (vp && vp.active && doc.filePath) {
    // Set absolute zoom anchored at the canvas center (CSS pixels — the
    // backing store is dpr-scaled and would mis-centre on 125%/150%).
    const pdfCanvas = document.getElementById('pdf-canvas');
    if (pdfCanvas) {
      const m = await import('./pdf-viewport.js');
      const dpr = window.devicePixelRatio || 1;
      m.setZoomAtPoint(pdfCanvas.width / dpr / 2, pdfCanvas.height / dpr / 2, newScale);
      doc.scale = Number(vp.zoom) || newScale;
    }
    return;
  }
  if (doc.viewMode === 'continuous') {
    const _old = doc.scale;
    doc.scale = newScale;
    await _continuousRezoom(_old);
    return;
  }
  doc.scale = newScale;
  await renderPage(doc.currentPage);
}

// Helper: pick the right (pageW, pageH, canvasW, canvasH) tuple for the
// current rendering mode and return them. Vector viewport reads from the
// singleton; legacy mode reads PDF.js viewport + #pdf-container.
//
// Returns null if the rendering mode can't compute fit yet (no viewport or
// no page loaded).
async function _getFitInputs() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc || !doc.pdfDoc) return null;

  const vp = window.__pdfViewport;
  // Same blank-doc guard as zoomIn() — see comment there.
  if (vp && vp.active && doc.filePath) {
    const pdfCanvas = document.getElementById('pdf-canvas');
    if (!pdfCanvas) return null;
    // CSS pixels, NOT the dpr-scaled backing store: viewport zoom/offset are
    // CSS-based, so fitting against canvas.width/height makes every fit dpr×
    // too large (page sticks out of view on 125%/150% Windows scaling —
    // most visible on tall A1/A0 sheets).
    const dpr = window.devicePixelRatio || 1;
    return {
      mode: 'vector',
      pageW: vp.pageW,
      pageH: vp.pageH,
      canvasW: pdfCanvas.width / dpr,
      canvasH: pdfCanvas.height / dpr,
      pdfCanvas,
    };
  }

  // Legacy mode — read dimensions from PDF.js viewport + container.
  const page = await doc.pdfDoc.getPage(doc.currentPage);
  const extraRot = getPageRotation(doc.currentPage);
  const opts = { scale: 1 };
  if (extraRot) opts.rotation = (page.rotate + extraRot) % 360;
  const pageViewport = page.getViewport(opts);
  const container = document.getElementById('pdf-container');
  if (!container) return null;
  return {
    mode: 'legacy',
    pageW: pageViewport.width,
    pageH: pageViewport.height,
    canvasW: container.clientWidth,
    canvasH: container.clientHeight,
    doc,
  };
}

// Apply a computed zoom value, dispatching to the right renderer for the
// active mode. Centralized so fitWidth/fitPage/setZoom all share the same
// "now actually use this zoom value" code path.
async function _applyZoom(fitInputs, newZoom) {
  if (fitInputs.mode === 'vector') {
    const m = await import('./pdf-viewport.js');
    m.setZoomAtPoint(fitInputs.canvasW / 2, fitInputs.canvasH / 2, newZoom);
    return;
  }
  // Legacy
  const doc = fitInputs.doc;
  if (doc.viewMode === 'continuous') {
    const _old = doc.scale;
    doc.scale = newZoom;
    await _continuousRezoom(_old);
    return;
  }
  doc.scale = newZoom;
  await renderPage(doc.currentPage);
}

export async function fitWidth() {
  const fit = await _getFitInputs();
  if (!fit) return;
  const m = await import('./pdf-viewport.js');
  if (fit.mode === 'vector') {
    // Zelfde centreringscontract als fitPage(): de oude route zette alleen de
    // zoom en behield de pan-offset, waardoor de pagina na navigatie tussen
    // afwijkende formaten deels buiten beeld bleef staan.
    m.fitToViewport('width');
    return;
  }
  const newZoom = m.computeFitZoom('width', fit.pageW, fit.pageH, fit.canvasW, fit.canvasH, 0);
  await _applyZoom(fit, newZoom);
}

export async function fitPage() {
  const fit = await _getFitInputs();
  if (!fit) return;
  const m = await import('./pdf-viewport.js');
  if (fit.mode === 'vector') {
    // Canonieke fit + centrering. De vorige route (setZoomAtPoint verankerd op
    // het canvas-midden) zette wel de juiste zoom maar behield de bestaande
    // pan-offset. Na paginanavigatie binnen een document met afwijkende
    // paginaformaten (A4 -> A0) stond de pagina daardoor deels of geheel
    // buiten beeld — terwijl clampAndCenter() bewust een no-op is met als
    // contract: "de gebruiker her-centreert met Fit Page". fitToViewport()
    // centreert expliciet en gebruikt bovendien de post-rotatie-afmetingen.
    m.fitToViewport();
    return;
  }
  const newZoom = m.computeFitZoom('page', fit.pageW, fit.pageH, fit.canvasW, fit.canvasH, 0);
  await _applyZoom(fit, newZoom);
}

export async function actualSize() {
  const doc = state.documents[state.activeDocumentIndex];
  if (!doc) return;

  // Vector viewport mode: 100% = 1.0 zoom, anchored at canvas center.
  // This makes 1 PDF point = 1 CSS pixel, the standard "Actual Size"
  // interpretation.
  const vp = window.__pdfViewport;
  // Same blank-doc guard as zoomIn() — see comment there.
  if (vp && vp.active && doc.filePath) {
    const pdfCanvas = document.getElementById('pdf-canvas');
    if (!pdfCanvas) return;
    const m = await import('./pdf-viewport.js');
    // Anchor in CSS pixels (same unit as zoomStepAtCenter) — the backing
    // store is dpr-scaled and would mis-centre on 125%/150% displays.
    const dpr = window.devicePixelRatio || 1;
    m.setZoomAtPoint(pdfCanvas.width / dpr / 2, pdfCanvas.height / dpr / 2, 1.0);
    return;
  }

  if (doc.viewMode === 'continuous' && doc.pdfDoc) {
    const _old = doc.scale;
    doc.scale = 1;
    await _continuousRezoom(_old);
    return;
  }
  doc.scale = 1;
  if (doc.pdfDoc) {
    await renderPage(doc.currentPage);
  }
}

// Rotate the current page by a delta (±90)
// ─── Annotation coordinate transforms for page rotation ─────────────────────

function rotatePoint(px, py, normDelta, oldW, oldH) {
  switch (normDelta) {
    case 90:  return { x: oldH - py, y: px };
    case 270: return { x: py, y: oldW - px };
    case 180: return { x: oldW - px, y: oldH - py };
    default:  return { x: px, y: py };
  }
}

function rotateRect(x, y, w, h, normDelta, oldW, oldH) {
  switch (normDelta) {
    case 90:  return { x: oldH - y - h, y: x, width: h, height: w };
    case 270: return { x: y, y: oldW - x - w, width: h, height: w };
    case 180: return { x: oldW - x - w, y: oldH - y - h, width: w, height: h };
    default:  return { x, y, width: w, height: h };
  }
}

function recalcBoundsFromPoints(ann, pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  ann.x = minX; ann.y = minY;
  ann.width = maxX - minX; ann.height = maxY - minY;
}

function rotateAnnotation(ann, normDelta, oldW, oldH) {
  if (normDelta === 0) return;
  let boundsHandled = false;

  // Path-based (draw/freehand)
  if (ann.path && ann.path.length > 0) {
    ann.path = ann.path.map(p => rotatePoint(p.x, p.y, normDelta, oldW, oldH));
    recalcBoundsFromPoints(ann, ann.path);
    boundsHandled = true;
  }

  // Points-based (polygon, polyline, cloud, measureArea, measurePerimeter)
  if (ann.points && ann.points.length > 0) {
    ann.points = ann.points.map(p => rotatePoint(p.x, p.y, normDelta, oldW, oldH));
    recalcBoundsFromPoints(ann, ann.points);
    boundsHandled = true;
  }

  // Line endpoints (line, arrow, measureDistance)
  if (ann.startX != null && ann.startY != null && ann.endX != null && ann.endY != null) {
    const s = rotatePoint(ann.startX, ann.startY, normDelta, oldW, oldH);
    const e = rotatePoint(ann.endX, ann.endY, normDelta, oldW, oldH);
    ann.startX = s.x; ann.startY = s.y;
    ann.endX = e.x; ann.endY = e.y;
    ann.x = Math.min(s.x, e.x); ann.y = Math.min(s.y, e.y);
    ann.width = Math.abs(e.x - s.x); ann.height = Math.abs(e.y - s.y);
    boundsHandled = true;
  }

  // MeasureDistance leader lines
  if (ann.leaderStartX != null && ann.leaderStartY != null) {
    const ls = rotatePoint(ann.leaderStartX, ann.leaderStartY, normDelta, oldW, oldH);
    ann.leaderStartX = ls.x; ann.leaderStartY = ls.y;
  }
  if (ann.leaderEndX != null && ann.leaderEndY != null) {
    const le = rotatePoint(ann.leaderEndX, ann.leaderEndY, normDelta, oldW, oldH);
    ann.leaderEndX = le.x; ann.leaderEndY = le.y;
  }
  // MeasureDistance text offset is a VECTOR (relative to the line midpoint):
  // rotate it with the linear part of the page rotation only (no translation).
  if (ann.textOffsetX != null || ann.textOffsetY != null) {
    const tox = ann.textOffsetX || 0;
    const toy = ann.textOffsetY || 0;
    switch (normDelta) {
      case 90:  ann.textOffsetX = -toy; ann.textOffsetY = tox; break;
      case 270: ann.textOffsetX = toy;  ann.textOffsetY = -tox; break;
      case 180: ann.textOffsetX = -tox; ann.textOffsetY = -toy; break;
    }
  }

  // Callout arrow/knee/armOrigin points
  if (ann.arrowX != null && ann.arrowY != null) {
    const a = rotatePoint(ann.arrowX, ann.arrowY, normDelta, oldW, oldH);
    ann.arrowX = a.x; ann.arrowY = a.y;
  }
  if (ann.kneeX != null && ann.kneeY != null) {
    const k = rotatePoint(ann.kneeX, ann.kneeY, normDelta, oldW, oldH);
    ann.kneeX = k.x; ann.kneeY = k.y;
  }
  if (ann.armOriginX != null && ann.armOriginY != null) {
    const ao = rotatePoint(ann.armOriginX, ann.armOriginY, normDelta, oldW, oldH);
    ann.armOriginX = ao.x; ann.armOriginY = ao.y;
  }

  // Text markup rects (textHighlight, textStrikethrough, textUnderline)
  if (ann.rects && ann.rects.length > 0) {
    ann.rects = ann.rects.map(r => rotateRect(r.x, r.y, r.width, r.height, normDelta, oldW, oldH));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of ann.rects) {
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x + r.width > maxX) maxX = r.x + r.width;
      if (r.y + r.height > maxY) maxY = r.y + r.height;
    }
    ann.x = minX; ann.y = minY;
    ann.width = maxX - minX; ann.height = maxY - minY;
    boundsHandled = true;
  }

  // Visual-content annotations: rotate center, keep w/h, add rotation property
  const visualTypes = new Set(['text', 'textbox', 'callout', 'stamp', 'image', 'signature']);
  if (!boundsHandled && visualTypes.has(ann.type) && ann.x != null && ann.y != null && ann.width != null && ann.height != null) {
    const cx = ann.x + ann.width / 2;
    const cy = ann.y + ann.height / 2;
    const rc = rotatePoint(cx, cy, normDelta, oldW, oldH);
    ann.x = rc.x - ann.width / 2;
    ann.y = rc.y - ann.height / 2;
    ann.rotation = ((ann.rotation || 0) + normDelta) % 360;
    boundsHandled = true;
  }

  // Bounding box for rect-only annotations (box, circle, highlight, etc.)
  if (!boundsHandled && ann.x != null && ann.y != null) {
    if (ann.width != null && ann.height != null) {
      const nr = rotateRect(ann.x, ann.y, ann.width, ann.height, normDelta, oldW, oldH);
      ann.x = nr.x; ann.y = nr.y; ann.width = nr.width; ann.height = nr.height;
    } else {
      const p = rotatePoint(ann.x, ann.y, normDelta, oldW, oldH);
      ann.x = p.x; ann.y = p.y;
    }
  }
}

function rotateAnnotationsForPage(pageNum, normDelta, oldW, oldH) {
  const doc = getActiveDocument();
  if (!doc) return;
  const annotations = doc.annotations;
  if (!annotations || annotations.length === 0) return;
  for (const ann of annotations) {
    if (ann.page === pageNum) {
      rotateAnnotation(ann, normDelta, oldW, oldH);
    }
  }
}

export async function rotatePage(delta, targetPage) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  const pageNum = targetPage || doc.currentPage;
  const current = getPageRotation(pageNum);

  // Get old viewport dimensions (at current rotation) for annotation transform
  const page = await doc.pdfDoc.getPage(pageNum);
  const oldViewport = page.getViewport({ scale: 1, rotation: (page.rotate + current) % 360 });
  const normDelta = ((delta % 360) + 360) % 360;

  // Transform annotation coordinates to match new rotation
  rotateAnnotationsForPage(pageNum, normDelta, oldViewport.width, oldViewport.height);

  setPageRotation(pageNum, current + delta);
  rebuildDocumentPageGeometryIndex(doc);

  // Mark document as modified
  noteDocumentMutation(doc, { pages: [pageNum], structural: true, reason: 'page:rotate' });

  // Re-render
  if (doc?.viewMode === 'continuous') {
    await renderContinuous(true, {
      synchronization: true,
      requiredPages: [pageNum],
    });
  } else {
    await renderPage(pageNum);
  }
  // Continuous rendering rebuilds every page wrapper. Publish only after the
  // replacement host exists so an active owner-scoped editor can reattach its
  // detached portal and project against the new rotation.
  if (getActiveDocument() === doc) bumpDocumentViewportRevision(doc, 'rotation');

  // Update thumbnails
  const { invalidateThumbnail } = await import('../ui/panels/left-panel.js');
  invalidateThumbnail(pageNum);
}

// Clear the PDF view when no document is open
export function clearPdfView() {
  cancelPendingDocumentZoom();
  cancelDeferredZoomRenders();
  import('./mupdf-renderer.js').then(m => m.closeDocument());
  const pdfCanvas = getPdfCanvas();
  const annotationCanvas = getAnnotationCanvas();
  if (!pdfCanvas || !annotationCanvas) return;

  // Deactivate vector viewport so its RAF loop stops redrawing the last
  // viewed document on the now-empty canvas.
  if (window.__pdfViewport) window.__pdfViewport.active = false;

  // Clear single page mode canvases
  const pdfCtx = pdfCanvas.getContext('2d');
  pdfCtx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
  const annotationCtx = annotationCanvas.getContext('2d');
  annotationCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);

  // Clear caches
  clearLowResCache();
  _lowResPreloadGeneration += 1;
  clearEditableMetadataPreload(getActiveDocument());
  _renderedPages.clear();
  _renderedPagesScale = null;

  // Clear continuous mode container
  const continuousContainer = document.getElementById('continuous-container');
  if (continuousContainer) {
    _teardownContinuousWindow('pdf-view-cleared');
    _untrackContinuousContainer(getActiveDocument(), continuousContainer);
    continuousContainer.querySelectorAll('canvas').forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
    });
    continuousContainer.innerHTML = '';
  }

  // Clear PDF vector snap cache
  clearPdfVectorCache();
  void import('./vector-renderer.js').then((module) => module.clearVectorCache()).catch(() => {});

  // Clear high-res page bitmap cache
  import('./page-bitmap-cache.js').then(m => m.clearAllBitmaps()).catch(() => {});

  // Clear element detection cache
  clearDetectionCache();

  // Clear text, link, and form layers
  clearSinglePageTextLayer();
  clearTextLayers();
  clearSinglePageLinkLayer();
  clearLinkLayers();
  clearSinglePageFormLayer();
  clearFormLayers();
  hideFormFieldsBar();
  hidePdfABar();

  // Show placeholder if no documents open
  const placeholder = document.getElementById('placeholder');
  const pdfContainer = document.getElementById('pdf-container');
  if (placeholder) placeholder.style.display = 'flex';
  if (pdfContainer) pdfContainer.classList.remove('visible');

  // Update status bar (derives from reactive state)
  updateAllStatus();
}

// ─── Self-test: call from DevTools console with window.__testRender() ──────
// Tests the full rendering pipeline and reports what engine is used.
if (typeof window !== 'undefined') {
  window.__testRender = async function(filePath) {
    const testPath = filePath || String.raw`C:\3BM\50_projecten\3_3BM_bouwtechniek\3059 Woonhuis Benedenkerkseweg 87 Stolwijk\20_post_IN\01 27-03-2026 beginstukken\begane grond do 3 constructie verwerkt_50.pdf`;
    console.log('=== Render Self-Test ===');
    console.log('Path:', testPath);
    console.log('isTauri():', isTauri());

    // Step 1: Test Rust render command directly
    if (isTauri()) {
      try {
        console.log('Testing invoke("render_pdf_page")...');
        const t0 = performance.now();
        const result = await invoke('render_pdf_page', { path: testPath, pageIndex: 0, scale: 1.5 });
        const elapsed = Math.round(performance.now() - t0);
        if (result && result.length > 8) {
          // Parse 8-byte header: width (u32 LE) + height (u32 LE)
          const hdr = new DataView(result.buffer, result.byteOffset, 8);
          const w = hdr.getUint32(0, true);
          const h = hdr.getUint32(4, true);
          const rgbaLen = result.length - 8;
          console.log(`✅ Rust render: ${w}x${h}, ${rgbaLen} bytes (${rgbaLen === w*h*4 ? 'size OK' : 'SIZE MISMATCH'}), ${elapsed}ms`);

          // Draw to canvas to verify
          const canvas = document.getElementById('pdf-canvas');
          if (canvas && w * h * 4 === rgbaLen) {
            canvas.width = w;
            canvas.height = h;
            canvas.style.width = Math.floor(w / (window.devicePixelRatio || 1)) + 'px';
            canvas.style.height = Math.floor(h / (window.devicePixelRatio || 1)) + 'px';
            const rgba = result.slice(8);
            const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), w, h);
            canvas.getContext('2d').putImageData(imgData, 0, 0);
            document.getElementById('placeholder')?.style.setProperty('display', 'none');
            document.getElementById('pdf-container')?.classList.add('visible');
            console.log('✅ Drawn to canvas');
          }
        } else {
          console.log('❌ Rust render returned empty or too small:', result?.length);
        }
      } catch (e) {
        console.log('❌ Rust render error:', e);
      }
    } else {
      console.log('⚠️ Not in Tauri — Rust render unavailable, PDF.js will be used');
    }

    // Step 2: Test via the full renderPage pipeline
    const doc = getActiveDocument();
    if (doc) {
      console.log('Active doc:', doc.filePath, 'page:', doc.currentPage, 'scale:', doc.scale);
      console.log('Calling renderPage()...');
      const t0 = performance.now();
      await renderPage(doc.currentPage || 1);
      console.log(`renderPage() total: ${Math.round(performance.now() - t0)}ms`);
    } else {
      console.log('No active document. Open a PDF first, then run __testRender() again.');
    }
    console.log('=== End Self-Test ===');
  };

  window.__testRustDirect = async function(filePath) {
    const testPath = filePath || String.raw`C:\3BM\50_projecten\3_3BM_bouwtechniek\3059 Woonhuis Benedenkerkseweg 87 Stolwijk\20_post_IN\01 27-03-2026 beginstukken\begane grond do 3 constructie verwerkt_50.pdf`;
    if (!isTauri()) { console.log('Not in Tauri'); return; }
    try {
      console.log('Invoking render_pdf_page directly...');
      const t0 = performance.now();
      const rgba = await invoke('render_pdf_page', { path: testPath, pageIndex: 0, scale: 1.5 });
      const elapsed = Math.round(performance.now() - t0);
      console.log(`Result: ${rgba?.length || 0} bytes in ${elapsed}ms`);
      if (rgba && rgba.length > 8) {
        // Parse 8-byte header: width (u32 LE) + height (u32 LE)
        const hdr = new DataView(rgba.buffer, rgba.byteOffset, 8);
        const w = hdr.getUint32(0, true);
        const h = hdr.getUint32(4, true);
        const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset + 8, rgba.length - 8);
        console.log(`Dimensions: ${w}x${h}, RGBA: ${pixels.length} bytes`);
        const canvas = document.getElementById('pdf-canvas');
        if (canvas && w * h * 4 === pixels.length) {
          canvas.width = w;
          canvas.height = h;
          canvas.style.width = (w / (window.devicePixelRatio || 1)) + 'px';
          canvas.style.height = (h / (window.devicePixelRatio || 1)) + 'px';
          const imgData = new ImageData(pixels, w, h);
          canvas.getContext('2d').putImageData(imgData, 0, 0);
          document.getElementById('placeholder')?.style.setProperty('display', 'none');
          document.getElementById('pdf-container')?.classList.add('visible');
          console.log(`Drawn to canvas: ${w}x${h}`);
        }
      }
    } catch (e) {
      console.log('❌ Error:', e);
    }
  };
}
