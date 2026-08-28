import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureSemanticRevisionIdentity,
  semanticRevisionIdentityIsCurrent,
} from '../core/semantic-revision-identity.js';

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
