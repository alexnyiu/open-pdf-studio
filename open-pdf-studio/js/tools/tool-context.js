import { state, getActiveDocument, clearSelection, addToSelection, removeFromSelection, isSelected, getAnnotationBounds, getSelectionBounds } from '../core/state.js';
import { annotationCanvas, annotationCtx } from '../ui/dom-elements.js';
import { createAnnotation, cloneAnnotation } from '../annotations/factory.js';
import { findAnnotationAt } from '../annotations/geometry.js';
import { findHandleAt, getCursorForHandle } from '../annotations/handles.js';
import { applyResize, applyMove, applyRotation } from '../annotations/transforms.js';
import { redrawAnnotations, redrawContinuous, renderAnnotationsForPage, snapToGrid } from '../annotations/rendering.js';
import { showProperties, hideProperties, showMultiSelectionProperties } from '../ui/panels/properties-panel.js';
import { startTextEditing, finishTextEditing, addComment } from './text-editing.js';
import { openStickyPopup } from '../bridge.js';
import {
  findTextEditAtPosition,
  startInsertedTextEditingAtPoint,
  startTextEditEditing,
  startTextEditingAtPointWhenReady,
} from './text-edit-tool.js';
import { markDocumentModified } from '../ui/chrome/tabs.js';
import { recordAdd, recordModify, recordBulkModify } from '../core/undo-manager.js';
import { showStampPicker, placeOverrideStamp } from '../annotations/stamps.js';
import { showSignatureDialog } from '../annotations/signature.js';
import { startPan, startContinuousPan } from './pan-handler.js';
import { snapAngle } from '../utils/helpers.js';
import { drawShapePreview } from './shape-preview.js';
import { createAnnotationFromTool, createContinuousAnnotation, buildAnnotationProps, createMeasureAreaAnnotation, createMeasurePerimeterAnnotation } from './annotation-creators.js';
import { isPdfAReadOnly } from '../pdf/loader.js';
import { calculateDistance, calculateArea, calculatePerimeter, formatMeasurement, snapDistanceTo10 } from '../annotations/measurement.js';
import { performSnap, drawSnapIndicator, setPolarAnchor, clearPolarAnchor } from './snap-engine.js';
import { buildCloudPolylinePath } from '../annotations/rendering/shapes.js';
import { drawDimension, drawMeasureAreaShape, drawCentroidLabel, drawMeasurePerimeterShape } from '../annotations/rendering/measurements.js';
import { getAnnotationType } from '../plugins/annotation-type-registry.js';
import { getColorPickerValue, getLineWidthValue } from '../bridge.js';
import { applyToolTransform } from './tool-transform.js';
export { applyToolTransform } from './tool-transform.js';

/**
 * Check if any modal dialog/overlay is blocking interaction
 */
export function isModalOpen() {
  if (state.modalDialogOpen) return true;
  return !!document.querySelector(
    '.form-validation-overlay, ' +
    '.about-overlay.visible, ' +
    '.doc-props-overlay.visible, ' +
    '.preferences-overlay.visible, ' +
    '.text-annot-overlay.visible, ' +
    '.loading-overlay.visible, ' +
    '.app-menu-overlay.visible, ' +
    '.sig-overlay.visible'
  );
}

/**
 * Resolve pointer coordinates from a PointerEvent into unified canvas-space coords.
 * Works for both single-page and continuous modes.
 */
export function resolvePointerCoords(e) {
  const doc = getActiveDocument();
  const docCurrentPage = doc ? doc.currentPage : 1;
  const scale = doc?.scale || 1.5;
  if (doc?.viewMode === 'continuous') {
    const eventCanvas = e.target.closest ? e.target.closest('.annotation-canvas') || e.target : e.target;
    const canvas = state.isDrawing && state.activeContinuousCanvas
      ? state.activeContinuousCanvas
      : eventCanvas;
    if (!canvas || !canvas.getBoundingClientRect) {
      return { x: 0, y: 0, pageNum: docCurrentPage, canvas: null, canvasCtx: null };
    }
    const pageNum = parseInt(canvas?.dataset?.page, 10);
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
      pageNum: isNaN(pageNum) ? docCurrentPage : pageNum,
      canvas,
      canvasCtx: canvas.getContext ? canvas.getContext('2d') : null
    };
  } else {
    const canvas = annotationCanvas;
    if (!canvas) {
      return { x: 0, y: 0, pageNum: docCurrentPage, canvas: null, canvasCtx: null };
    }
    const ctx = annotationCtx || canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();

    // Vector viewport mode: use viewport transform for coordinate conversion.
    // Same guard as renderer.js zoomIn/Out: only honour the viewport if THIS
    // doc actually uses it. Blank in-memory docs (filePath===null) are drawn
    // via the PDF.js fallback path in renderer.js — they read coords from
    // doc.scale + the annotation-canvas rect. If we'd let the viewport's
    // stale zoom/offset (from a previously-open real PDF) drive the coord
    // math here, every click on a blank-doc tab would land far off the page
    // → user sees "tool draws nothing" while the annotation actually exists
    // somewhere outside the canvas area.
    const vp = window.__pdfViewport;
    if (vp && vp.active && doc?.filePath) {
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      // Annotations use app-space: (0,0) = page top-left, Y-down, scale=1
      // Page top-left on screen = (offsetX, offsetY)
      // So app coords = (screen - offset) / zoom — NO Y-flip needed
      const appX = (screenX - vp.offsetX) / vp.zoom;
      const appY = (screenY - vp.offsetY) / vp.zoom;
      return {
        x: appX,
        y: appY,
        pageNum: docCurrentPage,
        canvas,
        canvasCtx: ctx
      };
    }

    // Legacy PDF.js mode
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
      pageNum: docCurrentPage,
      canvas,
      canvasCtx: ctx
    };
  }
}

