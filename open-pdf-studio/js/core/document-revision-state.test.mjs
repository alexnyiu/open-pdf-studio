import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDocumentRevisionState,
  clearPageReadiness,
  createInitialDocumentRevisionState,
  documentHasRevisionPersistenceDebt,
  documentIsEditReady,
  documentNeedsSynchronization,
  documentRevisionDebugSnapshot,
  initializeDocumentRevisionState,
  markDocumentSaveState,
  markLivePdfRevision,
  markPageRenderReady,
  markPageSemanticReady,
  markRevisionPersisted,
  markRevisionSerialized,
  noteDocumentMutation,
  setVisibleRequiredPages,
} from './document-revision-state.runtime.js';

function createDocument() {
  const revisionState = createInitialDocumentRevisionState();
  return {
    id: 'doc-a',
    lifecycleGeneration: 0,
    currentPage: 1,
    pdfDoc: { numPages: 2 },
    modified: false,
    pageRenderRevisions: revisionState.pageContentRevisions,
    pageRotations: {},
    pageDims: {},
    pageGeometryIndex: {},
    pageGeometryBaseDimensions: [],
    revisionState,
  };
}

test('initial document revision state is coherent and aliases page content identity', () => {
  const doc = createDocument();
  assert.equal(assertDocumentRevisionState(doc), doc.revisionState);
  assert.equal(initializeDocumentRevisionState(doc), doc.revisionState);
  assert.equal(doc.pageRenderRevisions, doc.revisionState.pageContentRevisions);
  assert.deepEqual(documentRevisionDebugSnapshot(doc), {
    documentId: 'doc-a',
    lifecycleGeneration: 0,
    contentRevision: 0,
    serializedRevision: 0,
    persistedRevision: 0,
    livePdfRevision: 0,
    visibleRenderRevision: 0,
    visibleSemanticRevision: 0,
    pageContentRevisions: {},
    pageRenderReadyRevisions: {},
    pageSemanticReadyRevisions: {},
    saveState: 'idle',
    activeSaveRequestId: null,
    lastSaveError: null,
    lastSynchronizationError: null,
  });
});

test('one committed mutation advances content and only affected page identity', () => {
  const doc = createDocument();
  assert.equal(noteDocumentMutation(doc, { pages: [2], reason: 'annotation:add' }), 1);
  assert.equal(doc.modified, true);
  assert.equal(doc.revisionState.saveState, 'pending');
  assert.deepEqual(doc.revisionState.pageContentRevisions, { 2: 1 });
  assert.equal(documentHasRevisionPersistenceDebt(doc), true);
});

test('serialization and persistence cannot claim a future or move backward revision', () => {
  const doc = createDocument();
  noteDocumentMutation(doc, { pages: [1], reason: 'edit-a' });
  assert.throws(() => markRevisionSerialized(doc, 2), /future content revision/u);
  markRevisionSerialized(doc, 1);
  assert.throws(() => markRevisionPersisted(doc, 2, '/tmp/a.pdf'), /unserialized revision/u);
  markRevisionPersisted(doc, 1, '/tmp/a.pdf');
  assert.throws(() => markRevisionPersisted(doc, 0, '/tmp/a.pdf'), /backward/u);
});

test('a disk-clean document can still require live-proxy synchronization', () => {
  const doc = createDocument();
  noteDocumentMutation(doc, { pages: [1], reason: 'edit-a' });
  markRevisionSerialized(doc, 1);
  markRevisionPersisted(doc, 1, '/tmp/a.pdf');
  assert.equal(documentHasRevisionPersistenceDebt(doc), false);
  assert.equal(documentNeedsSynchronization(doc), true);
  assert.equal(doc.revisionState.livePdfRevision, 0);
});

test('undo and redo identities stay monotonic even when logical content repeats', () => {
  const doc = createDocument();
  noteDocumentMutation(doc, { pages: [1], reason: 'command' });
  noteDocumentMutation(doc, { pages: [1], reason: 'undo:command' });
  noteDocumentMutation(doc, { pages: [1], reason: 'redo:command' });
  assert.equal(doc.revisionState.contentRevision, 3);
  assert.equal(doc.revisionState.pageContentRevisions[1], 3);
});

test('structural mutation invalidates every page readiness and geometry identity', () => {
  const doc = createDocument();
  doc.revisionState.pageRenderReadyRevisions = { 1: 0, 2: 0 };
  doc.revisionState.pageSemanticReadyRevisions = { 1: 0, 2: 0 };
  noteDocumentMutation(doc, { structural: true, reason: 'page:rotate' });
  assert.deepEqual(doc.revisionState.pageContentRevisions, { 1: 1, 2: 1 });
  assert.deepEqual(doc.revisionState.pageRenderReadyRevisions, {});
  assert.deepEqual(doc.revisionState.pageSemanticReadyRevisions, {});
  assert.equal(doc.pageGeometryIndex, null);
  assert.equal(doc.pageGeometryBaseDimensions, null);
});

test('edit readiness requires one current live, raster, and semantic revision', () => {
  const doc = createDocument();
  noteDocumentMutation(doc, { pages: [1], reason: 'edit-a' });
  markRevisionSerialized(doc, 1);
  markRevisionPersisted(doc, 1, '/tmp/a.pdf');
  markLivePdfRevision(doc, 1);
  setVisibleRequiredPages(doc, [1]);
  assert.equal(documentIsEditReady(doc, 1), false);
  markPageRenderReady(doc, 1, 1);
  assert.equal(documentIsEditReady(doc, 1), false);
  markPageSemanticReady(doc, 1, 1);
  markDocumentSaveState(doc, 'saved', { requestId: null });
  assert.equal(documentNeedsSynchronization(doc), false);
  assert.equal(documentIsEditReady(doc, 1), true);
  clearPageReadiness(doc, [1]);
  assert.equal(documentIsEditReady(doc, 1), false);
});

test('impossible persisted/live/readiness transitions fail closed', () => {
  const doc = createDocument();
  assert.throws(() => markLivePdfRevision(doc, 1), /unpersisted/u);
  doc.revisionState.pageRenderReadyRevisions = { 1: 1 };
  assert.throws(() => assertDocumentRevisionState(doc), /newer than livePdfRevision/u);
});
