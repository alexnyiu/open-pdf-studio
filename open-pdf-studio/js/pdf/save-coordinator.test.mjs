import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SaveEditorDeadlineError,
  SaveRequestSupersededError,
  createSaveCoordinator,
} from './save-coordinator.js';
import { createInitialDocumentRevisionState } from '../core/document-revision-state.runtime.js';

function owner(id = 'doc-a', revision = 1, generation = 1) {
  const revisionState = createInitialDocumentRevisionState();
  revisionState.contentRevision = revision;
  return {
    id,
    lifecycleGeneration: generation,
    revisionState,
    pageRenderRevisions: revisionState.pageContentRevisions,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for deterministic coordinator state');
}

test('two automatic requests before serialization coalesce to the latest revision', async () => {
  const document = owner();
  const timers = [];
  const calls = [];
  const coordinator = createSaveCoordinator({
    resolveDocumentById: () => document,
    setTimer(callback, delay) {
      const token = { callback, delay, cancelled: false };
      timers.push(token);
      return token;
    },
    clearTimer(token) {
      token.cancelled = true;
    },
  });
  const execute = async (context) => {
    calls.push(context.requestedRevision);
    return true;
  };
  const first = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    kind: 'auto',
    delayMs: 20,
    execute,
  });
  document.revisionState.contentRevision = 2;
  const second = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 2,
    kind: 'auto',
    delayMs: 20,
    execute,
  });
  const latestTimer = timers.findLast((timer) => timer.delay === 20 && !timer.cancelled);
  latestTimer.callback();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(calls, [2]);
});

test('manual Save flushes a pending automatic request at the latest revision', async () => {
  const document = owner();
  let calls = 0;
  const coordinator = createSaveCoordinator({ resolveDocumentById: () => document });
  const execute = async (context) => {
    calls += 1;
    assert.equal(context.requestedRevision, 2);
    return true;
  };
  const automatic = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    kind: 'auto',
    delayMs: 60_000,
    execute,
  });
  document.revisionState.contentRevision = 2;
  const manual = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 2,
    kind: 'manual',
    execute,
  });
  assert.equal(await manual, true);
  assert.equal(await automatic, true);
  assert.equal(calls, 1);
});

test('a newer revision during serialization schedules a follow-up and blocks the old replacement', async () => {
  const document = owner();
  const serialization = deferred();
  const attempted = [];
  const coordinator = createSaveCoordinator({ resolveDocumentById: () => document });
  const first = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    execute: async (context) => {
      await serialization.promise;
      attempted.push(context.requestedRevision);
      context.assertPersistenceOwnership();
      return true;
    },
  });
  await waitUntil(() => coordinator.debugSnapshot(document.id)?.active?.requestedRevision === 1);
  document.revisionState.contentRevision = 2;
  const followUp = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 2,
    kind: 'auto',
    execute: async (context) => {
      attempted.push(context.requestedRevision);
      context.assertPersistenceOwnership();
      return true;
    },
  });
  serialization.resolve();
  assert.equal(await first, true);
  assert.equal(await followUp, true);
  assert.deepEqual(attempted, [1, 2]);
});

test('an old request cannot replace after lifecycle ownership changes', async () => {
  const document = owner();
  const pause = deferred();
  let replaced = false;
  const coordinator = createSaveCoordinator({ resolveDocumentById: () => document });
  const save = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    execute: async (context) => {
      await pause.promise;
      context.assertPersistenceOwnership();
      replaced = true;
      return true;
    },
  });
  await waitUntil(() => coordinator.debugSnapshot(document.id)?.active != null);
  document.lifecycleGeneration = 2;
  pause.resolve();
  assert.equal(await save, false);
  assert.equal(replaced, false);
});

