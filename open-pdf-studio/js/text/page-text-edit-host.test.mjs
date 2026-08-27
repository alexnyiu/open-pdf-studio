import assert from 'node:assert/strict';
import test from 'node:test';

import { pageTextEditHostMatchesPlacement } from './page-text-edit-host-identity.js';

function host(dataset, isHost = true) {
  return {
    dataset,
    classList: {
      contains(value) {
        return isHost && value === 'pdf-text-edit-layer';
      },
    },
  };
}

const placement = Object.freeze({
  documentId: 'doc-current',
  pageNum: 2,
  generation: 7,
});

test('page editor hosts require exact immutable owner, page, and generation identity', () => {
  assert.equal(pageTextEditHostMatchesPlacement(host({
    documentId: 'doc-current',
    page: '2',
    generation: '7',
  }), placement), true);

  for (const dataset of [
    { documentId: 'doc-stale', page: '2', generation: '7' },
    { documentId: 'doc-current', page: '1', generation: '7' },
    { documentId: 'doc-current', page: '2', generation: '6' },
  ]) {
    assert.equal(pageTextEditHostMatchesPlacement(host(dataset), placement), false);
  }
  assert.equal(pageTextEditHostMatchesPlacement(host({
    documentId: 'doc-current', page: '2', generation: '7',
  }, false), placement), false);
});
