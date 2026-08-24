import { StandardFontEmbedder } from 'pdf-lib';

import {
  OCR_PDF_USER_SPACE,
  OCR_SOURCE_RASTER_SPACE,
  mapPointBetweenSpaces,
  mapPolygonBetweenSpaces,
} from '../contracts/geometry.js';
import { base64ToBytes, zeroBytes } from './raster.js';
import {
  SCANNED_TEXT_MAX_BASELINE_ANGLE_DEGREES,
  canonicalGeometry,
  cssFont,
  estimateStyle,
  patchRecord,
  repairHaloMetrics,
  revisedEstimatedStyle,
  standardFontName,
} from './single-line.js';

export const SCANNED_TEXT_FIXED_REGION_SCOPE = 'fixed-region-multiline';
export const SCANNED_TEXT_MIN_REGION_LINES = 2;
export const SCANNED_TEXT_MAX_REGION_LINES = 32;

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

export class ScannedTextFixedRegionError extends Error {
  constructor(code, message, evidence = null) {
    super(message);
    this.name = 'ScannedTextFixedRegionError';
    this.code = code;
    this.evidence = evidence;
  }
}

function fail(code, message, evidence = null) {
  throw new ScannedTextFixedRegionError(code, message, evidence);
}

function clone(value) {
  return structuredClone(value);
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function distance(left, right) {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function median(values, fallback = 0) {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function boundsOfPolygon(polygon) {
  const xs = polygon.points.map((point) => point[0]);
  const ys = polygon.points.map((point) => point[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function midpoint(points) {
  const start = points[0];
  const end = points.at(-1);
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}

function horizontalAngle(points) {
  const start = points[0];
  const end = points.at(-1);
  let angle = Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI;
  while (angle > 90) angle -= 180;
  while (angle < -90) angle += 180;
  return angle;
}

function stableRegionId(lineIds) {
  const encodedIds = lineIds.map((lineId) => `${lineId.length}.${lineId}`).join('.');
  const exact = `fixed-region-${encodedIds}`;
  if (exact.length <= 256) return exact;

  // Common selections retain a collision-free, length-prefixed identity. Very
  // long valid OCR IDs use four independent 32-bit passes to stay inside the
  // shared identifier limit without making production selection state huge.
  const bytes = new TextEncoder().encode(encodedIds);
  const digest = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map((seed) => {
    let hash = seed;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }).join('');
  return `fixed-region-h${digest}`;
}

/** Build a stable application-owned target from an explicit user line selection. */
export function fixedRegionTargetFromLineIds(result, lineIds) {
  if (!Array.isArray(lineIds)) fail('INVALID_REGION_SELECTION', 'A fixed region requires explicit OCR line IDs');
  const unique = [...new Set(lineIds)];
  if (unique.length < SCANNED_TEXT_MIN_REGION_LINES || unique.length > SCANNED_TEXT_MAX_REGION_LINES) {
    fail('INVALID_REGION_SELECTION', `Select between ${SCANNED_TEXT_MIN_REGION_LINES} and ${SCANNED_TEXT_MAX_REGION_LINES} OCR lines`);
  }
  const readingOrder = new Map(result.lines.map((line, index) => [line.id, index]));
  if (unique.some((lineId) => !readingOrder.has(lineId))) {
    fail('OCR_ID_NOT_FOUND', 'One or more selected OCR lines are no longer present');
  }
  unique.sort((left, right) => readingOrder.get(left) - readingOrder.get(right));
  return {
    kind: 'region',
    regionId: stableRegionId(unique),
    lineIds: unique,
  };
}

function selectedLineGeometry(selected, entry) {
  return {
    ...selected,
    geometry: { ...selected.geometry, lineGeometry: [entry] },
  };
}

function assertRegionTarget(result, selected, pageGeometry) {
  if (selected.target.kind !== 'region'
      || selected.target.lineIds.length < SCANNED_TEXT_MIN_REGION_LINES
      || selected.target.lineIds.length > SCANNED_TEXT_MAX_REGION_LINES) {
    fail('FIXED_REGION_REQUIRED', 'Fixed-region editing requires multiple explicitly selected OCR lines');
  }
  if (!['completed', 'partial'].includes(result.page.status)) {
    fail('OCR_PAGE_NOT_EDITABLE', 'Only completed or partial OCR pages can be edited');
  }
  if (selected.geometry.clipped) {
    fail('CLIPPED_EDIT_REGION', 'The original fixed region does not have complete repair context');
  }
  if (selected.geometry.confidence < 0.9) {
    fail('LOW_CONFIDENCE_GEOMETRY', 'The selected fixed-region geometry is below the supported confidence threshold');
  }
  const unsupported = (result.unsupportedContentReasons || [])
    .filter((reason) => DISALLOWED_CONTENT_CODES.has(reason.code));
  if (unsupported.length > 0) {
    fail('UNSUPPORTED_CONTENT', 'The OCR page contains content that cannot be edited safely in a fixed region', {
      codes: unsupported.map((reason) => reason.code),
    });
  }

  const linesById = new Map(result.lines.map((line) => [line.id, line]));
  const geometryById = new Map(selected.geometry.lineGeometry.map((entry) => [entry.lineId, entry]));
  const lines = selected.target.lineIds.map((lineId) => {
    const line = linesById.get(lineId);
    const entry = geometryById.get(lineId);
    if (!line || !entry) fail('OCR_ID_NOT_FOUND', 'A selected OCR line no longer has owned geometry');
    if (line.confidence < 0.9) {
      fail('LOW_CONFIDENCE_GEOMETRY', 'Every selected OCR line must meet the geometry confidence threshold', {
        lineId,
        confidence: line.confidence,
      });
    }
    const direction = line.detectedWritingDirection ?? 'ltr';
    if (direction !== 'ltr') {
      fail('UNSUPPORTED_TEXT_DIRECTION', 'Only horizontal left-to-right fixed regions are supported', { lineId, direction });
    }
    const geometry = canonicalGeometry(line, selectedLineGeometry(selected, entry), pageGeometry);
    return { line, geometry, sourceBounds: boundsOfPolygon(geometry.sourcePolygon) };
  });
  lines.sort((left, right) => midpoint(left.geometry.sourceBaseline)[1] - midpoint(right.geometry.sourceBaseline)[1]);

  const heights = lines.map((entry) => entry.sourceBounds.height);
  const medianHeight = median(heights, 1);
  const baselineYs = lines.map((entry) => midpoint(entry.geometry.sourceBaseline)[1]);
  const gaps = baselineYs.slice(1).map((value, index) => value - baselineYs[index]);
  const spacingPx = median(gaps, 0);
  if (gaps.some((gap) => gap < medianHeight * 0.72 || gap > medianHeight * 3.2)
      || spacingPx <= 0) {
    fail('INCOHERENT_LINE_SPACING', 'Selected OCR lines do not have safe measured line spacing', {
      gaps: gaps.map((value) => round(value)),
      medianHeight: round(medianHeight),
    });
  }
  const angles = lines.map((entry) => horizontalAngle(entry.geometry.sourceBaseline));
  const medianAngle = median(angles);
  if (angles.some((angle) => Math.abs(angle - medianAngle) > 1.25
      || Math.abs(angle) > SCANNED_TEXT_MAX_BASELINE_ANGLE_DEGREES)) {
    fail('INCOHERENT_BASELINES', 'Selected OCR lines do not share canonical horizontal baselines');
  }

  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1].sourceBounds;
    const current = lines[index].sourceBounds;
    const overlap = Math.max(0, Math.min(previous.maxX, current.maxX) - Math.max(previous.minX, current.minX));
    if (overlap / Math.max(1, Math.min(previous.width, current.width)) < 0.45) {
      fail('INSEPARABLE_COLUMNS', 'Selected OCR lines do not form one coherent fixed region');
    }
  }

  const top = Math.min(...lines.map((entry) => entry.sourceBounds.minY));
  const bottom = Math.max(...lines.map((entry) => entry.sourceBounds.maxY));
  const left = Math.min(...lines.map((entry) => entry.sourceBounds.minX));
  const right = Math.max(...lines.map((entry) => entry.sourceBounds.maxX));
  const selectedIds = new Set(selected.target.lineIds);
  for (const other of result.lines) {
    if (selectedIds.has(other.id)) continue;
    const otherGeometry = boundsOfPolygon(mapPolygonBetweenSpaces(
      pageGeometry.transformChain,
      other.polygon,
      OCR_SOURCE_RASTER_SPACE,
    ));
    const centerY = (otherGeometry.minY + otherGeometry.maxY) / 2;
    if (centerY < top || centerY > bottom) continue;
    const horizontalOverlap = Math.max(0, Math.min(right, otherGeometry.maxX) - Math.max(left, otherGeometry.minX));
    const gap = otherGeometry.minX > right ? otherGeometry.minX - right
      : left > otherGeometry.maxX ? left - otherGeometry.maxX
        : 0;
    if (horizontalOverlap === 0 && gap < Math.max(right - left, otherGeometry.width)) {
      fail('INSEPARABLE_COLUMNS', 'Another OCR column intersects the selected region rows');
    }
  }

  const leftSpread = Math.max(...lines.map((entry) => entry.sourceBounds.minX))
    - Math.min(...lines.map((entry) => entry.sourceBounds.minX));
  const rightSpread = Math.max(...lines.map((entry) => entry.sourceBounds.maxX))
    - Math.min(...lines.map((entry) => entry.sourceBounds.maxX));
  const centers = lines.map((entry) => (entry.sourceBounds.minX + entry.sourceBounds.maxX) / 2);
  const centerSpread = Math.max(...centers) - Math.min(...centers);
  const tolerance = Math.max(2, medianHeight * 0.5);
  const alignment = leftSpread <= tolerance ? 'left'
    : rightSpread <= tolerance ? 'right'
      : centerSpread <= tolerance ? 'center'
        : null;
  if (!alignment) {
    fail('LOW_CONFIDENCE_ALIGNMENT', 'The selected OCR lines do not have a reliable common alignment');
  }

  const canonicalSpacingPt = median(lines.slice(1).map((entry, index) => {
    const previous = midpoint(lines[index].geometry.canonicalBaseline.points);
    const current = midpoint(entry.geometry.canonicalBaseline.points);
    return distance(previous, current);
  }));
  return {
    lines,
    alignment,
    spacingPx: round(spacingPx),
    spacingPt: round(canonicalSpacingPt),
  };
}

function assertReplacementText(value) {
  if (typeof value !== 'string') fail('EMPTY_REPLACEMENT', 'Replacement text must be a string');
  const normalized = value.replace(/\r\n?/gu, '\n');
  if (normalized.length === 0 || normalized.trim().length === 0) {
    fail('EMPTY_REPLACEMENT', 'Replacement text must contain visible characters');
  }
  if (normalized.length > 4096) fail('REPLACEMENT_TOO_LONG', 'Replacement text exceeds 4096 UTF-16 code units');
  if (/\n{2,}|[\u2028\u2029]/u.test(normalized)) {
    fail('PARAGRAPH_REFLOW_NOT_SUPPORTED', 'Blank paragraphs and paragraph reflow are outside fixed-region editing');
  }
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(normalized)) {
    fail('UNSUPPORTED_TEXT_CONTROL', 'Replacement text contains unsupported control characters');
  }
  return normalized;
}

function lineWidth(embedder, text, fontSize) {
  try {
    embedder.encodeText(text);
    return embedder.widthOfTextAtSize(text, fontSize);
  } catch (error) {
    fail('MISSING_GLYPH', 'Replacement text contains a glyph unavailable in the supported font set', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function wrapReplacement(text, embedder, fontSize, availableWidthPt) {
  const output = [];
  let safeWrapped = false;
  for (const explicitLine of text.split('\n')) {
    if (explicitLine.trim().length === 0) fail('EMPTY_LAYOUT_LINE', 'Every fixed-region line must contain visible text');
    if (lineWidth(embedder, explicitLine, fontSize) <= availableWidthPt + 0.25) {
      output.push(explicitLine);
      continue;
    }
    const words = explicitLine.trim().split(/\s+/u);
    let current = '';
    for (const word of words) {
      if (lineWidth(embedder, word, fontSize) > availableWidthPt + 0.25) {
        fail('REPLACEMENT_OVERFLOW', 'An unbreakable word cannot remain inside the fixed region');
      }
      const candidate = current ? `${current} ${word}` : word;
      if (lineWidth(embedder, candidate, fontSize) <= availableWidthPt + 0.25) {
        current = candidate;
      } else {
        output.push(current);
        current = word;
        safeWrapped = true;
      }
    }
    if (current) output.push(current);
    safeWrapped = true;
  }
  return { lines: output, safeWrapped };
}

function polygonForLine(origin, widthPt, heightPt, angleDegrees) {
  const radians = angleDegrees * Math.PI / 180;
  const along = [Math.cos(radians), Math.sin(radians)];
  const normal = [-Math.sin(radians), Math.cos(radians)];
  const ascent = heightPt * 0.82;
  const descent = heightPt * 0.18;
  const topLeft = [origin[0] + normal[0] * ascent, origin[1] + normal[1] * ascent];
  const topRight = [topLeft[0] + along[0] * widthPt, topLeft[1] + along[1] * widthPt];
  const bottomLeft = [origin[0] - normal[0] * descent, origin[1] - normal[1] * descent];
  const bottomRight = [bottomLeft[0] + along[0] * widthPt, bottomLeft[1] + along[1] * widthPt];
  return {
    coordinateSpace: OCR_PDF_USER_SPACE,
    points: [topLeft, topRight, bottomRight, bottomLeft].map((point) => point.map((value) => round(value))),
  };
}

function layoutReplacement({ text, style, region, selected, pageGeometry, sourceRaster }) {
  const normalizedText = assertReplacementText(text);
  const fontName = standardFontName(style);
  const embedder = StandardFontEmbedder.for(fontName);
  const fontSize = style.fontSize.value;
  const heightPt = embedder.heightOfFontAtSize(fontSize);
  const canonicalRegion = mapPolygonBetweenSpaces(
    pageGeometry.transformChain,
    selected.geometry.selectionPolygon,
    OCR_PDF_USER_SPACE,
  );
  const regionBounds = boundsOfPolygon(canonicalRegion);
  const availableWidthPt = regionBounds.width;
  const availableHeightPt = regionBounds.height;
  const wrapped = wrapReplacement(normalizedText, embedder, fontSize, availableWidthPt);
  if (wrapped.lines.length > region.lines.length) {
    fail('REPLACEMENT_OVERFLOW', 'Replacement text requires more lines than the original fixed region', {
      requiredLines: wrapped.lines.length,
      availableLines: region.lines.length,
    });
  }
  if (heightPt > median(region.lines.map((entry) => {
    const bounds = boundsOfPolygon(entry.geometry.canonicalPolygon);
    return bounds.height;
  })) + 0.75) {
    fail('REPLACEMENT_OVERFLOW', 'Replacement glyph height would clip inside the fixed region');
  }

  const lines = wrapped.lines.map((lineText, index) => {
    const source = region.lines[index];
    const sourceBaseline = source.geometry.canonicalBaseline.points;
    const start = sourceBaseline[0];
    const end = sourceBaseline.at(-1);
    const angleDegrees = horizontalAngle(sourceBaseline);
    const widthPt = lineWidth(embedder, lineText, fontSize);
    const available = regionBounds.width;
    const offset = style.alignment.value === 'center' ? (available - widthPt) / 2
      : style.alignment.value === 'right' ? available - widthPt
        : 0;
    const radians = angleDegrees * Math.PI / 180;
    const leftOnBaseline = [regionBounds.minX, midpoint(sourceBaseline)[1]];
    const origin = [
      leftOnBaseline[0] + Math.cos(radians) * offset,
      leftOnBaseline[1] + Math.sin(radians) * offset,
    ];
    const polygon = polygonForLine(origin, widthPt, heightPt, angleDegrees);
    const polygonBounds = boundsOfPolygon(polygon);
    const tolerance = 0.75;
    if (polygonBounds.minX < regionBounds.minX - tolerance
        || polygonBounds.maxX > regionBounds.maxX + tolerance
        || polygonBounds.minY < regionBounds.minY - tolerance
        || polygonBounds.maxY > regionBounds.maxY + tolerance) {
      fail('CLIPPING_RISK', 'Replacement glyphs cannot be contained by the original fixed region', {
        line: index,
        polygonBounds,
        regionBounds,
      });
    }
    let encoded;
    try {
      encoded = embedder.encodeText(lineText);
    } catch (error) {
      fail('MISSING_GLYPH', 'Replacement text contains a glyph unavailable in the supported font set', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const baselineEnd = [
      origin[0] + Math.cos(radians) * widthPt,
      origin[1] + Math.sin(radians) * widthPt,
    ];
    return {
      index,
      text: lineText,
      encodedGlyphCount: Array.from(lineText).length,
      encodedText: encoded.toString(),
      widthPt: round(widthPt),
      heightPt: round(heightPt),
      origin: { coordinateSpace: OCR_PDF_USER_SPACE, point: origin.map((value) => round(value)) },
      angleDegrees: round(angleDegrees),
      baselineAligned: true,
      canonicalPolygon: polygon,
      canonicalBaseline: {
        status: 'provided',
        provenance: source.geometry.canonicalBaseline.provenance,
        coordinateSpace: OCR_PDF_USER_SPACE,
        points: [origin, baselineEnd].map((point) => point.map((value) => round(value))),
      },
    };
  });
  const canonicalText = lines.map((line) => line.text).join('\n');
  return {
    canonicalText,
    layout: {
      fontName,
      direction: 'ltr',
      shaping: 'pdf-lib-standard-font-winansi-v1',
      glyphCoverage: 'complete',
      availableWidthPt: round(availableWidthPt),
      availableHeightPt: round(availableHeightPt),
      canonicalRegion,
      measuredLineSpacingPt: region.spacingPt,
      lineSpacingMethod: 'median-canonical-baseline-delta-v1',
      alignment: style.alignment.value,
      safeWrapped: wrapped.safeWrapped,
      clippingPrevented: true,
      overflow: false,
      lines,
    },
  };
}

async function defaultVisiblePatchRenderer({ basePatchBytes, patch, style, geometry, layout, sourceRaster }) {
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
  context.font = cssFont(style, sourceRaster);
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillStyle = style.textColor.value;
  for (const line of layout.lines) {
    const origin = mapPointBetweenSpaces(
      geometry.transformChain,
      line.origin.point,
      OCR_PDF_USER_SPACE,
      OCR_SOURCE_RASTER_SPACE,
    );
    const metrics = context.measureText(line.text);
    const localX = origin[0] - patch.originX;
    const localY = origin[1] - patch.originY;
    const ascent = metrics.actualBoundingBoxAscent || style.fontSize.value * sourceRaster.dpi / 72;
    const descent = metrics.actualBoundingBoxDescent || ascent * 0.25;
    const left = -(metrics.actualBoundingBoxLeft || 0);
    const right = metrics.actualBoundingBoxRight || metrics.width;
    const radians = line.angleDegrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const glyphCorners = [
      [left, -ascent], [right, -ascent], [right, descent], [left, descent],
    ].map(([x, y]) => [
      localX + x * cosine - y * sine,
      localY + x * sine + y * cosine,
    ]);
    const glyphXs = glyphCorners.map((point) => point[0]);
    const glyphYs = glyphCorners.map((point) => point[1]);
    if (Math.min(...glyphXs) < -0.5 || Math.max(...glyphXs) > patch.widthPx + 0.5
        || Math.min(...glyphYs) < -0.5 || Math.max(...glyphYs) > patch.heightPx + 0.5) {
      fail('CLIPPING_RISK', 'Canvas glyph bounds would clip inside the fixed repair patch');
    }
    context.save();
    context.translate(localX, localY);
    context.rotate(radians);
    context.fillText(line.text, 0, 0);
    context.restore();
  }
  return new Uint8Array(context.getImageData(0, 0, patch.widthPx, patch.heightPx).data);
}

function sourceRecord(region, selected, pageGeometry) {
  return {
    ocrIds: {
      regionId: selected.target.targetId,
      lineIds: region.lines.map((entry) => entry.line.id),
      wordIds: [...new Set(region.lines.flatMap((entry) =>
        Array.isArray(entry.line.words) ? entry.line.words.map((word) => word.id) : []))],
    },
    originalText: region.lines.map((entry) => entry.line.text).join('\n'),
    originalPolygons: region.lines.map((entry) => clone(entry.line.polygon)),
    canonicalRegion: mapPolygonBetweenSpaces(
      pageGeometry.transformChain,
      selected.geometry.selectionPolygon,
      OCR_PDF_USER_SPACE,
    ),
    canonicalBaselines: region.lines.map((entry) => clone(entry.geometry.canonicalBaseline)),
    lineSpacing: {
      valuePt: region.spacingPt,
      valuePx: region.spacingPx,
      measured: true,
      method: 'median-canonical-baseline-delta-v1',
    },
  };
}

function searchableRecord(layout, text) {
  return {
    text,
    renderingMode: 'owned-invisible-ocr',
    synchronized: true,
    lines: layout.lines.map((line) => ({
      index: line.index,
      text: line.text,
      polygon: clone(line.canonicalPolygon),
      baseline: clone(line.canonicalBaseline),
    })),
  };
}

/** Build one bounded multi-line edit from an explicitly selected OCR region. */
export async function buildFixedRegionMultilineContent({
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
  const region = assertRegionTarget(result, selected, pageGeometry);
  if (repair.status !== 'applied' || !repair.repairedPatch) {
    const reasons = analysis?.eligibility?.rejectionReasons || [];
    fail(
      'INELIGIBLE_EDIT_REGION',
      reasons.map((reason) => reason.message).join('; ')
        || 'Visible replacement text requires an eligible repaired background',
      { rejectionReasons: clone(reasons) },
    );
  }
  const representative = region.lines.reduce((longest, entry) =>
    entry.line.text.length > longest.line.text.length ? entry : longest, region.lines[0]);
  const inferredOverrides = Object.hasOwn(styleOverrides, 'alignment')
    ? styleOverrides
    : { ...styleOverrides, alignment: region.alignment };
  const style = estimateStyle({
    line: representative.line,
    raster,
    geometry: representative.geometry,
    pageGeometry,
    analysis,
    overrides: inferredOverrides,
  });
  if (!Object.hasOwn(styleOverrides, 'alignment')) {
    style.alignment.confidence = 0.88;
    style.alignment.method = 'fixed-region-edge-alignment-v1';
  }
  const { canonicalText, layout } = layoutReplacement({
    text: replacementText,
    style,
    region,
    selected,
    pageGeometry,
    sourceRaster: result.sourceRaster,
  });
  const originalExtraction = base64ToBytes(originalPatch.data);
  const repairedBytes = base64ToBytes(repair.repairedPatch.data);
  let visibleBytes = null;
  try {
    const halo = repairHaloMetrics(originalExtraction, originalPatch, repairedBytes, repair.approvedRegion);
    visibleBytes = await renderVisiblePatch({
      basePatchBytes: repairedBytes,
      patch: repair.repairedPatch,
      text: canonicalText,
      style,
      geometry: { transformChain: pageGeometry.transformChain },
      layout,
      sourceRaster: result.sourceRaster,
    });
    if (!(visibleBytes instanceof Uint8Array || visibleBytes instanceof Uint8ClampedArray)
        || visibleBytes.byteLength !== repairedBytes.byteLength) {
      fail('INVALID_VISIBLE_PATCH', 'Visible replacement renderer returned invalid RGBA bytes');
    }
    const source = sourceRecord(region, selected, pageGeometry);
    return {
      scope: SCANNED_TEXT_FIXED_REGION_SCOPE,
      source,
      replacementText: canonicalText,
      estimatedStyle: style,
      layout,
      repairPatch: clone(repair.repairedPatch),
      visibleReplacement: {
        text: canonicalText,
        patch: await patchRecord(new Uint8Array(visibleBytes), repair.approvedRegion),
        halo,
        outsideEditRegionChangedPixels: 0,
      },
      searchableText: searchableRecord(layout, canonicalText),
      undo: {
        kind: 'scanned-text-edit',
        before: { text: source.originalText, repairStatus: 'original' },
        after: { text: canonicalText, repairStatus: 'applied' },
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

/** Re-render only from the owned original repair patch and stored canonical region. */
export async function reviseFixedRegionMultilineContent({
  page,
  selection,
  replacementText,
  styleOverrides = {},
  revision,
  parentRevision,
  renderVisiblePatch = defaultVisiblePatchRenderer,
}) {
  if (selection?.repair?.status !== 'applied'
      || selection?.content?.scope !== SCANNED_TEXT_FIXED_REGION_SCOPE
      || !page?.pageGeometry?.transformChain) {
    fail('EDIT_NOT_APPLIED', 'Only an applied owned fixed-region edit can be revised');
  }
  const style = revisedEstimatedStyle(selection.content.estimatedStyle, styleOverrides);
  const region = {
    alignment: style.alignment.value,
    spacingPx: selection.content.source.lineSpacing.valuePx,
    spacingPt: selection.content.source.lineSpacing.valuePt,
    lines: selection.content.source.canonicalBaselines.map((canonicalBaseline, index) => ({
      line: { id: selection.content.source.ocrIds.lineIds[index] },
      geometry: {
        canonicalBaseline,
        canonicalPolygon: mapPolygonBetweenSpaces(
          page.pageGeometry.transformChain,
          selection.geometry.lineGeometry[index].sourcePolygon,
          OCR_PDF_USER_SPACE,
        ),
      },
    })),
  };
  const { canonicalText, layout } = layoutReplacement({
    text: replacementText,
    style,
    region,
    selected: selection,
    pageGeometry: page.pageGeometry,
    sourceRaster: page.sourceRaster,
  });
  const repairedBytes = base64ToBytes(selection.repair.repairedPatch.data);
  let visibleBytes = null;
  try {
    visibleBytes = await renderVisiblePatch({
      basePatchBytes: repairedBytes,
      patch: selection.repair.repairedPatch,
      text: canonicalText,
      style,
      geometry: { transformChain: page.pageGeometry.transformChain },
      layout,
      sourceRaster: page.sourceRaster,
    });
    if (!(visibleBytes instanceof Uint8Array || visibleBytes instanceof Uint8ClampedArray)
        || visibleBytes.byteLength !== repairedBytes.byteLength) {
      fail('INVALID_VISIBLE_PATCH', 'Visible replacement renderer returned invalid RGBA bytes');
    }
    return {
      ...clone(selection.content),
      replacementText: canonicalText,
      estimatedStyle: style,
      layout,
      visibleReplacement: {
        ...clone(selection.content.visibleReplacement),
        text: canonicalText,
        patch: await patchRecord(new Uint8Array(visibleBytes), selection.repair.approvedRegion),
        outsideEditRegionChangedPixels: 0,
      },
      searchableText: searchableRecord(layout, canonicalText),
      undo: {
        kind: 'scanned-text-edit',
        before: { text: selection.content.replacementText, repairStatus: 'applied' },
        after: { text: canonicalText, repairStatus: 'applied' },
        revision,
        parentRevision,
      },
    };
  } finally {
    zeroBytes(repairedBytes);
    zeroBytes(visibleBytes);
  }
}
