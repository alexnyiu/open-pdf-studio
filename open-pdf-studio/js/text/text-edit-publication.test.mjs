import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createTextEditPublicationCoordinator } from './text-edit-publication.js';

function owner() {
  return {
    id: 'doc-publication',
    lifecycleGeneration: 4,
    currentPage: 50,
    viewMode: 'continuous',
    revisionState: {
      contentRevision: 9,
      livePdfRevision: 8,
      pageContentRevisions: { 50: 9 },
    },
  };
}

function token(documentState) {
  return Object.freeze({
    requestId: 'publication-token',
    documentId: documentState.id,
    lifecycleGeneration: documentState.lifecycleGeneration,
    contentRevision: 9,
    livePdfRevision: 8,
    pageRevision: 9,
    publishedPageRevision: 9,
    revisionAuthority: 'model',
    pageNum: 50,
  });
}

function harness(overrides = {}) {
  const surface = { mountGeneration: 17, textLayer: { id: 'layer' } };
  const calls = [];
  const coordinator = createTextEditPublicationCoordinator({
    resolveSurface: () => surface,
    captureToken: (documentState) => token(documentState),
    tokenIsCurrent: () => true,
    publishBase: async () => {
      calls.push('base');
      return { status: 'published', stamp: { kind: 'base' } };
    },
    publishSemantics: async () => {
      calls.push('semantic');
      return { status: 'published', stamp: { kind: 'semantic' } };
    },
    markSurface: () => { calls.push('surface'); return true; },
    markLayerReady: (_document, _page, layer) => { calls.push(`layer:${layer}`); return true; },
    markRenderReady: () => { calls.push('render-ready'); },
    markSemanticReady: () => { calls.push('semantic-ready'); },
    subscribeSurface: () => () => {},
    ...overrides,
  });
  return { coordinator, surface, calls };
}

test('Apply reports published only after exact base and semantic acknowledgements', async () => {
  const documentState = owner();
  const { coordinator, calls } = harness();
  const result = await coordinator.publish({
    documentState,
    pageNum: 50,
    editId: 'edit-1',
    editRevision: 3,
    expectedVisible: true,
    nativeAuthoritative: true,
  });
  assert.equal(result.status, 'published');
  assert.equal(result.visiblePublished, true);
  assert.equal(result.semanticPublished, true);
  assert.equal(result.pageRevision, 9);
  assert.deepEqual(calls.slice(0, 2).sort(), ['base', 'semantic']);
  assert.ok(calls.indexOf('surface') > calls.indexOf('base'));
  assert.ok(calls.includes('render-ready'));
  assert.ok(calls.includes('semantic-ready'));
});

test('a replaced text layer is retried on the next exact surface update', async () => {
  const documentState = owner();
  let semanticAttempts = 0;
  let notify = null;
  let currentSurface = {
    documentId: documentState.id,
    lifecycleGeneration: 4,
    pageNum: 50,
    pageContentRevision: 8,
    mountGeneration: 17,
    textLayer: { id: 'old-layer' },
  };
  const { coordinator } = harness({
    resolveSurface: () => currentSurface,
    publishSemantics: async () => {
      semanticAttempts += 1;
      return semanticAttempts === 1
        ? { status: 'deferred-unmounted', stamp: null }
        : { status: 'published', stamp: { requestGeneration: 22 } };
    },
    subscribeSurface: (listener) => { notify = listener; return () => { notify = null; }; },
    surfaceWaitTimeoutMs: 50,
  });
  const pending = coordinator.publish({
    documentState,
    pageNum: 50,
    editId: 'edit-1',
    editRevision: 3,
    expectedVisible: true,
  });
  while (!notify) await new Promise((resolve) => setImmediate(resolve));
  currentSurface = {
    documentId: documentState.id,
    lifecycleGeneration: 4,
    pageNum: 50,
    pageContentRevision: 9,
    mountGeneration: 18,
    textLayer: { id: 'replacement' },
  };
  notify({ type: 'updated', surface: currentSurface });
  assert.equal((await pending).status, 'published');
  assert.equal(semanticAttempts, 2);
});

