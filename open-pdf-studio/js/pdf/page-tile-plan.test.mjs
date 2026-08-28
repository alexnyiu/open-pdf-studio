import assert from 'node:assert/strict';
import test from 'node:test';

import { planVisiblePageTiles } from './page-tile-plan.js';

test('visible continuous region is planned at CSS scale times DPR', () => {
  const [tile] = planVisiblePageTiles({
    pageRect: { left: 100, top: 200, right: 712, bottom: 992 },
    viewportRect: { left: 0, top: 300, right: 900, bottom: 700 },
    cssScale: 1,
    devicePixelRatio: 2,
    pageWidthPt: 612,
    pageHeightPt: 792,
  });
  assert.equal(tile.targetScale, 2);
  assert.ok(tile.regionYpt < 100);
  assert.ok(tile.regionYpt + tile.regionHpt > 500);
});

test('overscanned tiles remain within the bitmap-axis cap', () => {
  const tiles = planVisiblePageTiles({
    pageRect: { left: 0, top: 0, right: 5000, bottom: 5000 },
    viewportRect: { left: 0, top: 0, right: 5000, bottom: 5000 },
    cssScale: 5,
    devicePixelRatio: 3,
    pageWidthPt: 1000,
    pageHeightPt: 1000,
    maxBitmapAxisPx: 4096,
    seamOverscanPx: 2,
  });
  assert.ok(tiles.length > 1);
  assert.ok(tiles.every((tile) => tile.expectedPixelWidth <= 4096));
  assert.ok(tiles.every((tile) => tile.expectedPixelHeight <= 4096));
});

test('rotated page dimensions are accepted without coordinate swapping', () => {
  const [tile] = planVisiblePageTiles({
    pageRect: { left: 0, top: 0, right: 792, bottom: 612 },
    viewportRect: { left: 0, top: 0, right: 792, bottom: 612 },
    cssScale: 1,
    devicePixelRatio: 2,
    pageWidthPt: 792,
    pageHeightPt: 612,
  });
  assert.equal(tile.regionWpt, 792);
  assert.equal(tile.regionHpt, 612);
});
