import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentOpenQueue } from './document-open-queue.js';

test('a reactive wrapper resolves the same document ID and generation', async () => {
  const raw = { id: 'reactive-owner', lifecycleGeneration: 0 };
  const reactive = new Proxy(raw, {});
  const loaded = [];
  const queue = createDocumentOpenQueue({ resolve: () => reactive, active: () => reactive,
    load: async (path, owner) => loaded.push({ path, owner }) });
  await queue.enqueue([{ path: 'reactive.pdf', document: raw }]);
  assert.deepEqual(loaded, [{ path: 'reactive.pdf', owner: reactive }]);
});

test('queued owners survive reorder, skip closed generations, and prefer the selected tab', async () => {
  const a = { id: 'a', lifecycleGeneration: 0 };
  const b = { id: 'b', lifecycleGeneration: 0 };
  const c = { id: 'c', lifecycleGeneration: 0 };
  let docs = [a, b, c], active = a, unblock;
  const calls = [];
  const queue = createDocumentOpenQueue({
    resolve: id => docs.find(d => d.id === id), active: () => active,
    load: async (path, owner) => { calls.push([path, owner.id]); if (owner === a) await new Promise(r => { unblock = r; }); },
  });
  const pending = queue.enqueue([{ path: 'A', document: a }, { path: 'B', document: b }, { path: 'C', document: c }]);
  await Promise.resolve();
  docs = [c, a]; active = c;
  unblock(); await pending;
  assert.deepEqual(calls, [['A', 'a'], ['C', 'c']]);
});

test('a failed load does not strand later work and a replaced owner is skipped', async () => {
  const docs = [{ id: 'a', lifecycleGeneration: 0 }, { id: 'b', lifecycleGeneration: 0 }];
  const calls = [], errors = [];
  const queue = createDocumentOpenQueue({ resolve: id => docs.find(d => d.id === id), active: () => null,
    load: async (_, doc) => { calls.push(doc.id); throw new Error('read failed'); }, onError: e => errors.push(e.message) });
  const done = queue.enqueue(docs.map(document => ({ path: document.id, document })));
  docs[1].lifecycleGeneration++;
  await done;
  assert.deepEqual(calls, ['a']); assert.deepEqual(errors, ['read failed']);
});

test('closing a pending owner releases it immediately without interrupting the running load', async () => {
  const docs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const calls = [];
  let unblock;
  const queue = createDocumentOpenQueue({ resolve: id => docs.find(doc => doc.id === id), active: () => null,
    load: async (_, doc) => {
      calls.push(doc.id);
      if (doc.id === 'a') await new Promise(resolve => { unblock = resolve; });
    } });
  const done = queue.enqueue(docs.map(document => ({ path: document.id, document })));
  await Promise.resolve();
  assert.equal(queue.pendingCount, 2);
  assert.equal(queue.remove('b'), 1);
  assert.equal(queue.pendingCount, 1);
  assert.equal(queue.remove('a'), 0);
  assert.deepEqual(calls, ['a']);
  unblock();
  await done;
  assert.deepEqual(calls, ['a', 'c']);
  assert.equal(queue.pendingCount, 0);
});
