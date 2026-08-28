import test from 'node:test';
import assert from 'node:assert/strict';
import { createThumbnailGeometry } from './thumbnail-virtualization.js';

test('thumbnail virtualization keeps exact scroll extent and mounts at most 32 items', () => {
  const geometry = createThumbnailGeometry(500, {
    heightForPage: (page) => page % 2 ? 200 : 100,
  });
  const first = geometry.window({ scrollTop: 0, viewportHeight: 600 });
  const middle = geometry.window({ scrollTop: geometry.pageTop(250), viewportHeight: 600 });
  assert.equal(first.start, 1);
  assert.ok(first.pages.length <= 32);
  assert.ok(middle.start < 250 && middle.end > 250);
  assert.ok(middle.pages.length <= 32);
  assert.equal(middle.topSpacer + middle.bottomSpacer < geometry.totalHeight, true);
});
