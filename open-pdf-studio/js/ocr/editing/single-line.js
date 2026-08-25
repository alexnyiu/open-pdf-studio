import { StandardFontEmbedder, StandardFonts } from 'pdf-lib';

import {
  OCR_PDF_USER_SPACE,
  OCR_SOURCE_RASTER_SPACE,
  mapPointBetweenSpaces,
  mapPolygonBetweenSpaces,
} from '../contracts/geometry.js';
import {
  base64ToBytes,
  bytesToBase64,
  sha256Hex,
  zeroBytes,
} from './raster.js';
import { resolvePackagedFace, shapeTextRun } from '../../text/font-catalog.js';

export const SCANNED_TEXT_SINGLE_LINE_SCOPE = 'isolated-horizontal-line';
export const SCANNED_TEXT_MAX_BASELINE_ANGLE_DEGREES = 3;
export const SCANNED_TEXT_MAX_EDGE_WARP_RATIO = 0.18;
export const SCANNED_TEXT_REPAIR_HALO_TOLERANCE = Object.freeze({
  maxBoundaryChannelDelta: 72,
  meanBoundaryChannelDelta: 24,
});

const DISALLOWED_CONTENT_CODES = new Set([
  'handwriting',
  'table',
  'math',
  'vertical-text',
  'curved-text',
  'rotated-text',
  'low-confidence',
  'unknown-language',
  'complex-layout',
  'other',
]);

export class ScannedTextSingleLineError extends Error {
  constructor(code, message, evidence = null) {
    super(message);
    this.name = 'ScannedTextSingleLineError';
    this.code = code;
    this.evidence = evidence;
  }
}

