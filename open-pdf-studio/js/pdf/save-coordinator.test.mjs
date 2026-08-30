import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SaveEditorDeadlineError,
  SaveRequestSupersededError,
  createSaveCoordinator,
} from './save-coordinator.js';
import { createSaveResult } from './save-result.js';
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

function durableResult(context, overrides = {}) {
  return createSaveResult({
    status: 'saved',
    documentId: context.documentId,
    requestedRevision: context.requestedRevision,
    serializedRevision: context.requestedRevision,
    persistedRevision: context.requestedRevision,
    proxyRevision: context.requestedRevision,
    bytesPersisted: true,
    proxyAdopted: true,
    ...overrides,
  });
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
    return durableResult(context);
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
  assert.equal((await first).status, 'saved');
  assert.equal((await second).status, 'saved');
  assert.deepEqual(calls, [2]);
});

test('ten committed edits produce one durable write and defer every proxy adoption', async () => {
  const document = owner();
  const timers = [];
  let writes = 0;
  let proxyInstalls = 0;
  const coordinator = createSaveCoordinator({
    resolveDocumentById: () => document,
    setTimer(callback, delay) {
      const token = { callback, delay, cancelled: false };
      timers.push(token);
      return token;
    },
    clearTimer(token) { token.cancelled = true; },
  });
  const requests = [];
  for (let revision = 1; revision <= 10; revision += 1) {
    document.revisionState.contentRevision = revision;
    requests.push(coordinator.request({
      documentId: document.id,
      documentGeneration: 1,
      requestedRevision: revision,
      kind: 'auto',
      delayMs: 750,
      execute: async (context) => {
        writes += 1;
        return durableResult(context, {
          status: 'saved-refresh-pending',
          proxyRevision: 0,
          proxyAdopted: false,
        });
      },
    }));
  }
  timers.findLast((timer) => !timer.cancelled).callback();
  const results = await Promise.all(requests);
  proxyInstalls += results.filter((result) => result.proxyAdopted).length;
  assert.equal(writes, 1);
  assert.equal(proxyInstalls, 0);
  assert.deepEqual(results.map((result) => result.requestedRevision), Array(10).fill(10));
});

test('a continuous editing session cannot leave automatic persistence pending forever', async () => {
  const document = owner();
  const timers = [];
  let clock = 0;
  const calls = [];
  const coordinator = createSaveCoordinator({
    resolveDocumentById: () => document,
    now: () => clock,
    automaticMaxCoalesceMs: 250,
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
    return durableResult(context);
  };
  const saves = [coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    kind: 'auto',
    delayMs: 100,
    execute,
  })];
  clock = 80;
  document.revisionState.contentRevision = 2;
  saves.push(coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 2,
    kind: 'auto',
    delayMs: 100,
    execute,
  }));
  clock = 160;
  document.revisionState.contentRevision = 3;
  saves.push(coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 3,
    kind: 'auto',
    delayMs: 100,
    execute,
  }));
  const latestTimer = timers.findLast((timer) => !timer.cancelled);
  assert.equal(latestTimer.delay, 90, 'the original 250 ms deadline caps the latest debounce');
  latestTimer.callback();
  assert.deepEqual((await Promise.all(saves)).map((result) => result.status), [
    'saved', 'saved', 'saved',
  ]);
  assert.deepEqual(calls, [3]);
});

