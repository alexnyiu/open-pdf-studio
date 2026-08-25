import { getActiveDocument } from '../core/state.js';
import { overlayCanvasTransform } from '../pdf/canvas-dpr.js';

/** Apply the same app-space to backing-canvas transform used by final annotations. */
export function applyToolTransform(ctx, transformContext = {}) {
  const doc = transformContext.doc || getActiveDocument();
  const vp = transformContext.viewport || window.__pdfViewport;
  const viewMode = transformContext.viewMode || doc?.viewMode || 'single';
  const dpr = transformContext.dpr || window.devicePixelRatio || 1;
  const viewportActive = viewMode === 'single' && vp && vp.active && doc?.filePath;
  const transform = overlayCanvasTransform({
    viewportActive,
    zoom: vp?.zoom,
    offsetX: vp?.offsetX,
    offsetY: vp?.offsetY,
    legacyScale: transformContext.scale || doc?.scale || 1.5,
    dpr,
  });
  ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  return transform;
}
