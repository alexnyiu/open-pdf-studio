import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedPdfPreloadController, directionalPreloadPages } from './pdf-preload-controller.js';

test('directional window prioritizes current and three pages in reading direction', () => {
  assert.deepEqual(directionalPreloadPages(4, 10, 1), [4, 5, 6, 7, 3]);
  assert.deepEqual(directionalPreloadPages(4, 10, -1), [4, 3, 2, 1, 5]);
});

test('controller deduplicates, evicts LRU, protects visible pages, and cancels generations', async () => {
  const calls = [];
  const events = [];
  const controller = new BoundedPdfPreloadController({
    maxPages: 2, maxBytes: 20,
    load: async (page) => { calls.push(page); return { value: `p${page}`, bytes: 10 }; },
    log: (event) => events.push(event),
  });
  await controller.schedule([1, 1, 2], { protectedPages: [1] });
  await controller.schedule([3], { protectedPages: [1] });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(controller.get(1), 'p1');
  assert.equal(controller.get(2), null);
  assert.equal(events.some((event) => event.type === 'eviction'), true);
  const first = controller.schedule([4, 5]);
  const second = controller.schedule([6]);
  await Promise.all([first, second]);
  assert.equal(controller.get(6), 'p6');
});
