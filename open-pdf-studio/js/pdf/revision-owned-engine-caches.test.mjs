import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cachePageType,
  evictAll as evictAllPageTypes,
  getCachedPageType,
  registerPageTypeCacheOwner,
} from './page-type-cache.js';
import {
  cacheCommands,
  clearVectorCache,
  hasCachedCommands,
  registerVectorCacheOwner,
} from './vector-renderer.js';

test.afterEach(() => {
  evictAllPageTypes();
  clearVectorCache();
});

test('page-type analysis from the same path is owned by content and page revision', () => {
  let contentRevision = 1;
  let pageRevision = 1;
  registerPageTypeCacheOwner('/analysis.pdf', 'analysis-doc', 2,
    () => contentRevision, () => pageRevision);
  cachePageType('/analysis.pdf', 0, 'tile');
  assert.equal(getCachedPageType('/analysis.pdf', 0), 'tile');
  contentRevision = 2;
  pageRevision = 2;
  assert.equal(getCachedPageType('/analysis.pdf', 0), null);
});

test('vector commands and decoded-image ownership cannot cross a saved revision', () => {
  let contentRevision = 7;
  let pageRevision = 7;
  registerVectorCacheOwner('/vector.pdf', 'vector-doc', 4,
    () => contentRevision, () => pageRevision);
  const commands = new Uint8Array(16);
  assert.equal(cacheCommands('/vector.pdf', 1, commands, 0), true);
  assert.equal(hasCachedCommands('/vector.pdf', 1, 0), true);
  contentRevision = 8;
  pageRevision = 8;
  assert.equal(hasCachedCommands('/vector.pdf', 1, 0), false);
});
