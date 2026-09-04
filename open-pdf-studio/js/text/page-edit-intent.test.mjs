import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pageEditIntentPendingForDocument,
  runPageEditIntent,
  synchronizeTextEditActivation,
  textEditActivationNeedsSynchronization,
} from './page-edit-intent.js';
import { createInitialDocumentRevisionState } from '../core/document-revision-state.runtime.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function revisionedDocument({ content = 0, persisted = 0, live = 0 } = {}) {
  const revisionState = createInitialDocumentRevisionState();
  Object.assign(revisionState, {
    contentRevision: content,
    serializedRevision: persisted,
    persistedRevision: persisted,
    livePdfRevision: live,
    saveState: persisted > live ? 'saved-refresh-pending' : 'saved',
  });
  return {
    id: 'text-edit-sync-owner',
    lifecycleGeneration: 1,
    revisionState,
  };
}

test('a persisted native edit requires synchronization before another target resolves', () => {
  const documentState = revisionedDocument({ content: 2, persisted: 2, live: 1 });
  assert.equal(textEditActivationNeedsSynchronization(documentState), true);
  documentState.revisionState.livePdfRevision = 2;
  assert.equal(textEditActivationNeedsSynchronization(documentState), false);
  assert.equal(textEditActivationNeedsSynchronization(documentState, {
    pending: { requestId: 'save-pending' },
  }), true);
});

test('the next edit silently adopts a deferred automatic-save revision', async () => {
  const documentState = revisionedDocument({ content: 1, persisted: 1, live: 0 });
  const requests = [];
  const ready = await synchronizeTextEditActivation({
    documentId: documentState.id,
    waitForSynchronization: async () => true,
    resolveDocument: () => documentState,
    getSaveCoordinatorSnapshot: () => null,
    requestSynchronization: async (request) => {
      requests.push(request);
      documentState.lifecycleGeneration += 1;
      documentState.revisionState.livePdfRevision = 1;
      documentState.revisionState.saveState = 'saved';
      return { status: 'saved' };
    },
  });
  assert.equal(ready, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requestedRevision, 1);
  assert.equal(documentState.lifecycleGeneration, 2);
});

test('an edit joining active automatic persistence follows with proxy synchronization', async () => {
  const documentState = revisionedDocument({ content: 1, persisted: 0, live: 0 });
  let saveActive = true;
  let requests = 0;
  const ready = await synchronizeTextEditActivation({
    documentId: documentState.id,
    waitForSynchronization: async () => true,
    resolveDocument: () => documentState,
    getSaveCoordinatorSnapshot: () => saveActive
      ? { active: { requestId: 'automatic-save' } }
      : null,
    requestSynchronization: async () => {
      requests += 1;
      if (requests === 1) {
        saveActive = false;
        documentState.revisionState.serializedRevision = 1;
        documentState.revisionState.persistedRevision = 1;
        documentState.revisionState.saveState = 'saved-refresh-pending';
        return { status: 'saved-refresh-pending' };
      }
      documentState.revisionState.livePdfRevision = 1;
      documentState.revisionState.saveState = 'saved';
      return { status: 'saved' };
    },
  });
  assert.equal(ready, true);
  assert.equal(requests, 2);
  assert.equal(documentState.revisionState.persistedRevision, 1);
  assert.equal(documentState.revisionState.livePdfRevision, 1);
});

test('an unsaved same-gesture handoff does not force persistence', async () => {
  const documentState = revisionedDocument({ content: 1, persisted: 0, live: 0 });
  let requests = 0;
  const ready = await synchronizeTextEditActivation({
    documentId: documentState.id,
    waitForSynchronization: async () => true,
    resolveDocument: () => documentState,
    getSaveCoordinatorSnapshot: () => null,
    requestSynchronization: async () => { requests += 1; },
  });
  assert.equal(ready, true);
  assert.equal(requests, 0);
});

test('a failed deferred synchronization blocks stale text activation', async () => {
  const documentState = revisionedDocument({ content: 1, persisted: 1, live: 0 });
  const ready = await synchronizeTextEditActivation({
    documentId: documentState.id,
    waitForSynchronization: async () => true,
    resolveDocument: () => documentState,
    getSaveCoordinatorSnapshot: () => null,
    requestSynchronization: async () => ({ status: 'saved-refresh-failed' }),
  });
  assert.equal(ready, false);
  assert.equal(documentState.revisionState.livePdfRevision, 0);
});

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
  assert.equal(pageEditIntentPendingForDocument(documentState.id), true);
  synchronization.resolve(true);
  await Promise.resolve();
  assert.equal(activations.length, 0);
  readiness.resolve();
  const result = await intent;
  assert.equal(pageEditIntentPendingForDocument(documentState.id), false);
  assert.equal(result.activated, true);
  assert.equal(result.value, 'opened');
  assert.equal(activations.length, 1);
  assert.equal(activations[0].documentState, documentState);
  assert.equal(activations[0].pageNum, 4);
  assert.deepEqual(activations[0].point, { x: 12.5, y: 28.25 });
});

test('a lifecycle change returns a truthful terminal result without activation', async () => {
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
  assert.deepEqual(await intent, {
    activated: false,
    reason: 'document-lifecycle-changed',
    errorCode: 'PAGE_EDIT_READINESS_LIFECYCLE_CHANGED',
    message: 'Document lifecycle changed before edit replay',
    action: 'retry-page-edit',
  });
  assert.equal(pageEditIntentPendingForDocument(documentState.id), false);
  assert.equal(activations, 0);
});

test('a readiness timeout returns a retryable typed result', async () => {
  const documentState = { id: 'timed-intent-owner', lifecycleGeneration: 1 };
  const error = Object.assign(new Error('page did not settle'), {
    code: 'PAGE_EDIT_READINESS_TIMEOUT',
  });
  const result = await runPageEditIntent({
    documentState,
    pageNum: 2,
    waitForSynchronization: async () => true,
    resolveDocument: () => documentState,
    awaitReadiness: async () => { throw error; },
    activate: () => assert.fail('timed-out intent must not activate'),
  });
  assert.deepEqual(result, {
    activated: false,
    reason: 'readiness-timeout',
    errorCode: 'PAGE_EDIT_READINESS_TIMEOUT',
    message: 'page did not settle',
    action: 'retry-page-edit',
  });
  assert.equal(pageEditIntentPendingForDocument(documentState.id), false);
});

test('a queued page lease is held through readiness and released in finally', async () => {
  const documentState = { id: 'leased-intent-owner', lifecycleGeneration: 8 };
  const readiness = deferred();
  const events = [];
  const intent = runPageEditIntent({
    documentState,
    pageNum: 9,
    waitForSynchronization: async () => true,
    resolveDocument: () => documentState,
    awaitReadiness: () => readiness.promise,
    activate: () => { throw new Error('activation failed'); },
    acquireLease: (identity) => {
      events.push(['acquire', identity]);
      return { leaseId: 'intent-lease' };
    },
    releaseLease: (lease) => events.push(['release', lease]),
  });
  await Promise.resolve();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], {
    documentId: documentState.id,
    lifecycleGeneration: 8,
    pageNum: 9,
    reason: 'page-edit-intent',
  });
  readiness.resolve();
  await assert.rejects(intent, /activation failed/u);
  assert.deepEqual(events.at(-1), ['release', { leaseId: 'intent-lease' }]);
  assert.equal(pageEditIntentPendingForDocument(documentState.id), false);
});