test('automatic serialization waits while another document save is running', async () => {
  const documents = new Map([
    ['doc-a', owner('doc-a')],
    ['doc-b', owner('doc-b')],
  ]);
  const firstSerialization = deferred();
  let automaticCalls = 0;
  const coordinator = createSaveCoordinator({
    resolveDocumentById: (id) => documents.get(id),
    automaticRetryMs: 5,
  });
  const manual = coordinator.request({
    documentId: 'doc-a',
    documentGeneration: 1,
    requestedRevision: 1,
    kind: 'manual',
    execute: async (context) => {
      await firstSerialization.promise;
      return durableResult(context);
    },
  });
  await waitUntil(() => coordinator.debugSnapshot('doc-a')?.active != null);
  const automatic = coordinator.request({
    documentId: 'doc-b',
    documentGeneration: 1,
    requestedRevision: 1,
    kind: 'auto',
    execute: async (context) => {
      automaticCalls += 1;
      return durableResult(context);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(automaticCalls, 0);
  firstSerialization.resolve();
  assert.equal((await manual).status, 'saved');
  assert.equal((await automatic).status, 'saved');
  assert.equal(automaticCalls, 1);
});

test('a live text session defers heavy serialization but wakes after the session settles', async () => {
  const document = owner();
  const timers = [];
  let liveSession = true;
  let calls = 0;
  const coordinator = createSaveCoordinator({
    resolveDocumentById: () => document,
    automaticRetryMs: 25,
    shouldDeferAutomatic: () => liveSession
      ? { reason: 'live-text-session', retryAfterMs: 25 } : null,
    setTimer(callback, delay) {
      const token = { callback, delay, cancelled: false };
      timers.push(token);
      return token;
    },
    clearTimer(token) {
      token.cancelled = true;
    },
  });
  const save = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    kind: 'auto',
    delayMs: 10,
    execute: async (context) => {
      calls += 1;
      return durableResult(context);
    },
  });
  timers.findLast((timer) => !timer.cancelled).callback();
  assert.equal(calls, 0);
  assert.equal(coordinator.debugSnapshot(document.id)?.pending?.requestedRevision, 1);
  liveSession = false;
  timers.findLast((timer) => !timer.cancelled).callback();
  assert.equal((await save).status, 'saved');
  assert.equal(calls, 1);
  assert.equal(coordinator.debugSnapshot(document.id), null);
});

test('completion diagnostics record serialization duration and candidate size', async () => {
  const document = owner();
  const diagnostics = [];
  let clock = 10;
  const coordinator = createSaveCoordinator({
    resolveDocumentById: () => document,
    now: () => clock,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const save = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    execute: async (context) => {
      clock = 47;
      return durableResult(context, { candidateBytes: 4096 });
    },
  });
  assert.equal((await save).status, 'saved');
  const completed = diagnostics.find((event) => event.event === 'completed');
  assert.equal(completed.durationMs, 37);
  assert.equal(completed.candidateBytes, 4096);
});

test('manual Save flushes a pending automatic request at the latest revision', async () => {
  const document = owner();
  let calls = 0;
  const coordinator = createSaveCoordinator({ resolveDocumentById: () => document });
  const execute = async (context) => {
    calls += 1;
    assert.equal(context.requestedRevision, 2);
    return durableResult(context);
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
  assert.equal((await manual).status, 'saved');
  assert.equal((await automatic).status, 'saved');
  assert.equal(calls, 1);
});

test('a newer revision during serialization allows the old durable write and schedules a follow-up', async () => {
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
      return durableResult(context, {
        status: 'saved-refresh-pending',
        proxyRevision: 0,
        proxyAdopted: false,
      });
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
      return durableResult(context);
    },
  });
  serialization.resolve();
  assert.equal((await first).status, 'saved');
  assert.equal((await followUp).status, 'saved');
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
      return durableResult(context);
    },
  });
  await waitUntil(() => coordinator.debugSnapshot(document.id)?.active != null);
  document.lifecycleGeneration = 2;
  pause.resolve();
  assert.equal((await save).status, 'superseded');
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
      return durableResult(context, {
        status: oldPublished ? 'saved' : 'saved-refresh-pending',
        proxyRevision: oldPublished ? context.requestedRevision : 0,
        proxyAdopted: oldPublished,
      });
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
      return durableResult(context);
    },
  });
  afterReplacement.resolve();
  assert.equal((await first).status, 'saved');
  assert.equal((await followUp).status, 'saved');
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
      return durableResult(context);
    },
  });
  assert.equal((await save).status, 'saved');
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
      return durableResult(context);
    },
  });
  await waitUntil(() => coordinator.debugSnapshot(document.id)?.active != null);
  coordinator.cancelDocument(document.id, 1, 'document-close');
  pause.resolve();
  assert.equal((await save).status, 'superseded');
  assert.equal(published, false);
});

