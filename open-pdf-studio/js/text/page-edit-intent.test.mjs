import assert from 'node:assert/strict';
import test from 'node:test';

import { runPageEditIntent } from './page-edit-intent.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('a text click during synchronization preserves its page and point and replays once', async () => {
  const documentState = { id: 'intent-owner', lifecycleGeneration: 3 };
  const synchronization = deferred();
  const readiness = deferred();
  const activations = [];
  const intent = runPageEditIntent({
    documentState,
    pageNum: 4,
    point: { x: 12.5, y: 28.25 },
    waitForSynchronization: () => synchronization.promise,
    resolveDocument: () => documentState,
    awaitReadiness: () => readiness.promise,
    activate: (activation) => { activations.push(activation); return 'opened'; },
  });
  synchronization.resolve(true);
  await Promise.resolve();
  assert.equal(activations.length, 0);
  readiness.resolve();
  const result = await intent;
  assert.equal(result.activated, true);
  assert.equal(result.value, 'opened');
  assert.equal(activations.length, 1);
  assert.equal(activations[0].documentState, documentState);
  assert.equal(activations[0].pageNum, 4);
  assert.deepEqual(activations[0].point, { x: 12.5, y: 28.25 });
});

test('a lifecycle change rejects a queued edit without activation', async () => {
  const documentState = { id: 'intent-owner', lifecycleGeneration: 3 };
  const readiness = deferred();
  let activations = 0;
  const intent = runPageEditIntent({
    documentState,
    pageNum: 1,
    point: { x: 1, y: 2 },
    waitForSynchronization: async () => true,
    resolveDocument: () => documentState,
    awaitReadiness: () => readiness.promise,
    activate: () => { activations += 1; },
  });
  await Promise.resolve();
  documentState.lifecycleGeneration += 1;
  readiness.resolve();
  await assert.rejects(intent, { name: 'AbortError' });
  assert.equal(activations, 0);
});
