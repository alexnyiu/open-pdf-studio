import assert from 'node:assert/strict';
import test from 'node:test';

import { createLowResolutionPreviewKey } from './low-resolution-preview-key.js';

function previewOwner(overrides = {}) {
  return {
    id: 'preview-document',
    filePath: '/same-preview.pdf',
    lifecycleGeneration: 2,
    revisionState: { contentRevision: 3 },
    pageRenderRevisions: { 1: 3 },
    pageRotations: { 1: 0 },
    ...overrides,
  };
}

test('low-resolution previews distinguish lifecycle, content, page revision, and rotation', () => {
  const baseline = createLowResolutionPreviewKey(previewOwner(), 1);
  for (const owner of [
    previewOwner({ lifecycleGeneration: 3 }),
    previewOwner({ revisionState: { contentRevision: 4 } }),
    previewOwner({ pageRenderRevisions: { 1: 4 } }),
    previewOwner({ pageRotations: { 1: 90 } }),
  ]) assert.notEqual(createLowResolutionPreviewKey(owner, 1), baseline);
});
