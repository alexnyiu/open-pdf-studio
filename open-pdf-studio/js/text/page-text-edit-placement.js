import {
  applyPageRotation,
  invertPageRotation,
  normalizePageRotation,
} from './text-edit-appearance.js';

const SCALED_STYLE_PROPERTIES = new Set([
  'font-size',
  'line-height',
  'padding',
  'padding-left',
  'padding-right',
  'padding-top',
  'padding-bottom',
  'outline-offset',
  'text-decoration-thickness',
  'text-underline-offset',
]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pixelValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim().endsWith('px')) return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

function assertBounds(bounds, label) {
  const normalized = {
    x: finite(bounds?.x, Number.NaN),
    y: finite(bounds?.y, Number.NaN),
    width: finite(bounds?.width, Number.NaN),
    height: finite(bounds?.height, Number.NaN),
  };
  if (!Object.values(normalized).every(Number.isFinite)
      || normalized.width <= 0 || normalized.height <= 0) {
    throw new TypeError(`${label} must contain finite positive page bounds`);
  }
  return normalized;
}

/**
 * Create the stable, JSON-compatible placement carried by a live text editor.
 * Coordinates use unrotated PDF page space with a top-left origin. This is a
 * presentation contract only; OCR repair geometry and native provenance remain
 * owned by their existing records.
 */
export function createPageTextEditPlacement({
  documentId,
  pageNum,
  pageWidth,
  pageHeight,
  canonicalBounds,
  commitBounds = null,
  sourceScale = 1,
  sourceStyle = {},
  sourceClientAnchor = null,
  mode = 'native-expandable',
  elementRotation = 0,
  anchor = 'top-left',
  generation = 0,
}) {
  if (!documentId || !Number.isInteger(pageNum) || pageNum < 1) {
    throw new TypeError('Page text edit placement requires a document and page identity');
  }
  const width = finite(pageWidth, Number.NaN);
  const height = finite(pageHeight, Number.NaN);
  const scale = finite(sourceScale, Number.NaN);
  if (!(width > 0) || !(height > 0) || !(scale > 0)) {
    throw new TypeError('Page text edit placement requires positive page geometry and scale');
  }
  const bounds = assertBounds(canonicalBounds, 'canonicalBounds');
  return {
    documentId: String(documentId),
    pageNum,
    coordinateSpace: 'pdf-page-top-left',
    pageWidth: width,
    pageHeight: height,
    canonicalBounds: bounds,
    commitBounds: commitBounds ? assertBounds(commitBounds, 'commitBounds') : null,
    sourceScale: scale,
    sourceStyle: { ...sourceStyle },
    sourceClientAnchor: sourceClientAnchor ? {
      left: finite(sourceClientAnchor.left),
      top: finite(sourceClientAnchor.top),
    } : null,
    mode,
    elementRotation: finite(elementRotation),
    anchor: anchor === 'center' ? 'center' : 'top-left',
    generation: Math.max(0, Math.trunc(finite(generation))),
  };
}

