import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RasterQuality,
  bumpPageRenderRevision,
  chooseBestRaster,
  createPageRasterKey,
  createRenderedSurfaceState,
  pageRenderRevision,
  rasterCanSatisfy,
  renderedSurfaceIsSharp,
  requestedRasterScale,
  serializePageRasterKey,
} from './page-raster.js';

const key = (overrides = {}) => createPageRasterKey({
  documentId: 'document-a',
  lifecycleGeneration: 3,
  contentRevision: 5,
  pageRevision: 2,
  filePath: '/fixture.pdf',
  pageNum: 7,
  rotation: 90,
  cssScale: 1.25,
  devicePixelRatio: 2,
  quality: RasterQuality.FINAL,
  ...overrides,
});

test('raster identity includes owner, content revision, density, and quality', () => {
  const original = serializePageRasterKey(key());
  for (const changed of [
    { lifecycleGeneration: 4 },
    { contentRevision: 6 },
    { pageRevision: 3 },
    { pageNum: 8 },
    { rotation: 180 },
    { cssScale: 1.5 },
    { devicePixelRatio: 3 },
    { quality: RasterQuality.PREVIEW },
  ]) {
    assert.notEqual(serializePageRasterKey(key(changed)), original);
  }
});

test('higher-density final raster satisfies lower-density final request', () => {
  const request = { key: key(), quality: RasterQuality.FINAL, targetRasterScale: 2.5 };
  const denser = { key: key(), quality: RasterQuality.FINAL, actualRasterScale: 3 };
  assert.equal(rasterCanSatisfy(denser, request), true);
  assert.equal(chooseBestRaster([{ ...denser, actualRasterScale: 4 }, denser], request), denser);
});

test('preview never satisfies a settled final request', () => {
  const request = { key: key(), quality: RasterQuality.FINAL, targetRasterScale: 2.5 };
  const preview = { key: key(), quality: RasterQuality.PREVIEW, actualRasterScale: 8 };
  assert.equal(rasterCanSatisfy(preview, request), false);
});

test('interactive quality is readable fallback but cannot impersonate final DPR pixels', () => {
  const interactiveRequest = {
    key: key({ quality: RasterQuality.INTERACTIVE, devicePixelRatio: 1 }),
    quality: RasterQuality.INTERACTIVE,
    targetRasterScale: 1.25,
  };
  const interactive = {
    key: interactiveRequest.key,
    quality: RasterQuality.INTERACTIVE,
    actualRasterScale: 1.25,
  };
  assert.equal(rasterCanSatisfy(interactive, interactiveRequest), true);
  assert.equal(rasterCanSatisfy({
    ...interactive,
    key: key({ quality: RasterQuality.FINAL, devicePixelRatio: 1 }),
    quality: RasterQuality.FINAL,
  }, interactiveRequest), true);
  assert.equal(rasterCanSatisfy(interactive, {
    key: interactive.key,
    quality: RasterQuality.FINAL,
    targetRasterScale: 1.25,
  }), false);
});

test('page content invalidation increments only the affected page', () => {
  const documentState = { pageRenderRevisions: {} };
  assert.equal(pageRenderRevision(documentState, 3), 0);
  assert.equal(bumpPageRenderRevision(documentState, 3), 1);
  assert.equal(bumpPageRenderRevision(documentState, 3), 2);
  assert.equal(pageRenderRevision(documentState, 4), 0);
});

test('settled surface requires final quality within the density tolerance', () => {
  const target = requestedRasterScale(1.5, 2);
  assert.equal(renderedSurfaceIsSharp(createRenderedSurfaceState({
    targetRasterScale: target,
    actualRasterScale: 2.991,
    cssScale: 1.5,
    devicePixelRatio: 2,
    quality: RasterQuality.FINAL,
  })), true);
  assert.equal(renderedSurfaceIsSharp(createRenderedSurfaceState({
    targetRasterScale: target,
    actualRasterScale: target,
    cssScale: 1.5,
    devicePixelRatio: 2,
    quality: RasterQuality.PREVIEW,
  })), false);
});
