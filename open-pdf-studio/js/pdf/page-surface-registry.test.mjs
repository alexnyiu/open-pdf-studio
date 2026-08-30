import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adoptPageSurfacesForDocumentLifecycle,
  clearPageSurfaceRegistryForTests,
  markPageSurfacePublication,
  mountedPageSurfaces,
  registerPageSurface,
  resolvePageSurface,
  resolvePageSurfaceForElement,
  unregisterPageSurface,
} from './page-surface-registry.js';

function owner({ page = 50, revision = 7 } = {}) {
  return {
    id: 'doc-surface',
    lifecycleGeneration: 3,
    currentPage: page,
    viewMode: 'continuous',
    revisionState: {
      contentRevision: revision,
      pageContentRevisions: { [page]: revision, 1: 2 },
    },
  };
}

function element(name) {
  return { name, isConnected: true, dataset: {} };
}

test.beforeEach(clearPageSurfaceRegistryForTests);

test('page 50 continuous publication never resolves the global page 1 surface', () => {
  const documentState = owner();
  const singleContainer = element('single-container');
  registerPageSurface({
    documentState,
    pageNum: 1,
    pageContentRevision: 2,
    surfaceKind: 'single-page-canvas',
    container: singleContainer,
    baseSurface: element('global-pdf-canvas'),
    overlayCanvas: element('global-annotation-canvas'),
    canonicalPageDimensions: { width: 612, height: 792 },
    cssScale: 1,
    dpr: 2,
  });
  const continuous = registerPageSurface({
    documentState,
    pageNum: 50,
    surfaceKind: 'continuous-canvas',
    container: element('continuous-page-50'),
    baseSurface: element('page-50-canvas'),
    overlayCanvas: element('page-50-overlay'),
    textLayer: element('page-50-text'),
    canonicalPageDimensions: { width: 792, height: 612 },
    cssScale: 1.5,
    dpr: 3,
  });

  const resolved = resolvePageSurface(documentState, 50, { targetRevision: 7 });
  assert.equal(resolved.mountGeneration, continuous.mountGeneration);
  assert.equal(resolved.baseSurface.name, 'page-50-canvas');
  assert.equal(resolved.textLayer.name, 'page-50-text');
  assert.equal(resolved.dpr, 3);
});

test('a continuous raster image retains its page-local geometry and overlay canvases', () => {
  const documentState = owner();
  const geometryCanvas = element('geometry-canvas');
  const rasterImage = element('pdf-page-raster');
  const surface = registerPageSurface({
    documentState,
    pageNum: 50,
    surfaceKind: 'continuous-raster-image',
    container: element('continuous-image-page'),
    baseSurface: rasterImage,
    geometryCanvas,
    overlayCanvas: element('annotation-overlay'),
    canonicalPageDimensions: { width: 612, height: 792 },
    cssScale: 0.75,
    dpr: 1,
  });
  assert.equal(surface.baseSurface, rasterImage);
  assert.equal(surface.geometryCanvas, geometryCanvas);
  assert.equal(resolvePageSurface(documentState, 50).surfaceKind, 'continuous-raster-image');
});

test('text-layer replacement updates one mount and stale publication cannot advance it', () => {
  const documentState = owner();
  const container = element('page');
  const first = registerPageSurface({
    documentState,
    pageNum: 50,
    container,
    surfaceKind: 'continuous-canvas',
    baseSurface: element('base'),
    textLayer: element('old-text'),
    canonicalPageDimensions: { width: 612, height: 792 },
    cssScale: 1,
    dpr: 2,
  });
  const replacement = registerPageSurface({
    documentState,
    pageNum: 50,
    container,
    surfaceKind: 'continuous-canvas',
    textLayer: element('new-text'),
  });
  assert.equal(replacement.mountGeneration, first.mountGeneration);
  assert.equal(replacement.textLayer.name, 'new-text');
  assert.equal(replacement.baseSurface.name, 'base');

  assert.equal(markPageSurfacePublication(replacement, {
    documentState,
    revision: 7,
    basePublished: true,
    semanticPublished: true,
  }), true);
  documentState.revisionState.contentRevision = 8;
  documentState.revisionState.pageContentRevisions[50] = 8;
  assert.equal(markPageSurfacePublication(replacement, {
    documentState,
    revision: 7,
    basePublished: true,
  }), false);
});

test('unmount removes the exact registration without touching a replacement mount', () => {
  const documentState = owner();
  const firstContainer = element('first');
  const first = registerPageSurface({
    documentState,
    pageNum: 50,
    container: firstContainer,
    surfaceKind: 'continuous-canvas',
  });
  assert.equal(unregisterPageSurface(first), true);
  assert.equal(resolvePageSurface(documentState, 50), null);

  const second = registerPageSurface({
    documentState,
    pageNum: 50,
    container: element('second'),
    surfaceKind: 'continuous-canvas',
  });
  assert.notEqual(second.mountGeneration, first.mountGeneration);
  assert.equal(unregisterPageSurface(first), false);
  assert.equal(resolvePageSurface(documentState, 50).mountGeneration, second.mountGeneration);
});

test('page-local descendants and mounted-layer enumeration resolve through the registry', () => {
  const documentState = owner();
  const container = element('container');
  const canvas = element('canvas');
  const child = element('child');
  canvas.parentElement = container;
  child.parentElement = canvas;
  const textLayer = element('text-layer');
  registerPageSurface({
    documentState,
    pageNum: 50,
    container,
    baseSurface: canvas,
    textLayer,
    surfaceKind: 'continuous-canvas',
  });
  assert.equal(resolvePageSurfaceForElement(child, documentState)?.pageNum, 50);
  assert.deepEqual(mountedPageSurfaces(documentState).map((surface) => surface.textLayer), [textLayer]);
  assert.equal(resolvePageSurfaceForElement(child, {
    ...documentState,
    lifecycleGeneration: documentState.lifecycleGeneration + 1,
  }), null);
});

test('saved proxy adoption keeps a changed page visible until its replacement publishes', () => {
  const documentState = owner();
  const container = element('page-50');
  const oldBase = element('old-base');
  registerPageSurface({
    documentState,
    pageNum: 50,
    pageContentRevision: 7,
    basePublishedRevision: 7,
    semanticPublishedRevision: 7,
    container,
    baseSurface: oldBase,
    surfaceKind: 'continuous-canvas',
  });
  documentState.lifecycleGeneration = 4;
  documentState.revisionState.contentRevision = 8;
  documentState.revisionState.pageContentRevisions[50] = 8;
  const [adopted] = adoptPageSurfacesForDocumentLifecycle(documentState);
  assert.equal(resolvePageSurface(documentState, 50)?.baseSurface, oldBase);
  assert.equal(adopted.pageContentRevision, 7);
  assert.equal(container.dataset.staleDisplayRevision, '7');
  const newBase = element('new-base');
  assert.equal(markPageSurfacePublication(adopted, {
    documentState,
    revision: 8,
    basePublished: true,
    semanticPublished: true,
    baseSurface: newBase,
  }), true);
  assert.equal(resolvePageSurface(documentState, 50)?.baseSurface, newBase);
  assert.equal(container.dataset.staleDisplayRevision, undefined);
  assert.equal(mountedPageSurfaces().length, 1);
});
