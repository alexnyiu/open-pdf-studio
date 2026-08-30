import assert from 'node:assert/strict';
import test from 'node:test';

import { applyContinuousPageSurfaceLayout } from './continuous-page-surface-layout.js';

test('continuous raster publications cannot replace wrapper-owned CSS geometry', () => {
  const surface = {
    style: { width: '450px', height: '300px' },
    dataset: {},
  };

  assert.equal(applyContinuousPageSurfaceLayout(surface, 'bitmap-publication'), true);
  assert.deepEqual(surface.style, { width: '100%', height: '100%' });
  assert.equal(surface.dataset.layoutSizeOwner, 'bitmap-publication');

  // A later compatible cache publication may carry a different backing
  // density, but it still cannot install its raster dimensions as CSS size.
  surface.style.width = '900px';
  surface.style.height = '600px';
  assert.equal(applyContinuousPageSurfaceLayout(surface, 'cache-republication'), true);
  assert.deepEqual(surface.style, { width: '100%', height: '100%' });
});

test('continuous layout sizing fails closed without a style-capable surface', () => {
  assert.equal(applyContinuousPageSurfaceLayout(null), false);
  assert.equal(applyContinuousPageSurfaceLayout({}), false);
});
