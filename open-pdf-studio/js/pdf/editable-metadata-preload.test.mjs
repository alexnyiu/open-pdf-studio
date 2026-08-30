import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureSemanticRevisionIdentity,
  semanticRevisionIdentityIsCurrent,
} from '../core/semantic-revision-identity.js';
import { adoptEditableMetadataController } from './editable-metadata-adoption.js';

test('a second native edit rejects old metadata and accepts the new proxy revision', () => {
  const documentState = {
    id: 'editable-metadata-owner',
    lifecycleGeneration: 1,
    pdfDoc: { id: 'proxy-one' },
    revisionState: { contentRevision: 1, livePdfRevision: 1 },
  };
  const oldEntry = {
    revisionIdentity: captureSemanticRevisionIdentity(documentState),
    text: 'old proxy text',
  };
  assert.equal(semanticRevisionIdentityIsCurrent(oldEntry.revisionIdentity, documentState), true);

  documentState.pdfDoc = { id: 'proxy-two' };
  documentState.lifecycleGeneration = 2;
  documentState.revisionState.contentRevision = 2;
  documentState.revisionState.livePdfRevision = 2;
  assert.equal(semanticRevisionIdentityIsCurrent(oldEntry.revisionIdentity, documentState), false);

  const newEntry = {
    revisionIdentity: captureSemanticRevisionIdentity(documentState),
    text: 'new proxy text',
  };
  assert.equal(semanticRevisionIdentityIsCurrent(newEntry.revisionIdentity, documentState), true);
  assert.equal(newEntry.text, 'new proxy text');
});

test('validated proxy adoption retains settled metadata for unchanged pages only', () => {
  const oldRevision = Object.freeze({ lifecycleGeneration: 1 });
  const nextRevision = Object.freeze({ lifecycleGeneration: 2 });
  const entries = new Map([
    [1, { bytes: 10, used: 1, value: { text: 'warm page 1', revisionIdentity: oldRevision } }],
    [2, { bytes: 10, used: 2, value: { text: 'changed page 2', revisionIdentity: oldRevision } }],
  ]);
  const controller = {
    generation: 3,
    promises: new Map([[2, Promise.resolve()]]),
    entries,
    delete(pageNum) { return entries.delete(pageNum); },
    load: () => 'old loader',
  };
  const record = { controller, revisionIdentity: oldRevision };
  const nextLoader = () => 'new loader';
  assert.equal(adoptEditableMetadataController(record, {
    revisionIdentity: nextRevision,
    changedPages: [2],
    load: nextLoader,
  }), true);
  assert.equal(controller.generation, 4);
  assert.equal(controller.promises.size, 0);
  assert.equal(controller.entries.get(1).value.text, 'warm page 1');
  assert.equal(controller.entries.get(1).value.revisionIdentity, nextRevision);
  assert.equal(controller.entries.has(2), false);
  assert.equal(record.revisionIdentity, nextRevision);
  assert.equal(controller.load, nextLoader);
});
