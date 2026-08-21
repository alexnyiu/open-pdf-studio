import { assertOcrResultV2 } from '../contracts/v2.js';
import { assertOcrPageGeometryV1 } from '../contracts/page-geometry.v1.js';
import { deriveScannedTextEditSelectionId } from '../contracts/scanned-text-edit-state.v1.js';
import {
  OCR_SOURCE_RASTER_SPACE,
  applyHomography,
  composeTransformBetweenSpaces,
  mapPolygonBetweenSpaces,
} from '../contracts/geometry.js';

export class ScannedTextEditSelectionError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ScannedTextEditSelectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ScannedTextEditSelectionError(code, message);
}

function clone(value) {
  return structuredClone(value);
}

function sameFingerprint(left, right) {
  return left?.algorithm === right?.algorithm && left?.value === right?.value;
}

function assertMatchingPage(result, pageGeometry) {
  const matches = result.document.id === pageGeometry.document.id
    && result.document.revision === pageGeometry.document.revision
    && result.document.generation === pageGeometry.document.generation
    && result.page.id === pageGeometry.page.id
    && result.page.index === pageGeometry.page.index
    && result.page.revision === pageGeometry.page.revision
    && result.sourceRaster.id === pageGeometry.sourceRaster.id
    && sameFingerprint(result.sourceRaster.fingerprint, pageGeometry.sourceRaster.fingerprint)
    && result.sourceRaster.widthPx === pageGeometry.sourceRaster.widthPx
    && result.sourceRaster.heightPx === pageGeometry.sourceRaster.heightPx;
  if (!matches) {
    fail('STALE_OCR_GEOMETRY', 'OCR result and page geometry do not identify the same document revision, page, and source raster');
  }
}

function normalizeTarget(target) {
  if (!target || !['line', 'region'].includes(target.kind)) {
    fail('INVALID_EDIT_TARGET', 'The edit target must be a stable OCR line or application-owned region');
  }
  if (target.kind === 'line') {
    const lineId = target.lineId ?? target.targetId;
    if (typeof lineId !== 'string' || lineId.length === 0) {
      fail('INVALID_EDIT_TARGET', 'A line target requires its stable OCR line ID');
    }
    return { kind: 'line', targetId: lineId, lineIds: [lineId] };
  }
  if (typeof target.regionId !== 'string' || target.regionId.length === 0
      || !Array.isArray(target.lineIds) || target.lineIds.length === 0) {
    fail('INVALID_EDIT_TARGET', 'A region target requires a stable region ID and at least one stable OCR line ID');
  }
  if (new Set(target.lineIds).size !== target.lineIds.length
      || target.lineIds.some((lineId) => typeof lineId !== 'string' || lineId.length === 0)) {
    fail('INVALID_EDIT_TARGET', 'Region OCR line IDs must be unique non-empty identifiers');
  }
  return { kind: 'region', targetId: target.regionId, lineIds: [...target.lineIds] };
}