test('native publication retries the newest surface when zoom settles during candidate render', async () => {
  const documentState = owner();
  const firstSurface = {
    documentId: documentState.id,
    lifecycleGeneration: 4,
    pageNum: 50,
    pageContentRevision: 9,
    mountGeneration: 17,
    cssScale: 1.25,
    textLayer: { id: 'first-layer' },
  };
  const settledSurface = {
    ...firstSurface,
    cssScale: 1,
    textLayer: { id: 'settled-layer' },
  };
  let currentSurface = firstSurface;
  let baseAttempts = 0;
  let semanticAttempts = 0;
  let acknowledgedSurface = null;
  const { coordinator } = harness({
    resolveSurface: () => currentSurface,
    publishBase: async (context) => {
      baseAttempts += 1;
      if (baseAttempts === 1) {
        currentSurface = settledSurface;
        return {
          status: 'superseded',
          errorCode: 'NATIVE_PREVIEW_SURFACE_CHANGED',
          error: 'scale settled during render',
        };
      }
      assert.equal(context.surface, settledSurface);
      return { status: 'published', stamp: { kind: 'settled-base' } };
    },
    publishSemantics: async (context) => {
      semanticAttempts += 1;
      if (semanticAttempts === 2) assert.equal(context.surface, settledSurface);
      return { status: 'published', stamp: { kind: 'semantic' } };
    },
    markSurface: (surface) => { acknowledgedSurface = surface; return true; },
  });

  const result = await coordinator.publish({
    documentState,
    pageNum: 50,
    nativeAuthoritative: true,
  });
  assert.equal(result.status, 'published');
  assert.equal(result.visiblePublished, true);
  assert.equal(result.semanticPublished, true);
  assert.equal(baseAttempts, 2);
  assert.equal(semanticAttempts, 2);
  assert.equal(acknowledgedSurface, settledSurface);
});

test('an unmounted non-visible page defers, while a missing active page fails visibly', async () => {
  const documentState = owner();
  const { coordinator } = harness({ resolveSurface: () => null });
  const deferred = await coordinator.publish({
    documentState,
    pageNum: 50,
    expectedVisible: false,
  });
  assert.equal(deferred.status, 'deferred-unmounted');
  assert.equal(coordinator.pendingSnapshot().length, 1);

  const failed = await coordinator.publish({
    documentState,
    pageNum: 50,
    expectedVisible: true,
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'PAGE_SURFACE_MISSING');
});

test('document lifecycle cancellation releases deferred publication listeners', async () => {
  const documentState = owner();
  let unsubscribeCalls = 0;
  const { coordinator } = harness({
    resolveSurface: () => null,
    subscribeSurface: () => () => { unsubscribeCalls += 1; },
  });
  await coordinator.publish({
    documentState,
    pageNum: 50,
    expectedVisible: false,
  });
  assert.equal(coordinator.pendingSnapshot().length, 1);
  assert.equal(coordinator.cancelDocument(documentState.id, documentState.lifecycleGeneration), 1);
  assert.equal(unsubscribeCalls, 1);
  assert.equal(coordinator.pendingSnapshot().length, 0);
  assert.equal(coordinator.cancelDocument(documentState.id), 0);
});

test('an explicit successful retry also releases its prior deferred listener', async () => {
  const documentState = owner();
  let currentSurface = null;
  let unsubscribeCalls = 0;
  const { coordinator, surface } = harness({
    resolveSurface: () => currentSurface,
    subscribeSurface: () => () => { unsubscribeCalls += 1; },
  });
  await coordinator.publish({ documentState, pageNum: 50, expectedVisible: false });
  currentSurface = surface;
  assert.equal((await coordinator.publish({
    documentState, pageNum: 50, expectedVisible: true,
  })).status, 'published');
  assert.equal(unsubscribeCalls, 1);
  assert.equal(coordinator.pendingSnapshot().length, 0);
});

test('a deferred unmounted publication applies automatically on the next exact mount', async () => {
  const documentState = owner();
  let current = null;
  let notify = null;
  const { coordinator, calls } = harness({
    resolveSurface: () => current,
    subscribeSurface: (listener) => { notify = listener; return () => { notify = null; }; },
  });
  const deferredResult = await coordinator.publish({
    documentState,
    pageNum: 50,
    expectedVisible: false,
  });
  assert.equal(deferredResult.status, 'deferred-unmounted');
  current = {
    documentId: documentState.id,
    lifecycleGeneration: 4,
    pageNum: 50,
    pageContentRevision: 9,
    mountGeneration: 22,
    textLayer: { id: 'remounted-layer' },
  };
  notify({ type: 'registered', surface: current });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.includes('base'));
  assert.ok(calls.includes('semantic'));
  assert.equal(coordinator.pendingSnapshot().length, 0);
});

