import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createInitialDocumentRevisionState,
  noteDocumentMutation,
} from '../../core/document-revision-state.runtime.js';
import {
  acknowledgeDocumentSaveStatus,
  createDocumentSaveRecoveryController,
  documentSaveStatusModel,
} from './document-save-status.js';

function documentState(id = 'doc-a') {
  return {
    id,
    lifecycleGeneration: 3,
    revisionState: createInitialDocumentRevisionState(),
  };
}

test('automatic save failure remains visible and leaves persistence debt pending', () => {
  const document = documentState();
  Object.assign(document.revisionState, {
    contentRevision: 4,
    serializedRevision: 4,
    persistedRevision: 3,
    livePdfRevision: 3,
    saveState: 'failed',
    activeSaveRequestId: 'save-4',
    lastSaveError: 'Exact serializer stack detail',
  });
  const status = documentSaveStatusModel(document);
  assert.equal(status.visible, true);
  assert.equal(status.message, 'Save failed; changes remain pending');
  assert.equal(status.exactError, 'Exact serializer stack detail');
  assert.deepEqual(status.actions, ['retry-save', 'acknowledge']);
  assert.ok(document.revisionState.contentRevision > document.revisionState.persistedRevision);
  noteDocumentMutation(document, { pages: [1], reason: 'continued-edit-after-save-failure' });
  assert.equal(document.revisionState.saveState, 'failed');
  assert.equal(document.revisionState.lastSaveError, 'Exact serializer stack detail');
});

test('successful persistence plus failed refresh exposes the partial-success recovery actions', () => {
  const document = documentState();
  Object.assign(document.revisionState, {
    contentRevision: 5,
    serializedRevision: 5,
    persistedRevision: 5,
    livePdfRevision: 4,
    saveState: 'saved-refresh-failed',
    lastSynchronizationError: 'Exact proxy installation failure',
  });
  const status = documentSaveStatusModel(document);
  assert.equal(status.message, 'PDF saved; editor refresh failed');
  assert.deepEqual(status.actions, ['retry-refresh', 'acknowledge']);
  assert.equal(status.exactError, 'Exact proxy installation failure');
});

test('queued, warning, refresh-pending, and Save As outcomes are distinct and actionable', () => {
  const document = documentState();
  Object.assign(document.revisionState, {
    contentRevision: 4,
    serializedRevision: 4,
    persistedRevision: 4,
    livePdfRevision: 3,
    saveState: 'saved-refresh-pending',
  });
  assert.deepEqual(documentSaveStatusModel(document), {
    documentId: document.id,
    state: 'saved-refresh-pending',
    identity: documentSaveStatusModel(document).identity,
    exactError: null,
    progress: false,
    severity: 'success',
    actions: [],
    visible: true,
    message: 'Saved; editor refresh pending',
  });

  Object.assign(document.revisionState, {
    saveState: 'saved-with-warning',
    livePdfRevision: 4,
    lastSaveWarnings: [{ code: 'SAFE_SAVE_WARNING', message: 'Cleanup remains' }],
  });
  const warning = documentSaveStatusModel(document);
  assert.equal(warning.message, 'PDF saved with a warning');
  assert.equal(warning.exactError, 'Cleanup remains');
  assert.deepEqual(warning.actions, ['view-save-details', 'acknowledge']);

  Object.assign(document.revisionState, {
    saveState: 'save-as-required',
    contentRevision: 5,
  });
  const saveAs = documentSaveStatusModel(document);
  assert.equal(saveAs.message, 'Choose a destination to save changes');
  assert.deepEqual(saveAs.actions, ['save-as', 'acknowledge']);
});

test('retry refresh uses the refresh-only path and never invokes persistence', async () => {
  const document = documentState();
  Object.assign(document.revisionState, {
    contentRevision: 2,
    serializedRevision: 2,
    persistedRevision: 2,
    livePdfRevision: 1,
    saveState: 'saved-refresh-failed',
  });
  let saveCalls = 0;
  let refreshCalls = 0;
  const controller = createDocumentSaveRecoveryController({
    resolveDocumentById: () => document,
    requestSave: async () => { saveCalls += 1; return true; },
    requestRefresh: async ({ requestedRevision }) => {
      refreshCalls += 1;
      assert.equal(requestedRevision, 2);
      return true;
    },
    requestReopen: async () => true,
  });
  assert.equal(await controller.retryRefresh(document.id), true);
  assert.equal(saveCalls, 0);
  assert.equal(refreshCalls, 1);
});

test('a failed refresh retry exposes Reopen without changing persistence state', async () => {
  const document = documentState();
  Object.assign(document.revisionState, {
    contentRevision: 2,
    serializedRevision: 2,
    persistedRevision: 2,
    livePdfRevision: 1,
    saveState: 'saved-refresh-failed',
  });
  const controller = createDocumentSaveRecoveryController({
    resolveDocumentById: () => document,
    requestSave: async () => true,
    requestRefresh: async () => false,
    requestReopen: async () => true,
  });
  assert.equal(await controller.retryRefresh(document.id), false);
  assert.equal(document.revisionState.persistedRevision, 2);
  assert.deepEqual(
    documentSaveStatusModel(document).actions,
    ['retry-refresh', 'reopen', 'acknowledge'],
  );
  assert.equal(await controller.reopen(document.id), true);
});

