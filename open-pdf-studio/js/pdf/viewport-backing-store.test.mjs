import assert from 'node:assert/strict';
import test from 'node:test';

import { releaseCanvasBackingStores } from './viewport-backing-store.js';

test('hidden viewport canvases release backing pixels without changing their CSS geometry', () => {
  const pdf = { width: 1600, height: 1200, style: { width: '800px', height: '600px' } };
  const annotation = { width: 1600, height: 1200, style: { width: '800px', height: '600px' } };
  const result = releaseCanvasBackingStores([pdf, annotation, pdf]);

  assert.deepEqual(result, {
    releasedBytes: 1600 * 1200 * 4 * 2,
    releasedCount: 2,
  });
  assert.equal(pdf.width, 0);
  assert.equal(pdf.height, 0);
  assert.equal(annotation.width, 0);
  assert.equal(annotation.height, 0);
  assert.deepEqual(pdf.style, { width: '800px', height: '600px' });
});

test('backing-store release is idempotent', () => {
  const canvas = { width: 0, height: 0, style: {} };
  assert.deepEqual(releaseCanvasBackingStores([canvas]), {
    releasedBytes: 0,
    releasedCount: 0,
  });
});