test('base publication failure retains the old surface and never marks readiness', async () => {
  const documentState = owner();
  const { coordinator, calls } = harness({
    publishBase: async () => ({ status: 'failed', error: 'forced-visible-failure' }),
  });
  const result = await coordinator.publish({
    documentState,
    pageNum: 50,
    expectedVisible: true,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.visiblePublished, false);
  assert.equal(result.errorCode, 'PAGE_BASE_PUBLICATION_FAILED');
  assert.equal(calls.includes('surface'), false);
  assert.equal(calls.includes('render-ready'), false);
});

test('superseded ownership cannot publish either surface', async () => {
  const documentState = owner();
  const { coordinator, calls } = harness({ tokenIsCurrent: () => false });
  const result = await coordinator.publish({ documentState, pageNum: 50 });
  assert.equal(result.status, 'superseded');
  assert.equal(result.errorCode, 'PUBLICATION_TOKEN_STALE_BEFORE_START');
  assert.deepEqual(calls, []);
});

test('a model mutation cannot acknowledge a page revision newer than its render', async () => {
  const documentState = owner();
  const { coordinator, calls } = harness();
  const result = await coordinator.publish({
    documentState,
    pageNum: 50,
    expectedPageRevision: 8,
    publicationSource: 'page-rotation',
  });
  assert.equal(result.status, 'superseded');
  assert.equal(result.errorCode, 'EXPECTED_PAGE_REVISION_SUPERSEDED');
  assert.deepEqual(calls, []);
});

test('surface replacement before acknowledgement has an exact supersession code', async () => {
  const documentState = owner();
  const { coordinator, calls } = harness({ markSurface: () => false });
  const result = await coordinator.publish({ documentState, pageNum: 50 });
  assert.equal(result.status, 'superseded');
  assert.equal(result.errorCode, 'PAGE_SURFACE_CHANGED_BEFORE_ACKNOWLEDGEMENT');
  assert.equal(calls.includes('render-ready'), false);
  assert.equal(calls.includes('semantic-ready'), false);
});

test('every production text owner commit crosses the shared publication boundary', () => {
  const editTool = readFileSync(new URL('../tools/text-edit-tool.js', import.meta.url), 'utf8');
  const annotationTool = readFileSync(new URL('../tools/text-editing.js', import.meta.url), 'utf8');
  const rendering = readFileSync(new URL('../annotations/rendering.js', import.meta.url), 'utf8');
  assert.match(editTool, /publishCommittedTextEdit\(\{/u);
  assert.match(annotationTool, /publishCommittedTextEdit\(\{/u);
  assert.doesNotMatch(editTool, /document\.getElementById\(['"]pdf-canvas/u);
  assert.doesNotMatch(editTool, /document\.querySelector\(['"]\.textLayer['"]\)/u);
  assert.doesNotMatch(rendering, /coverNativeSourceForLivePreview|dominantBackgroundColor/u);
});

test('model publication rebinds an active native source editor to its replacement layer', () => {
  const publication = readFileSync(new URL('./text-edit-publication.js', import.meta.url), 'utf8');
  const editTool = readFileSync(new URL('../tools/text-edit-tool.js', import.meta.url), 'utf8');
  assert.match(publication, /rebindActiveTextEditorSourceProjection\(\{/u);
  assert.match(editTool, /export function rebindActiveTextEditorSourceProjection/u);
  assert.match(editTool, /span\.style\.visibility = 'hidden'/u);
  assert.match(editTool, /activeEditor\.block = \{ \.\.\.activeEditor\.block, spans \}/u);
});
