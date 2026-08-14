// ============================================================================
// "Remove embedded image" tool (issue #184).
//
// Lets the user delete a raster image that is baked into the PDF page content
// (an image XObject drawn with `/Name Do`) — distinct from image *annotations*
// (stamps), which the contextual "Afbeelding" tab already handles (#212).
//
// While active, every removable image on the current page is outlined; the one
// under the cursor is highlighted. Clicking it asks for confirmation and then
// deletes it from the content stream (undo-able, saved into the PDF).
// ============================================================================

import { state, getActiveDocument } from '../../core/state.js';
import { setTool } from '../manager.js';
import { getEffectiveScale } from '../tool-context.js';
import { showMessage } from '../../bridge.js';
import { showConfirm } from '../../ui/chrome/confirm-dialog.js';
import i18next from '../../i18n/config.js';
import {
  detectEmbeddedImages, getCachedEmbeddedImages, hitTestEmbeddedImage,
  removeEmbeddedImage, clearEmbeddedImageCache,
} from '../embedded-image-detector.js';

let _hoverPage = -1;
let _hoverIndex = -1;
let _busy = false;

function t(key, def) {
  return i18next.t(key, { ns: 'ribbon', defaultValue: def });
}

// Ensure the current page's images are detected; redraw once ready.
function ensureDetected(pageNum, redraw) {
  if (getCachedEmbeddedImages(pageNum)) return;
  detectEmbeddedImages(pageNum).then((list) => {
    if (state.currentTool !== 'removeImage') return;
    if (list.length === 0) {
      showMessage(t('drawing.noEmbeddedImages', 'No embedded images found on this page.'));
    }
    redraw && redraw();
  }).catch(() => {});
}

// Entry point used by the ribbon button: activate + kick off detection.
export function startRemoveImageTool() {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return;
  clearEmbeddedImageCache();
  _hoverPage = -1; _hoverIndex = -1;
  setTool('removeImage');
  const redraw = () => {
    if (getActiveDocument()?.viewMode === 'continuous') {
      import('../../annotations/rendering.js').then(m => m.redrawContinuous());
    } else {
      import('../../annotations/rendering.js').then(m => m.redrawAnnotations());
    }
  };
  ensureDetected(doc.currentPage, redraw);
}

export const removeImageTool = {
  name: 'removeImage',
  cursor: 'crosshair',

  onPointerMove(ctx) {
    ensureDetected(ctx.pageNum, ctx.redraw);
    const idx = hitTestEmbeddedImage(ctx.pageNum, ctx.x, ctx.y);
    if (idx !== _hoverIndex || ctx.pageNum !== _hoverPage) {
      _hoverIndex = idx;
      _hoverPage = ctx.pageNum;
      if (ctx.canvas) ctx.canvas.style.cursor = idx >= 0 ? 'pointer' : 'crosshair';
      ctx.redraw();
    }
  },

  async onPointerDown(ctx) {
    if (_busy) return;
    const idx = hitTestEmbeddedImage(ctx.pageNum, ctx.x, ctx.y);
    if (idx < 0) return;

    const msg = t('drawing.removeImageConfirm',
      'Remove this image from the page? This edits the PDF content and can be undone.');
    try {
      const confirmed = await showConfirm({
        title: t('drawing.removeImage', 'Remove image'),
        message: msg,
        confirmLabel: t('drawing.removeImage', 'Remove image'),
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;
    } catch { return; }

    _busy = true;
    try {
      const ok = await removeEmbeddedImage(ctx.pageNum, idx);
      _hoverIndex = -1;
      if (!ok) {
        showMessage(t('drawing.removeImageFailed', 'Could not remove this image.'));
      }
    } finally {
      _busy = false;
    }
    ctx.redraw();
  },

  onDeactivate() {
    _hoverPage = -1;
    _hoverIndex = -1;
    clearEmbeddedImageCache();
  },
};

// Draw pass — invoked from redrawAnnotations()/renderAnnotationsForPage() while
// the canvas is already in app-space. Outlines removable images on `pageNum`
// and highlights the hovered one.
export function drawEmbeddedImageOverlay(ctx, pageNum) {
  if (state.currentTool !== 'removeImage') return;
  const list = getCachedEmbeddedImages(pageNum);
  if (!list || list.length === 0) return;

  const sc = getEffectiveScale() || 1;
  ctx.save();
  for (let i = 0; i < list.length; i++) {
    const b = list[i].bbox;
    const hovered = (pageNum === _hoverPage && i === _hoverIndex);
    if (hovered) {
      ctx.fillStyle = 'rgba(232, 17, 35, 0.18)'; // Windows red wash
      ctx.fillRect(b.x, b.y, b.width, b.height);
      ctx.strokeStyle = '#e81123';
      ctx.lineWidth = 2 / sc;
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = 'rgba(0, 120, 215, 0.9)'; // Windows accent blue
      ctx.lineWidth = 1.5 / sc;
      ctx.setLineDash([6 / sc, 4 / sc]);
    }
    ctx.strokeRect(b.x, b.y, b.width, b.height);
  }
  ctx.restore();
}
