import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquirePageLease,
  clearPageLeasesForTests,
  leasedPagesForDocument,
  pageLeaseSnapshot,
  releasePageLease,
  subscribePageLeases,
} from './page-lease-registry.js';

test.afterEach(() => clearPageLeasesForTests());

test('leases retain exact owner lifecycle pages until every handoff releases', () => {
  const owner = acquirePageLease({
    documentId: 'doc-a', lifecycleGeneration: 4, pageNum: 3, reason: 'edit-owner',
  });
  const target = acquirePageLease({
    documentId: 'doc-a', lifecycleGeneration: 4, pageNum: 8, reason: 'click-away-target',
  });
  acquirePageLease({ documentId: 'doc-a', lifecycleGeneration: 5, pageNum: 99 });
  assert.deepEqual(leasedPagesForDocument('doc-a', 4), [3, 8]);
  assert.equal(releasePageLease(owner), true);
  assert.deepEqual(leasedPagesForDocument('doc-a', 4), [8]);
  assert.equal(releasePageLease(target), true);
  assert.deepEqual(leasedPagesForDocument('doc-a', 4), []);
});

test('lease events are terminal, idempotent, and carry immutable identity', () => {
  const events = [];
  const unsubscribe = subscribePageLeases((event) => events.push(event));
  const lease = acquirePageLease({ documentId: 'doc-b', pageNum: 2, reason: 'test' });
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(releasePageLease(lease), true);
  assert.equal(releasePageLease(lease), false);
  unsubscribe();
  assert.deepEqual(events.map((event) => event.type), ['acquired', 'released']);
  assert.equal(pageLeaseSnapshot().length, 0);
});

test('continuous virtualization protects every leased page in windowing and idle trim', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./renderer.js', import.meta.url), 'utf8');
  const protectedPages = source.slice(
    source.indexOf('function _protectedContinuousPages'),
    source.indexOf('\nfunction _teardownContinuousWindow'),
  );
  const virtualWindow = source.slice(
    source.indexOf('function _updateContinuousVirtualWindow'),
    source.indexOf('\nexport function continuousRenderStateSnapshot'),
  );
  const idleTrim = source.slice(
    source.indexOf('export function trimIdleContinuousPageSurfaces'),
    source.indexOf('\nexport ', source.indexOf('export function trimIdleContinuousPageSurfaces') + 8),
  );
  assert.match(protectedPages, /leasedPagesForDocument/u);
  assert.match(virtualWindow, /protectedPages/u);
  assert.match(idleTrim, /for \(const pageNum of protectedPages\) keep\.add\(pageNum\)/u);
});
