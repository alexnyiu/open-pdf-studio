import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SavedDocumentSynchronizationError,
  captureSavedDocumentViewState,
  hasRecoverableSavedDocumentSynchronization,
  invalidateSavedDocumentDerivedState,
  restoreSavedDocumentViewState,
  retrySavedDocumentSynchronization,
  synchronizeSavedDocument,
  waitForSavedDocumentSynchronization,
} from './saved-document-transition.js';
import {
  createInitialDocumentRevisionState,
  documentIsEditReady,
  documentRevisionReadinessSatisfied,
} from '../core/document-revision-state.runtime.js';

let documentSequence = 0;

function persistedDocument() {
  documentSequence += 1;
  const revisionState = createInitialDocumentRevisionState();
  Object.assign(revisionState, {
    contentRevision: 1,
    serializedRevision: 1,
    persistedRevision: 1,
    livePdfRevision: 0,
    saveState: 'persisted',
  });
  return {
    id: `doc-transition-${documentSequence}`,
    lifecycleGeneration: 1,
    revisionState,
    pageRenderRevisions: revisionState.pageContentRevisions,
    pdfDoc: { numPages: 3 },
    currentPage: 2,
    scale: 1.5,
    viewMode: 'single',
    bookSpread: false,
    facingSpread: false,
    pageRotations: { 2: 90 },
    annotations: [{ id: 'selected' }, { id: 'other' }],
    selectedAnnotations: [{ id: 'selected' }],
    selectedAnnotation: { id: 'selected' },
    scrollPosition: { x: 12, y: 34 },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function transitionInput(documentState, overrides = {}) {
  return {
    documentState,
    requestedRevision: 1,
    requestId: 'save-request-1',
    filePath: '/tmp/saved.pdf',
    bytes: new Uint8Array([1, 2, 3]),
    preparedPdfJsDocument: { numPages: 3, id: 'prepared' },
    captureViewState: (document) => captureSavedDocumentViewState(document),
    installProxy: async ({ documentState: document, preparedPdfJsDocument }) => {
      document.pdfDoc = preparedPdfJsDocument;
      document.lifecycleGeneration += 1;
      return { requiredPages: [2] };
    },
    invalidateRevision: async () => {},
    invalidateSemanticState: async () => {},
    rebuildRequiredPages: async ({ requiredPages }) => ({
      renderReadyPages: requiredPages,
      semanticReadyPages: requiredPages,
    }),
    rebuildEditableMetadata: async ({ requiredPages }) => requiredPages,
    restartSemanticPreload: async () => true,
    restoreViewState: async (document, snapshot) => {
      restoreSavedDocumentViewState(document, snapshot);
    },
    waitForEditReadiness: async ({ documentState: document, requiredPages }) => (
      requiredPages.every((page) => documentRevisionReadinessSatisfied(document, page))
    ),
    ...overrides,
  };
}

test('automatic persistence installs its validated proxy and reaches the persisted revision', async () => {
  const document = persistedDocument();
  const result = await synchronizeSavedDocument(transitionInput(document));
  assert.equal(result.synchronized, true);
  assert.equal(document.pdfDoc.id, 'prepared');
  assert.equal(document.revisionState.livePdfRevision, 1);
  assert.equal(document.revisionState.saveState, 'saved');
  assert.equal(documentIsEditReady(document, 2), true);
});

test('automatic save invalidates old semantics and rebuilds changed metadata before readiness', async () => {
  const document = persistedDocument();
  document.revisionState.pendingChangedPages = [3, 2];
  const order = [];
  await synchronizeSavedDocument(transitionInput(document, {
    installProxy: async ({ documentState: owner, preparedPdfJsDocument }) => {
      order.push('install-proxy');
      owner.pdfDoc = preparedPdfJsDocument;
      owner.lifecycleGeneration += 1;
      return { requiredPages: [2] };
    },
    invalidateSemanticState: async ({ documentState: owner, requestedRevision, changedPages }) => {
      order.push('clear-semantic-caches');
      assert.equal(owner.pdfDoc.id, 'prepared');
      assert.equal(owner.revisionState.livePdfRevision, requestedRevision);
      assert.deepEqual(changedPages, [2, 3]);
    },
    rebuildRequiredPages: async ({ requiredPages }) => {
      order.push('render-required-pages');
      return { renderReadyPages: requiredPages, semanticReadyPages: requiredPages };
    },
    rebuildEditableMetadata: async ({ requiredPages, changedPages }) => {
      order.push('rebuild-editable-metadata');
      assert.deepEqual(requiredPages, [2]);
      assert.deepEqual(changedPages, [2, 3]);
      return requiredPages;
    },
    restartSemanticPreload: async () => {
      order.push('restart-whole-preload');
      return true;
    },
    waitForEditReadiness: async ({ documentState: owner, requiredPages }) => {
      order.push('page-edit-ready');
      return requiredPages.every((page) => documentRevisionReadinessSatisfied(owner, page));
    },
  }));
  assert.deepEqual(order, [
    'install-proxy',
    'clear-semantic-caches',
    'render-required-pages',
    'rebuild-editable-metadata',
    'restart-whole-preload',
    'page-edit-ready',
  ]);
  assert.deepEqual(document.revisionState.pendingChangedPages, []);
  assert.equal(document.revisionState.pendingStructuralChange, false);
});

test('central saved-document invalidation invokes every visual, semantic, and engine invalidator', async () => {
  const document = persistedDocument();
  document.revisionState.livePdfRevision = 1;
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  const dependencies = {
    clearReadiness: record('readiness'),
    cancelWholePreload: record('whole-preload'),
    cancelThumbnails: record('thumbnail-work'),
    invalidateSemantic: async (...args) => record('semantic')(...args),
    clearBitmap: record('bitmap'),
    clearTiles: record('tiles'),
    clearVectors: record('vectors'),
    clearPageTypes: record('page-types'),
    invalidateNative: async (...args) => record('native')(...args),
    clearLowResolution: record('low-resolution'),
    clearThumbnails: record('thumbnails'),
    clearLayers: record('layers'),
    clearPerformance: record('performance'),
    initializePerformance: async (...args) => record('initialize-performance')(...args),
    rebuildGeometry: record('rebuild-geometry'),
    registerCacheOwners: async (...args) => record('cache-owners')(...args),
  };

  await invalidateSavedDocumentDerivedState({
    documentState: document,
    requestedRevision: 1,
    changedPages: null,
    filePath: '/new.pdf',
    previousFilePath: '/old.pdf',
    dependencies,
  });

  const names = calls.map(([name]) => name);
  for (const expected of [
    'readiness', 'whole-preload', 'thumbnail-work', 'semantic',
    'bitmap', 'tiles', 'vectors', 'page-types', 'native',
    'low-resolution', 'thumbnails', 'layers', 'performance', 'initialize-performance',
  ]) assert.ok(names.includes(expected), `${expected} was not invoked`);
  assert.equal(names.filter((name) => name === 'bitmap').length, 2);
  assert.equal(names.includes('rebuild-geometry'), false);
  assert.equal(names.includes('cache-owners'), false);
});

test('non-structural saved-document invalidation restamps geometry and cache owners', async () => {
  const document = persistedDocument();
  document.revisionState.livePdfRevision = 1;
  const calls = [];
  const noop = () => {};
  await invalidateSavedDocumentDerivedState({
    documentState: document,
    requestedRevision: 1,
    changedPages: [2],
    dependencies: {
      clearReadiness: noop,
      cancelWholePreload: noop,
      cancelThumbnails: noop,
      invalidateSemantic: async () => {},
      clearBitmap: noop,
      clearTiles: noop,
      clearVectors: noop,
      clearPageTypes: noop,
      invalidateNative: async () => {},
      clearLowResolution: noop,
      clearThumbnails: noop,
      clearLayers: noop,
      clearPerformance: () => calls.push('clear-performance'),
      initializePerformance: async () => calls.push('initialize-performance'),
      rebuildGeometry: () => calls.push('rebuild-geometry'),
      registerCacheOwners: async () => calls.push('cache-owners'),
    },
  });
  assert.deepEqual(calls, ['rebuild-geometry', 'cache-owners']);
});

test('a disk-clean but unsynchronized document performs Phase B without persistence', async () => {
  const document = persistedDocument();
  let proxyInstalls = 0;
  const input = transitionInput(document, {
    installProxy: async ({ documentState: owner, preparedPdfJsDocument }) => {
      proxyInstalls += 1;
      owner.pdfDoc = preparedPdfJsDocument;
      return { requiredPages: [2] };
    },
  });
  await synchronizeSavedDocument(input);
  assert.equal(proxyInstalls, 1);
  assert.equal(document.revisionState.persistedRevision, 1);
  assert.equal(document.revisionState.livePdfRevision, 1);
});

test('a second edit activation waits for synchronization and starts on the new live revision', async () => {
  const document = persistedDocument();
  const rebuild = deferred();
  const transition = synchronizeSavedDocument(transitionInput(document, {
    rebuildRequiredPages: async ({ requiredPages }) => {
      await rebuild.promise;
      return { renderReadyPages: requiredPages, semanticReadyPages: requiredPages };
    },
  }));
  let editStarted = false;
  const edit = waitForSavedDocumentSynchronization(document.id).then((ready) => {
    editStarted = ready;
    return document.revisionState.livePdfRevision;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(editStarted, false);
  rebuild.resolve();
  await transition;
  assert.equal(await edit, 1);
  assert.equal(editStarted, true);
});

test('a post-save edit cannot be cancelled by a late pre-save transition', async () => {
  const document = persistedDocument();
  const install = deferred();
  const transition = synchronizeSavedDocument(transitionInput(document, {
    installProxy: async ({ documentState: owner, preparedPdfJsDocument }) => {
      await install.promise;
      owner.pdfDoc = preparedPdfJsDocument;
      owner.lifecycleGeneration += 1;
      return { requiredPages: [2] };
    },
  }));
  let registeredGeneration = null;
  const activation = waitForSavedDocumentSynchronization(document.id).then((ready) => {
    if (ready) registeredGeneration = document.lifecycleGeneration;
  });
  install.resolve();
  await transition;
  await activation;
  assert.equal(registeredGeneration, 2);
});

test('active-tab wrapper identity does not suppress the immutable owner transition', async () => {
  const document = persistedDocument();
  const unrelatedActiveTab = { id: 'other-document' };
  let installedOwner = null;
  await synchronizeSavedDocument(transitionInput(document, {
    installProxy: async ({ documentState: owner }) => {
      assert.notEqual(owner, unrelatedActiveTab);
      installedOwner = owner.id;
      return { requiredPages: [2] };
    },
  }));
  assert.equal(installedOwner, document.id);
});

test('Save As transition preserves path-owned view, selection, rotations, and search state', () => {
  const document = persistedDocument();
  const appState = {
    currentTool: 'editText',
    search: {
      isOpen: true,
      query: 'coherence',
      replaceQuery: 'revision',
      matchCase: true,
      wholeWord: false,
      highlightAll: true,
      results: [1],
      currentIndex: 0,
      totalMatches: 1,
      isSearching: true,
    },
  };
  const snapshot = captureSavedDocumentViewState(document, { appState });
  document.currentPage = 1;
  document.scale = 3;
  document.pageRotations = {};
  document.annotations = [{ id: 'selected' }];
  appState.currentTool = 'select';
  restoreSavedDocumentViewState(document, snapshot, { appState });
  assert.equal(document.currentPage, 2);
  assert.equal(document.scale, 1.5);
  assert.deepEqual(document.pageRotations, { 2: 90 });
  assert.equal(document.selectedAnnotation.id, 'selected');
  assert.equal(appState.currentTool, 'editText');
  assert.equal(appState.search.query, 'coherence');
  assert.deepEqual(appState.search.results, []);
});

test('proxy-install failure preserves the saved revision and exposes recovery', async () => {
  const document = persistedDocument();
  await assert.rejects(
    synchronizeSavedDocument(transitionInput(document, {
      installProxy: async () => { throw new Error('forced proxy install failure'); },
    })),
    SavedDocumentSynchronizationError,
  );
  assert.equal(document.revisionState.persistedRevision, 1);
  assert.equal(document.revisionState.livePdfRevision, 0);
  assert.equal(document.revisionState.saveState, 'saved-refresh-failed');
  assert.equal(hasRecoverableSavedDocumentSynchronization(document.id), true);
});

test('retry synchronization reuses saved bytes and candidate without replacing the file', async () => {
  const document = persistedDocument();
  let installs = 0;
  let persistenceCalls = 0;
  const input = transitionInput(document, {
    installProxy: async ({ documentState: owner, preparedPdfJsDocument, bytes }) => {
      installs += 1;
      assert.deepEqual([...bytes], [1, 2, 3]);
      if (installs === 1) throw new Error('one-shot install failure');
      owner.pdfDoc = preparedPdfJsDocument;
      return { requiredPages: [2] };
    },
    invalidateRevision: async () => { persistenceCalls += 0; },
  });
  await assert.rejects(synchronizeSavedDocument(input));
  const result = await retrySavedDocumentSynchronization(document.id);
  assert.equal(result.synchronized, true);
  assert.equal(installs, 2);
  assert.equal(persistenceCalls, 0);
  assert.equal(document.revisionState.saveState, 'saved');
});

test('retry after a readiness failure does not reinstall the already-live proxy', async () => {
  const document = persistedDocument();
  let installs = 0;
  let readinessAttempts = 0;
  const input = transitionInput(document, {
    installProxy: async ({ documentState: owner, preparedPdfJsDocument }) => {
      installs += 1;
      owner.pdfDoc = preparedPdfJsDocument;
      return { requiredPages: [2] };
    },
    waitForEditReadiness: async ({ documentState: owner }) => {
      readinessAttempts += 1;
      return readinessAttempts > 1 && documentRevisionReadinessSatisfied(owner, 2);
    },
  });
  await assert.rejects(synchronizeSavedDocument(input));
  await retrySavedDocumentSynchronization(document.id);
  assert.equal(installs, 1);
  assert.equal(readinessAttempts, 2);
});
