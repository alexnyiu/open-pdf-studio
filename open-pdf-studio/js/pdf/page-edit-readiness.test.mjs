import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createInitialDocumentRevisionState } from '../core/document-revision-state.runtime.js';
import { captureRenderPublicationToken } from './render-publication-token.js';
import {
  adoptPageEditReadinessForDocumentLifecycle,
  PAGE_EDIT_READY_LAYERS,
  awaitPageEditReady,
  clearPageEditReadiness,
  failPageEditReadiness,
  markPageEditLayerReady,
  pageEditReadinessSatisfied,
  pageEditReadinessSnapshot,
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

test('the first layer publication mutates the readiness entry retained by a reactive map', () => {
  const documentState = owner();
  const retained = {};
  documentState.pageEditReadiness = new Proxy(retained, {
    set(target, property, value) {
      target[property] = { ...value, layers: { ...value.layers } };
      return true;
    },
  });
  const token = captureRenderPublicationToken(documentState, 1, 'reactive-readiness');
  assert.equal(markPageEditLayerReady(documentState, 1, 'raster', token), true);
  assert.equal(pageEditReadinessSnapshot(documentState, 1).layers.raster, 1);
});

test('a model-owned page preview reaches the page revision while the proxy lags', () => {
  const documentState = owner();
  documentState.revisionState.contentRevision = 2;
  documentState.revisionState.pageContentRevisions[1] = 2;
  const proxyToken = captureRenderPublicationToken(documentState, 1, 'old-proxy');
  assert.equal(proxyToken.publishedPageRevision, 1);
  for (const layer of PAGE_EDIT_READY_LAYERS) {
    markPageEditLayerReady(documentState, 1, layer, proxyToken);
  }
  assert.equal(pageEditReadinessSatisfied(documentState, 1), false);

  const modelToken = captureRenderPublicationToken(documentState, 1, 'model-preview', {
    revisionAuthority: 'model',
  });
  assert.equal(modelToken.publishedPageRevision, 2);
  for (const layer of PAGE_EDIT_READY_LAYERS) {
    markPageEditLayerReady(documentState, 1, layer, modelToken);
  }
  assert.equal(pageEditReadinessSatisfied(documentState, 1), true);
  assert.equal(pageEditReadinessSnapshot(documentState, 1).layers.raster, 2);

  documentState.revisionState.persistedRevision = 2;
  documentState.revisionState.livePdfRevision = 2;
  assert.equal(pageEditReadinessSatisfied(documentState, 1), true,
    'installing matching proxy bytes must not erase a current model preview');
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

test('validated proxy adoption preserves only unchanged page readiness', () => {
  const documentState = owner();
  documentState.revisionState.pageContentRevisions[2] = 1;
  for (const pageNum of [1, 2]) {
    const token = captureRenderPublicationToken(documentState, pageNum, 'adopt-readiness');
    for (const layer of PAGE_EDIT_READY_LAYERS) {
      markPageEditLayerReady(documentState, pageNum, layer, token);
    }
  }
  documentState.lifecycleGeneration += 1;
  documentState.pdfDoc = {};
  documentState.revisionState.contentRevision = 2;
  documentState.revisionState.livePdfRevision = 2;
  documentState.revisionState.pageContentRevisions[2] = 2;
  assert.deepEqual(adoptPageEditReadinessForDocumentLifecycle(documentState, [2]), [1]);
  assert.equal(pageEditReadinessSatisfied(documentState, 1), true);
  assert.equal(pageEditReadinessSatisfied(documentState, 2), false);
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
  assert.equal(pageEditReadinessSnapshot(documentState, 1).ready, false,
    'diagnostics must not report ready while the fail-closed barrier retains an error');
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

test('desktop blank-document creation rebuilds readiness after its committed mutation', async () => {
  const source = await readFile(new URL('./loader.js', import.meta.url), 'utf8');
  const desktopStart = source.indexOf('if (isTauri() && window.__TAURI__?.path');
  const desktopEnd = source.indexOf('// ─── Browser fallback', desktopStart);
  const desktopBlankCreation = source.slice(desktopStart, desktopEnd);
  const mutation = desktopBlankCreation.indexOf(
    "markDocumentModified({ reason: 'document:create-blank' })",
  );
  const rebuild = desktopBlankCreation.indexOf("setViewMode(doc?.viewMode || 'single')");
  assert.ok(mutation >= 0, 'blank-document creation must record its persistent mutation');
  assert.ok(rebuild > mutation, 'the new content revision must rebuild page edit readiness');
});

test('loader cancellation follows immutable document lifecycle ownership', async () => {
  const source = await readFile(new URL('./loader.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /state\.documents\.includes\(doc\)/u);
  assert.doesNotMatch(source, /state\.documents\[state\.activeDocumentIndex\] === doc/u);
  assert.match(
    source,
    /let loadOwner = captureDocumentLifecycleOwner\(doc\)/u,
  );
  assert.match(
    source,
    /loadOwner = captureDocumentLifecycleOwner\(getDocumentById\(loadOwner\.id\) \|\| doc\)/u,
  );
  assert.match(
    source,
    /const annotationOwner = captureDocumentLifecycleOwner\(doc\)/u,
  );
  assert.doesNotMatch(
    source,
    /const \{ loadDocumentScale \} = await import\('\.\.\/annotations\/measurement\.js'\)/u,
  );
  assert.match(
    source,
    /void import\('\.\.\/annotations\/measurement\.js'\)\.then/u,
  );
});

test('the first rendered page hydrates annotations even after its text layer exists', async () => {
  const source = await readFile(new URL('./renderer.js', import.meta.url), 'utf8');
  const annotationStart = source.indexOf('// Ensure annotations for this page are loaded');
  const annotationEnd = source.indexOf('// Final stale-doc check', annotationStart);
  const annotationReadiness = source.slice(annotationStart, annotationEnd);
  assert.match(
    annotationReadiness,
    /!doc\._loadedAnnotationPages\.has\(pageNum\)/u,
    'a newly created text layer must not suppress first-page annotation hydration',
  );
  assert.match(annotationReadiness, /await ensureAnnotationsForPage\(pageNum\)/u);
});

test('first-page FreeText hydration waits for exact ownership and callout metadata', async () => {
  const source = await readFile(new URL('./loader.js', import.meta.url), 'utf8');
  const singlePageStart = source.indexOf('async function loadAnnotationsForSinglePage');
  const singlePageEnd = source.indexOf('// Ensure annotations are loaded', singlePageStart);
  const singlePageLoader = source.slice(singlePageStart, singlePageEnd);
  assert.match(
    singlePageLoader,
    /needsExactFreeTextMetadata = annotations\.some\(a => a\.subtype === 'FreeText'\)/u,
  );
  assert.match(
    singlePageLoader,
    /waitForColors \|\| hasSquareAnnotations \|\| needsExactFreeTextMetadata/u,
    'FreeText must not publish a provisional textbox before exact dictionary metadata is loaded',
  );
});

test('persistent undo commands schedule readiness rebuilding for their new revision', async () => {
  const source = await readFile(new URL('../core/undo-manager.js', import.meta.url), 'utf8');
  const mutationHelperStart = source.indexOf('function noteUndoCommandMutation');
  const mutationHelperEnd = source.indexOf('\n}\n', mutationHelperStart);
  const mutationHelper = source.slice(mutationHelperStart, mutationHelperEnd);
  assert.match(mutationHelper, /noteDocumentMutation\(doc,/u);
  assert.match(
    mutationHelper,
    /scheduleRevisionReadinessRebuild\(doc, contentRevision\)/u,
  );
});

test('rotation recording does not publish the already-rendered mutation twice', async () => {
  const undoSource = await readFile(new URL('../core/undo-manager.js', import.meta.url), 'utf8');
  const recorderStart = undoSource.indexOf('export function recordPageRotation');
  const recorderEnd = undoSource.indexOf('\n}\n', recorderStart);
  const recorder = undoSource.slice(recorderStart, recorderEnd);
  assert.match(recorder, /executeForDocument\(getActiveDocument\(\),/u);
  assert.match(recorder, /\{ noteRevision: false \}\)/u);

  const rendererSource = await readFile(new URL('./renderer.js', import.meta.url), 'utf8');
  const rotationStart = rendererSource.indexOf('export async function rotatePage');
  const rotationEnd = rendererSource.indexOf('// Clear the PDF view', rotationStart);
  const rotation = rendererSource.slice(rotationStart, rotationEnd);
  assert.match(rotation, /noteDocumentMutation\(doc,/u);
  assert.match(
    rotation,
    /renderContinuous\(true, \{\s*synchronization: true,\s*requiredPages: \[pageNum\],\s*\}\)/u,
    'continuous rotation must suppress competing scheduler work until its current page is ready',
  );

  const undoStart = undoSource.indexOf('export async function undo()');
  const redoStart = undoSource.indexOf('export async function redo()');
  const redoEnd = undoSource.indexOf('// ---- Undo transaction support', redoStart);
  assert.match(undoSource.slice(undoStart, redoStart), /noteUndoCommandMutation\(/u);
  assert.match(undoSource.slice(redoStart, redoEnd), /noteUndoCommandMutation\(/u);
});

test('leaving the vector viewport transfers its authoritative zoom to continuous layout', async () => {
  const source = await readFile(new URL('./renderer.js', import.meta.url), 'utf8');
  const viewModeStart = source.indexOf('export async function setViewMode(mode,');
  const viewModeEnd = source.indexOf('// ─── Adjacent-page prefetch', viewModeStart);
  const viewMode = source.slice(viewModeStart, viewModeEnd);
  assert.match(viewMode, /doc\.scale = Number\(liveViewport\.zoom\)/u);

  const setZoomStart = source.indexOf('export async function setZoom(newScale)');
  const setZoomEnd = source.indexOf('// Helper: pick the right', setZoomStart);
  const setZoom = source.slice(setZoomStart, setZoomEnd);
  assert.match(setZoom, /doc\.scale = Number\(vp\.zoom\) \|\| newScale/u);
});
