import { state, getActiveDocument } from '../core/state.js';
import { annotationCanvas, annotationCtx } from '../ui/dom-elements.js';
import { redrawAnnotations, drawAnnotation, renderAnnotationsForPage } from '../annotations/rendering.js';
import { drawSnapIndicator } from './snap-engine.js';
import { buildAnnotationProps } from './annotation-creators.js';
import { getAnnotationType } from '../plugins/annotation-type-registry.js';
import { applyToolTransform } from './tool-transform.js';

/**
 * Draw a live preview of the shape being created.
 *
 * Uses the same buildAnnotationProps() + drawAnnotation() pipeline as
 * final annotation creation and rendering. This guarantees the preview
 * looks identical to the final result (line widths, arrowhead styles,
 * hatch patterns, border styles, etc.).
 */
export function drawShapePreview(currentX, currentY, e, transformContext = {}) {
  // Het voorbeeld VOOR de basisredraw bouwen: voor de betonbalk doet het
  // voorbeeld als sibling mee (state._previewJoinAnn), zodat bestaande
  // balken hun verstek/open-T al tonen tijdens het tekenen — zie de
  // betonbalk-case in annotations/rendering.js.
  state._isPreview = true;
  let tempAnn;
  try {
    tempAnn = buildAnnotationProps(state.currentTool, state.startX, state.startY, currentX, currentY, e);
  } finally {
    state._isPreview = false;
  }
  if (tempAnn && Number.isInteger(transformContext.pageNum)) tempAnn.page = transformContext.pageNum;
  if (tempAnn && tempAnn.type === 'betonbalk') state._previewJoinAnn = tempAnn;
  try {
  const canvas = transformContext.canvas || annotationCanvas;
  const canvasCtx = transformContext.canvasCtx || annotationCtx;
  if (!canvas || !canvasCtx) return;
  if (transformContext.viewMode === 'continuous') {
    renderAnnotationsForPage(canvasCtx, transformContext.pageNum, canvas.width, canvas.height, transformContext.dpr);
  } else {
    redrawAnnotations();
  }
  const doc = transformContext.doc || getActiveDocument();
  const vp = transformContext.viewport || window.__pdfViewport;
  // Blank docs (no filePath) bypass the viewport singleton — see
  // tool-context.js for the full rationale.
  const useViewport = transformContext.viewMode !== 'continuous' && vp && vp.active && doc?.filePath;
  canvasCtx.save();
  applyToolTransform(canvasCtx, transformContext);

  const tool = state.currentTool;

  if (tempAnn) {
    drawAnnotation(canvasCtx, tempAnn);
  } else {
    // Fallback: plugin types with custom preview
    const typeHandler = getAnnotationType(tool);
    if (typeHandler && typeHandler.preview) {
      typeHandler.preview(canvasCtx, state.startX, state.startY, currentX, currentY, state, e);
    }
  }

  // Draw snap indicator overlay
  if (state.lastSnapResult && state.lastSnapResult.snapped) {
    const snapScale = useViewport ? vp.zoom : (doc?.scale || 1.5);
    drawSnapIndicator(canvasCtx, state.lastSnapResult, snapScale);
  }

  canvasCtx.restore();
  } finally {
    state._previewJoinAnn = null;
  }
}
