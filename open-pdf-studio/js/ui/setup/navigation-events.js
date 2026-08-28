import { state, getActiveDocument } from '../../core/state.js';
import { cancelDeferredZoomRenders, goToPage } from '../../pdf/renderer.js';
import { viewport, bumpViewportRevision, suppressNextFit, addPanVelocity, stopPanMomentum } from '../../pdf/pdf-viewport.js';
import { normalizedWheelDelta } from '../../pdf/zoom-gesture.js';
import { ZoomGestureController } from '../../pdf/zoom-gesture-controller.js';
import { createPageNavigationGestureGate } from '../../pdf/page-navigation-gesture.js';
import { notePdfForegroundActivity } from '../../pdf/foreground-activity.js';
import {
  startPerformanceFrameCadence,
  stopPerformanceFrameCadence,
} from '../../pdf/performance-metrics.js';
import {
  cancelPendingDocumentZoom,
  scheduleDocumentZoom,
} from '../../pdf/document-zoom-scheduler.js';
import { getTool } from '../../tools/tool-registry.js';

// ─── Wheel Zoom + Pan + Page Navigation ───────────────────────────────────
// Single source of truth for the wheel event on the main view.
// In vector viewport mode:
//   Ctrl+wheel  → smooth proportional zoom at cursor
//   plain wheel → pan inside the current page; at the page edge in the wheel
//                 direction, navigate to next/previous page.
// In legacy mode it falls back to scroll-position-based page nav.

const _pageNavGesture = createPageNavigationGestureGate({ threshold: 80 });
// Pixels of slack at the page edge before we treat the page as "at the edge"
// and trigger a page change. Without this, sub-pixel float offsets prevent nav.
const EDGE_SLACK = 1;