/** Convert an axis-aligned on-screen rectangle into unrotated page space. */
export function canonicalBoundsFromDisplayRect(rect, frame) {
  if (!(frame?.scale > 0)) throw new TypeError('Display conversion requires a positive page scale');
  const left = (finite(rect?.left) - finite(frame.containerLeft) - finite(frame.offsetX)) / frame.scale;
  const top = (finite(rect?.top) - finite(frame.containerTop) - finite(frame.offsetY)) / frame.scale;
  const width = finite(rect?.width) / frame.scale;
  const height = finite(rect?.height) / frame.scale;
  const corners = [
    [left, top],
    [left + width, top],
    [left, top + height],
    [left + width, top + height],
  ].map(([x, y]) => invertPageRotation(
    x, y, frame.pageWidth, frame.pageHeight, frame.rotation,
  ));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function scaledStyle(sourceStyle, sourceScale, targetScale) {
  const ratio = targetScale / sourceScale;
  const output = {};
  for (const [key, value] of Object.entries(sourceStyle || {})) {
    if (['position', 'left', 'top', 'width', 'height', 'max-width', 'max-height', 'transform', 'transform-origin', 'z-index'].includes(key)) continue;
    const pixels = SCALED_STYLE_PROPERTIES.has(key) ? pixelValue(value) : null;
    output[key] = pixels == null ? value : `${pixels * ratio}px`;
  }
  return output;
}

/** Project a stable placement into one page-local editing host. */
export function projectPageTextEditPlacement(placement, frame, style = placement?.sourceStyle) {
  if (!placement || !frame || !(frame.scale > 0)) return null;
  const bounds = placement.canonicalBounds;
  const origin = applyPageRotation(
    bounds.x,
    bounds.y,
    frame.pageWidth,
    frame.pageHeight,
    frame.rotation,
  );
  const sourceLeft = pixelValue(style?.left);
  const sourceTop = pixelValue(style?.top);
  const anchor = placement.sourceClientAnchor;
  const deltaLeft = anchor && sourceLeft != null
    ? (sourceLeft - anchor.left) / placement.sourceScale * frame.scale : 0;
  const deltaTop = anchor && sourceTop != null
    ? (sourceTop - anchor.top) / placement.sourceScale * frame.scale : 0;
  const sourceWidth = pixelValue(style?.width);
  const sourceHeight = pixelValue(style?.height);
  const width = sourceWidth != null
    ? sourceWidth / placement.sourceScale * frame.scale
    : bounds.width * frame.scale;
  const height = sourceHeight != null
    ? sourceHeight / placement.sourceScale * frame.scale
    : bounds.height * frame.scale;
  const rotation = normalizePageRotation(frame.rotation + placement.elementRotation);
  const rotationTransform = rotation ? `rotate(${rotation}deg)` : '';
  const transform = placement.anchor === 'center'
    ? `translate(-50%, -50%)${rotationTransform ? ` ${rotationTransform}` : ''}`
    : (rotationTransform || 'none');
  return {
    ...scaledStyle(style, placement.sourceScale, frame.scale),
    position: 'absolute',
    left: `${frame.offsetX + origin.x * frame.scale + deltaLeft}px`,
    top: `${frame.offsetY + origin.y * frame.scale + deltaTop}px`,
    width: `${width}px`,
    height: `${height}px`,
    'max-width': `${width}px`,
    transform,
    'transform-origin': '0 0',
    'z-index': style?.['z-index'] || '2',
  };
}

export function projectCommitBounds(placement, frame) {
  if (!placement?.commitBounds) return null;
  const projected = projectPageTextEditPlacement({
    ...placement,
    canonicalBounds: placement.commitBounds,
    sourceStyle: {},
    sourceClientAnchor: null,
  }, frame, {});
  if (!projected) return null;
  return {
    position: projected.position,
    left: projected.left,
    top: projected.top,
    width: projected.width,
    height: projected.height,
    transform: projected.transform,
    'transform-origin': projected['transform-origin'],
  };
}

/** Determine a scrollbar-free preview while retaining immutable commit bounds. */
export function scrollFreePreviewSize({
  minimumWidth,
  minimumHeight,
  scrollWidth,
  scrollHeight,
  fixedWidth = true,
}) {
  const commitWidth = Math.max(1, finite(minimumWidth, 1));
  const commitHeight = Math.max(1, finite(minimumHeight, 1));
  const contentWidth = Math.max(0, finite(scrollWidth));
  const contentHeight = Math.max(0, finite(scrollHeight));
  const width = fixedWidth ? commitWidth : Math.max(commitWidth, contentWidth);
  const height = Math.max(commitHeight, contentHeight);
  return {
    width,
    height,
    overflowX: fixedWidth && contentWidth > commitWidth + 0.5,
    overflowY: contentHeight > commitHeight + 0.5,
    overflowing: (fixedWidth && contentWidth > commitWidth + 0.5)
      || contentHeight > commitHeight + 0.5,
  };
}

/** Convert a display-space drag vector into unrotated canonical page units. */
export function canonicalDeltaFromDisplayDelta(delta, frame) {
  const scale = finite(frame?.scale, Number.NaN);
  if (!(scale > 0)) throw new TypeError('Display drag conversion requires a positive page scale');
  const dx = finite(delta?.x) / scale;
  const dy = finite(delta?.y) / scale;
  switch (normalizePageRotation(frame?.rotation)) {
    case 90: return { x: dy, y: -dx };
    case 180: return { x: -dx, y: -dy };
    case 270: return { x: -dy, y: dx };
    default: return { x: dx, y: dy };
  }
}

/** Keep a directly manipulated editor inside its canonical page rectangle. */
export function clampPageTextEditBounds(bounds, page, minimum = {}) {
  const pageWidth = finite(page?.width, Number.NaN);
  const pageHeight = finite(page?.height, Number.NaN);
  if (!(pageWidth > 0) || !(pageHeight > 0)) {
    throw new TypeError('Editor bounds require positive page dimensions');
  }
  const minimumWidth = Math.min(pageWidth, Math.max(1, finite(minimum.width, 1)));
  const minimumHeight = Math.min(pageHeight, Math.max(1, finite(minimum.height, 1)));
  const width = Math.min(pageWidth, Math.max(minimumWidth, finite(bounds?.width, minimumWidth)));
  const height = Math.min(pageHeight, Math.max(minimumHeight, finite(bounds?.height, minimumHeight)));
  return {
    x: Math.max(0, Math.min(pageWidth - width, finite(bounds?.x))),
    y: Math.max(0, Math.min(pageHeight - height, finite(bounds?.y))),
    width,
    height,
  };
}
