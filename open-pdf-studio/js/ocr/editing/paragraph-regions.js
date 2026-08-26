import {
  OCR_SOURCE_RASTER_SPACE,
  deriveAxisAlignedBounds,
  mapBaselineBetweenSpaces,
  mapPolygonBetweenSpaces,
} from '../contracts/geometry.js';
import { SCANNED_TEXT_MAX_REGION_LINES } from './fixed-region.js';
import { segmentParagraphLines } from '../../text/paragraph-boundaries.js';

export const OCR_PARAGRAPH_ALGORITHM = 'ocr-paragraph-boundaries-v1';
export const OCR_PARAGRAPH_LINE_LIMIT_REASON = 'PARAGRAPH_LINE_LIMIT';

function median(values, fallback = 0) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return fallback;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function stableId(prefix, ids) {
  const encoded = ids.map((id) => `${id.length}.${id}`).join('.');
  if (`${prefix}-${encoded}`.length <= 256) return `${prefix}-${encoded}`;
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(encoded)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-h${hash.toString(16).padStart(8, '0')}`;
}

function baselineAngle(baseline) {
  if (baseline?.status !== 'provided' || baseline.points.length < 2) return null;
  const first = baseline.points[0];
  const last = baseline.points.at(-1);
  let angle = Math.atan2(last[1] - first[1], last[0] - first[0]) * 180 / Math.PI;
  while (angle > 90) angle -= 180;
  while (angle < -90) angle += 180;
  return angle;
}

function normalizeLine(line, pageGeometry, readingOrder) {
  try {
    const polygon = mapPolygonBetweenSpaces(pageGeometry.transformChain, line.polygon, OCR_SOURCE_RASTER_SPACE);
    const bounds = deriveAxisAlignedBounds(polygon);
    let baseline = mapBaselineBetweenSpaces(pageGeometry.transformChain, line.baseline, OCR_SOURCE_RASTER_SPACE);
    if (baseline.status === 'unavailable' && polygon.points.length >= 4) {
      baseline = {
        status: 'provided',
        coordinateSpace: OCR_SOURCE_RASTER_SPACE,
        points: [[bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]],
        provenance: 'paragraph-inference-polygon-edge',
      };
    }
    const angle = baselineAngle(baseline);
    const geometryValid = bounds.width > 0 && bounds.height > 0 && Number.isFinite(angle);
    return {
      id: line.id,
      text: line.text,
      confidence: line.confidence,
      direction: line.detectedWritingDirection ?? 'ltr',
      readingOrder,
      polygon,
      baseline,
      left: bounds.x,
      right: bounds.x + bounds.width,
      top: bounds.y,
      bottom: bounds.y + bounds.height,
      width: bounds.width,
      height: bounds.height,
      angle,
      geometryValid,
      columnId: null,
    };
  } catch {
    return {
      id: line.id, text: line.text, confidence: line.confidence,
      direction: line.detectedWritingDirection ?? 'ltr', readingOrder,
      polygon: null, baseline: null, left: 0, right: 0, top: readingOrder,
      bottom: readingOrder, width: 0, height: 0, angle: null,
      geometryValid: false, columnId: `invalid-${line.id}`,
    };
  }
}

function overlapRatio(left, right) {
  const overlap = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  return overlap / Math.max(1, Math.min(left.width, right.width));
}

function assignColumns(lines) {
  const tracks = [];
  const valid = lines.filter((line) => line.geometryValid).sort((left, right) => left.readingOrder - right.readingOrder);
  for (const line of valid) {
    const candidates = tracks.filter((track) => overlapRatio(line, track) >= 0.45
      || Math.abs(line.left - track.left) <= Math.max(line.height, track.height) * 0.75);
    if (candidates.length !== 1) {
      const track = { id: `column-${tracks.length + 1}`, left: line.left, right: line.right,
        width: line.width, height: line.height, samples: 1 };
      tracks.push(track);
      line.columnId = track.id;
      continue;
    }
    const track = candidates[0];
    line.columnId = track.id;
    track.left = (track.left * track.samples + line.left) / (track.samples + 1);
    track.right = (track.right * track.samples + line.right) / (track.samples + 1);
    track.width = track.right - track.left;
    track.height = (track.height * track.samples + line.height) / (track.samples + 1);
    track.samples += 1;
  }
  return lines;
}

function overrideMap(overrides, knownLines) {
  const map = new Map();
  for (const entry of overrides?.boundaries ?? overrides ?? []) {
    if (!entry || !knownLines.has(entry.beforeLineId) || !knownLines.has(entry.afterLineId)) continue;
    if (!['merge', 'split'].includes(entry.decision)) continue;
    map.set(`${entry.beforeLineId}\u0000${entry.afterLineId}`, entry.decision);
  }
  return map;
}

function boundsFor(lines) {
  if (lines.some((line) => !line.geometryValid)) return null;
  const left = Math.min(...lines.map((line) => line.left));
  const top = Math.min(...lines.map((line) => line.top));
  const right = Math.max(...lines.map((line) => line.right));
  const bottom = Math.max(...lines.map((line) => line.bottom));
  return { coordinateSpace: OCR_SOURCE_RASTER_SPACE, x: left, y: top, width: right - left, height: bottom - top };
}

export function buildOcrParagraphRegions({ result, pageGeometry, overrides = [] }) {
  const normalized = assignColumns(result.lines.map((line, index) => normalizeLine(line, pageGeometry, index)));
  const knownLines = new Set(normalized.map((line) => line.id));
  const mappedOverrides = overrideMap(overrides, knownLines);
  const regions = [];
  const boundaries = [];
  const columnIds = [...new Set(normalized.map((line) => line.columnId))];
  for (const columnId of columnIds) {
    const lines = normalized.filter((line) => line.columnId === columnId)
      .sort((left, right) => left.top - right.top || left.readingOrder - right.readingOrder);
    const heights = lines.map((line) => line.height);
    const gaps = lines.slice(1).map((line, index) => line.top - lines[index].bottom).filter((gap) => gap >= 0);
    const widths = lines.map((line) => line.width);
    const medianHeight = median(heights, 1);
    const medianGap = median(gaps, medianHeight * 0.5);
    const medianWidth = median(widths, 1);
    const segmented = segmentParagraphLines(lines, {
      overrides: mappedOverrides,
      contextForBoundary(previous, next) {
        return { medianHeight, medianGap, medianWidth, gap: next.top - previous.bottom };
      },
    });
    boundaries.push(...segmented.boundaries);
    for (const group of segmented.groups) {
      const lineIds = group.map((line) => line.id);
      const tooLong = lineIds.length > SCANNED_TEXT_MAX_REGION_LINES;
      const geometryValid = group.every((line) => line.geometryValid && line.direction === 'ltr');
      const confidence = Math.min(...group.map((line) => Number.isFinite(line.confidence) ? line.confidence : 0));
      regions.push({
        id: stableId('ocr-paragraph', lineIds),
        lineIds,
        columnId,
        bounds: boundsFor(group),
        alignment: Math.max(...group.map((line) => line.left)) - Math.min(...group.map((line) => line.left)) <= medianHeight * 0.5
          ? 'left' : 'unknown',
        confidence,
        editable: geometryValid && !tooLong,
        rejectionReason: tooLong ? OCR_PARAGRAPH_LINE_LIMIT_REASON
          : geometryValid ? null : 'UNSUPPORTED_PARAGRAPH_GEOMETRY',
        readingOrder: Math.min(...group.map((line) => line.readingOrder)),
        boundaryEvidence: segmented.boundaries.filter((entry) => lineIds.includes(entry.beforeLineId)
          && lineIds.includes(entry.afterLineId)),
      });
    }
  }
  regions.sort((left, right) => left.readingOrder - right.readingOrder);
  Object.defineProperty(regions, 'boundaries', { value: boundaries, enumerable: false });
  return regions;
}

export function paragraphRegionForLine(regions, lineId) {
  return regions.find((region) => region.lineIds.includes(lineId)) ?? null;
}

export function partitionSelectionByParagraph(regions, selectedLineIds) {
  const selected = new Set(selectedLineIds);
  return regions.filter((region) => region.lineIds.some((lineId) => selected.has(lineId)));
}