test('a superseded request that already persisted cannot install a proxy or mark newer state clean', async () => {
  const document = owner();
  const afterReplacement = deferred();
  let oldPublished = false;
  let followUpPublished = false;
  const coordinator = createSaveCoordinator({ resolveDocumentById: () => document });
  const first = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    execute: async (context) => {
      context.assertPersistenceOwnership();
      await afterReplacement.promise;
      oldPublished = context.ownsPublication();
      return { saved: true, followUpNeeded: !oldPublished };
    },
  });
  await waitUntil(() => coordinator.debugSnapshot(document.id)?.active != null);
  document.revisionState.contentRevision = 2;
  const followUp = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 2,
    kind: 'auto',
    execute: async (context) => {
      context.assertPersistenceOwnership();
      followUpPublished = context.ownsPublication();
      return true;
    },
  });
  afterReplacement.resolve();
  assert.equal(await first, true);
  assert.equal(await followUp, true);
  assert.equal(oldPublished, false);
  assert.equal(followUpPublished, true);
});

test('a tab switch cannot redirect immutable save ownership', async () => {
  const documents = new Map([
    ['doc-a', owner('doc-a')],
    ['doc-b', owner('doc-b')],
  ]);
  let activeTab = 'doc-a';
  let savedOwner = null;
  const coordinator = createSaveCoordinator({
    resolveDocumentById: (id) => documents.get(id),
  });
  const save = coordinator.request({
    documentId: 'doc-a',
    documentGeneration: 1,
    requestedRevision: 1,
    execute: async (context) => {
      activeTab = 'doc-b';
      context.assertPersistenceOwnership();
      savedOwner = context.owner().id;
      return true;
    },
  });
  assert.equal(await save, true);
  assert.equal(activeTab, 'doc-b');
  assert.equal(savedOwner, 'doc-a');
});

test('document close cancels pre-persistence work and prevents publication', async () => {
  const document = owner();
  const pause = deferred();
  let published = false;
  const coordinator = createSaveCoordinator({ resolveDocumentById: () => document });
  const save = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    execute: async (context) => {
      await pause.promise;
      context.assertPersistenceOwnership();
      published = context.ownsPublication();
      return true;
    },
  });
  await waitUntil(() => coordinator.debugSnapshot(document.id)?.active != null);
  coordinator.cancelDocument(document.id, 1, 'document-close');
  pause.resolve();
  assert.equal(await save, false);
  assert.equal(published, false);
});

test('editor wait resolves from its completion promise before serialization', async () => {
  const document = owner();
  const editor = deferred();
  let serialized = false;
  const coordinator = createSaveCoordinator({
    resolveDocumentById: () => document,
    waitForEditor: () => editor.promise,
  });
  const save = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    execute: async () => {
      serialized = true;
      return true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serialized, false);
  editor.resolve(true);
  assert.equal(await save, true);
  assert.equal(serialized, true);
});

test('a stuck editor produces a bounded visible failure state', async () => {
  const document = owner();
  const coordinator = createSaveCoordinator({
    resolveDocumentById: () => document,
    waitForEditor: () => new Promise(() => {}),
    editorDeadlineMs: 5,
  });
  const save = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    execute: async () => true,
  });
  await assert.rejects(save, SaveEditorDeadlineError);
  assert.equal(document.revisionState.saveState, 'failed');
  assert.match(document.revisionState.lastSaveError, /did not finish/iu);
});

test('Save As retains the requested path and untitled transition owner', async () => {
  const document = owner();
  document.isUntitled = true;
  document.filePath = '/tmp/render.pdf';
  const coordinator = createSaveCoordinator({ resolveDocumentById: () => document });
  const saved = await coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    kind: 'manual',
    saveAsPath: '/tmp/user-choice.pdf',
    execute: async (context) => {
      assert.equal(context.saveAsPath, '/tmp/user-choice.pdf');
      context.assertPersistenceOwnership();
      context.owner().filePath = context.saveAsPath;
      context.owner().isUntitled = false;
      return true;
    },
  });
  assert.equal(saved, true);
  assert.equal(document.filePath, '/tmp/user-choice.pdf');
  assert.equal(document.isUntitled, false);
});

test('superseded errors expose the transaction boundary', () => {
  const error = new SaveRequestSupersededError('before-replacement');
  assert.equal(error.code, 'SAVE_REQUEST_SUPERSEDED');
  assert.equal(error.stage, 'before-replacement');
});
