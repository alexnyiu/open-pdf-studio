import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearAllBitmaps,
  clearBitmapsForPages,
  consumeCachedBitmapAfterTransfer,
  computeCappedWholePageScale,
  computeZoomBucket,
  getCachedBitmap,
  registerPageBitmapCacheOwner,
  releaseCachedBitmapAfterPublication,
  setCachedBitmapEntry,
  trimIdlePageBitmaps,
} from './page-bitmap-cache.js';
import { setActiveRenderDocument } from './render-resource-budget.js';

const context = (overrides = {}) => ({
  documentId: 'doc-raster', lifecycleGeneration: 2, pageRevision: 1,
  cssScale: 1, devicePixelRatio: 2, quality: 'final', targetRasterScale: 2,
  ...overrides,
});

test('whole-page zoom quantization never rounds back above the bitmap axis cap', () => {
  const maximumAxis = 4096;
  const letterMaximumPointAxis = 792;
  const capScale = maximumAxis / letterMaximumPointAxis;

  assert.equal(computeZoomBucket(5), 8);
  assert.equal(computeCappedWholePageScale(5, capScale), capScale);
  assert.ok(letterMaximumPointAxis * computeCappedWholePageScale(5, capScale) <= maximumAxis);
});

test('whole-page zoom quantization retains reusable buckets below the cap', () => {
  assert.equal(computeCappedWholePageScale(3, 5.2), 4);
  assert.equal(computeCappedWholePageScale(0.2, 5.2), 0.25);
  assert.equal(computeCappedWholePageScale(6, 5.2), 5.2);
});

test('large-document idle trim keeps current page and one nearby preview', () => {
  const closed = [];
  const bitmap = (pageNum) => ({ close: () => closed.push(pageNum) });
  for (let pageNum = 1; pageNum <= 4; pageNum += 1) {
    setCachedBitmapEntry('/trim.pdf', pageNum, 0, 1, bitmap(pageNum), 10, 10, 1);
  }

  const result = trimIdlePageBitmaps({
    filePath: '/trim.pdf',
    maximumBytes: 800,
    currentPageNum: 2,
  });

  assert.equal(result.beforeBytes, 1_600);
  assert.equal(result.afterBytes, 800);
  assert.equal(result.evictedEntries, 2);
  assert.ok(getCachedBitmap('/trim.pdf', 2, 0, 1));
  assert.equal(closed.includes(2), false);
  clearAllBitmaps();
});

