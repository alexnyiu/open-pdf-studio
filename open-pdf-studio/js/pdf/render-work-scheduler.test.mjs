import assert from 'node:assert/strict';
import test from 'node:test';

import { createRenderWorkScheduler } from './render-work-scheduler.js';

test('scheduler runs one foreground task at a time and orders queued work by priority', async () => {
  const scheduler = createRenderWorkScheduler();
  const order = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const first = scheduler.schedule({ key: 'first', priority: 1, run: async () => { order.push('first'); await barrier; } });
  const low = scheduler.schedule({ key: 'low', priority: 2, run: () => order.push('low') });
  const high = scheduler.schedule({ key: 'high', priority: 10, run: () => order.push('high') });
  release();
  await Promise.all([first, low, high]);
  assert.deepEqual(order, ['first', 'high', 'low']);
});

test('foreground interaction cancels queued background work without invalidating visible work', async () => {
  const scheduler = createRenderWorkScheduler();
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const foreground = scheduler.schedule({ key: 'visible', run: () => barrier });
  const background = scheduler.schedule({ key: 'preload', kind: 'background', run: () => 'unexpected' });
  scheduler.noteInteraction();
  release();
  assert.equal((await background).status, 'cancelled');
  assert.equal((await foreground).status, 'complete');
  assert.deepEqual(scheduler.snapshot().statistics, {
    scheduled: 2,
    completed: 1,
    cancelled: 1,
    failed: 0,
    maxQueued: 1,
    maxRunning: 1,
  });
});

test('foreground interaction invalidates a running background completion', async () => {
  const scheduler = createRenderWorkScheduler();
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const background = scheduler.schedule({ key: 'running-preload', kind: 'background', run: () => barrier });
  scheduler.noteInteraction();
  release('late bitmap');
  assert.equal((await background).status, 'cancelled');
  assert.equal(scheduler.snapshot().statistics.cancelled, 1);
});
