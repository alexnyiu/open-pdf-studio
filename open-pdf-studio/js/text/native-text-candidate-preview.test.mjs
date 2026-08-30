import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNativeTextCandidatePreviewPublisher,
  nativeTextCandidateRasterPlan,
} from './native-text-candidate-preview.js';

test('candidate raster planning honors DPR 1, 2, and 3', () => {
  for (const dpr of [1, 2, 3]) {
    const plan = nativeTextCandidateRasterPlan({
      pageWidthPt: 612,
      pageHeightPt: 792,
      cssScale: 1.25,
      dpr,
    });
    assert.equal(plan.renderScale, 1.25 * dpr);
    assert.equal(plan.backingWidth, Math.ceil(612 * 1.25 * dpr));
    assert.equal(plan.backingHeight, Math.ceil(792 * 1.25 * dpr));
    assert.equal(plan.capped, false);
  }
});

test('candidate raster planning caps the longest backing axis at 4096 pixels', () => {
  const plan = nativeTextCandidateRasterPlan({
    pageWidthPt: 2000,
    pageHeightPt: 3000,
    cssScale: 2,
    dpr: 3,
  });
  assert.equal(plan.capped, true);
  assert.equal(plan.backingHeight, 4096);
  assert.ok(plan.backingWidth <= 4096);
  assert.ok(plan.renderScale < plan.requestedRenderScale);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function previewHarness({ failRender = false } = {}) {
  const renderGate = deferred();
  const oldPreview = { removed: false, remove() { this.removed = true; } };
  const appended = [];
  const container = {
    querySelector: (selector) => selector === '.text-edit-authoritative-preview' ? oldPreview : null,
    appendChild: (element) => { appended.push(element); },
  };
  const surface = {
    documentId: 'doc-candidate',
    lifecycleGeneration: 7,
    pageNum: 50,
    pageContentRevision: 10,
    mountGeneration: 31,
    surfaceKind: 'continuous-raster-image',
    container,
    baseSurface: { tagName: 'IMG' },
    geometryCanvas: { tagName: 'CANVAS' },
    overlayCanvas: { style: {} },
    cssScale: 1.5,
    dpr: 2,
  };
  const created = [];
  const makeCanvas = () => {
    const canvas = {
      dataset: {},
      style: {},
      width: 0,
      height: 0,
      getContext: () => ({}),
    };
    created.push(canvas);
    return canvas;
  };
  const page = {
    rotate: 0,
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: failRender ? Promise.reject(new Error('forced-render-failure')) : renderGate.promise }),
  };
  const publisher = createNativeTextCandidatePreviewPublisher({
    getCandidate: async () => ({ candidateBytes: new Uint8Array(64), pageCount: 100 }),
    openCandidateDocument: async () => ({ getPage: async () => page }),
    destroyDocument: async () => {},
    isTokenCurrent: async () => true,
    resolvePage: async () => surface,
    getRotation: async () => 0,
    makeCanvas,
  });
  const context = {
    documentState: {
      id: 'doc-candidate',
      lifecycleGeneration: 7,
      revisionState: { contentRevision: 10, pageContentRevisions: { 50: 10 } },
    },
    pageNum: 50,
    revision: 10,
    token: { contentRevision: 10 },
    surface,
  };
  return { publisher, context, renderGate, oldPreview, appended, created };
}

test('continuous image plus geometry surfaces retain the old base until candidate render completes', async () => {
  const harness = previewHarness();
  const pending = harness.publisher(harness.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.oldPreview.removed, false);

  harness.renderGate.resolve();
  const result = await pending;
  assert.equal(result.status, 'published');
  assert.equal(result.surfaceKind, 'continuous-canvas');
  assert.equal(result.stamp.kind, 'native-candidate-page');
  assert.equal(harness.appended.length, 1);
  assert.equal(harness.oldPreview.removed, true);
  assert.equal(harness.created[0].width, 1800);
  assert.equal(harness.created[0].height, 2400);
});

test('a candidate render failure leaves the old page surface mounted', async () => {
  const harness = previewHarness({ failRender: true });
  const result = await harness.publisher(harness.context);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /forced-render-failure/u);
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.oldPreview.removed, false);
});
