import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialDocumentRevisionState } from '../core/document-revision-state.runtime.js';
import { captureRenderPublicationToken } from './render-publication-token.js';
import {
  PAGE_EDIT_READY_LAYERS,
  awaitPageEditReady,
  clearPageEditReadiness,
  failPageEditReadiness,
  markPageEditLayerReady,
  pageEditReadinessSatisfied,
} from './page-edit-readiness.js';

class EventTargetWindow extends EventTarget {
  dispatch(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

const priorWindow = globalThis.window;
const priorCustomEvent = globalThis.CustomEvent;

function owner() {
  const revisionState = createInitialDocumentRevisionState();
  revisionState.contentRevision = 1;
  revisionState.persistedRevision = 1;
  revisionState.livePdfRevision = 1;
  revisionState.pageContentRevisions[1] = 1;
  return {
    id: 'ready-document',
    lifecycleGeneration: 2,
    pdfDoc: {},
    revisionState,
    pageRenderRevisions: revisionState.pageContentRevisions,
  };
}

test.beforeEach(() => {
  globalThis.window = new EventTargetWindow();
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, options) { super(type); this.detail = options?.detail; }
  };
});

test.after(() => {
  if (priorWindow === undefined) delete globalThis.window;
  else globalThis.window = priorWindow;
  if (priorCustomEvent === undefined) delete globalThis.CustomEvent;
  else globalThis.CustomEvent = priorCustomEvent;
});

test('page edit readiness resolves only after every required current layer settles', async () => {
  const documentState = owner();
  const token = captureRenderPublicationToken(documentState, 1, 'readiness-test');
  let readyEvent = null;
  window.addEventListener('opds:page-edit-ready', (event) => { readyEvent = event.detail; }, {
    once: true,
  });
  const pending = awaitPageEditReady(documentState, 1);
  let resolved = false;
  void pending.then(() => { resolved = true; });
  for (const layer of PAGE_EDIT_READY_LAYERS.slice(0, -1)) {
    assert.equal(markPageEditLayerReady(documentState, 1, layer, token), true);
  }
  await Promise.resolve();
  assert.equal(resolved, false);
  markPageEditLayerReady(documentState, 1, 'editableMetadata', token);
  await pending;
  assert.equal(pageEditReadinessSatisfied(documentState, 1), true);
  assert.equal(readyEvent.documentId, documentState.id);
  assert.equal(readyEvent.lifecycleGeneration, 2);
  assert.equal(readyEvent.contentRevision, 1);
  assert.equal(readyEvent.livePdfRevision, 1);
  assert.equal(readyEvent.pageRevision, 1);
  assert.equal(readyEvent.pageNum, 1);
});

test('stale layer completion cannot satisfy a newer content revision', () => {
  const documentState = owner();
  const stale = captureRenderPublicationToken(documentState, 1, 'stale-readiness');
  documentState.revisionState.contentRevision = 2;
  documentState.revisionState.pageContentRevisions[1] = 2;
  assert.equal(markPageEditLayerReady(documentState, 1, 'raster', stale), false);
  assert.equal(pageEditReadinessSatisfied(documentState, 1, { requiredLayers: ['raster'] }), false);
});

test('lifecycle change rejects a queued readiness wait cleanly', async () => {
  const documentState = owner();
  const pending = awaitPageEditReady(documentState, 1);
  documentState.lifecycleGeneration += 1;
  window.dispatch('opds:document-lifecycle-changed', {
    documentId: documentState.id,
    lifecycleGeneration: documentState.lifecycleGeneration,
  });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('clearing an affected page invalidates its complete readiness record', () => {
  const documentState = owner();
  const token = captureRenderPublicationToken(documentState, 1, 'clear-readiness');
  for (const layer of PAGE_EDIT_READY_LAYERS) markPageEditLayerReady(documentState, 1, layer, token);
  assert.equal(pageEditReadinessSatisfied(documentState, 1), true);
  clearPageEditReadiness(documentState, [1]);
  assert.equal(pageEditReadinessSatisfied(documentState, 1), false);
});

test('a failed current layer cannot be overwritten by later layer completions', () => {
  const documentState = owner();
  const token = captureRenderPublicationToken(documentState, 1, 'failed-readiness');
  failPageEditReadiness(documentState, 1, 'text layer failed', token);
  for (const layer of PAGE_EDIT_READY_LAYERS) {
    markPageEditLayerReady(documentState, 1, layer, token);
  }
  assert.equal(pageEditReadinessSatisfied(documentState, 1), false);
});

test('a waiter started after a current failure rejects immediately', async () => {
  const documentState = owner();
  const token = captureRenderPublicationToken(documentState, 1, 'failed-before-wait');
  failPageEditReadiness(documentState, 1, 'forms failed', token);
  await assert.rejects(awaitPageEditReady(documentState, 1), /forms failed/u);
});

test('an affected content revision change rejects the old readiness wait', async () => {
  const documentState = owner();
  const pending = awaitPageEditReady(documentState, 1);
  documentState.revisionState.contentRevision += 1;
  documentState.revisionState.pageContentRevisions[1] += 1;
  window.dispatch('opds:page-edit-readiness-cleared', {
    documentId: documentState.id,
    lifecycleGeneration: documentState.lifecycleGeneration,
    contentRevision: documentState.revisionState.contentRevision,
    pages: [1],
  });
  await assert.rejects(pending, { name: 'AbortError' });
});
