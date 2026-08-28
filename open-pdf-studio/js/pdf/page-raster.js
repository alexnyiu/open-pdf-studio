/**
 * Runtime-only raster identity and density policy shared by every PDF view.
 * Persistence and semantic page layers deliberately do not depend on this.
 */
import {
  initializeDocumentRevisionState,
  noteDocumentMutation,
} from '../core/document-revision-state.runtime.js';

export const RasterQuality = Object.freeze({
  PREVIEW: 'preview',
  FINAL: 'final',
});

export const RASTER_DENSITY_TOLERANCE = 0.01;

const finitePositive = (value, fallback = 1) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const normalizedRotation = (rotation) => {
  const value = Number(rotation) || 0;
  return ((value % 360) + 360) % 360;
};

/** Stable scale bucket precise enough to distinguish monitor-DPR changes. */
export function rasterScaleBucket(scale) {
  return Math.round(finitePositive(scale) * 10_000) / 10_000;
}

export function pageRenderRevision(documentState, pageNum) {
  if (!documentState) return 0;
  const state = initializeDocumentRevisionState(documentState);
  const revision = Number(state.pageContentRevisions?.[Number(pageNum)]);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

export function bumpPageRenderRevision(documentState, pageNum) {
  const page = Number(pageNum);
  if (!documentState || !Number.isInteger(page) || page <= 0) return 0;
  noteDocumentMutation(documentState, {
    pages: [page],
    reason: 'page-content:legacy-invalidation',
  });
  return pageRenderRevision(documentState, page);
}

export function requestedRasterScale(cssScale, devicePixelRatio = 1) {
  return finitePositive(cssScale) * finitePositive(devicePixelRatio);
}

export function createPageRasterKey({
  documentId,
  lifecycleGeneration = 0,
  pageRevision = 0,
  filePath = '',
  pageNum,
  rotation = 0,
  cssScale = 1,
  devicePixelRatio = 1,
  quality = RasterQuality.FINAL,
} = {}) {
  const page = Number(pageNum);
  if (!documentId || !Number.isInteger(page) || page <= 0) {
    throw new TypeError('A raster key requires a documentId and positive pageNum');
  }
  if (!Object.values(RasterQuality).includes(quality)) {
    throw new TypeError(`Unsupported raster quality: ${quality}`);
  }
  return Object.freeze({
    documentId: String(documentId),
    lifecycleGeneration: Math.max(0, Number(lifecycleGeneration) || 0),
    pageRevision: Math.max(0, Number(pageRevision) || 0),
    filePath: String(filePath || ''),
    pageNum: page,
    rotation: normalizedRotation(rotation),
    cssScaleBucket: rasterScaleBucket(cssScale),
    devicePixelRatio: rasterScaleBucket(devicePixelRatio),
    quality,
  });
}

export function serializePageRasterKey(key) {
  return [
    key.documentId,
    key.lifecycleGeneration,
    key.pageRevision,
    key.filePath,
    key.pageNum,
    key.rotation,
    key.cssScaleBucket,
    key.devicePixelRatio,
    key.quality,
  ].map((part) => encodeURIComponent(String(part))).join('|');
}

function sameContent(left, right) {
  return left?.documentId === right?.documentId
    && left?.lifecycleGeneration === right?.lifecycleGeneration
    && left?.pageRevision === right?.pageRevision
    && left?.filePath === right?.filePath
    && left?.pageNum === right?.pageNum
    && left?.rotation === right?.rotation;
}

/**
 * A final, denser raster may satisfy a lower-density request. A preview may
 * only satisfy another preview request, regardless of its pixel dimensions.
 */
export function rasterCanSatisfy(candidate, request, tolerance = RASTER_DENSITY_TOLERANCE) {
  if (!candidate || !request || !sameContent(candidate.key, request.key)) return false;
  if (request.quality === RasterQuality.FINAL && candidate.quality !== RasterQuality.FINAL) return false;
  return finitePositive(candidate.actualRasterScale, 0)
    + Math.max(0, Number(tolerance) || 0)
    >= finitePositive(request.targetRasterScale);
}

export function chooseBestRaster(candidates, request) {
  return [...(candidates || [])]
    .filter((candidate) => rasterCanSatisfy(candidate, request))
    .sort((left, right) => {
      const densityDelta = left.actualRasterScale - right.actualRasterScale;
      if (densityDelta !== 0) return densityDelta;
      return (right.lastUsedAt || 0) - (left.lastUsedAt || 0);
    })[0] || null;
}

export function createRenderedSurfaceState({
  targetRasterScale,
  actualRasterScale,
  cssScale,
  devicePixelRatio,
  quality,
  source,
  ownerGeneration,
  publicationRevision,
  publishedAt = globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  return Object.freeze({
    targetRasterScale: finitePositive(targetRasterScale),
    actualRasterScale: finitePositive(actualRasterScale),
    cssScale: finitePositive(cssScale),
    devicePixelRatio: finitePositive(devicePixelRatio),
    quality,
    source: String(source || 'unknown'),
    ownerGeneration: Math.max(0, Number(ownerGeneration) || 0),
    publicationRevision: Math.max(0, Number(publicationRevision) || 0),
    publishedAt: Number(publishedAt) || 0,
  });
}

export function renderedSurfaceIsSharp(state, tolerance = RASTER_DENSITY_TOLERANCE) {
  return state?.quality === RasterQuality.FINAL
    && Number(state.actualRasterScale) + Math.max(0, Number(tolerance) || 0)
      >= Number(state.targetRasterScale);
}
