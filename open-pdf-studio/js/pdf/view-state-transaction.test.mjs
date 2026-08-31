import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureContinuousRendererState,
  captureSharedUiLease,
  captureSinglePageViewportState,
  captureViewStateTransaction,
  initializeDocumentViewMutationState,
  mergeViewStateTransaction,
  noteDocumentViewActivation,
  noteDocumentViewMutation,
  resolveViewportFitAction,
  restoreContinuousRendererState,
  restoreSinglePageViewportState,
} from './view-state-transaction.js';

function owner() {
  return { id: 'doc-a', lifecycleGeneration: 3 };
}

test('newer user fields win while untouched and system-mutated fields restore', () => {
  const document = owner();
  const lease = captureSharedUiLease(document);
  const snapshot = captureViewStateTransaction(document, {
    page: 2,
    mode: 'single',
    zoom: 1.5,
    scroll: { x: 20, y: 40 },
    tool: 'editText',
    search: { query: 'old' },
  }, { sharedUiLease: lease });

  noteDocumentViewMutation(document, ['zoom', 'search']);
  noteDocumentViewMutation(document, ['page'], { origin: 'system' });
  document.lifecycleGeneration = 4;
  const applied = new Map();
  const conflicts = [];
  const result = mergeViewStateTransaction(document, snapshot, {
    ownerActive: true,
    sharedUiLease: captureSharedUiLease(document),
    apply: (field, value) => applied.set(field, value),
    onConflict: (conflict) => conflicts.push(conflict),
  });

  assert.deepEqual([...applied.keys()], ['page', 'mode', 'scroll', 'tool']);
  assert.deepEqual(result.restored, ['page', 'mode', 'scroll', 'tool']);
  assert.deepEqual(result.skipped.map((entry) => entry.field), ['zoom', 'search']);
  assert.deepEqual(conflicts.map((entry) => entry.reason), [
    'newer-user-mutation',
    'newer-user-mutation',
  ]);
});

test('single-page renderer state preserves exact zoom and canonical anchor within one CSS pixel', () => {
  for (const zoom of [0.75, 1, 1.5, 2.5, 4]) {
    const snapshot = captureSinglePageViewportState({
      documentId: 'doc-a',
      pageNum: 7,
      rotation: 90,
      zoom,
      offsetX: -213.25,
      offsetY: -487.75,
      canvasWidth: 1_200,
      canvasHeight: 800,
      viewportRevision: 12,
    });
    const restored = restoreSinglePageViewportState(snapshot, {
      canvasWidth: 1_440,
      canvasHeight: 900,
      currentZoom: 1,
      currentOffsetX: 0,
      currentOffsetY: 0,
      restoreZoom: true,
      restorePan: true,
    });
    const restoredScreenX = snapshot.anchor.pdfPoint.x * restored.zoom + restored.offsetX;
    const restoredScreenY = snapshot.anchor.pdfPoint.y * restored.zoom + restored.offsetY;
    assert.equal(restored.zoom, zoom);
    assert.ok(Math.abs(restoredScreenX - 720) <= 1);
    assert.ok(Math.abs(restoredScreenY - 450) <= 1);
  }
});

test('Retina backing dimensions normalize to the same CSS-space anchor', () => {
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    const cssWidth = 1_100;
    const cssHeight = 760;
    const snapshot = captureSinglePageViewportState({
      documentId: 'doc-a',
      pageNum: 4,
      zoom: 2.5,
      offsetX: -340,
      offsetY: -510,
      canvasWidth: (cssWidth * dpr) / dpr,
      canvasHeight: (cssHeight * dpr) / dpr,
    });
    const restored = restoreSinglePageViewportState(snapshot, {
      canvasWidth: cssWidth,
      canvasHeight: cssHeight,
    });
    assert.ok(Math.abs(snapshot.anchor.pdfPoint.x * restored.zoom
      + restored.offsetX - cssWidth / 2) <= 1);
    assert.ok(Math.abs(snapshot.anchor.pdfPoint.y * restored.zoom
      + restored.offsetY - cssHeight / 2) <= 1);
  }
});