test('retry save resolves the latest document revision rather than the failed snapshot', async () => {
  const document = documentState();
  Object.assign(document.revisionState, {
    contentRevision: 3,
    serializedRevision: 2,
    persistedRevision: 1,
    livePdfRevision: 1,
    saveState: 'failed',
  });
  let requestedRevision = null;
  const controller = createDocumentSaveRecoveryController({
    resolveDocumentById: () => document,
    requestSave: async (request) => { requestedRevision = request.requestedRevision; return true; },
    requestRefresh: async () => true,
    requestReopen: async () => true,
  });
  document.revisionState.contentRevision = 4;
  assert.equal(await controller.retrySave(document.id), true);
  assert.equal(requestedRevision, 4);
});

test('tab selection preserves independent document statuses', () => {
  const first = documentState('doc-a');
  const second = documentState('doc-b');
  first.revisionState.saveState = 'saving';
  second.revisionState.saveState = 'failed';
  second.revisionState.lastSaveError = 'disk full';
  assert.equal(documentSaveStatusModel(first).message, 'Saving…');
  assert.equal(documentSaveStatusModel(second).message, 'Save failed; changes remain pending');
  acknowledgeDocumentSaveStatus(second);
  assert.equal(documentSaveStatusModel(first).visible, true);
  assert.equal(documentSaveStatusModel(second).visible, false);
});

test('debug snapshot exactly reflects the authoritative revision transition', () => {
  const document = documentState();
  Object.assign(document.revisionState, {
    contentRevision: 8,
    serializedRevision: 8,
    persistedRevision: 8,
    livePdfRevision: 7,
    visibleRenderRevision: 7,
    visibleSemanticRevision: 6,
    saveState: 'saved-refresh-failed',
    activeSaveRequestId: null,
    lastSynchronizationError: 'readiness failed',
  });
  const controller = createDocumentSaveRecoveryController({
    resolveDocumentById: () => document,
    requestSave: async () => true,
    requestRefresh: async () => true,
    requestReopen: async () => true,
  });
  assert.deepEqual(controller.debugSnapshot(document.id), {
    documentId: document.id,
    lifecycleGeneration: 3,
    contentRevision: 8,
    serializedRevision: 8,
    persistedRevision: 8,
    livePdfRevision: 7,
    visibleRenderRevision: 7,
    visibleSemanticRevision: 6,
    pageContentRevisions: {},
    pageRenderReadyRevisions: {},
    pageSemanticReadyRevisions: {},
    saveState: 'saved-refresh-failed',
    activeSaveRequestId: null,
    lastSaveError: null,
    lastSaveErrorCode: null,
    lastSaveWarnings: [],
    lastSaveRecovery: null,
    lastSynchronizationError: 'readiness failed',
  });
});

test('the production status bar binds selected-document state and exposes recovery controls', async () => {
  const [statusBar, recovery, mcpBridge, saver] = await Promise.all([
    readFile(new URL('../../solid/components/StatusBar.jsx', import.meta.url), 'utf8'),
    readFile(new URL('./document-save-recovery.js', import.meta.url), 'utf8'),
    readFile(new URL('../../mcp-bridge.js', import.meta.url), 'utf8'),
    readFile(new URL('../../pdf/saver.js', import.meta.url), 'utf8'),
  ]);
  assert.match(statusBar, /state\.documents\[state\.activeDocumentIndex\]/u);
  assert.match(statusBar, /documentSaveStatusModel/u);
  assert.match(statusBar, /data-save-state=\{saveStatus\(\)\.state\}/u);
  assert.match(statusBar, /aria-live="polite"/u);
  assert.match(statusBar, /retrySaveForDocument/u);
  assert.match(statusBar, /retryRefreshForDocument/u);
  assert.match(statusBar, /reopenSavedDocument/u);
  assert.doesNotMatch(statusBar, /saveStatus\(\)\.exactError/u,
    'the exact diagnostic error must not replace the concise user message');
  assert.match(recovery, /retryDocumentRefresh/u);
  assert.match(recovery, /reopenPersistedDocument/u);
  assert.match(mcpBridge, /documentSaveState/u);
  assert.match(mcpBridge, /documentRevisionDebugSnapshot\(doc\)/u);
  const refreshRetry = saver.slice(
    saver.indexOf('export async function retryDocumentRefresh'),
    saver.indexOf('\nfunction productionSavedTransitionCallbacks'),
  );
  assert.match(refreshRetry, /synchronizePersistedOwnerWithoutWrite/u);
  assert.doesNotMatch(refreshRetry, /performSavePDF/u,
    'refresh recovery must never enter the physical persistence path');
});
