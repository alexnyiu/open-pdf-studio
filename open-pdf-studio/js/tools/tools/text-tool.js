import { applyToolTransform } from '../tool-transform.js';
import { SYMBOL_STAMP_DEFAULT_SIZE } from '../../annotations/stamp-defaults.js';

/**
 * Text tools — comment, text, stamp, signature, editText
 * These are single-click placement tools that delegate to existing modules
 */
export const commentTool = {
  name: 'comment',
  cursor: 'crosshair',

  onPointerDown(ctx) {
    ctx.addComment(ctx.x, ctx.y);
    // Auto-reset to select tool
    import("../../tools/manager.js").then(m => m.maybeRevertToSelect && m.maybeRevertToSelect());
  },
};

export const stampTool = {
  name: 'stamp',
  cursor: 'crosshair',

  onPointerDown(ctx, e) {
    if (e && e.button === 2) return;
    const { state } = ctx;
    if (state.toolOverrides?.stampSvg || state.toolOverrides?.stampImage) {
      ctx.placeOverrideStamp(ctx.x, ctx.y);
      // Auto-reset to select tool
      import("../../tools/manager.js").then(m => m.maybeRevertToSelect && m.maybeRevertToSelect());
    } else {
      ctx.showStampPicker(ctx.x, ctx.y);
    }
  },

  onPointerMove(ctx) {
    const { state } = ctx;
    const previewImg = state.toolOverrides?._previewImg;
    if (!previewImg || !ctx.canvasCtx) return;

    const w = state.toolOverrides.stampWidth || SYMBOL_STAMP_DEFAULT_SIZE;
    const h = state.toolOverrides.stampHeight || SYMBOL_STAMP_DEFAULT_SIZE;

    // Redraw existing annotations then overlay the preview
    ctx.redraw();

    const canvasCtx = ctx.canvasCtx;
    canvasCtx.save();
    applyToolTransform(canvasCtx, ctx.transformContext);
    canvasCtx.globalAlpha = 0.6;
    canvasCtx.drawImage(previewImg, ctx.x - w / 2, ctx.y - h / 2, w, h);
    canvasCtx.restore();
  },

  onDeactivate(ctx) {
    // Clear preview when switching away from stamp tool
    ctx.redraw();
  },
};

export const signatureTool = {
  name: 'signature',
  cursor: 'crosshair',

  onPointerDown(ctx) {
    ctx.showSignatureDialog(ctx.x, ctx.y);
    // Auto-reset to select tool
    import("../../tools/manager.js").then(m => m.maybeRevertToSelect && m.maybeRevertToSelect());
  },
};

export const editTextTool = {
  name: 'editText',
  cursor: 'text',

  onPointerDown(ctx) {
    const { x, y, pageNum, canvas } = ctx;
    ctx.startTextEditingAtPointWhenReady({ x, y, pageNum, canvasEl: canvas });
  },
};

export const addTextTool = {
  name: 'addText',
  cursor: 'text',

  onPointerDown(ctx, event) {
    if (event?.button === 2) return;
    ctx.startInsertedTextEditingAtPoint({
      x: ctx.x,
      y: ctx.y,
      pageNum: ctx.pageNum,
      canvasEl: ctx.canvas,
    });
  },
};
