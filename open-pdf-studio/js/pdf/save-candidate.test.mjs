import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearSaveCandidates,
  createSaveCandidate,
  latestSaveCandidate,
  storeSaveCandidate,
} from './save-candidate.js';

function candidate(revision, destroyed) {
  return createSaveCandidate({
    documentId: 'doc-a',
    lifecycleGeneration: 3,
    requestedRevision: revision,
    outputPath: '/tmp/doc-a.pdf',
    bytes: new Uint8Array([revision, 2, 3]),
    pageCount: 1,
    preparedPdfJsDocument: {
      async destroy() { destroyed.push(revision); },
    },
  });
}

test('the exact latest candidate is reused and a superseded candidate is disposed', async () => {
  const destroyed = [];
  const first = candidate(1, destroyed);
  await storeSaveCandidate(first);
  assert.equal(latestSaveCandidate('doc-a', 3, 1), first);

  const second = candidate(2, destroyed);
  await storeSaveCandidate(second);
  assert.equal(latestSaveCandidate('doc-a', 3, 1), null);
  assert.equal(latestSaveCandidate('doc-a', 3, 2), second);
  assert.deepEqual(destroyed, [1]);

  await clearSaveCandidates('doc-a');
  assert.deepEqual(destroyed, [1, 2]);
});

test('candidate bytes are immutable copies of serializer output', async () => {
  const source = new Uint8Array([1, 2, 3]);
  const saved = createSaveCandidate({
    documentId: 'doc-b',
    lifecycleGeneration: 1,
    requestedRevision: 1,
    outputPath: '/tmp/doc-b.pdf',
    bytes: source,
    pageCount: 1,
  });
  source[0] = 9;
  assert.deepEqual([...saved.bytes], [1, 2, 3]);
});
