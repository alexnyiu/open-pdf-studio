const PASSIVE_TOOLS = new Set([
  '', 'none', 'select', 'editText', 'hand', 'pan', 'textSelect', 'selectText',
]);

const belongsToPage = (record, pageNum) => Number(record?.page) === pageNum;

/**
 * A continuous-page annotation canvas is a hit target even when it has no
 * pixels to paint. Keep its CSS box, but allocate a full-DPR backing store
 * only while the page has persistent or transient overlay content.
 */
export function continuousOverlayBackingRequired(documentState, pageNum, uiState = {}) {
  const page = Number(pageNum);
  if (!documentState || !Number.isInteger(page) || page <= 0) return false;
  if ((documentState.annotations || []).some((record) => belongsToPage(record, page))) return true;
  if ((documentState.textEdits || []).some((record) => belongsToPage(record, page))) return true;
  // Watermarks may target ranges or every page. Retain the conservative full
  // backing store whenever the document owns at least one watermark.
  if ((documentState.watermarks || []).length > 0) return true;
  if (belongsToPage(documentState.cursor2D, page)) return true;
  if ((documentState.selectedAnnotations || []).some((record) => belongsToPage(record, page))) return true;
  if (uiState.isRubberBanding && Number(uiState.rubberBandPage) === page) return true;
  if ((uiState._imageAlignGuides || []).length > 0
      && Number(uiState._imageAlignGuidesPage) === page) return true;
  if (belongsToPage(uiState._previewJoinAnn, page)) return true;
  if ((uiState.lastSnapResult || uiState.gMoveMode || uiState.gRotateMode)
      && Number(documentState.currentPage) === page) return true;
  if ((uiState.imageCropMode || uiState.currentTool === 'removeImage')
      && Number(documentState.currentPage) === page) return true;
  const tool = String(uiState.currentTool || '');
  return Number(documentState.currentPage) === page && !PASSIVE_TOOLS.has(tool);
}

export function continuousOverlayBackingPlan({
  logicalWidth,
  logicalHeight,
  devicePixelRatio = 1,
  required = true,
} = {}) {
  const cssWidth = Math.max(1, Number(logicalWidth) || 1);
  const cssHeight = Math.max(1, Number(logicalHeight) || 1);
  const dpr = Math.max(1, Number(devicePixelRatio) || 1);
  return Object.freeze({
    cssWidth,
    cssHeight,
    backingWidth: required ? Math.max(1, Math.floor(cssWidth * dpr)) : 1,
    backingHeight: required ? Math.max(1, Math.floor(cssHeight * dpr)) : 1,
    compact: !required,
  });
}
