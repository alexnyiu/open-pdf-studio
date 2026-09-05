import assert from 'node:assert/strict';
import test from 'node:test';
import { unrotatedTileRegion, rotateTileRgba } from './page-tile-rotation.js';

test('rotated page regions map to the corresponding bounded native rectangle', () => {
  const tile = { regionXpt: 10, regionYpt: 20, regionWpt: 30, regionHpt: 40 };
  assert.deepEqual(unrotatedTileRegion(tile, 600, 800, 0), { x: 10, y: 20, width: 30, height: 40 });
  assert.deepEqual(unrotatedTileRegion(tile, 800, 600, 90), { x: 20, y: 760, width: 40, height: 30 });
  assert.deepEqual(unrotatedTileRegion(tile, 600, 800, 180), { x: 560, y: 740, width: 30, height: 40 });
  assert.deepEqual(unrotatedTileRegion(tile, 800, 600, 270), { x: 540, y: 10, width: 40, height: 30 });
});

test('RGBA tile rotations preserve every pixel and alpha in display order', () => {
  const pixels = new Uint8ClampedArray(new Uint32Array([1, 2, 3, 4, 5, 6]).buffer);
  const expected = new Map([[0, [1, 2, 3, 4, 5, 6]], [90, [5, 3, 1, 6, 4, 2]],
    [180, [6, 5, 4, 3, 2, 1]], [270, [2, 4, 6, 1, 3, 5]]]);
  for (const [angle, values] of expected) {
    const result = rotateTileRgba(pixels, 2, 3, angle);
    assert.deepEqual([...new Uint32Array(result.pixels.buffer)], values);
    assert.deepEqual([result.width, result.height], angle % 180 ? [3, 2] : [2, 3]);
    const original = rotateTileRgba(result.pixels, result.width, result.height, -angle);
    assert.deepEqual([...original.pixels], [...pixels]);
  }
  assert.equal(rotateTileRgba(pixels, 2, 3, 0).pixels, pixels);
});
