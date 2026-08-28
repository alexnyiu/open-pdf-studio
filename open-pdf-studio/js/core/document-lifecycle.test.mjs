import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceDocumentLifecycleState,
  replaceDocumentPdfProxyState,
} from './document-lifecycle-state.js';

test('lifecycle advancement cancels the owner before incrementing generation', () => {
  const documentState = {
    id: 'owner',
    lifecycleGeneration: 7,
    pdfDoc: { id: 'old' },
    pageEditReadiness: { 1: { ready: true } },
  };
  const observations = [];
  const generation = advanceDocumentLifecycleState(documentState, 'reload', (id, reason) => {
    observations.push({ id, reason, generation: documentState.lifecycleGeneration });
  });
  assert.deepEqual(observations, [{ id: 'owner', reason: 'reload', generation: 7 }]);
  assert.equal(generation, 8);
  assert.deepEqual(documentState.pageEditReadiness, {});
});

test('proxy replacement crosses one lifecycle boundary and returns the prior proxy', () => {
  const previous = { id: 'old' };
  const next = { id: 'new' };
  const documentState = { id: 'owner', lifecycleGeneration: 0, pdfDoc: previous };
  let cancellations = 0;
  const result = replaceDocumentPdfProxyState(documentState, next, 'save-reload', () => {
    cancellations += 1;
  });
  assert.equal(result, previous);
  assert.equal(documentState.pdfDoc, next);
  assert.equal(documentState.lifecycleGeneration, 1);
  assert.equal(cancellations, 1);
});

test('missing lifecycle starts at zero and null owners are rejected safely', () => {
  const documentState = { id: 'owner', pdfDoc: null };
  assert.equal(advanceDocumentLifecycleState(documentState), 1);
  assert.equal(advanceDocumentLifecycleState(null), 0);
  assert.throws(() => replaceDocumentPdfProxyState(null, {}), /Document state is required/);
});
