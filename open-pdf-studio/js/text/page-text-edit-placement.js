import {
  applyPageRotation,
  invertPageRotation,
  normalizePageRotation,
} from './text-edit-appearance.js';

const FONT_STYLES = new Set(['normal', 'italic', 'oblique']);
const TEXT_ALIGNMENTS = new Set(['left', 'center', 'right', 'start', 'end', 'justify']);
const DIRECTIONS = new Set(['ltr', 'rtl', 'auto']);
const BORDER_STYLES = new Set(['none', 'hidden', 'solid', 'dashed', 'dotted', 'double']);
const BOX_SIZING = new Set(['border-box', 'content-box']);
const RESIZE_VALUES = new Set(['none', 'both', 'horizontal', 'vertical', 'block', 'inline']);
const OVERFLOW_VALUES = new Set(['visible', 'hidden', 'clip', 'scroll', 'auto']);
const WHITE_SPACE_VALUES = new Set(['normal', 'pre', 'pre-wrap', 'pre-line', 'nowrap', 'break-spaces']);
const OVERFLOW_WRAP_VALUES = new Set(['normal', 'break-word', 'anywhere']);
const WORD_BREAK_VALUES = new Set(['normal', 'break-all', 'keep-all', 'break-word']);
const POINTER_EVENTS_VALUES = new Set(['auto', 'none']);
const IMAGE_RENDERING_VALUES = new Set(['auto', 'smooth', 'high-quality', 'crisp-edges', 'pixelated']);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalNumber(value, minimum = Number.NEGATIVE_INFINITY) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : null;
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalToken(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function copyNumber(target, key, value, minimum = Number.NEGATIVE_INFINITY) {
  const number = optionalNumber(value, minimum);
  if (number != null) target[key] = number;
}

function copyString(target, key, value) {
  const string = optionalString(value);
  if (string != null) target[key] = string;
}

function copyToken(target, key, value, allowed) {
  const token = optionalToken(value, allowed);
  if (token != null) target[key] = token;
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
  sourceRotation = 0,
  canonicalStyle = {},
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
    sourceRotation: normalizePageRotation(sourceRotation),
    canonicalStyle: createPageTextEditStyle(canonicalStyle),
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

/**
 * Normalize the only presentation fields that a page text editor may project.
 * All lengths are unrotated PDF page units. CSS is deliberately not accepted at
 * this boundary: callers provide semantic values and projection creates CSS.
 */
export function createPageTextEditStyle(style = {}) {
  const geometry = {};
  copyNumber(geometry, 'width', style.geometry?.width, 0);
  copyNumber(geometry, 'height', style.geometry?.height, 0);
  copyNumber(geometry, 'offsetX', style.geometry?.offsetX);
  copyNumber(geometry, 'offsetY', style.geometry?.offsetY);
  const zIndex = style.geometry?.zIndex;
  if ((typeof zIndex === 'string' && /^-?\d+$/u.test(zIndex)) || Number.isFinite(zIndex)) {
    geometry.zIndex = String(zIndex);
  }

  const typography = {};
  copyString(typography, 'fontFamily', style.typography?.fontFamily);
  copyNumber(typography, 'fontSize', style.typography?.fontSize, 0);
  copyNumber(typography, 'lineHeight', style.typography?.lineHeight, 0);
  copyNumber(typography, 'lineHeightMultiplier', style.typography?.lineHeightMultiplier, 0);
  const fontWeight = style.typography?.fontWeight;
  if ((typeof fontWeight === 'string' && /^(normal|bold|[1-9]00)$/u.test(fontWeight))
      || (Number.isFinite(fontWeight) && fontWeight >= 1 && fontWeight <= 1000)) {
    typography.fontWeight = String(fontWeight);
  }
  copyToken(typography, 'fontStyle', style.typography?.fontStyle, FONT_STYLES);
  copyToken(typography, 'textAlign', style.typography?.textAlign, TEXT_ALIGNMENTS);
  copyString(typography, 'color', style.typography?.color);
  copyToken(typography, 'direction', style.typography?.direction, DIRECTIONS);
  if (style.typography?.fontSynthesis === 'none') typography.fontSynthesis = 'none';

  const padding = {};
  const allPadding = optionalNumber(style.padding?.all, 0);
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const sidePadding = optionalNumber(style.padding?.[side], 0);
    if (sidePadding != null) padding[side] = sidePadding;
    else if (allPadding != null) padding[side] = allPadding;
  }

  const border = {};
  copyNumber(border, 'width', style.border?.width, 0);
  copyToken(border, 'style', style.border?.style, BORDER_STYLES);
  copyString(border, 'color', style.border?.color);
  copyToken(border, 'boxSizing', style.border?.boxSizing, BOX_SIZING);

  const decoration = {};
  copyString(decoration, 'backgroundColor', style.decoration?.backgroundColor);
  copyToken(decoration, 'outlineStyle', style.decoration?.outlineStyle, BORDER_STYLES);
  copyNumber(decoration, 'outlineWidth', style.decoration?.outlineWidth, 0);
  copyString(decoration, 'outlineColor', style.decoration?.outlineColor);
  copyNumber(decoration, 'outlineOffset', style.decoration?.outlineOffset);
  copyString(decoration, 'textDecorationLine', style.decoration?.textDecorationLine);
  copyNumber(decoration, 'textDecorationThickness', style.decoration?.textDecorationThickness, 0);
  copyNumber(decoration, 'textDecorationThicknessEm', style.decoration?.textDecorationThicknessEm, 0);
  copyNumber(decoration, 'textUnderlineOffset', style.decoration?.textUnderlineOffset);
  copyNumber(decoration, 'textUnderlineOffsetEm', style.decoration?.textUnderlineOffsetEm);
  copyString(decoration, 'textShadow', style.decoration?.textShadow);
  copyString(decoration, 'caretColor', style.decoration?.caretColor);
  copyNumber(decoration, 'textOffset', style.decoration?.textOffset);

  const layout = {};
  copyToken(layout, 'resize', style.layout?.resize, RESIZE_VALUES);
  copyToken(layout, 'overflow', style.layout?.overflow, OVERFLOW_VALUES);
  copyToken(layout, 'whiteSpace', style.layout?.whiteSpace, WHITE_SPACE_VALUES);
  copyToken(layout, 'overflowWrap', style.layout?.overflowWrap, OVERFLOW_WRAP_VALUES);
  copyToken(layout, 'wordBreak', style.layout?.wordBreak, WORD_BREAK_VALUES);
  copyToken(layout, 'pointerEvents', style.layout?.pointerEvents, POINTER_EVENTS_VALUES);
  copyToken(layout, 'imageRendering', style.layout?.imageRendering, IMAGE_RENDERING_VALUES);

  return { geometry, typography, padding, border, decoration, layout };
}

/** Merge a semantic style patch without reopening the CSS parsing boundary. */
export function mergePageTextEditStyle(style, patch) {
  const current = createPageTextEditStyle(style);
  const typography = { ...current.typography, ...patch?.typography };
  if (Object.hasOwn(patch?.typography || {}, 'lineHeight')) delete typography.lineHeightMultiplier;
  if (Object.hasOwn(patch?.typography || {}, 'lineHeightMultiplier')) delete typography.lineHeight;
  const padding = Object.hasOwn(patch?.padding || {}, 'all')
    ? { all: patch.padding.all, ...Object.fromEntries(
      ['top', 'right', 'bottom', 'left']
        .filter((side) => Object.hasOwn(patch.padding, side))
        .map((side) => [side, patch.padding[side]]),
    ) }
    : { ...current.padding, ...patch?.padding };
  const decoration = { ...current.decoration, ...patch?.decoration };
  if (Object.hasOwn(patch?.decoration || {}, 'textDecorationThickness')) {
    delete decoration.textDecorationThicknessEm;
  }
  if (Object.hasOwn(patch?.decoration || {}, 'textDecorationThicknessEm')) {
    delete decoration.textDecorationThickness;
  }
  if (Object.hasOwn(patch?.decoration || {}, 'textUnderlineOffset')) {
    delete decoration.textUnderlineOffsetEm;
  }
  if (Object.hasOwn(patch?.decoration || {}, 'textUnderlineOffsetEm')) {
    delete decoration.textUnderlineOffset;
  }
  return createPageTextEditStyle({
    geometry: { ...current.geometry, ...patch?.geometry },
    typography,
    padding,
    border: { ...current.border, ...patch?.border },
    decoration,
    layout: { ...current.layout, ...patch?.layout },
  });
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

function projectCanonicalStyle(style, targetScale) {
  const canonical = createPageTextEditStyle(style);
  const { typography, padding, border, decoration, layout } = canonical;
  const output = {};
  if (typography.fontFamily) output['font-family'] = typography.fontFamily;
  if (typography.fontSize != null) output['font-size'] = `${typography.fontSize * targetScale}px`;
  if (typography.lineHeight != null) output['line-height'] = `${typography.lineHeight * targetScale}px`;
  else if (typography.lineHeightMultiplier != null) output['line-height'] = String(typography.lineHeightMultiplier);
  if (typography.fontWeight) output['font-weight'] = typography.fontWeight;
  if (typography.fontStyle) output['font-style'] = typography.fontStyle;
  if (typography.textAlign) output['text-align'] = typography.textAlign;
  if (typography.color) output.color = typography.color;
  if (typography.direction) output.direction = typography.direction;
  if (typography.fontSynthesis) output['font-synthesis'] = typography.fontSynthesis;

  for (const side of ['top', 'right', 'bottom', 'left']) {
    if (padding[side] != null) output[`padding-${side}`] = `${padding[side] * targetScale}px`;
  }
  if (border.width != null) output['border-width'] = `${border.width * targetScale}px`;
  if (border.style) output['border-style'] = border.style;
  if (border.color) output['border-color'] = border.color;
  if (border.boxSizing) output['box-sizing'] = border.boxSizing;

  if (decoration.backgroundColor) output['background-color'] = decoration.backgroundColor;
  if (decoration.outlineStyle) output['outline-style'] = decoration.outlineStyle;
  if (decoration.outlineWidth != null) output['outline-width'] = `${decoration.outlineWidth * targetScale}px`;
  if (decoration.outlineColor) output['outline-color'] = decoration.outlineColor;
  if (decoration.outlineOffset != null) output['outline-offset'] = `${decoration.outlineOffset * targetScale}px`;
  if (decoration.textDecorationLine) output['text-decoration-line'] = decoration.textDecorationLine;
  if (decoration.textDecorationThickness != null) {
    output['text-decoration-thickness'] = `${decoration.textDecorationThickness * targetScale}px`;
  } else if (decoration.textDecorationThicknessEm != null) {
    output['text-decoration-thickness'] = `${decoration.textDecorationThicknessEm}em`;
  }
  if (decoration.textUnderlineOffset != null) {
    output['text-underline-offset'] = `${decoration.textUnderlineOffset * targetScale}px`;
  } else if (decoration.textUnderlineOffsetEm != null) {
    output['text-underline-offset'] = `${decoration.textUnderlineOffsetEm}em`;
  }
  if (decoration.textShadow) output['text-shadow'] = decoration.textShadow;
  if (decoration.caretColor) output['caret-color'] = decoration.caretColor;
  if (decoration.textOffset != null) output['--text-offset'] = `${decoration.textOffset * targetScale}px`;

  if (layout.resize) output.resize = layout.resize;
  if (layout.overflow) output.overflow = layout.overflow;
  if (layout.whiteSpace) output['white-space'] = layout.whiteSpace;
  if (layout.overflowWrap) output['overflow-wrap'] = layout.overflowWrap;
  if (layout.wordBreak) output['word-break'] = layout.wordBreak;
  if (layout.pointerEvents) output['pointer-events'] = layout.pointerEvents;
  if (layout.imageRendering) output['image-rendering'] = layout.imageRendering;
  return output;
}

/** Project a stable placement into one page-local editing host. */
export function projectPageTextEditPlacement(placement, frame) {
  if (!placement || !frame || !(frame.scale > 0)) return null;
  const bounds = placement.canonicalBounds;
  const canonicalStyle = createPageTextEditStyle(placement.canonicalStyle);
  const offsetX = canonicalStyle.geometry.offsetX || 0;
  const offsetY = canonicalStyle.geometry.offsetY || 0;
  const origin = applyPageRotation(
    bounds.x + offsetX,
    bounds.y + offsetY,
    frame.pageWidth,
    frame.pageHeight,
    frame.rotation,
  );
  const styleWidth = canonicalStyle.geometry.width;
  const styleHeight = canonicalStyle.geometry.height;
  const width = styleWidth != null
    ? styleWidth * frame.scale
    : bounds.width * frame.scale;
  const height = styleHeight != null
    ? styleHeight * frame.scale
    : bounds.height * frame.scale;
  const rotation = normalizePageRotation(frame.rotation + placement.elementRotation);
  const rotationTransform = rotation ? `rotate(${rotation}deg)` : '';
  const transform = placement.anchor === 'center'
    ? `translate(-50%, -50%)${rotationTransform ? ` ${rotationTransform}` : ''}`
    : (rotationTransform || 'none');
  return {
    ...projectCanonicalStyle(canonicalStyle, frame.scale),
    position: 'absolute',
    left: `${frame.offsetX + origin.x * frame.scale}px`,
    top: `${frame.offsetY + origin.y * frame.scale}px`,
    width: `${width}px`,
    height: `${height}px`,
    'max-width': `${width}px`,
    transform,
    'transform-origin': '0 0',
    'z-index': canonicalStyle.geometry.zIndex || '2',
  };
}

/** Compare every generated CSS field before scheduling or performing a write. */
export function shallowEqualPageTextEditProjection(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

/** Apply one complete projected result, clearing fields removed by a later projection. */
export function applyPageTextEditProjection(element, projected, previous = null) {
  if (!element?.style || !projected || shallowEqualPageTextEditProjection(previous, projected)) return false;
  for (const key of Object.keys(previous || {})) {
    if (!Object.hasOwn(projected, key)) element.style.removeProperty?.(key);
  }
  for (const [key, value] of Object.entries(projected)) {
    if (previous?.[key] !== value) element.style.setProperty?.(key, String(value));
  }
  return true;
}

export function projectCommitBounds(placement, frame) {
  if (!placement?.commitBounds) return null;
  const projected = projectPageTextEditPlacement({
    ...placement,
    canonicalBounds: placement.commitBounds,
    canonicalStyle: createPageTextEditStyle(),
    sourceClientAnchor: null,
  }, frame);
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
  // scrollWidth/scrollHeight are integer CSS pixels while projected PDF
  // bounds are often fractional. Allow one pixel of measurement rounding so
  // an exactly fitting draft does not surface a false overflow warning.
  const overflowEpsilon = 1;
  const commitWidth = Math.max(1, finite(minimumWidth, 1));
  const commitHeight = Math.max(1, finite(minimumHeight, 1));
  const contentWidth = Math.max(0, finite(scrollWidth));
  const contentHeight = Math.max(0, finite(scrollHeight));
  const width = fixedWidth ? commitWidth : Math.max(commitWidth, contentWidth);
  const height = Math.max(commitHeight, contentHeight);
  return {
    width,
    height,
    overflowX: fixedWidth && contentWidth > commitWidth + overflowEpsilon,
    overflowY: contentHeight > commitHeight + overflowEpsilon,
    overflowing: (fixedWidth && contentWidth > commitWidth + overflowEpsilon)
      || contentHeight > commitHeight + overflowEpsilon,
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