function fail(code, message, evidence = null) {
  throw new ScannedTextSingleLineError(code, message, evidence);
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function clone(value) {
  return structuredClone(value);
}

function distance(left, right) {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function angleDegrees(left, right) {
  return Math.atan2(right[1] - left[1], right[0] - left[0]) * 180 / Math.PI;
}

function normalizedHorizontalAngle(value) {
  let angle = value;
  while (angle > 90) angle -= 180;
  while (angle < -90) angle += 180;
  return angle;
}

function median(values, fallback = 0) {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function estimate(value, confidence, method) {
  return { value, estimated: true, confidence: round(confidence, 3), method };
}

function assertSingleLineTarget(result, selected) {
  if (selected.target.kind !== 'line' || selected.target.lineIds.length !== 1) {
    fail('MULTILINE_NOT_SUPPORTED', 'Scanned text editing supports exactly one isolated OCR line');
  }
  const line = result.lines.find((entry) => entry.id === selected.target.lineIds[0]);
  if (!line) fail('OCR_ID_NOT_FOUND', 'The selected OCR line is no longer present');
  if (!['completed', 'partial'].includes(result.page.status)) {
    fail('OCR_PAGE_NOT_EDITABLE', 'Only completed or partial OCR pages can be edited');
  }
  if (line.confidence < 0.9 || selected.geometry.confidence < 0.9) {
    fail('LOW_CONFIDENCE_GEOMETRY', 'The OCR line geometry is below the supported confidence threshold', {
      lineConfidence: line.confidence,
      geometryConfidence: selected.geometry.confidence,
    });
  }
  const unsupported = (result.unsupportedContentReasons || [])
    .filter((reason) => DISALLOWED_CONTENT_CODES.has(reason.code));
  if (unsupported.length > 0) {
    fail('UNSUPPORTED_CONTENT', 'The OCR page contains unsupported content for isolated-line editing', {
      codes: unsupported.map((reason) => reason.code),
    });
  }
  const direction = line.detectedWritingDirection ?? 'ltr';
  if (direction !== 'ltr') {
    fail('UNSUPPORTED_TEXT_DIRECTION', 'Only horizontal left-to-right scanned text is supported', { direction });
  }
  try {
    StandardFontEmbedder.for(StandardFonts.Helvetica).encodeText(line.text);
  } catch (error) {
    fail('UNSUPPORTED_SCRIPT', 'The OCR source line uses a script outside the supported single-line font set', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return line;
}

export function canonicalGeometry(line, selected, pageGeometry) {
  const sourcePolygon = selected.geometry.lineGeometry[0].sourcePolygon;
  const canonicalPolygon = mapPolygonBetweenSpaces(
    pageGeometry.transformChain,
    sourcePolygon,
    OCR_PDF_USER_SPACE,
  );
  let sourceBaseline;
  let baselineProvenance;
  if (line.baseline?.status === 'provided' && Array.isArray(line.baseline.points)
      && line.baseline.points.length >= 2) {
    sourceBaseline = line.baseline.points.map((point) => mapPointBetweenSpaces(
      pageGeometry.transformChain,
      point,
      line.baseline.coordinateSpace,
      OCR_SOURCE_RASTER_SPACE,
    ));
    baselineProvenance = line.baseline.provenance || 'ocr-engine';
  } else {
    const points = sourcePolygon.points;
    const leftX = Math.min(...points.map((point) => point[0]));
    const rightX = Math.max(...points.map((point) => point[0]));
    const bottomY = Math.max(...points.map((point) => point[1]));
    const height = Math.max(...points.map((point) => point[1]))
      - Math.min(...points.map((point) => point[1]));
    const baselineY = bottomY - Math.max(1, height * 0.16);
    sourceBaseline = [[leftX, baselineY], [rightX, baselineY]];
    baselineProvenance = 'estimated-from-ocr-polygon';
  }
  const canonicalBaselinePoints = sourceBaseline.map((point) => mapPointBetweenSpaces(
    pageGeometry.transformChain,
    point,
    OCR_SOURCE_RASTER_SPACE,
    OCR_PDF_USER_SPACE,
  ));
  const sourceAngle = normalizedHorizontalAngle(angleDegrees(
    sourceBaseline[0],
    sourceBaseline[sourceBaseline.length - 1],
  ));
  if (Math.abs(sourceAngle) > SCANNED_TEXT_MAX_BASELINE_ANGLE_DEGREES) {
    fail('NON_HORIZONTAL_BASELINE', 'Vertical, rotated, curved, or severely warped OCR lines are not supported', {
      angleDegrees: round(sourceAngle),
      toleranceDegrees: SCANNED_TEXT_MAX_BASELINE_ANGLE_DEGREES,
    });
  }

  const points = sourcePolygon.points;
  if (points.length !== 4) fail('WARPED_TEXT_GEOMETRY', 'The OCR line must have one four-corner polygon');
  const top = distance(points[0], points[1]);
  const bottom = distance(points[3], points[2]);
  const left = distance(points[0], points[3]);
  const right = distance(points[1], points[2]);
  const widthWarp = Math.abs(top - bottom) / Math.max(1, Math.max(top, bottom));
  const heightWarp = Math.abs(left - right) / Math.max(1, Math.max(left, right));
  const warpRatio = Math.max(widthWarp, heightWarp);
  if (warpRatio > SCANNED_TEXT_MAX_EDGE_WARP_RATIO) {
    fail('WARPED_TEXT_GEOMETRY', 'Severely warped OCR lines are not supported', {
      warpRatio: round(warpRatio),
      tolerance: SCANNED_TEXT_MAX_EDGE_WARP_RATIO,
    });
  }

  return {
    sourcePolygon,
    canonicalPolygon,
    sourceBaseline,
    canonicalBaseline: {
      status: 'provided',
      provenance: baselineProvenance,
      coordinateSpace: OCR_PDF_USER_SPACE,
      points: canonicalBaselinePoints,
    },
    sourceAngle,
    warpRatio,
  };
}

function rgbHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function estimateStyle({ line, raster, geometry, pageGeometry, analysis, overrides = {} }) {
  const points = geometry.sourcePolygon.points;
  const minX = Math.max(0, Math.floor(Math.min(...points.map((point) => point[0]))));
  const maxX = Math.min(raster.widthPx, Math.ceil(Math.max(...points.map((point) => point[0]))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
  const maxY = Math.min(raster.heightPx, Math.ceil(Math.max(...points.map((point) => point[1]))));
  const background = analysis.metrics.meanRgb;
  const channels = [[], [], []];
  let foregroundPixels = 0;
  let totalPixels = 0;
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const offset = (y * raster.widthPx + x) * 4;
      const red = raster.data[offset];
      const green = raster.data[offset + 1];
      const blue = raster.data[offset + 2];
      const difference = Math.max(
        Math.abs(red - background[0]),
        Math.abs(green - background[1]),
        Math.abs(blue - background[2]),
      );
      totalPixels += 1;
      if (difference < 28) continue;
      foregroundPixels += 1;
      channels[0].push(red);
      channels[1].push(green);
      channels[2].push(blue);
    }
  }
  const inkCoverage = foregroundPixels / Math.max(1, totalPixels);
  const polygonHeightPt = (distance(
    geometry.canonicalPolygon.points[0],
    geometry.canonicalPolygon.points[3],
  ) + distance(
    geometry.canonicalPolygon.points[1],
    geometry.canonicalPolygon.points[2],
  )) / 2;
  const lineWidthPx = Math.max(1, distance(points[0], points[1]));
  const averageCharacterAspect = lineWidthPx / Math.max(1, Array.from(line.text).length)
    / Math.max(1, maxY - minY);
  const inferredClass = averageCharacterAspect >= 0.62 ? 'monospace'
    : averageCharacterAspect <= 0.43 ? 'serif'
      : 'sans-serif';
  const provisionalFont = inferredClass === 'monospace' ? StandardFonts.Courier
    : inferredClass === 'serif' ? StandardFonts.TimesRoman
      : StandardFonts.Helvetica;
  const provisionalEmbedder = StandardFontEmbedder.for(provisionalFont);
  const canonicalPoints = geometry.canonicalPolygon.points;
  const canonicalLineWidthPt = (distance(canonicalPoints[0], canonicalPoints[1])
    + distance(canonicalPoints[3], canonicalPoints[2])) / 2;
  const heightFitSize = provisionalEmbedder.sizeOfFontAtHeight(Math.max(1, polygonHeightPt * 0.82));
  const sourceTextUnitWidth = provisionalEmbedder.widthOfTextAtSize(line.text, 1);
  const widthFitSize = sourceTextUnitWidth > 0
    ? canonicalLineWidthPt / sourceTextUnitWidth
    : heightFitSize;
  const estimatedSize = Math.max(1, Math.min(heightFitSize, widthFitSize));
  const crop = pageGeometry.boxes?.cropBox || pageGeometry.boxes?.mediaBox;
  const canonicalXs = geometry.canonicalPolygon.points.map((point) => point[0]);
  const lineCenter = (Math.min(...canonicalXs) + Math.max(...canonicalXs)) / 2;
  const pageCenter = crop ? crop.x + crop.width / 2 : lineCenter;
  const centerDelta = crop ? Math.abs(lineCenter - pageCenter) / Math.max(1, crop.width) : 1;
  const rightGap = crop ? crop.x + crop.width - Math.max(...canonicalXs) : Number.POSITIVE_INFINITY;
  const leftGap = crop ? Math.min(...canonicalXs) - crop.x : 0;
  const inferredAlignment = centerDelta <= 0.03 ? 'center'
    : rightGap < leftGap * 0.35 ? 'right'
      : 'left';

  const allowed = new Set(['fontClass', 'fontSize', 'weight', 'italic', 'textColor', 'alignment']);
  for (const key of Object.keys(overrides)) {
    if (!allowed.has(key)) fail('UNSUPPORTED_STYLE_PROPERTY', `Scanned text style ${key} is outside this phase`);
  }
  const fontClass = overrides.fontClass ?? inferredClass;
  const fontSize = Number(overrides.fontSize ?? estimatedSize);
  const weight = overrides.weight ?? (inkCoverage >= 0.27 ? 'bold' : 'normal');
  const italic = overrides.italic ?? false;
  const textColor = overrides.textColor ?? rgbHex(
    median(channels[0], 0),
    median(channels[1], 0),
    median(channels[2], 0),
  );
  const alignment = overrides.alignment ?? inferredAlignment;
  if (!['serif', 'sans-serif', 'monospace'].includes(fontClass)) fail('INVALID_STYLE_ESTIMATE', 'Unsupported estimated font class');
  if (!Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 999) fail('INVALID_STYLE_ESTIMATE', 'Estimated font size is invalid');
  if (!['normal', 'bold'].includes(weight)) fail('INVALID_STYLE_ESTIMATE', 'Estimated weight is invalid');
  if (typeof italic !== 'boolean') fail('INVALID_STYLE_ESTIMATE', 'Estimated italic state is invalid');
  if (!/^#[0-9a-f]{6}$/iu.test(textColor)) fail('INVALID_STYLE_ESTIMATE', 'Estimated text color must be an RGB hex value');
  if (!['left', 'center', 'right'].includes(alignment)) fail('INVALID_STYLE_ESTIMATE', 'Estimated alignment is invalid');
  const overrideMethod = (key, method) => Object.hasOwn(overrides, key) ? 'user-adjusted-estimate' : method;
  return {
    fontClass: estimate(fontClass, Object.hasOwn(overrides, 'fontClass') ? 1 : 0.35, overrideMethod('fontClass', 'character-aspect-heuristic-v1')),
    fontSize: estimate(round(fontSize, 3), Object.hasOwn(overrides, 'fontSize') ? 1 : 0.72, overrideMethod('fontSize', 'polygon-height-font-metrics-v1')),
    weight: estimate(weight, Object.hasOwn(overrides, 'weight') ? 1 : 0.55, overrideMethod('weight', 'foreground-ink-coverage-v1')),
    italic: estimate(italic, Object.hasOwn(overrides, 'italic') ? 1 : 0.3, overrideMethod('italic', 'upright-default-low-confidence-v1')),
    textColor: estimate(textColor.toLowerCase(), Object.hasOwn(overrides, 'textColor') ? 1 : 0.78, overrideMethod('textColor', 'foreground-median-rgb-v1')),
    alignment: estimate(alignment, Object.hasOwn(overrides, 'alignment') ? 1 : 0.45, overrideMethod('alignment', 'page-margin-heuristic-v1')),
  };
}

export function standardFontName(style) {
  const bold = style.weight.value === 'bold';
  const italic = style.italic.value;
  if (style.fontClass.value === 'monospace') {
    return bold && italic ? StandardFonts.CourierBoldOblique
      : bold ? StandardFonts.CourierBold
        : italic ? StandardFonts.CourierOblique
          : StandardFonts.Courier;
  }
  if (style.fontClass.value === 'serif') {
    return bold && italic ? StandardFonts.TimesRomanBoldItalic
      : bold ? StandardFonts.TimesRomanBold
        : italic ? StandardFonts.TimesRomanItalic
          : StandardFonts.TimesRoman;
  }
  return bold && italic ? StandardFonts.HelveticaBoldOblique
    : bold ? StandardFonts.HelveticaBold
      : italic ? StandardFonts.HelveticaOblique
        : StandardFonts.Helvetica;
}

function assertReplacementText(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    fail('EMPTY_REPLACEMENT', 'Replacement text must contain visible characters');
  }
  if (value.length > 4096) fail('REPLACEMENT_TOO_LONG', 'Replacement text exceeds 4096 UTF-16 code units');
  if (/[\r\n\u2028\u2029]/u.test(value)) {
    fail('MULTILINE_NOT_SUPPORTED', 'Line breaks and paragraph reflow are outside isolated single-line editing');
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    fail('UNSUPPORTED_TEXT_CONTROL', 'Replacement text contains unsupported control characters');
  }
}

async function layoutReplacement({ text, style, geometry, selected, sourceRaster }) {
  assertReplacementText(text);
  const face = resolvePackagedFace(
    style.fontClass.value,
    style.weight.value === 'bold',
    style.italic.value,
  );
  let shaped;
  try {
    shaped = await shapeTextRun({
      text,
      faceId: face.id,
      size: style.fontSize.value,
      direction: 'ltr',
    });
  } catch (error) {
    fail('MISSING_GLYPH', 'Replacement text contains a script or glyph unavailable in the supported font set', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const fontSize = style.fontSize.value;
  const widthPt = Math.max(shaped.advance, shaped.inkBounds.right - shaped.inkBounds.left) + 2;
  const heightPt = shaped.inkBounds.bottom - shaped.inkBounds.top + 2;
  const canonicalBaseline = geometry.canonicalBaseline.points;
  const baselineWidthPt = distance(canonicalBaseline[0], canonicalBaseline[canonicalBaseline.length - 1]);
  const repair = selected.geometry.repairBounds;
  const repairWidthPt = repair.width * 72 / sourceRaster.dpi;
  const repairHeightPt = repair.height * 72 / sourceRaster.dpi;
  const availableWidthPt = Math.max(baselineWidthPt, repairWidthPt);
  if (widthPt > availableWidthPt + 0.25 || heightPt > repairHeightPt + 0.5) {
    fail('REPLACEMENT_OVERFLOW', 'Replacement text cannot remain inside the isolated edit region', {
      widthPt: round(widthPt),
      availableWidthPt: round(availableWidthPt),
      heightPt: round(heightPt),
      availableHeightPt: round(repairHeightPt),
    });
  }
  const start = canonicalBaseline[0];
  const end = canonicalBaseline[canonicalBaseline.length - 1];
  const angle = angleDegrees(start, end);
  const baselineAvailable = distance(start, end);
  const offset = style.alignment.value === 'center' ? (baselineAvailable - widthPt) / 2
    : style.alignment.value === 'right' ? baselineAvailable - widthPt
      : 0;
  const radians = angle * Math.PI / 180;
  const origin = [
    start[0] + Math.cos(radians) * offset,
    start[1] + Math.sin(radians) * offset,
  ];
  return {
    fontName: face.family,
    direction: 'ltr',
    shaping: 'fontkit-liberation-ltr-v1',
    glyphCoverage: 'complete',
    encodedGlyphCount: shaped.glyphs.length,
    encodedText: shaped.glyphs.map((glyph) => glyph.id.toString(16).toUpperCase().padStart(4, '0')).join(''),
    widthPt: round(widthPt),
    heightPt: round(heightPt),
    availableWidthPt: round(availableWidthPt),
    availableHeightPt: round(repairHeightPt),
    origin: { coordinateSpace: OCR_PDF_USER_SPACE, point: origin.map((value) => round(value)) },
    angleDegrees: round(angle),
    baselineAligned: true,
    overflow: false,
  };
}

export function cssFont(style, sourceRaster) {
  const face = resolvePackagedFace(
    style.fontClass.value,
    style.weight.value === 'bold',
    style.italic.value,
  );
  const family = `"${face.family}", ${style.fontClass.value === 'monospace' ? 'monospace' : style.fontClass.value === 'serif' ? 'serif' : 'sans-serif'}`;
  const sizePx = style.fontSize.value * sourceRaster.dpi / 72;
  return `${style.italic.value ? 'italic ' : ''}${style.weight.value === 'bold' ? '700 ' : '400 '}${sizePx}px ${family}`;
}

async function defaultVisiblePatchRenderer({ basePatchBytes, patch, text, style, geometry, layout, sourceRaster }) {
  const Canvas = globalThis.OffscreenCanvas;
  let canvas;
  if (typeof Canvas === 'function') canvas = new Canvas(patch.widthPx, patch.heightPx);
  else if (globalThis.document?.createElement) {
    canvas = document.createElement('canvas');
    canvas.width = patch.widthPx;
    canvas.height = patch.heightPx;
  } else {
    fail('VISIBLE_RENDERER_UNAVAILABLE', 'A deterministic canvas renderer is required for visible scanned text');
  }
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) fail('VISIBLE_RENDERER_UNAVAILABLE', 'The canvas text renderer could not be initialized');
  const image = context.createImageData(patch.widthPx, patch.heightPx);
  image.data.set(basePatchBytes);
  context.putImageData(image, 0, 0);
  const baseline = geometry.sourceBaseline;
  const start = baseline[0];
  const end = baseline[baseline.length - 1];
  const textWidthPx = layout.widthPt * sourceRaster.dpi / 72;
  const baselineWidthPx = distance(start, end);
  const offset = style.alignment.value === 'center' ? (baselineWidthPx - textWidthPx) / 2
    : style.alignment.value === 'right' ? baselineWidthPx - textWidthPx
      : 0;
  const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
  context.save();
  context.translate(
    start[0] - patch.originX + Math.cos(angle) * offset,
    start[1] - patch.originY + Math.sin(angle) * offset,
  );
  context.rotate(angle);
  context.font = cssFont(style, sourceRaster);
  await globalThis.document?.fonts?.load?.(context.font);
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillStyle = style.textColor.value;
  context.fillText(text, 0, 0);
  context.restore();
  return new Uint8Array(context.getImageData(0, 0, patch.widthPx, patch.heightPx).data);
}

function pixelOffset(width, x, y) {
  return (y * width + x) * 4;
}

export function repairHaloMetrics(originalExtraction, originalPatch, repairedBytes, approvedRegion) {
  const relativeX = approvedRegion.x - originalPatch.originX;
  const relativeY = approvedRegion.y - originalPatch.originY;
  let maximum = 0;
  let total = 0;
  let samples = 0;
  for (let y = 0; y < approvedRegion.height; y += 1) {
    for (let x = 0; x < approvedRegion.width; x += 1) {
      const onBoundary = x === 0 || y === 0 || x === approvedRegion.width - 1 || y === approvedRegion.height - 1;
      if (!onBoundary) continue;
      const outsideX = x === 0 ? relativeX - 1
        : x === approvedRegion.width - 1 ? relativeX + approvedRegion.width
          : relativeX + x;
      const outsideY = y === 0 ? relativeY - 1
        : y === approvedRegion.height - 1 ? relativeY + approvedRegion.height
          : relativeY + y;
      if (outsideX < 0 || outsideY < 0 || outsideX >= originalPatch.widthPx || outsideY >= originalPatch.heightPx) continue;
      const repairedOffset = pixelOffset(approvedRegion.width, x, y);
      const outsideOffset = pixelOffset(originalPatch.widthPx, outsideX, outsideY);
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs(repairedBytes[repairedOffset + channel] - originalExtraction[outsideOffset + channel]);
        maximum = Math.max(maximum, delta);
        total += delta;
        samples += 1;
      }
    }
  }
  const metrics = {
    maxBoundaryChannelDelta: maximum,
    meanBoundaryChannelDelta: round(total / Math.max(1, samples), 3),
    sampleCount: samples,
    tolerance: clone(SCANNED_TEXT_REPAIR_HALO_TOLERANCE),
    passed: maximum <= SCANNED_TEXT_REPAIR_HALO_TOLERANCE.maxBoundaryChannelDelta
      && total / Math.max(1, samples) <= SCANNED_TEXT_REPAIR_HALO_TOLERANCE.meanBoundaryChannelDelta,
  };
  if (!metrics.passed) fail('REPAIR_HALO_EXCEEDED', 'The repair boundary exceeds the approved visible-halo tolerance', metrics);
  return metrics;
}

export async function patchRecord(bytes, bounds) {
  return {
    encoding: 'rgba8-base64',
    coordinateSpace: OCR_SOURCE_RASTER_SPACE,
    originX: bounds.x,
    originY: bounds.y,
    widthPx: bounds.width,
    heightPx: bounds.height,
    rowBytes: bounds.width * 4,
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    data: bytesToBase64(bytes),
  };
}

/**
 * Build the application-owned content record for exactly one horizontal OCR
 * line. The immutable OCR result is read only; all editable values live in the
 * scanned-text edit state.
 */
export async function buildIsolatedSingleLineContent({
  result,
  pageGeometry,
  raster,
  selected,
  originalPatch,
  repair,
  analysis,
  replacementText,
  styleOverrides = {},
  revision,
  parentRevision,
  renderVisiblePatch = defaultVisiblePatchRenderer,
}) {
  const line = assertSingleLineTarget(result, selected);
  if (repair.status !== 'applied' || !repair.repairedPatch) {
    fail('INELIGIBLE_EDIT_REGION', 'Visible replacement text requires an eligible repaired background');
  }
  const geometry = canonicalGeometry(line, selected, pageGeometry);
  const style = estimateStyle({ line, raster, geometry, pageGeometry, analysis, overrides: styleOverrides });
  const layout = await layoutReplacement({
    text: replacementText,
    style,
    geometry,
    selected,
    sourceRaster: result.sourceRaster,
  });
  const originalExtraction = base64ToBytes(originalPatch.data);
  const repairedBytes = base64ToBytes(repair.repairedPatch.data);
  let visibleBytes = null;
  try {
    const halo = repairHaloMetrics(
      originalExtraction,
      originalPatch,
      repairedBytes,
      repair.approvedRegion,
    );
    visibleBytes = await renderVisiblePatch({
      basePatchBytes: repairedBytes,
      patch: repair.repairedPatch,
      text: replacementText,
      style,
      geometry,
      layout,
      sourceRaster: result.sourceRaster,
    });
    if (!(visibleBytes instanceof Uint8Array || visibleBytes instanceof Uint8ClampedArray)
        || visibleBytes.byteLength !== repairedBytes.byteLength) {
      fail('INVALID_VISIBLE_PATCH', 'Visible replacement renderer returned invalid RGBA bytes');
    }
    const visiblePatch = await patchRecord(new Uint8Array(visibleBytes), repair.approvedRegion);
    return {
      scope: SCANNED_TEXT_SINGLE_LINE_SCOPE,
      source: {
        ocrIds: {
          lineId: line.id,
          wordIds: Array.isArray(line.words) ? line.words.map((word) => word.id) : [],
        },
        originalText: line.text,
        originalPolygon: clone(line.polygon),
        canonicalPolygon: geometry.canonicalPolygon,
        canonicalBaseline: geometry.canonicalBaseline,
      },
      replacementText,
      estimatedStyle: style,
      layout,
      repairPatch: clone(repair.repairedPatch),
      visibleReplacement: {
        text: replacementText,
        patch: visiblePatch,
        halo,
        outsideEditRegionChangedPixels: 0,
      },
      searchableText: {
        text: replacementText,
        renderingMode: 'owned-invisible-ocr',
        synchronized: true,
      },
      undo: {
        kind: 'scanned-text-edit',
        before: { text: line.text, repairStatus: 'original' },
        after: { text: replacementText, repairStatus: 'applied' },
        revision,
        parentRevision,
      },
    };
  } finally {
    zeroBytes(originalExtraction);
    zeroBytes(repairedBytes);
    zeroBytes(visibleBytes);
  }
}

/** Preserve the complete owned searchable page projection for exact removal after reopen. */
export function buildScannedTextSearchablePageSnapshot(result, pageGeometry) {
  return result.lines.map((line, readingOrder) => {
    const polygon = mapPolygonBetweenSpaces(
      pageGeometry.transformChain,
      line.polygon,
      OCR_PDF_USER_SPACE,
    );
    let baseline;
    if (line.baseline?.status === 'provided' && Array.isArray(line.baseline.points)
        && line.baseline.points.length >= 2) {
      baseline = {
        status: 'provided',
        provenance: line.baseline.provenance || 'ocr-engine',
        coordinateSpace: OCR_PDF_USER_SPACE,
        points: line.baseline.points.map((point) => mapPointBetweenSpaces(
          pageGeometry.transformChain,
          point,
          line.baseline.coordinateSpace,
          OCR_PDF_USER_SPACE,
        )),
      };
    } else {
      const points = polygon.points;
      const minX = Math.min(...points.map((point) => point[0]));
      const maxX = Math.max(...points.map((point) => point[0]));
      const minY = Math.min(...points.map((point) => point[1]));
      const height = Math.max(...points.map((point) => point[1])) - minY;
      baseline = {
        status: 'provided',
        provenance: 'estimated-from-ocr-polygon',
        coordinateSpace: OCR_PDF_USER_SPACE,
        points: [[minX, minY + Math.max(1, height * 0.16)], [maxX, minY + Math.max(1, height * 0.16)]],
      };
    }
    const words = Array.isArray(line.words) && line.words.every((word) => word?.polygon)
      ? line.words.map((word) => ({
          id: word.id,
          text: word.text,
          direction: word.detectedWritingDirection || line.detectedWritingDirection || null,
          polygon: mapPolygonBetweenSpaces(
            pageGeometry.transformChain,
            word.polygon,
            OCR_PDF_USER_SPACE,
          ),
        }))
      : undefined;
    return {
      lineId: line.id,
      text: line.text,
      confidence: line.confidence,
      readingOrder,
      direction: line.detectedWritingDirection || null,
      polygon,
      baseline,
      ...(words ? { words } : {}),
    };
  });
}

export function revisedEstimatedStyle(previous, overrides) {
  const allowed = new Set(['fontClass', 'fontSize', 'weight', 'italic', 'textColor', 'alignment']);
  for (const key of Object.keys(overrides || {})) {
    if (!allowed.has(key)) fail('UNSUPPORTED_STYLE_PROPERTY', `Scanned text style ${key} is outside this phase`);
  }
  const next = clone(previous);
  const values = {
    fontClass: overrides.fontClass,
    fontSize: overrides.fontSize,
    weight: overrides.weight,
    italic: overrides.italic,
    textColor: overrides.textColor,
    alignment: overrides.alignment,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    next[key] = estimate(key === 'fontSize' ? round(Number(value), 3) : value, 1, 'user-adjusted-estimate');
  }
  if (!['serif', 'sans-serif', 'monospace'].includes(next.fontClass.value)
      || !Number.isFinite(next.fontSize.value) || next.fontSize.value <= 0
      || !['normal', 'bold'].includes(next.weight.value)
      || typeof next.italic.value !== 'boolean'
      || !/^#[0-9a-f]{6}$/iu.test(next.textColor.value)
      || !['left', 'center', 'right'].includes(next.alignment.value)) {
    fail('INVALID_STYLE_ESTIMATE', 'Updated scanned-text style estimate is invalid');
  }
  next.textColor.value = next.textColor.value.toLowerCase();
  return next;
}

/** Re-render an existing owned line without sampling the already-edited PDF raster. */
export async function reviseIsolatedSingleLineContent({
  page,
  selection,
  replacementText,
  styleOverrides = {},
  revision,
  parentRevision,
  renderVisiblePatch = defaultVisiblePatchRenderer,
}) {
  if (selection?.repair?.status !== 'applied'
      || selection?.content?.scope !== SCANNED_TEXT_SINGLE_LINE_SCOPE) {
    fail('EDIT_NOT_APPLIED', 'Only an applied isolated scanned-text line can be revised');
  }
  const style = revisedEstimatedStyle(selection.content.estimatedStyle, styleOverrides);
  const sourcePolygon = selection.geometry.lineGeometry[0].sourcePolygon;
  if (!page.pageGeometry?.transformChain) {
    fail('PAGE_GEOMETRY_UNAVAILABLE', 'Canonical page geometry is required to revise an owned scanned-text line');
  }
  const sourceBaseline = selection.content.source.canonicalBaseline.points.map((point) =>
    mapPointBetweenSpaces(
      page.pageGeometry.transformChain,
      point,
      OCR_PDF_USER_SPACE,
      OCR_SOURCE_RASTER_SPACE,
    ));
  const geometry = {
    sourcePolygon,
    canonicalPolygon: selection.content.source.canonicalPolygon,
    canonicalBaseline: selection.content.source.canonicalBaseline,
    sourceBaseline,
  };
  const layout = await layoutReplacement({
    text: replacementText,
    style,
    geometry,
    selected: selection,
    sourceRaster: page.sourceRaster,
  });
  const repairedBytes = base64ToBytes(selection.repair.repairedPatch.data);
  let visibleBytes = null;
  try {
    visibleBytes = await renderVisiblePatch({
      basePatchBytes: repairedBytes,
      patch: selection.repair.repairedPatch,
      text: replacementText,
      style,
      geometry,
      layout,
      sourceRaster: page.sourceRaster,
    });
    if (!(visibleBytes instanceof Uint8Array || visibleBytes instanceof Uint8ClampedArray)
        || visibleBytes.byteLength !== repairedBytes.byteLength) {
      fail('INVALID_VISIBLE_PATCH', 'Visible replacement renderer returned invalid RGBA bytes');
    }
    return {
      ...clone(selection.content),
      replacementText,
      estimatedStyle: style,
      layout,
      visibleReplacement: {
        ...clone(selection.content.visibleReplacement),
        text: replacementText,
        patch: await patchRecord(new Uint8Array(visibleBytes), selection.repair.approvedRegion),
        outsideEditRegionChangedPixels: 0,
      },
      searchableText: {
        text: replacementText,
        renderingMode: 'owned-invisible-ocr',
        synchronized: true,
      },
      undo: {
        kind: 'scanned-text-edit',
        before: { text: selection.content.replacementText, repairStatus: 'applied' },
        after: { text: replacementText, repairStatus: 'applied' },
        revision,
        parentRevision,
      },
    };
  } finally {
    zeroBytes(repairedBytes);
    zeroBytes(visibleBytes);
  }
}
