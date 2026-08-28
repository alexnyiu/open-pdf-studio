export function normalizedCanvasDpr(value) {
  const dpr = Number(value);
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

export function canvasBackingDimensions(cssWidth, cssHeight, dpr) {
  const scale = normalizedCanvasDpr(dpr);
  return {
    width: Math.max(1, Math.round(Math.max(0, Number(cssWidth) || 0) * scale)),
    height: Math.max(1, Math.round(Math.max(0, Number(cssHeight) || 0) * scale)),
    cssWidth: Math.max(0, Number(cssWidth) || 0),
    cssHeight: Math.max(0, Number(cssHeight) || 0),
    dpr: scale,
  };
}

export function singlePageOverlaySurfaceDimensions({
  viewportActive,
  viewportWidth,
  viewportHeight,
  pageWidth,
  pageHeight,
}) {
  const positive = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  const page = {
    width: positive(pageWidth),
    height: positive(pageHeight),
  };
  if (!viewportActive) return page;
  const viewport = {
    width: positive(viewportWidth),
    height: positive(viewportHeight),
  };
  return viewport.width > 0 && viewport.height > 0 ? viewport : page;
}

export function overlayCanvasTransform({ viewportActive, zoom, offsetX, offsetY, legacyScale, dpr }) {
  const pixelRatio = normalizedCanvasDpr(dpr);
  const scale = (viewportActive ? Number(zoom) : Number(legacyScale)) * pixelRatio;
  return {
    a: scale,
    b: 0,
    c: 0,
    d: scale,
    e: viewportActive ? (Number(offsetX) || 0) * pixelRatio : 0,
    f: viewportActive ? (Number(offsetY) || 0) * pixelRatio : 0,
  };
}

export function overlayVisibleBounds({ backingWidth, backingHeight, viewportActive, zoom, offsetX, offsetY, legacyScale, dpr }) {
  const transform = overlayCanvasTransform({
    viewportActive, zoom, offsetX, offsetY, legacyScale, dpr,
  });
  return viewportActive ? {
    x: -(Number(offsetX) || 0) / (Number(zoom) || 1),
    y: -(Number(offsetY) || 0) / (Number(zoom) || 1),
    width: backingWidth / transform.a,
    height: backingHeight / transform.d,
  } : {
    x: 0,
    y: 0,
    width: backingWidth / transform.a,
    height: backingHeight / transform.d,
  };
}