export function setupWheelZoom() {
  const mainView = document.querySelector('.main-view');
  if (!mainView) return;
  const zoomController = new ZoomGestureController({
    schedule: scheduleDocumentZoom,
    onStart: () => {
      stopPanMomentum();
      notePdfForegroundActivity('zoom');
      startPerformanceFrameCadence('zoomFrameIntervalMs');
    },
    onEnd: () => {
      stopPerformanceFrameCadence('zoomFrameIntervalMs');
      import('../../pdf/renderer.js').then((module) => {
        module.finishContinuousZoomGesture();
        module.finishLegacyBlankZoomGesture();
      });
      window.dispatchEvent(new CustomEvent('opds:zoom-gesture-end'));
    },
  });
  const requestForPointer = (event, { delta = 0, factor = null } = {}) => {
    const activeDoc = getActiveDocument();
    if (!activeDoc?.pdfDoc) return { delta, factor };
    if (activeDoc.viewMode === 'continuous' && activeDoc.filePath) {
      const pointed = document.elementFromPoint?.(event.clientX, event.clientY)
        ?.closest?.('#continuous-container .page-wrapper');
      return {
        delta,
        factor,
        clientPoint: { x: event.clientX, y: event.clientY },
        anchor: {
          pageNum: Number(pointed?.dataset?.page) || activeDoc.currentPage,
          clientX: event.clientX,
          clientY: event.clientY,
        },
      };
    }
    if (!viewport.active || !activeDoc.filePath) {
      return { delta, factor, clientPoint: { x: event.clientX, y: event.clientY } };
    }
    const pdfCanvas = document.getElementById('pdf-canvas');
    const rect = pdfCanvas?.getBoundingClientRect();
    return {
      delta,
      factor,
      screenPoint: rect
        ? { x: event.clientX - rect.left, y: event.clientY - rect.top }
        : { x: event.clientX, y: event.clientY },
    };
  };
  zoomController.attachNative(mainView, (event) => requestForPointer(event));

  mainView.addEventListener('wheel', async (e) => {
    const activeDoc = getActiveDocument();
    if (!activeDoc?.pdfDoc) return;
    notePdfForegroundActivity(e.ctrlKey || e.metaKey ? 'zoom-wheel' : 'scroll');

    // Ctrl+wheel = zoom — handled FIRST, before tool delegation, so the
    // user can always zoom regardless of the active tool (line, pencil,
    // select, polygon, etc.). Previously the wheel was delegated to the
    // tool first; if any tool's onWheel preventDefault'd (even by accident
    // mid-arc/polyline construction), ctrl+wheel zoom silently broke.
    // When the wheelZoomWithoutCtrl voorkeur aan staat, zoomt een gewoon
    // wielrol ook (Ctrl+wiel blijft altijd werken).
    if (e.ctrlKey || e.metaKey || state.preferences.wheelZoomWithoutCtrl) {
      e.preventDefault();
      // Starting a zoom gesture: kill any in-flight pan momentum so the page
      // doesn't keep gliding mid-zoom (would tear the cursor anchor away).
      stopPanMomentum();
      if (!viewport.active || !activeDoc.filePath) {
        // Continuous mode: the vector viewport is deliberately inactive
        // (renderContinuous() disables it) — route the zoom through the
        // continuous helper, anchored at the cursor's Y position so the
        // content under the mouse stays put.
        if (activeDoc.viewMode === 'continuous' && activeDoc.filePath) {
          const contDy = normalizedWheelDelta(e.deltaY, e.deltaMode, window.innerHeight);
          if (contDy !== 0) {
            // Proportional zoom: scale tracks the wheel delta directly so the
            // page follows the cursor immediately instead of jumping a fixed
            // chunk per notch. Clamp per event so a high-res wheel can't
            // slingshot through several zoom levels at once.
            zoomController.wheel(e, requestForPointer(e, { delta: contDy }));
          }
          return;
        }
        // No PDF loaded → bail (preventDefault already ran).
        // Blank docs (filePath===null) bypass the vector viewport and use
        // PDF.js + doc.scale instead. zoomStepAtPoint() below would mutate
        // the stale viewport state from a previously-opened real PDF, not
        // the blank doc's doc.scale → ctrl+wheel appears dead. Fall back
        // to the legacy zoomIn/zoomOut path (loses cursor anchor, but at
        // least the user can zoom).
        if (activeDoc.pdfDoc && activeDoc.filePath === null) {
          const wheelDy = normalizedWheelDelta(e.deltaY, e.deltaMode, window.innerHeight);
          if (wheelDy !== 0) {
            zoomController.wheel(e, requestForPointer(e, { delta: wheelDy }));
          }
        }
        return;
      }
      // Always anchor to pdf-canvas rect. The cursor may be over a non-canvas
      // overlay (textLayer span, annotation overlay child) whose own rect is
      // offset from the canvas — using e.target.getBoundingClientRect() in
      // that case gives wrong sx/sy and the zoom anchor drifts. The
      // pdf-canvas, annotation-canvas and text-highlight-canvas all share the
      // same rect, so the pdf-canvas rect is the authoritative reference.
      const dy = normalizedWheelDelta(e.deltaY, e.deltaMode, window.innerHeight);
      if (dy) zoomController.wheel(e, requestForPointer(e, { delta: dy }));
      return;
    }

    // Plain wheel (no modifier) — delegate to active tool first so tools
    // that consume wheel (e.g. arc-bulge adjustment in filled-area /
    // measurement tools) can intercept. If the tool preventDefaults, we
    // skip the pan/page-nav handling below.
    const _wheelTool = getTool(state.currentTool);
    if (_wheelTool && _wheelTool.onWheel) {
      const _wheelCtx = { state, redraw: () => {
        viewport.dirty = true;
      }};
      _wheelTool.onWheel(_wheelCtx, e);
      if (e.defaultPrevented) return;
    }

    // ─── Vector viewport mode: pan + edge-triggered page nav ──────────────
    if (viewport.active) {
      e.preventDefault();
      const pdfCanvas = document.getElementById('pdf-canvas');
      if (!pdfCanvas) return;

      const dx = normalizedWheelDelta(e.deltaX, e.deltaMode, window.innerHeight);
      const dy = normalizedWheelDelta(e.deltaY, e.deltaMode, window.innerHeight);
      const pageScreenH = viewport.pageH * viewport.zoom;
      const pageScreenW = viewport.pageW * viewport.zoom;
      // CSS-pixels, niet de backing-store. viewport.offsetY/zoom rekenen in
      // CSS-pixels; `pdfCanvas.height` is dpr maal zo groot. Op een scherm met
      // dpr > 1 maakte dat het kijkvenster kunstmatig hoog, waardoor "onderaan
      // de pagina" te vroeg waar was en de pan-onderdrukking hieronder ook
      // pagina's blokkeerde die wél scrollruimte hadden.
      const canvasRect = pdfCanvas.getBoundingClientRect();
      const canvasH = canvasRect.height;
      const canvasW = canvasRect.width;

      // Where the page edges sit on the visible canvas right now
      const pageTop = viewport.offsetY;
      const pageBottom = viewport.offsetY + pageScreenH;
      const pageLeft = viewport.offsetX;
      const pageRight = viewport.offsetX + pageScreenW;

      // "At edge" tests — true if the page bottom/top is already inside the viewport
      const atTop = pageTop >= -EDGE_SLACK;                       // can't pan up further
      const atBottom = pageBottom <= canvasH + EDGE_SLACK;        // can't pan down further

      // Page nav: only if scroll direction matches an exhausted edge AND we're
      // single-page mode. The accumulated 80 px gesture gate permits sustained
      // trackpad traversal without a timer while preventing one inertial tail
      // from skipping several pages.
      if (activeDoc.viewMode === 'single' && Math.abs(dy) > Math.abs(dx)) {
        if (dy > 0 && atBottom && activeDoc.currentPage < activeDoc.pdfDoc.numPages) {
          if (!_pageNavGesture.shouldNavigate(dy, { atEdge: true })) return;
          // Kill any in-flight pan momentum so the new page doesn't inherit
          // the previous page's residual scroll velocity (would slingshot
          // past the top into the centered fit position).
          stopPanMomentum();
          // Tell the next setPage() to keep the current zoom instead of
          // running fitToViewport(), so the user's zoom level survives the
          // page change with no flash to fit-zoom in between.
          suppressNextFit();
          await goToPage(activeDoc.currentPage + 1);
          alignPageToTop();
          return;
        }
        if (dy < 0 && atTop && activeDoc.currentPage > 1) {
          if (!_pageNavGesture.shouldNavigate(dy, { atEdge: true })) return;
          stopPanMomentum();
          suppressNextFit();
          await goToPage(activeDoc.currentPage - 1);
          alignPageToBottom();
          return;
        }
        _pageNavGesture.shouldNavigate(dy, { atEdge: false });
      }

      // Smooth pan: feed wheel deltas into the velocity accumulator instead
      // of writing offsetX/Y directly. The RAF loop in pdf-viewport applies
      // and decays the velocity over multiple frames, producing Apple-style
      // momentum scroll — a single wheel notch glides to a smooth stop.
      // Skip the contribution on any axis where the page already fits the
      // viewport (no scroll headroom on that axis).
      const vx = (pageScreenW <= canvasW) ? 0 : dx;
      const vy = (pageScreenH <= canvasH) ? 0 : dy;
      if (vx !== 0 || vy !== 0) {
        addPanVelocity(vx, vy);
      }
      return;
    }

    // ─── Legacy mode: scroll-position-based page nav ──────────────────────
    if (activeDoc?.viewMode !== 'single') return;
    const pdfContainer = document.getElementById('pdf-container');
    if (!pdfContainer) return;

    const canScroll = pdfContainer.scrollHeight > pdfContainer.clientHeight + 1;
    const atBottomLegacy = !canScroll || pdfContainer.scrollTop + pdfContainer.clientHeight >= pdfContainer.scrollHeight - 5;
    const atTopLegacy = !canScroll || pdfContainer.scrollTop <= 5;

    if (e.deltaY > 0 && atBottomLegacy && activeDoc.currentPage < activeDoc.pdfDoc.numPages) {
      if (!_pageNavGesture.shouldNavigate(e.deltaY, { atEdge: true })) return;
      e.preventDefault();
      await goToPage(activeDoc.currentPage + 1);
    } else if (e.deltaY < 0 && atTopLegacy && activeDoc.currentPage > 1) {
      if (!_pageNavGesture.shouldNavigate(e.deltaY, { atEdge: true })) return;
      e.preventDefault();
      await goToPage(activeDoc.currentPage - 1);
    } else {
      _pageNavGesture.shouldNavigate(e.deltaY, { atEdge: false });
    }
  }, { passive: false });
}