test('document close after proxy installation cancels the adopted generation publication', async () => {
  const document = owner();
  const proxyInstalled = deferred();
  const continueSynchronization = deferred();
  let published = false;
  const coordinator = createSaveCoordinator({ resolveDocumentById: () => document });
  const save = coordinator.request({
    documentId: document.id,
    documentGeneration: 1,
    requestedRevision: 1,
    execute: async (context) => {
      context.assertPersistenceOwnership();
      document.lifecycleGeneration = 2;
      context.adoptDocumentGeneration(2);
      proxyInstalled.resolve();
      await continueSynchronization.promise;
      context.assertSynchronizationOwnership('after-required-page-rebuild');
      published = true;
      return durableResult(context);
    },
  });
  await proxyInstalled.promise;
  assert.equal(coordinator.debugSnapshot(document.id)?.active?.documentGeneration, 2);
  coordinator.cancelDocument(document.id, 2, 'document-close');
  document.lifecycleGeneration = 3;
  continueSynchronization.resolve();
  assert.equal((await save).status, 'superseded');
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
    execute: async (context) => {
      serialized = true;
      return durableResult(context);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serialized, false);
  editor.resolve(true);
  assert.equal((await save).status, 'saved');
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
    execute: async (context) => durableResult(context),
  });
  const result = await save;
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'SAVE_EDITOR_DEADLINE');
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
      return durableResult(context);
    },
  });
  assert.equal(saved.status, 'saved');
  assert.equal(document.filePath, '/tmp/user-choice.pdf');
  assert.equal(document.isUntitled, false);
});

test('superseded errors expose the transaction boundary', () => {
  const error = new SaveRequestSupersededError('before-replacement');
  assert.equal(error.code, 'SAVE_REQUEST_SUPERSEDED');
  assert.equal(error.stage, 'before-replacement');
});

test('legacy boolean save execution results are rejected at the coordinator boundary', async () => {
  const document = owner();
  const coordinator = createSaveCoordinator({ resolveDocumentById: () => document });
  const result = await coordinator.request({
    documentId: document.id,
    documentGeneration: document.lifecycleGeneration,
    requestedRevision: document.revisionState.contentRevision,
    execute: async () => true,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'SAVE_FAILED');
  assert.match(result.errorMessage, /must return SaveResult/u);
});

test('every terminal result clears activeSaveRequestId and preserves its status', async () => {
  for (const status of [
    'saved',
    'saved-with-warning',
    'saved-refresh-pending',
    'saved-refresh-failed',
    'save-as-required',
    'deferred',
    'superseded',
    'failed',
  ]) {
    const document = owner(`doc-${status}`);
    const coordinator = createSaveCoordinator({ resolveDocumentById: () => document });
    const result = await coordinator.request({
      documentId: document.id,
      documentGeneration: 1,
      requestedRevision: 1,
      execute: async (context) => createSaveResult({
        status,
        documentId: context.documentId,
        requestedRevision: context.requestedRevision,
        serializedRevision: status.startsWith('saved') ? 1 : null,
        persistedRevision: status.startsWith('saved') ? 1 : null,
        proxyRevision: status === 'saved' || status === 'saved-with-warning' ? 1 : 0,
        bytesPersisted: status.startsWith('saved'),
        proxyAdopted: status === 'saved' || status === 'saved-with-warning',
        errorCode: status === 'failed' ? 'WRITE_FAILED' : null,
        errorMessage: status === 'failed' ? 'disk full' : null,
      }),
    });
    assert.equal(result.status, status);
    assert.equal(document.revisionState.activeSaveRequestId, null);
    assert.notEqual(document.revisionState.saveState, 'saving');
  }
});
