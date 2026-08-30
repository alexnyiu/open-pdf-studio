import assert from 'node:assert/strict';
import test from 'node:test';

import { PageGeometryIndex, pageGeometryEntries } from './page-geometry-index.js';

test('page geometry applies application rotations without losing stable page identity', () => {
  const entries = pageGeometryEntries([[612, 792], [400, 500]], { 2: 90 });
  assert.deepEqual(entries.map(({ pageNum, widthPt, heightPt }) => ({ pageNum, widthPt, heightPt })), [
    { pageNum: 1, widthPt: 612, heightPt: 792 },
    { pageNum: 2, widthPt: 500, heightPt: 400 },
  ]);
});

test('continuous index resolves offsets and bounds the mounted page window', () => {
  const index = new PageGeometryIndex(pageGeometryEntries(Array.from({ length: 100 }, () => [612, 792])));
  assert.equal(index.pageAtOffset(20), 1);
  assert.equal(index.pageAtOffset(index.pageRect(50, { scale: 1 }).y + 1), 50);
  const pages = index.visiblePages({ scrollTop: index.pageRect(50, { scale: 1 }).y, viewportHeight: 900 });
  assert.ok(pages.includes(50));
  assert.ok(pages.length <= 9);
});

test('book index pairs pages into stable rows and positions them around the spine', () => {
  const index = new PageGeometryIndex(pageGeometryEntries([[600, 800], [600, 800], [500, 700]]));
  assert.equal(index.rows('book').length, 2);
  const left = index.pageRect(2, { layout: 'book', contentWidth: 1400 });
  const right = index.pageRect(3, { layout: 'book', contentWidth: 1400 });
  assert.ok(left.x + left.width < right.x);
  assert.equal(left.y, right.y);
});

test('protected editor page remains mounted outside the ordinary overscan window', () => {
  const index = new PageGeometryIndex(pageGeometryEntries(Array.from({ length: 30 }, () => [612, 792])));
  const pages = index.visiblePages({ scrollTop: 20, viewportHeight: 800, protectedPages: [20] });
  assert.ok(pages.includes(20));
});

test('visible-range lookup enters a large geometry index near the requested offset', () => {
  const index = new PageGeometryIndex(pageGeometryEntries(Array.from({ length: 10_000 }, () => [612, 792])));
  const pageNineThousand = index.pageRect(9_000, { scale: 1 });
  assert.equal(index.rowIndexAtOffset(pageNineThousand.y + 1), 8_999);
  assert.deepEqual(
    index.visiblePages({ scrollTop: pageNineThousand.y, viewportHeight: 792, overscanPx: 0 }),
    [9_000],
  );
});

test('strict visibility stays correct across a mixed-size page boundary', () => {
  const index = new PageGeometryIndex(pageGeometryEntries([
    [612, 400],
    [612, 1_200],
    [612, 300],
  ]));
  const second = index.pageRect(2, { scale: 1 });
  const pages = index.visiblePages({
    scrollTop: second.y - 100,
    viewportHeight: 500,
    overscanPx: 0,
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(index.pageAtOffset(second.y + 900), 2);
});