test('continuous state restores its logical PDF anchor and defers when geometry is unavailable', () => {
  const snapshot = captureContinuousRendererState({
    documentId: 'doc-a',
    pageNum: 250,
    scale: 1.5,
    pageRect: { x: 40, y: 300_000 },
    scrollLeft: 175,
    scrollTop: 300_450,
    viewportWidth: 1_200,
    viewportHeight: 800,
    horizontalOffsetPx: -12,
    verticalOffsetPx: 7,
    viewportRevision: 9,
  });
  assert.equal(restoreContinuousRendererState(snapshot, {}).status, 'deferred-unmounted');

  const restored = restoreContinuousRendererState(snapshot, {
    pageRect: { x: 60, y: 320_000 },
    horizontalOffsetPx: -4,
    verticalOffsetPx: 3,
  });
  const screenX = 60 - 4 + snapshot.anchor.pdfPoint.x * restored.scale - restored.scrollLeft;
  const screenY = 320_000 + 3 + snapshot.anchor.pdfPoint.y * restored.scale - restored.scrollTop;
  assert.ok(Math.abs(screenX - snapshot.anchor.viewportPoint.x) <= 1);
  assert.ok(Math.abs(screenY - snapshot.anchor.viewportPoint.y) <= 1);
});

test('unchanged continuous representation restores exact native scroll coordinates', () => {
  const pageRect = { x: 60, y: 4_000, width: 900, height: 1_200 };
  const snapshot = captureContinuousRendererState({
    documentId: 'doc-a',
    pageNum: 6,
    scale: 1.35,
    pageRect,
    scrollLeft: 217.5,
    scrollTop: 4_320.25,
    viewportWidth: 775,
    viewportHeight: 697,
    horizontalOffsetPx: -18,
    verticalOffsetPx: 0.25,
  });
  const restored = restoreContinuousRendererState(snapshot, {
    pageRect: { ...pageRect },
    scale: 1.35,
    horizontalOffsetPx: -18,
    verticalOffsetPx: 0.25,
    viewportWidth: 775,
    viewportHeight: 697,
    currentScrollLeft: 0,
    currentScrollTop: 0,
  });
  assert.equal(restored.source, 'exact-representation');
  assert.equal(restored.scrollLeft, 217.5);
  assert.equal(restored.scrollTop, 4_320.25);
});

test('inactive owners and invalidated activation leases cannot restore shared UI', () => {
  const document = owner();
  const snapshot = captureViewStateTransaction(document, {
    page: 3,
    mode: 'continuous',
    zoom: 2,
    scroll: { x: 0, y: 900 },
    tool: 'pan',
    selection: ['a'],
    panels: { left: 'thumbnails' },
    search: { query: 'beam' },
  }, { sharedUiLease: captureSharedUiLease(document) });
  noteDocumentViewActivation(document);
  const applied = [];
  const result = mergeViewStateTransaction(document, snapshot, {
    ownerActive: false,
    sharedUiLease: captureSharedUiLease(document),
    apply: (field) => applied.push(field),
  });
  assert.deepEqual(applied, ['page', 'mode', 'zoom']);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), [
    'inactive-shared-ui-owner',
    'inactive-shared-ui-owner',
    'inactive-shared-ui-owner',
    'inactive-shared-ui-owner',
    'inactive-shared-ui-owner',
  ]);
});

test('system-originated mutations never advance user conflict stamps', () => {
  const document = owner();
  const before = initializeDocumentViewMutationState(document);
  noteDocumentViewMutation(document, ['page', 'zoom'], { origin: 'system' });
  assert.deepEqual(initializeDocumentViewMutationState(document), before);
});

test('every newer user-owned view field defeats an older save snapshot', () => {
  const document = owner();
  const values = Object.fromEntries([
    ['page', 1], ['mode', 'single'], ['spread', {}], ['zoom', 1], ['pan', {}],
    ['scroll', {}], ['rotation', {}], ['tool', 'select'], ['selection', []],
    ['panels', {}], ['search', {}],
  ]);
  const snapshot = captureViewStateTransaction(document, values);
  noteDocumentViewMutation(document, Object.keys(values));
  const result = mergeViewStateTransaction(document, snapshot, {
    ownerActive: true,
    sharedUiLease: captureSharedUiLease(document),
    apply: () => assert.fail('stale field must not restore'),
  });
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.skipped.map((entry) => entry.field), Object.keys(values));
  assert.ok(result.skipped.every((entry) => entry.reason === 'newer-user-mutation'));
});

test('same-document proxy adoption preserves view while deliberate open and rotation fit', () => {
  assert.equal(resolveViewportFitAction({
    fitPolicy: 'preserve',
    logicalDocumentChanged: false,
    rotationChanged: false,
  }), 'preserve');
  assert.equal(resolveViewportFitAction({
    fitPolicy: 'auto',
    logicalDocumentChanged: true,
  }), 'initial');
  assert.equal(resolveViewportFitAction({
    fitPolicy: 'auto',
    rotationChanged: true,
  }), 'rotation');
});
