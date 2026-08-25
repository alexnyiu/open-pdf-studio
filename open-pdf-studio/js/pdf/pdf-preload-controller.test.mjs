import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundedPdfPreloadController,
  PreloadResourceBudget,
  directionalPreloadPages,
  wholeDocumentPreloadPages,
} from './pdf-preload-controller.js';

test('directional window prioritizes current and three pages in reading direction', () => {
  assert.deepEqual(directionalPreloadPages(4, 10, 1), [4, 5, 6, 7, 3]);
  assert.deepEqual(directionalPreloadPages(4, 10, -1), [4, 3, 2, 1, 5]);
});

test('whole-document order prioritizes current and visible thumbnails before reading order', () => {
  assert.deepEqual(wholeDocumentPreloadPages(5, 7, [4, 6, 5]), [5, 4, 6, 1, 2, 3, 7]);
});

test('resource budget reports page, byte, and cumulative-work limits deterministically', () => {
  const pageBudget = new PreloadResourceBudget({ maxPages: 2, maxBytes: 1000, maxWorkMs: 1000 });
  assert.equal(pageBudget.record({ bytes: 10, elapsedMs: 10 }), null);
  assert.equal(pageBudget.record({ bytes: 10, elapsedMs: 10 }), 'pages');

  const byteBudget = new PreloadResourceBudget({ maxPages: 10, maxBytes: 20, maxWorkMs: 1000 });
  assert.equal(byteBudget.record({ bytes: 20, elapsedMs: 1 }), 'bytes');

  const timeBudget = new PreloadResourceBudget({ maxPages: 10, maxBytes: 1000, maxWorkMs: 20 });
  assert.equal(timeBudget.record({ bytes: 1, elapsedMs: 20 }), 'time');
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

test('controller yields completely while foreground work is active and resumes on a later schedule', async () => {
  let foregroundIdle = false;
  const calls = [];
  const controller = new BoundedPdfPreloadController({
    isIdle: () => foregroundIdle,
    load: async (page) => { calls.push(page); return { value: page, bytes: 1 }; },
  });
  await controller.schedule([1, 2]);
  assert.deepEqual(calls, []);
  foregroundIdle = true;
  await controller.schedule([1, 2]);
  assert.deepEqual(calls, [1, 2]);
});

test('completion from a cancelled generation is discarded before the replacement sweep runs', async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  const controller = new BoundedPdfPreloadController({
    load: async (page) => {
      calls.push(page);
      if (page === 1) await firstGate;
      return { value: page, bytes: 1 };
    },
  });
  const first = controller.schedule([1]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacement = controller.schedule([2]);
  releaseFirst();
  await Promise.all([first, replacement]);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(controller.get(1), null);
  assert.equal(controller.get(2), 2);
});