// Verticale uitlijning van een pagina na wiel-navigatie.
//
// Past de pagina volledig in het kijkvenster, dan is er niets uit te lijnen:
// boven- én onderrand zijn al zichtbaar. In dat geval hoort de pagina gewoon
// gecentreerd te staan, precies zoals na Pagina passend.
//
// Deze twee functies leunden daarvoor op clampAndCenter(), die een passende
// pagina elke frame hercentreerde. Die functie is later leeggemaakt (vrije
// pan/zoom), waardoor het vangnet wegviel: sindsdien bleef een passende pagina
// staan waar hier neergezet — boven-uitgelijnd bij naar beneden scrollen,
// onder-uitgelijnd bij naar boven scrollen. De pagina leek daardoor bij elke
// wielrol een stukje op en neer te springen terwijl er niets te scrollen viel.
//
// Rekenen in CSS-pixels; viewport.offsetY doet dat ook.
function _viewportHeightCss() {
  const pdfCanvas = document.getElementById('pdf-canvas');
  if (!pdfCanvas) return 0;
  return pdfCanvas.getBoundingClientRect().height;
}

// After advancing forward via wheel, snap the new page so its TOP is at the
// top of the viewport (so the user can keep scrolling down through it).
function alignPageToTop() {
  const vpH = _viewportHeightCss();
  const pageScreenH = viewport.pageH * viewport.zoom;
  viewport.offsetY = (vpH > 0 && pageScreenH <= vpH)
    ? (vpH - pageScreenH) / 2
    : 0;
  viewport.dirty = true;
  bumpViewportRevision('page-align-top');
}

// After going back via wheel, snap the new page so its BOTTOM is at the
// bottom of the viewport.
function alignPageToBottom() {
  const vpH = _viewportHeightCss();
  if (!vpH) return;
  const pageScreenH = viewport.pageH * viewport.zoom;
  viewport.offsetY = (pageScreenH <= vpH)
    ? (vpH - pageScreenH) / 2
    : vpH - pageScreenH;
  viewport.dirty = true;
  bumpViewportRevision('page-align-bottom');
}

export function cancelPendingZoom() {
  cancelPendingDocumentZoom();
  cancelDeferredZoomRenders();
}
