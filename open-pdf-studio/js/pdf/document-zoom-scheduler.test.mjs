import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomFrameState } from './zoom-frame-state.js';

test('pending zoom cancellation clears its RAF and invalidates a delivered callback', async () => {
  const callbacks = new Map();
  const cancelled = [];
  const performed = [];
  let nextFrame = 0;
  const frames = createZoomFrameState({
    requestFrame(callback) {
      const id = ++nextFrame;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      cancelled.push(id);
      callbacks.delete(id);
    },
  });

  assert.equal(frames.enqueue({
    key: 'document-1:7:1:single:3:blank',
    owner: { documentId: 'document-1', lifecycleGeneration: 7 },
    accumulatedDelta: -80,
  }, async (request) => performed.push(request)), true);
  assert.equal(frames.enqueue({
    key: 'document-1:7:1:single:3:blank',
    owner: { documentId: 'document-1', lifecycleGeneration: 7 },
    accumulatedDelta: -40,
    clientPoint: { x: 40, y: 50 },
  }, async (request) => performed.push(request)), true);
  assert.equal(frames.snapshot().accumulatedDelta, -120);
  assert.deepEqual(frames.snapshot().clientPoint, { x: 40, y: 50 });
  const delivered = callbacks.get(1);
  frames.cancel();
  assert.equal(frames.snapshot(), null);
  assert.deepEqual(cancelled, [1]);
  await delivered();
  assert.deepEqual(performed, []);
});

test('a new document owner cancels the prior accumulated zoom frame', async () => {
  const callbacks = new Map();
  const cancelled = [];
  let nextFrame = 0;
  const frames = createZoomFrameState({
    requestFrame(callback) {
      const id = ++nextFrame;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      cancelled.push(id);
      callbacks.delete(id);
    },
  });
  frames.enqueue({ key: 'owner-a', owner: { documentId: 'a' }, accumulatedDelta: 10 }, async () => {});
  frames.enqueue({ key: 'owner-b', owner: { documentId: 'b' }, accumulatedDelta: 20 }, async () => {});
  assert.deepEqual(cancelled, [1]);
  assert.equal(frames.snapshot().owner.documentId, 'b');
  assert.equal(frames.snapshot().accumulatedDelta, 20);
  await callbacks.get(2)();
  assert.equal(frames.snapshot(), null);
});

test('cancellation invalidates an asynchronous zoom operation already released by RAF', async () => {
  let callback = null;
  let release = null;
  let applied = false;
  const barrier = new Promise((resolve) => { release = resolve; });
  const frames = createZoomFrameState({
    requestFrame(value) { callback = value; return 1; },
    cancelFrame() {},
  });
  frames.enqueue({ key: 'owner', owner: { documentId: 'owner' }, accumulatedDelta: 1 },
    async (_request, operation) => {
      await barrier;
      if (operation.isCurrent()) applied = true;
    });
  const running = callback();
  frames.cancel();
  release();
  await running;
  assert.equal(applied, false);
});