function axisBounds(polygons) {
  const points = polygons.flatMap((polygon) => polygon.points);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function pixelBounds(bounds, padding, raster) {
  const desired = {
    x: Math.floor(bounds.minX - padding),
    y: Math.floor(bounds.minY - padding),
    right: Math.ceil(bounds.maxX + padding),
    bottom: Math.ceil(bounds.maxY + padding),
  };
  const clipped = {
    x: Math.max(0, desired.x),
    y: Math.max(0, desired.y),
    right: Math.min(raster.widthPx, desired.right),
    bottom: Math.min(raster.heightPx, desired.bottom),
  };
  if (clipped.right <= clipped.x || clipped.bottom <= clipped.y) {
    fail('EMPTY_REPAIR_GEOMETRY', 'The selected OCR geometry does not cover any source-raster pixels');
  }
  return {
    desired,
    value: {
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      x: clipped.x,
      y: clipped.y,
      width: clipped.right - clipped.x,
      height: clipped.bottom - clipped.y,
    },
    clipped: desired.x !== clipped.x || desired.y !== clipped.y
      || desired.right !== clipped.right || desired.bottom !== clipped.bottom,
  };
}

function rectanglePolygon(bounds) {
  return {
    coordinateSpace: OCR_SOURCE_RASTER_SPACE,
    points: [
      [bounds.x, bounds.y],
      [bounds.x + bounds.width, bounds.y],
      [bounds.x + bounds.width, bounds.y + bounds.height],
      [bounds.x, bounds.y + bounds.height],
    ],
  };
}

function maxRoundTripError(points, matrix, inverseMatrix) {
  return points.reduce((maximum, point) => {
    const mapped = applyHomography(matrix, point);
    const restored = applyHomography(inverseMatrix, mapped);
    return Math.max(maximum, Math.hypot(point[0] - restored[0], point[1] - restored[1]));
  }, 0);
}

function rounded(value) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

/**
 * Resolve a line or region exclusively through immutable OCR IDs and copy all
 * geometry into canonical source-raster pixels. Nothing is written back to the
 * OCR result or page-geometry contract.
 */
export function selectScannedTextEditTarget({
  result,
  pageGeometry,
  target,
  repairPaddingPx = 1,
  contextPaddingPx = null,
}) {
  assertOcrResultV2(result);
  assertOcrPageGeometryV1(pageGeometry);
  assertMatchingPage(result, pageGeometry);
  const normalizedTarget = normalizeTarget(target);
  const linesById = new Map(result.lines.map((line) => [line.id, line]));
  const selectedLines = normalizedTarget.lineIds.map((lineId) => {
    const line = linesById.get(lineId);
    if (!line) fail('OCR_ID_NOT_FOUND', `Stable OCR line ID ${lineId} is not present in the immutable result`);
    return line;
  });
  if (!Number.isSafeInteger(repairPaddingPx) || repairPaddingPx < 0 || repairPaddingPx > 64) {
    fail('INVALID_REPAIR_PADDING', 'repairPaddingPx must be an integer from 0 through 64');
  }

  const lineGeometry = selectedLines.map((line) => {
    const sourceSpace = line.polygon.coordinateSpace;
    const matrix = composeTransformBetweenSpaces(pageGeometry.transformChain, sourceSpace, OCR_SOURCE_RASTER_SPACE);
    const inverseMatrix = composeTransformBetweenSpaces(pageGeometry.transformChain, OCR_SOURCE_RASTER_SPACE, sourceSpace);
    const sourcePolygon = mapPolygonBetweenSpaces(pageGeometry.transformChain, line.polygon, OCR_SOURCE_RASTER_SPACE);
    const roundTripMaxErrorPx = maxRoundTripError(line.polygon.points, matrix, inverseMatrix);
    return {
      lineId: line.id,
      sourceSpace,
      originalPolygon: clone(line.polygon),
      sourcePolygon,
      transform: {
        fromSpace: sourceSpace,
        toSpace: OCR_SOURCE_RASTER_SPACE,
        matrix: matrix.map(rounded),
        inverseMatrix: inverseMatrix.map(rounded),
      },
      roundTripMaxErrorPx: rounded(roundTripMaxErrorPx),
    };
  });

  const sourceBounds = axisBounds(lineGeometry.map((entry) => entry.sourcePolygon));
  const repair = pixelBounds(sourceBounds, repairPaddingPx, result.sourceRaster);
  const selectedHeight = Math.max(1, sourceBounds.maxY - sourceBounds.minY);
  const contextPadding = contextPaddingPx ?? Math.max(12, Math.ceil(selectedHeight));
  if (!Number.isSafeInteger(contextPadding) || contextPadding < 4 || contextPadding > 256) {
    fail('INVALID_CONTEXT_PADDING', 'contextPaddingPx must be an integer from 4 through 256');
  }
  const extraction = pixelBounds({
    minX: repair.value.x,
    minY: repair.value.y,
    maxX: repair.value.x + repair.value.width,
    maxY: repair.value.y + repair.value.height,
  }, contextPadding, result.sourceRaster);

  const roundTripMaxErrorPx = Math.max(...lineGeometry.map((entry) => entry.roundTripMaxErrorPx));
  const desiredArea = Math.max(1,
    (repair.desired.right - repair.desired.x) * (repair.desired.bottom - repair.desired.y));
  const retainedArea = repair.value.width * repair.value.height;
  const coverage = Math.min(1, retainedArea / desiredArea);
  const minimumLineConfidence = Math.min(...selectedLines.map((line) => line.confidence));
  const roundTripScore = roundTripMaxErrorPx <= 1e-6 ? 1 : Math.max(0, 1 - roundTripMaxErrorPx);
  const confidence = rounded(Math.max(0, Math.min(1,
    minimumLineConfidence * 0.7 + coverage * 0.2 + roundTripScore * 0.1,
  )));
  const selectionId = deriveScannedTextEditSelectionId(
    result.page.id,
    normalizedTarget.kind,
    normalizedTarget.targetId,
  );

  return {
    id: selectionId,
    target: {
      ...normalizedTarget,
      result: {
        jobId: result.jobId,
        requestId: result.requestId,
        pageId: result.page.id,
        pageRevision: result.page.revision,
        sourceRasterId: result.sourceRaster.id,
        sourceRasterFingerprint: clone(result.sourceRaster.fingerprint),
      },
    },
    geometry: {
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      lineGeometry,
      selectionPolygon: rectanglePolygon(repair.value),
      repairBounds: repair.value,
      extractionBounds: extraction.value,
      roundTripMaxErrorPx: rounded(roundTripMaxErrorPx),
      clipped: repair.clipped || extraction.clipped,
      confidence,
    },
    sourceRaster: clone(result.sourceRaster),
    page: {
      id: result.page.id,
      index: result.page.index,
      revision: result.page.revision,
    },
    document: clone(result.document),
    pageGeometry: {
      contract: pageGeometry.contract,
      schemaVersion: pageGeometry.schemaVersion,
      geometryId: pageGeometry.geometryId,
    },
  };
}