/**
 * Apply the correct canvas transform for drawing tool previews/interactions.
 * In vector viewport mode: uses viewport zoom + offset (no DPR).
 * In legacy mode: uses doc.scale (with DPR handled elsewhere).
 * Call ctx.save() before and ctx.restore() after.
 */
/**
 * Get the effective scale for the current rendering mode.
 * Vector mode: viewport zoom. Legacy mode: doc.scale.
 */
export function getEffectiveScale() {
  const doc = getActiveDocument();
  const vp = window.__pdfViewport;
  // Same blank-doc guard as resolvePointerCoords.
  if (vp && vp.active && doc?.filePath) return vp.zoom;
  return doc?.scale || 1.5;
}

/**
 * Build a tool context object from event + resolved coordinates.
 * This gives each tool a clean API to work with.
 */
export function buildToolContext(e, coords) {
  const ctxDoc = getActiveDocument();
  const vp = window.__pdfViewport;
  const ctxScale = (vp && vp.active && ctxDoc?.filePath) ? vp.zoom : (ctxDoc?.scale || 1.5);
  const transformContext = {
    doc: ctxDoc,
    pageNum: coords.pageNum,
    canvas: coords.canvas,
    canvasCtx: coords.canvasCtx,
    viewMode: ctxDoc?.viewMode || 'single',
    scale: ctxDoc?.scale || 1.5,
    viewport: vp,
    dpr: window.devicePixelRatio || 1,
  };
  return {
    // Coordinates
    x: coords.x,
    y: coords.y,
    pageNum: coords.pageNum,
    canvas: coords.canvas,
    canvasCtx: coords.canvasCtx,
    event: e,

    // State access
    state,
    prefs: state.preferences,
    scale: ctxScale,
    viewMode: ctxDoc?.viewMode || 'single',
    transformContext,

    // Snapping
    snap: (x, y, excludeId, extraPoints) => performSnap(x, y, ctxDoc?.annotations || [], coords.pageNum, ctxScale, excludeId, extraPoints),
    snapToGrid,
    snapAngle,
    setPolarAnchor,
    clearPolarAnchor,
    snapDistanceTo10,
    drawSnapIndicator: (snapResult) => {
      if (!coords.canvasCtx) return;
      coords.canvasCtx.save();
      applyToolTransform(coords.canvasCtx, transformContext);
      drawSnapIndicator(coords.canvasCtx, snapResult, ctxScale);
      coords.canvasCtx.restore();
    },

    // Annotation operations
    findAnnotationAt,
    findHandleAt: (x, y, ann) => findHandleAt(x, y, ann, ctxScale),
    getCursorForHandle: (handle, rotation, ann) => getCursorForHandle(handle, rotation, ann),
    createAnnotation,
    cloneAnnotation,
    applyResize,
    applyMove,
    applyRotation,
    getAnnotationBounds,
    getSelectionBounds,
    buildAnnotationProps,
    createAnnotationFromTool,
    createContinuousAnnotation,
    createMeasureAreaAnnotation,
    createMeasurePerimeterAnnotation,
    buildCloudPolylinePath,
    drawDimension,
    drawMeasureAreaShape,
    drawMeasurePerimeterShape,
    drawCentroidLabel,
    calculateDistance,
    calculateArea,
    calculatePerimeter,
    formatMeasurement,

    // Selection
    clearSelection,
    addToSelection,
    removeFromSelection,
    isSelected,

    // Properties panel
    showProperties,
    hideProperties,
    showMultiSelectionProperties,

    // Text editing
    startTextEditing,
    finishTextEditing,
    addComment,
    openStickyPopup,
    findTextEditAtPosition,
    startInsertedTextEditingAtPoint,
    startTextEditEditing,
    startTextEditingAtPointWhenReady,

    // Stamps and signatures
    showStampPicker,
    placeOverrideStamp,
    showSignatureDialog,

    // Pan
    startPan,
    startContinuousPan,

    // Drawing
    drawShapePreview: (x, y, event) => drawShapePreview(x, y, event, transformContext),
    getAnnotationType,
    getColorPickerValue,
    getLineWidthValue,

    // Undo
    recordAdd,
    recordModify,
    recordBulkModify,
    markDocumentModified,

    // Rendering
    redraw: () => {
      if (getActiveDocument()?.viewMode === 'continuous') redrawContinuous();
      else redrawAnnotations();
    },
    redrawAnnotations,
    redrawContinuous,
    renderAnnotationsForPage,

    // PDF/A
    isPdfAReadOnly,
  };
}
