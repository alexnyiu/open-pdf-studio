const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

/**
 * Plan page-local full-density tiles for the visible part of a continuous or
 * facing page. Coordinates are in the already-rotated page coordinate space,
 * matching the PDFium region renderer when the same rotation is supplied.
 */
export function planVisiblePageTiles({
  pageRect,
  viewportRect,
  predictedRect = null,
  cssScale,
  devicePixelRatio,
  pageWidthPt,
  pageHeightPt,
  maxBitmapAxisPx = 4096,
  seamOverscanPx = 2,
} = {}) {
  const scale = Number(cssScale);
  const dpr = Number(devicePixelRatio);
  const widthPt = Number(pageWidthPt);
  const heightPt = Number(pageHeightPt);
  if (![scale, dpr, widthPt, heightPt].every((value) => Number.isFinite(value) && value > 0)) return [];
  if (!pageRect || !viewportRect) return [];

  viewportRect = predictedRect || viewportRect;
  const left = Math.max(pageRect.left, viewportRect.left);
  const top = Math.max(pageRect.top, viewportRect.top);
  const right = Math.min(pageRect.right, viewportRect.right);
  const bottom = Math.min(pageRect.bottom, viewportRect.bottom);
  if (right <= left || bottom <= top) return [];

  const targetScale = scale * dpr;
  const overscanCss = Math.max(0, Number(seamOverscanPx) || 0) / dpr;
  const visibleX = clamp((left - pageRect.left - overscanCss) / scale, 0, widthPt);
  const visibleY = clamp((top - pageRect.top - overscanCss) / scale, 0, heightPt);
  const visibleRight = clamp((right - pageRect.left + overscanCss) / scale, 0, widthPt);
  const visibleBottom = clamp((bottom - pageRect.top + overscanCss) / scale, 0, heightPt);
  const visibleW = Math.max(0, visibleRight - visibleX);
  const visibleH = Math.max(0, visibleBottom - visibleY);
  if (!visibleW || !visibleH) return [];

  const seamPt = Math.max(0, Number(seamOverscanPx) || 0) / targetScale;
  const coreMaxPt = Math.max(1 / targetScale,
    (Math.max(1, Number(maxBitmapAxisPx) || 4096) - seamOverscanPx * 2 - 1) / targetScale);
  const tiles = [];
  for (let coreY = Math.floor(visibleY / coreMaxPt) * coreMaxPt; coreY < visibleBottom - 1e-7; coreY += coreMaxPt) {
    const coreBottom = Math.min(heightPt, coreY + coreMaxPt);
    for (let coreX = Math.floor(visibleX / coreMaxPt) * coreMaxPt; coreX < visibleRight - 1e-7; coreX += coreMaxPt) {
      const coreRight = Math.min(widthPt, coreX + coreMaxPt);
      const regionXpt = clamp(coreX - seamPt, 0, widthPt);
      const regionYpt = clamp(coreY - seamPt, 0, heightPt);
      const regionRight = clamp(coreRight + seamPt, 0, widthPt);
      const regionBottom = clamp(coreBottom + seamPt, 0, heightPt);
      const regionWpt = regionRight - regionXpt;
      const regionHpt = regionBottom - regionYpt;
      tiles.push(Object.freeze({
        regionXpt,
        regionYpt,
        regionWpt,
        regionHpt,
        cssLeft: regionXpt * scale,
        cssTop: regionYpt * scale,
        cssWidth: regionWpt * scale,
        cssHeight: regionHpt * scale,
        targetScale,
        expectedPixelWidth: Math.ceil(regionWpt * targetScale),
        expectedPixelHeight: Math.ceil(regionHpt * targetScale),
      }));
    }
  }
  return tiles;
}