test('idle trim does not retain a duplicate bitmap for mounted overscan pages', () => {
  const closed = [];
  const priorDocument = globalThis.document;
  registerPageBitmapCacheOwner('/overscan.pdf', 'doc-overscan', 1);
  setActiveRenderDocument('doc-overscan');
  for (let pageNum = 1; pageNum <= 4; pageNum += 1) {
    setCachedBitmapEntry(
      '/overscan.pdf', pageNum, 0, 1,
      { close: () => closed.push(pageNum) }, 10, 10, 1,
    );
  }
  globalThis.document = {
    querySelectorAll: () => [
      {
        dataset: { page: '1', strictlyVisible: 'false' },
        querySelector: () => ({
          width: 10,
          height: 10,
          dataset: { renderSurface: 'pdf' },
        }),
      },
      { dataset: { page: '3', strictlyVisible: 'true' } },
      { dataset: { page: '4', strictlyVisible: 'false' } },
    ],
  };

  try {
    const result = trimIdlePageBitmaps({
      filePath: '/overscan.pdf',
      maximumBytes: 800,
      currentPageNum: 2,
    });

    assert.equal(result.beforeBytes, 1_600);
    assert.equal(result.afterBytes, 800);
    assert.deepEqual(closed, [1, 4]);
    assert.ok(getCachedBitmap('/overscan.pdf', 2, 0, 1));
    assert.ok(getCachedBitmap('/overscan.pdf', 3, 0, 1));
  } finally {
    clearAllBitmaps();
    setActiveRenderDocument(null);
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
});

test('idle trim releases visible and current decoded rasters after their canvases publish', () => {
  const closed = [];
  const priorDocument = globalThis.document;
  registerPageBitmapCacheOwner('/painted.pdf', 'doc-painted', 1);
  setActiveRenderDocument('doc-painted');
  for (let pageNum = 1; pageNum <= 3; pageNum += 1) {
    setCachedBitmapEntry(
      '/painted.pdf', pageNum, 0, 1,
      { close: () => closed.push(pageNum) }, 10, 10, 1,
    );
  }
  const paintedWrapper = (pageNum, strictlyVisible) => ({
    dataset: {
      page: String(pageNum),
      strictlyVisible: String(strictlyVisible),
      rasterQuality: 'final',
    },
    querySelector: () => ({
      width: 10,
      height: 10,
      dataset: { renderSurface: 'pdf' },
    }),
  });
  globalThis.document = {
    querySelectorAll: () => [
      paintedWrapper(1, true),
      paintedWrapper(2, true),
      paintedWrapper(3, false),
    ],
  };

  try {
    const result = trimIdlePageBitmaps({
      filePath: '/painted.pdf',
      maximumBytes: 32 * 1024 * 1024,
      currentPageNum: 2,
      protectedPageNums: [1],
    });

    assert.equal(result.beforeBytes, 1_200);
    assert.equal(result.afterBytes, 0);
    assert.equal(result.evictedBytes, 1_200);
    assert.equal(result.duplicateBytesEvicted, 1_200);
    assert.equal(result.duplicateEntriesEvicted, 3);
    assert.deepEqual(closed, [1, 2, 3]);
    assert.equal(getCachedBitmap('/painted.pdf', 1, 0, 1), null);
    assert.equal(getCachedBitmap('/painted.pdf', 2, 0, 1), null);
    assert.equal(getCachedBitmap('/painted.pdf', 3, 0, 1), null);
  } finally {
    clearAllBitmaps();
    setActiveRenderDocument(null);
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
});

test('shared registry reuses a denser final surface across view scale requests', () => {
  registerPageBitmapCacheOwner('/registry.pdf', 'doc-raster', 2, () => 1);
  const bitmap = { close() {} };
  setCachedBitmapEntry('/registry.pdf', 3, 0, 3, bitmap, 300, 400, 3,
    context({ cssScale: 1.5, targetRasterScale: 3, actualRasterScale: 3 }));
  const reused = getCachedBitmap('/registry.pdf', 3, 0, 2, context());
  assert.equal(reused?.bitmap, bitmap);
  clearAllBitmaps();
});

test('page 250 invalidation keeps pages 245 through 255 warm', () => {
  const closed = [];
  for (let pageNum = 245; pageNum <= 255; pageNum += 1) {
    setCachedBitmapEntry('/thousand-pages.pdf', pageNum, 0, 1,
      { close: () => closed.push(pageNum) }, 10, 10, 1);
  }
  clearBitmapsForPages('/thousand-pages.pdf', [250]);
  assert.equal(getCachedBitmap('/thousand-pages.pdf', 250, 0, 1), null);
  for (const pageNum of [245, 246, 247, 248, 249, 251, 252, 253, 254, 255]) {
    assert.ok(getCachedBitmap('/thousand-pages.pdf', pageNum, 0, 1));
  }
  assert.deepEqual(closed, [250]);
  clearAllBitmaps();
});

test('proxy-global revision preserves a page until its own revision changes', () => {
  let contentRevision = 4;
  let pageRevision = 1;
  registerPageBitmapCacheOwner('/same-raster.pdf', 'doc-raster', 2, () => 1, () => contentRevision);
  const closed = [];
  const old = { close: () => closed.push('old') };
  setCachedBitmapEntry('/same-raster.pdf', 3, 0, 4, old, 400, 400, 4,
    context({ contentRevision: 4, targetRasterScale: 4, actualRasterScale: 4 }));
  contentRevision = 5;
  assert.equal(getCachedBitmap('/same-raster.pdf', 3, 0, 2,
    context({ contentRevision: 5, pageRevision }))?.bitmap, old);
  pageRevision = 2;
  const current = { close: () => closed.push('current') };
  setCachedBitmapEntry('/same-raster.pdf', 3, 0, 2, current, 200, 200, 2,
    context({ contentRevision: 5, pageRevision, targetRasterScale: 2, actualRasterScale: 2 }));
  assert.deepEqual(closed, ['old']);
  assert.equal(getCachedBitmap('/same-raster.pdf', 3, 0, 2,
    context({ contentRevision: 5, pageRevision }))?.bitmap, current);
  clearAllBitmaps();
});

test('preview surface cannot satisfy a settled final request', () => {
  registerPageBitmapCacheOwner('/preview.pdf', 'doc-raster', 2, () => 1);
  setCachedBitmapEntry('/preview.pdf', 1, 0, 4, { close() {} }, 400, 400, 4,
    context({ quality: 'preview', targetRasterScale: 4, actualRasterScale: 4 }));
  assert.equal(getCachedBitmap('/preview.pdf', 1, 0, 2, context()), null);
  clearAllBitmaps();
});

test('published canvas becomes the sole raster owner after coalesced waiters can paint', async () => {
  const closed = [];
  registerPageBitmapCacheOwner('/published.pdf', 'doc-raster', 2, () => 1);
  const entry = setCachedBitmapEntry(
    '/published.pdf', 7, 0, 2,
    { close: () => closed.push(7) }, 200, 300, 2,
    context({ pageRevision: 1 }),
  );

  assert.equal(releaseCachedBitmapAfterPublication(entry), true);
  assert.equal(releaseCachedBitmapAfterPublication(entry), false);
  assert.equal(getCachedBitmap('/published.pdf', 7, 0, 2, context()), entry);
  assert.deepEqual(closed, []);

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(getCachedBitmap('/published.pdf', 7, 0, 2, context()), null);
  assert.deepEqual(closed, [7]);
  clearAllBitmaps();
});

test('bitmaprenderer transfer synchronously removes the detached registry entry', () => {
  const closed = [];
  registerPageBitmapCacheOwner('/transferred.pdf', 'doc-raster', 2, () => 1);
  const entry = setCachedBitmapEntry(
    '/transferred.pdf', 8, 0, 2,
    { close: () => closed.push(8) }, 200, 300, 2,
    context({ pageRevision: 1 }),
  );

  assert.equal(consumeCachedBitmapAfterTransfer(entry), true);
  assert.equal(consumeCachedBitmapAfterTransfer(entry), false);
  assert.equal(getCachedBitmap('/transferred.pdf', 8, 0, 2, context()), null);
  assert.deepEqual(closed, []);
  clearAllBitmaps();
});
