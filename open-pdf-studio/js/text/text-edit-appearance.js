export function normalizePageRotation(rotation) {
  const normalized = ((Number(rotation) || 0) % 360 + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

/**
 * PDF.js multiplies viewport scale by a page's UserUnit and applies the
 * intrinsic page rotation. The unified single-page viewport applies both
 * sizing and rotation itself, so its text layer must stay in unrotated raw
 * PDF user space or it will be transformed twice.
 */
export function rawPdfTextLayerViewportOptions(userUnit = 1) {
  const numericUserUnit = Number(userUnit);
  const pointsPerUserUnit = Number.isFinite(numericUserUnit) && numericUserUnit > 0
    ? numericUserUnit
    : 1;
  return { scale: 1 / pointsPerUserUnit, rotation: 0 };
}

/**
 * Return the occupied horizontal source interval for one PDF text line.
 * PDF.js may split one show-text operator into word spans. Summing their
 * widths drops the explicit gaps, while DOM bounds can be distorted by a
 * fallback font's scaleX.
 */
export function sourceTextLineExtent(items) {
  if (!Array.isArray(items) || items.length === 0) return { x: 0, width: 0 };
  const left = Math.min(...items.map((item) => Number(item.pdfX) || 0));
  const right = Math.max(...items.map((item) =>
    (Number(item.pdfX) || 0) + Math.max(0, Number(item.pdfWidth) || 0)));
  return { x: left, width: Math.max(0, right - left) };
}

export function getPageRotationMatrix(pageWidth, pageHeight, rotation) {
  switch (normalizePageRotation(rotation)) {
    case 90:
      return [0, 1, -1, 0, pageHeight, 0];
    case 180:
      return [-1, 0, 0, -1, pageWidth, pageHeight];
    case 270:
      return [0, -1, 1, 0, 0, pageWidth];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

export function getTextLayerCssMatrix(
  pageWidth,
  pageHeight,
  rotation,
  zoom = 1,
  offsetX = 0,
  offsetY = 0,
) {
  const [a, b, c, d, e, f] = getPageRotationMatrix(pageWidth, pageHeight, rotation);
  return [
    a * zoom,
    b * zoom,
    c * zoom,
    d * zoom,
    offsetX + e * zoom,
    offsetY + f * zoom,
  ];
}

export function applyPageRotation(x, y, pageWidth, pageHeight, rotation) {
  const [a, b, c, d, e, f] = getPageRotationMatrix(pageWidth, pageHeight, rotation);
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

export function invertPageRotation(x, y, pageWidth, pageHeight, rotation) {
  switch (normalizePageRotation(rotation)) {
    case 90:
      return { x: y, y: pageHeight - x };
    case 180:
      return { x: pageWidth - x, y: pageHeight - y };
    case 270:
      return { x: pageWidth - y, y: x };
    default:
      return { x, y };
  }
}

export function getRotatedPageSize(pageWidth, pageHeight, rotation) {
  const quarterTurn = normalizePageRotation(rotation) % 180 !== 0;
  return quarterTurn
    ? { width: pageHeight, height: pageWidth }
    : { width: pageWidth, height: pageHeight };
}

export function resolveTextEditPageGeometry(dims, displayWidth, displayHeight, extraRotation = 0) {
  const intrinsicRotation = Number(dims?.rotation) || 0;
  const rotation = normalizePageRotation(intrinsicRotation + extraRotation);
  const hasStoredDimensions = Number(dims?.widthPt) > 0 && Number(dims?.heightPt) > 0;
  const pageWidth = hasStoredDimensions
    ? Number(dims.widthPt)
    : (rotation % 180 ? displayHeight : displayWidth);
  const pageHeight = hasStoredDimensions
    ? Number(dims.heightPt)
    : (rotation % 180 ? displayWidth : displayHeight);
  const displaySize = getRotatedPageSize(pageWidth, pageHeight, rotation);
  return {
    pageWidth,
    pageHeight,
    rotation,
    displayWidth: displaySize.width,
    displayHeight: displaySize.height,
  };
}

export function elementRectToCanvasPixels(elementRect, canvasRect, canvasWidth, canvasHeight) {
  if (!canvasRect?.width || !canvasRect?.height || !canvasWidth || !canvasHeight) return null;
  const scaleX = canvasWidth / canvasRect.width;
  const scaleY = canvasHeight / canvasRect.height;
  const left = Math.max(0, Math.floor((elementRect.left - canvasRect.left) * scaleX));
  const top = Math.max(0, Math.floor((elementRect.top - canvasRect.top) * scaleY));
  const right = Math.min(canvasWidth, Math.ceil((elementRect.right - canvasRect.left) * scaleX));
  const bottom = Math.min(canvasHeight, Math.ceil((elementRect.bottom - canvasRect.top) * scaleY));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function componentHex(value) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
}

export function selectTextColor(pixels, fallback = '#000000', width = 0, height = 0) {
  if (!pixels || pixels.length < 4) return fallback;
  const clusters = new Map();
  const hasBounds = width > 1 && height > 1 && width * height * 4 <= pixels.length;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    if (alpha < 32) continue;
    if (hasBounds) {
      const pixelIndex = i / 4;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
    }
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const key = `${r >> 3},${g >> 3},${b >> 3}`;
    const cluster = clusters.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    cluster.count++;
    cluster.r += r;
    cluster.g += g;
    cluster.b += b;
    clusters.set(key, cluster);
  }

  if (clusters.size === 0) return fallback;
  const background = [...clusters.values()].reduce((largest, cluster) =>
    !largest || cluster.count > largest.count ? cluster : largest
  , null);
  const backgroundColor = [
    background.r / background.count,
    background.g / background.count,
    background.b / background.count,
  ];

  let best = null;
  let bestDistance = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 32) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const distance = (backgroundColor[0] - r) ** 2
      + (backgroundColor[1] - g) ** 2
      + (backgroundColor[2] - b) ** 2;
    if (distance > bestDistance) {
      bestDistance = distance;
      best = [r, g, b];
    }
  }

  if (!best || bestDistance <= 3 * 4 ** 2) return fallback;
  const [r, g, b] = best;
  if (Math.max(r, g, b) <= 24 && Math.max(r, g, b) - Math.min(r, g, b) <= 4) {
    return '#000000';
  }
  return `#${componentHex(r)}${componentHex(g)}${componentHex(b)}`;
}

/**
 * Find a sufficiently uniform dominant background in an RGBA sample. This is
 * used only for the disposable live preview layer: if the source region has a
 * complex background, returning null leaves the saved-PDF source untouched
 * rather than painting an unsafe cover.
 */
export function dominantBackgroundColor(pixels, minimumShare = 0.65) {
  if (!pixels || pixels.length < 4) return null;
  const clusters = new Map();
  let opaque = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3] < 224) continue;
    opaque += 1;
    const key = `${pixels[index] >> 4},${pixels[index + 1] >> 4},${pixels[index + 2] >> 4}`;
    const cluster = clusters.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    cluster.count += 1;
    cluster.r += pixels[index];
    cluster.g += pixels[index + 1];
    cluster.b += pixels[index + 2];
    clusters.set(key, cluster);
  }
  if (opaque === 0 || clusters.size === 0) return null;
  const dominant = [...clusters.values()].reduce((best, candidate) =>
    !best || candidate.count > best.count ? candidate : best, null);
  if (dominant.count / opaque < minimumShare) return null;
  return {
    r: Math.round(dominant.r / dominant.count),
    g: Math.round(dominant.g / dominant.count),
    b: Math.round(dominant.b / dominant.count),
  };
}

export function restoreTextEditSnapshot(record, snapshot) {
  if (!record || !snapshot) return;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(snapshot, key)) delete record[key];
  }
  Object.assign(record, snapshot);
}

export function sampleTextColor(canvas, elementRect, fallback = '#000000') {
  if (!canvas || !elementRect) return fallback;
  try {
    const bounds = elementRectToCanvasPixels(
      elementRect,
      canvas.getBoundingClientRect(),
      canvas.width,
      canvas.height,
    );
    if (!bounds) return fallback;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return fallback;
    const image = context.getImageData(bounds.x, bounds.y, bounds.width, bounds.height);
    return selectTextColor(image.data, fallback, bounds.width, bounds.height);
  } catch (_) {
    return fallback;
  }
}
