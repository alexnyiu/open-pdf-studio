import test from 'node:test';
import assert from 'node:assert/strict';

import { createTextEditSessionRegistry } from '../../text/text-edit-session-registry.js';
import { authorizeDocumentClose } from './document-close-authorization.js';

function fixture({ modified = true, editorDirty = true } = {}) {
  const documentState = {
    id: 'owner-a',
    fileName: 'owner-a.pdf',
    lifecycleGeneration: 4,
    modified,
  };
  const registry = createTextEditSessionRegistry(
    (documentId) => documentId === documentState.id ? documentState : null,
    { now: () => 1 },
  );
  const cancellations = [];
  registry.register({
    ownerDocumentId: documentState.id,
    ownerDocumentGeneration: documentState.lifecycleGeneration,
    pageNum: 1,
    kind: 'native-source-text',
    isDirty: () => editorDirty,
    commit() {},
    cancel(reason) { cancellations.push(reason); },
  });
  return {
    documentState,
    registry,
    cancellations,
    isTextEditingDirtyForDocument: registry.isDirtyForDocument.bind(registry),
  };
}

test('Cancel preserves the complete dirty editor until close authorization', async () => {
  const { documentState, registry, cancellations, isTextEditingDirtyForDocument } = fixture();
  const session = registry.active();
  const authorized = await authorizeDocumentClose({
    documentState,
    requestAction: async () => 'cancel',
    saveDocument: async () => { throw new Error('Save must not run'); },
    isTextEditingDirtyForDocument,
    cancelTextEditingForDocument: registry.cancelForDocument.bind(registry),
  });

  assert.equal(authorized, false);
  assert.equal(registry.active(), session);
  assert.equal(registry.active().isDirty(), true);
  assert.deepEqual(cancellations, []);
});

test("Don't Save cancels the owner editor only after explicit authorization", async () => {
  const { documentState, registry, cancellations, isTextEditingDirtyForDocument } = fixture();
  const observations = [];
  const authorized = await authorizeDocumentClose({
    documentState,
    requestAction: async () => {
      observations.push({ phase: 'decision', editorPresent: Boolean(registry.active()) });
      return 'dontsave';
    },
    isTextEditingDirtyForDocument,
    cancelTextEditingForDocument(documentId, reason) {
      observations.push({ phase: 'cancel', documentId, reason });
      return registry.cancelForDocument(documentId, reason);
    },
  });

  assert.equal(authorized, true);
  assert.deepEqual(observations, [
    { phase: 'decision', editorPresent: true },
    { phase: 'cancel', documentId: 'owner-a', reason: 'document-close' },
  ]);
  assert.equal(registry.active(), null);
  assert.deepEqual(cancellations, ['document-close']);
});

test('a failed Save preserves the editor and rejects the close', async () => {
  const {
    documentState,
    registry,
    cancellations,
    isTextEditingDirtyForDocument,
  } = fixture({ editorDirty: false });
  const session = registry.active();
  const authorized = await authorizeDocumentClose({
    documentState,
    requestAction: async () => 'save',
    saveDocument: async () => false,
    isTextEditingDirtyForDocument,
    cancelTextEditingForDocument: registry.cancelForDocument.bind(registry),
  });

  assert.equal(authorized, false);
  assert.equal(registry.active(), session);
  assert.deepEqual(cancellations, []);
});

test('a clean document with a dirty text draft requires explicit discard authorization', async () => {
  const {
    documentState,
    registry,
    cancellations,
    isTextEditingDirtyForDocument,
  } = fixture({ modified: false, editorDirty: true });
  const requests = [];
  const authorized = await authorizeDocumentClose({
    documentState,
    requestAction: async (request) => {
      requests.push(request);
      return 'dontsave';
    },
    saveDocument: async () => { throw new Error('Save must not run for a dirty draft'); },
    isTextEditingDirtyForDocument,
    cancelTextEditingForDocument: registry.cancelForDocument.bind(registry),
  });

  assert.equal(authorized, true);
  assert.deepEqual(requests, [{
    documentId: 'owner-a',
    fileName: 'owner-a.pdf',
    dirtyTextEdit: true,
    documentModified: false,
  }]);
  assert.equal(registry.active(), null);
  assert.deepEqual(cancellations, ['document-close']);
});

test('Cancel preserves a dirty text draft on an otherwise clean document', async () => {
  const {
    documentState,
    registry,
    cancellations,
    isTextEditingDirtyForDocument,
  } = fixture({ modified: false, editorDirty: true });
  const session = registry.active();
  const authorized = await authorizeDocumentClose({
    documentState,
    requestAction: async () => 'cancel',
    isTextEditingDirtyForDocument,
    cancelTextEditingForDocument: registry.cancelForDocument.bind(registry),
  });

  assert.equal(authorized, false);
  assert.equal(registry.active(), session);
  assert.deepEqual(cancellations, []);
});

test('Save can never implicitly apply or discard an active dirty text draft', async () => {
  const {
    documentState,
    registry,
    cancellations,
    isTextEditingDirtyForDocument,
  } = fixture({ modified: true, editorDirty: true });
  let saveCalls = 0;
  const session = registry.active();
  const authorized = await authorizeDocumentClose({
    documentState,
    requestAction: async () => 'save',
    saveDocument: async () => { saveCalls += 1; return true; },
    isTextEditingDirtyForDocument,
    cancelTextEditingForDocument: registry.cancelForDocument.bind(registry),
  });

  assert.equal(authorized, false);
  assert.equal(saveCalls, 0);
  assert.equal(registry.active(), session);
  assert.deepEqual(cancellations, []);
});

test('a clean document with a clean editor closes without prompting', async () => {
  const {
    documentState,
    registry,
    cancellations,
    isTextEditingDirtyForDocument,
  } = fixture({ modified: false, editorDirty: false });
  const authorized = await authorizeDocumentClose({
    documentState,
    requestAction: async () => { throw new Error('No prompt expected'); },
    isTextEditingDirtyForDocument,
    cancelTextEditingForDocument: registry.cancelForDocument.bind(registry),
  });

  assert.equal(authorized, true);
  assert.equal(registry.active(), null);
  assert.deepEqual(cancellations, ['document-close']);
});
