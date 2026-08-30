import {
  initializeDocumentRevisionState,
  clearPageReadiness,
  markDocumentSaveState,
  markLivePdfRevision,
  markPageRenderReady,
  markPageSemanticReady,
  setVisibleRequiredPages,
} from '../core/document-revision-state.runtime.js';
import { throwIfSaveFaultInjected } from './save-fault-injection.js';
import { clearPageEditReadiness } from './page-edit-readiness.js';
import {
  captureSharedUiLease,
  captureViewStateTransaction,
  mergeViewStateTransaction,
} from './view-state-transaction.js';

const activeSynchronizations = new Map();
const recoverableSynchronizations = new Map();

/** Decide whether persisted bytes may replace the live PDF.js proxy now. */
export function decidePersistedProxyAdoption({
  kind = 'manual',
  requestedRevision,
  contentRevision,
  liveTextSession = false,
  dirtyTextDraft = false,
  pendingPageEditIntent = false,
  ownerActiveForSharedUi = true,
} = {}) {
  const defer = (reason) => Object.freeze({
    adopt: false,
    status: 'saved-refresh-pending',
    reason,
  });
  if (kind === 'auto') return defer('automatic-persistence');
  if (liveTextSession) return defer('live-text-session');
  if (dirtyTextDraft) return defer('dirty-text-draft');
  if (pendingPageEditIntent) return defer('pending-page-edit-intent');
  if (Number(contentRevision) > Number(requestedRevision)) return defer('newer-content-revision');
  if (!ownerActiveForSharedUi) return defer('inactive-shared-ui-owner');
  return Object.freeze({ adopt: true, status: 'saved', reason: null });
}

export class SavedDocumentSynchronizationError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SavedDocumentSynchronizationError';
    this.code = 'SAVED_DOCUMENT_SYNCHRONIZATION_FAILED';
    this.fileSaved = true;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function positivePages(values, fallback = null) {
  const pages = [...new Set((values || []).map(Number)
    .filter((page) => Number.isSafeInteger(page) && page > 0))]
    .sort((left, right) => left - right);
  if (pages.length > 0) return pages;
  return fallback == null ? [] : [Math.max(1, Number(fallback) || 1)];
}

export async function invalidateSavedDocumentSemanticState({
  documentState,
  requestedRevision,
  changedPages = null,
}) {
  if (!documentState?.id || !documentState.pdfDoc) {
    throw new TypeError('A live saved document is required for semantic invalidation');
  }
  const revisions = initializeDocumentRevisionState(documentState);
  if (revisions.livePdfRevision !== Number(requestedRevision)) {
    throw new RangeError('Semantic invalidation must target the installed live PDF revision');
  }
  const [editableMetadata, provenance, searchCache] = await Promise.all([
    import('./editable-metadata-preload.js'),
    import('../text/native-text-provenance.js'),
    import('../search/text-cache.js'),
  ]);
  editableMetadata.clearEditableMetadataPreload(documentState);
  provenance.clearNativeTextSourceCache(documentState);
  searchCache.invalidateTextCache(documentState.id);
  documentState.preloadStatus = Object.freeze({
    state: 'idle',
    completed: 0,
    total: Number(documentState.pdfDoc.numPages) || 0,
    retainedBytes: 0,
    limitReason: null,
    documentId: String(documentState.id),
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    pdfDocument: documentState.pdfDoc,
    contentRevision: revisions.contentRevision,
    livePdfRevision: revisions.livePdfRevision,
    changedPages: changedPages === null ? null : Object.freeze(positivePages(changedPages)),
  });
  return true;
}

async function loadSavedDocumentDerivedInvalidators() {
  const [
    renderer,
    tiles,
    vectors,
    pageTypes,
    thumbnails,
    performance,
    wholePreload,
    textLayers,
    linkLayers,
    formLayers,
    platform,
    stateModule,
    pageReadiness,
  ] = await Promise.all([
    import('./renderer.js'),
    import('./tile-cache.js'),
    import('./vector-renderer.js'),
    import('./page-type-cache.js'),
    import('../ui/panels/left-panel.js'),
    import('./document-performance.js'),
    import('./whole-pdf-preload.js'),
    import('../text/text-layer.js'),
    import('./link-layer.js'),
    import('./form-layer.js'),
    import('../core/platform.js'),
    import('../core/state.js'),
    import('./page-edit-readiness.js'),
  ]);
  return {
    clearReadiness: (documentState, pages) => clearPageReadiness(documentState, pages),
    clearEditReadiness: (documentState, pages) => (
      pageReadiness.clearPageEditReadiness(documentState, pages)
    ),
    cancelWholePreload: (documentState) => wholePreload.cancelWholePdfPreload(documentState),
    invalidateSemantic: invalidateSavedDocumentSemanticState,
    clearBitmap: (filePath) => renderer.clearBitmapJSCacheForFile(filePath),
    clearLowResolution: (documentState, pages) => (
      renderer.clearLowResCacheForDocument(documentState, pages)
    ),
    clearTiles: (filePath) => tiles.tileCacheClearForFile(filePath),
    clearVectors: (filePath) => vectors.clearVectorCacheForFile(filePath),
    clearPageTypes: (filePath) => pageTypes.evictFile(filePath),
    cancelThumbnails: (documentState) => thumbnails.cancelDocumentThumbnailWork(documentState),
    clearThumbnails: (documentId) => thumbnails.clearThumbnailCache(documentId),
    clearLayers: (documentState) => {
      if (stateModule.getActiveDocument() !== documentState) return;
      textLayers.clearSinglePageTextLayer();
      textLayers.clearTextLayers();
      linkLayers.clearSinglePageLinkLayer();
      linkLayers.clearLinkLayers();
      formLayers.clearSinglePageFormLayer();
      formLayers.clearFormLayers();
    },
    invalidateNative: async (filePath) => {
      if (filePath && platform.isTauri()) {
        await platform.invoke('invalidate_pdf_cache', { path: filePath });
      }
    },
    clearPerformance: (documentState) => performance.clearDocumentPerformance(documentState),
    rebuildGeometry: (documentState) => performance.rebuildDocumentPageGeometryIndex(documentState),
    initializePerformance: (documentState) => performance.initializeDocumentPerformance(documentState, {
      fileBytes: documentState.sourceByteLength,
    }),
    registerCacheOwners: (documentState) => performance.registerDocumentRenderCacheOwners(documentState),
  };
}

export async function invalidateSavedDocumentDerivedState({
  documentState,
  requestedRevision,
  changedPages = null,
  filePath = documentState?.filePath,
  previousFilePath = null,
  dependencies = null,
}) {
  if (!documentState?.id || !documentState.pdfDoc) {
    throw new TypeError('A live saved document is required for derived-state invalidation');
  }
  const revisions = initializeDocumentRevisionState(documentState);
  if (revisions.livePdfRevision !== Number(requestedRevision)) {
    throw new RangeError('Derived-state invalidation must target the installed live PDF revision');
  }
  const invalidators = dependencies || await loadSavedDocumentDerivedInvalidators();
  const pages = changedPages === null ? null : positivePages(changedPages);
  const structuralOrUncertain = pages === null || revisions.pendingStructuralChange === true;
  const cachePaths = [...new Set([previousFilePath, filePath, documentState.filePath].filter(Boolean))];

  invalidators.clearReadiness(documentState, pages);
  invalidators.clearEditReadiness(documentState, pages);
  invalidators.cancelWholePreload(documentState);
  invalidators.cancelThumbnails(documentState);
  await invalidators.invalidateSemantic({ documentState, requestedRevision, changedPages: pages });
  for (const cachePath of cachePaths) {
    invalidators.clearBitmap(cachePath);
    invalidators.clearTiles(cachePath);
    invalidators.clearVectors(cachePath);
    invalidators.clearPageTypes(cachePath);
    await invalidators.invalidateNative(cachePath);
  }
  invalidators.clearLowResolution(documentState, pages);
  invalidators.clearThumbnails(documentState.id);
  invalidators.clearLayers(documentState);

  if (structuralOrUncertain) {
    invalidators.clearPerformance(documentState);
    await invalidators.initializePerformance(documentState);
  } else {
    invalidators.rebuildGeometry(documentState);
    await invalidators.registerCacheOwners(documentState);
  }
  return true;
}

export async function rebuildSavedDocumentEditableMetadata({
  documentState,
  requestedRevision,
  requiredPages = [],
  changedPages = null,
}) {
  const revisions = initializeDocumentRevisionState(documentState);
  if (revisions.livePdfRevision !== Number(requestedRevision)) return [];
  const [{ preloadEditableMetadataPage }, publication, readiness] = await Promise.all([
    import('./editable-metadata-preload.js'),
    import('./render-publication-token.js'),
    import('./page-edit-readiness.js'),
  ]);
  const required = positivePages(requiredPages);
  const changed = changedPages === null ? [] : positivePages(changedPages);
  const ordered = [...changed, ...required.filter((page) => !changed.includes(page))];
  const ready = [];
  for (const pageNum of ordered) {
    const token = publication.captureRenderPublicationToken(
      documentState,
      pageNum,
      'saved-semantic-rebuild',
    );
    const result = await preloadEditableMetadataPage(documentState, pageNum, token);
    if (!publication.renderPublicationTokenIsCurrent(token, documentState)
        || initializeDocumentRevisionState(documentState).livePdfRevision
          !== Number(requestedRevision)) return ready;
    if (result) {
      readiness.markPageEditLayerReady(documentState, pageNum, 'editableMetadata', token);
      if (required.includes(pageNum)) ready.push(pageNum);
    } else if (required.includes(pageNum)) {
      readiness.failPageEditReadiness(
        documentState,
        pageNum,
        'Editable metadata did not publish for the current saved revision',
        token,
      );
    }
  }
  return ready;
}

export async function restartSavedDocumentSemanticPreload({ documentState }) {
  const [{ getDocumentById, getActiveDocument }, preload, thumbnails] = await Promise.all([
    import('../core/state.js'),
    import('./whole-pdf-preload.js'),
    import('../ui/panels/left-panel.js'),
  ]);
  if (getDocumentById(documentState?.id) !== documentState) return false;
  if (getActiveDocument() === documentState) {
    const visiblePages = positivePages([
      documentState.currentPage,
      ...thumbnails.visibleThumbnailPages(),
    ]).filter((page) => page <= Number(documentState.pdfDoc?.numPages));
    for (const pageNum of visiblePages) {
      await thumbnails.preloadThumbnailPage(documentState, pageNum);
    }
    await thumbnails.generateThumbnails();
  }
  void Promise.resolve(preload.restartWholePdfPreload(documentState)).catch((error) => {
    console.warn('[preload] Saved-revision restart failed:', error?.message || error);
  });
  return true;
}

function cloneSearchState(search) {
  if (!search) return null;
  return Object.freeze({
    isOpen: search.isOpen === true,
    query: String(search.query || ''),
    replaceQuery: String(search.replaceQuery || ''),
    matchCase: search.matchCase === true,
    wholeWord: search.wholeWord === true,
    highlightAll: search.highlightAll !== false,
  });
}

export function captureSavedDocumentViewState(documentState, {
  appState = null,
  scrollContainer = null,
  panelState = null,
  rendererState = null,
  ownerActive = null,
} = {}) {
  if (!documentState) throw new TypeError('A document is required to capture saved view state');
  const active = ownerActive === null
    ? (appState?.documents
      ? appState.documents[appState.activeDocumentIndex] === documentState
      : true)
    : ownerActive === true;
  const scale = Math.max(0.05,
    Number(rendererState?.zoom ?? rendererState?.scale ?? documentState.scale) || 1);
  const pageNumber = Math.max(1, Number(documentState.currentPage) || 1);
  const scrollPosition = Object.freeze({
    x: Math.max(0, Number(active
      ? scrollContainer?.scrollLeft ?? documentState.scrollPosition?.x
      : documentState.scrollPosition?.x) || 0),
    y: Math.max(0, Number(active
      ? scrollContainer?.scrollTop ?? documentState.scrollPosition?.y
      : documentState.scrollPosition?.y) || 0),
  });
  const selectedAnnotationIds = Object.freeze(
    (documentState.selectedAnnotations || []).map((annotation) => String(annotation.id)),
  );
  const values = {
    page: pageNumber,
    mode: documentState.viewMode || 'single',
    spread: Object.freeze({
      bookSpread: documentState.bookSpread === true,
      facingSpread: documentState.facingSpread === true,
    }),
    zoom: scale,
    rotation: Object.freeze({ ...(documentState.pageRotations || {}) }),
  };
  if (active) {
    values.pan = rendererState?.kind === 'single-viewport' ? rendererState : null;
    values.scroll = rendererState?.kind === 'continuous-renderer'
      ? rendererState : scrollPosition;
    values.tool = appState?.currentTool || null;
    values.selection = selectedAnnotationIds;
    values.panels = panelState;
    values.search = cloneSearchState(appState?.search);
  }
  const transaction = captureViewStateTransaction(documentState, values, {
    sharedUiLease: active ? captureSharedUiLease(documentState) : null,
  });
  return Object.freeze({
    pageNumber,
    viewMode: documentState.viewMode || 'single',
    bookSpread: documentState.bookSpread === true,
    facingSpread: documentState.facingSpread === true,
    scale,
    pageRotations: Object.freeze({ ...(documentState.pageRotations || {}) }),
    scrollPosition,
    activeTool: active ? appState?.currentTool || null : null,
    selectedAnnotationIds,
    panelState: active ? panelState : null,
    search: active ? cloneSearchState(appState?.search) : null,
    rendererState,
    transaction,
    ownerActiveAtCapture: active,
  });
}

export function restoreSavedDocumentViewState(documentState, snapshot, {
  appState = null,
  restorePanelState = null,
  ownerActive = null,
  sharedUiLease = null,
  diagnostic = null,
} = {}) {
  if (!documentState || !snapshot) return false;
  const active = ownerActive === null
    ? (appState?.documents
      ? appState.documents[appState.activeDocumentIndex] === documentState
      : true)
    : ownerActive === true;
  const pageCount = Math.max(1, Number(documentState.pdfDoc?.numPages) || 1);
  const transaction = snapshot.transaction || captureViewStateTransaction(documentState, {
    page: snapshot.pageNumber,
    mode: snapshot.viewMode,
    spread: {
      bookSpread: snapshot.bookSpread === true,
      facingSpread: snapshot.facingSpread === true,
    },
    zoom: snapshot.scale,
    rotation: snapshot.pageRotations || {},
    ...(active ? {
      pan: snapshot.rendererState?.kind === 'single-viewport' ? snapshot.rendererState : null,
      scroll: snapshot.rendererState?.kind === 'continuous-renderer'
        ? snapshot.rendererState : snapshot.scrollPosition,
      tool: snapshot.activeTool,
      selection: snapshot.selectedAnnotationIds || [],
      panels: snapshot.panelState,
      search: snapshot.search,
    } : {}),
  }, { sharedUiLease: snapshot.ownerActiveAtCapture ? snapshot.transaction?.sharedUiLease : null });
  const currentLease = active
    ? sharedUiLease || captureSharedUiLease(documentState) : null;
  const report = mergeViewStateTransaction(documentState, transaction, {
    ownerActive: active,
    sharedUiLease: currentLease,
    onConflict: (conflict) => diagnostic?.('view-restore-conflict', conflict),
    apply(field, value) {
      if (field === 'page') {
        documentState.currentPage = Math.min(pageCount, Math.max(1, Number(value) || 1));
      } else if (field === 'mode') {
        documentState.viewMode = value === 'continuous' ? 'continuous' : 'single';
      } else if (field === 'spread') {
        documentState.bookSpread = value?.bookSpread === true;
        documentState.facingSpread = value?.facingSpread === true;
      } else if (field === 'zoom') {
        documentState.scale = Math.max(0.05, Number(value) || 1);
      } else if (field === 'rotation') {
        documentState.pageRotations = { ...(value || {}) };
      } else if (field === 'selection') {
        const byId = new Map((documentState.annotations || [])
          .map((annotation) => [String(annotation.id), annotation]));
        documentState.selectedAnnotations = (value || [])
          .map((id) => byId.get(String(id))).filter(Boolean);
        documentState.selectedAnnotation = documentState.selectedAnnotations[0] || null;
      } else if (field === 'tool' && appState && value) {
        appState.currentTool = value;
      } else if (field === 'search' && appState?.search && value) {
        Object.assign(appState.search, value, {
          results: [], currentIndex: -1, totalMatches: 0, isSearching: false,
        });
      } else if (field === 'panels' && typeof restorePanelState === 'function') {
        restorePanelState(value);
      } else if (field === 'scroll' && value?.kind !== 'continuous-renderer') {
        documentState.scrollPosition = {
          x: Math.max(0, Number(value?.x) || 0),
          y: Math.max(0, Number(value?.y) || 0),
        };
      }
    },
  });
  return Object.freeze({
    ...report,
    rendererState: snapshot.rendererState || null,
    rendererPolicy: Object.freeze({
      restoreZoom: report.restored.includes('zoom'),
      restorePan: report.restored.includes('pan'),
      restoreScroll: report.restored.includes('scroll'),
    }),
  });
}

async function runSynchronization(record, { retry = false } = {}) {
  const {
    documentState,
    requestedRevision,
    requestId,
    filePath,
    bytes,
    preparedPdfJsDocument,
    captureViewState,
    installProxy,
    invalidateRevision,
    rebuildRequiredPages,
    restoreViewState,
    waitForEditReadiness,
    invalidateSemanticState,
    rebuildEditableMetadata,
    restartSemanticPreload,
    adoptDocumentGeneration,
    assertSynchronizationOwnership,
    changedPages,
    diagnostic,
  } = record;
  const assertOwned = (stage) => {
    if (typeof assertSynchronizationOwnership === 'function') {
      assertSynchronizationOwnership(stage);
    }
  };
  const viewState = record.viewState || await captureViewState(documentState);
  record.viewState = viewState;
  markDocumentSaveState(documentState, 'synchronizing', {
    requestId,
    synchronizationError: null,
  });
  diagnostic?.('synchronizing', { retry });
  try {
    assertOwned('before-synchronization');
    let installResult = record.installResult;
    if (!record.proxyInstalled) {
      throwIfSaveFaultInjected('before-proxy-install');
      throwIfSaveFaultInjected('proxy-install');
      installResult = await installProxy({
        documentState,
        filePath,
        bytes: bytes.slice(),
        preparedPdfJsDocument,
        viewState,
      });
      record.installResult = installResult || {};
      record.proxyInstalled = true;
      if (typeof adoptDocumentGeneration === 'function') {
        adoptDocumentGeneration(
          installResult?.lifecycleGeneration ?? documentState.lifecycleGeneration,
        );
      }
      assertOwned('after-proxy-install');
      markLivePdfRevision(documentState, requestedRevision);
    }
    throwIfSaveFaultInjected('after-proxy-install-before-view-restore');
    if (!record.viewRestored) {
      throwIfSaveFaultInjected('before-view-restore');
      await restoreViewState(documentState, viewState);
      assertOwned('after-view-state-restore');
      record.viewRestored = true;
    }
    if (!record.semanticInvalidated) {
      await invalidateSemanticState({
        documentState,
        requestedRevision,
        changedPages,
        filePath,
        previousFilePath: record.previousFilePath,
      });
      assertOwned('after-semantic-invalidation');
      record.semanticInvalidated = true;
    }
    throwIfSaveFaultInjected('before-required-page-recompute');
    let requiredPages = Array.isArray(installResult?.requiredPages)
      ? positivePages(installResult.requiredPages)
      : positivePages(null, viewState.pageNumber || documentState.currentPage);
    setVisibleRequiredPages(documentState, requiredPages);
    await invalidateRevision({ documentState, requestedRevision, requiredPages, viewState });
    assertOwned('after-revision-invalidation');
    clearPageEditReadiness(documentState, requiredPages);
    const readiness = await rebuildRequiredPages({
      documentState,
      requestedRevision,
      requiredPages,
      viewState,
      installResult: installResult || {},
    }) || {};
    assertOwned('after-required-page-rebuild');
    if (Array.isArray(readiness.requiredPages)) {
      requiredPages = positivePages(readiness.requiredPages);
      setVisibleRequiredPages(documentState, requiredPages);
    }
    const metadataReadyPages = await rebuildEditableMetadata({
      documentState,
      requestedRevision,
      requiredPages,
      changedPages,
      viewState,
    });
    assertOwned('after-editable-metadata-rebuild');
    for (const page of positivePages(readiness.renderReadyPages)) {
      if (requiredPages.includes(page)) {
        markPageRenderReady(
          documentState,
          page,
          documentState.revisionState?.pageContentRevisions?.[page] ?? requestedRevision,
        );
      }
    }
    for (const page of positivePages(readiness.semanticReadyPages)) {
      if (requiredPages.includes(page) && metadataReadyPages.includes(page)) {
        markPageSemanticReady(
          documentState,
          page,
          documentState.revisionState?.pageContentRevisions?.[page] ?? requestedRevision,
        );
      }
    }
    await restartSemanticPreload({
      documentState,
      requestedRevision,
      requiredPages,
      changedPages,
    });
    assertOwned('after-semantic-preload-restart');
    throwIfSaveFaultInjected('render-readiness');
    const ready = await waitForEditReadiness({
      documentState,
      requestedRevision,
      requiredPages,
      viewState,
    });
    assertOwned('after-edit-readiness');
    if (ready !== true) throw new Error('The saved document did not reach edit readiness');
    const synchronizedRevisions = initializeDocumentRevisionState(documentState);
    if (synchronizedRevisions.contentRevision === Number(requestedRevision)
        && synchronizedRevisions.persistedRevision === Number(requestedRevision)
        && synchronizedRevisions.livePdfRevision === Number(requestedRevision)) {
      synchronizedRevisions.pendingChangedPages = [];
      synchronizedRevisions.pendingStructuralChange = false;
    }
    markDocumentSaveState(documentState, 'saved', {
      requestId: null,
      synchronizationError: null,
    });
    diagnostic?.('saved', { retry, requiredPages });
    recoverableSynchronizations.delete(documentState.id);
    return { saved: true, synchronized: true, requiredPages };
  } catch (error) {
    if (error?.code === 'SAVE_REQUEST_SUPERSEDED') {
      if (!record.proxyInstalled) {
        try { await preparedPdfJsDocument?.destroy?.(); } catch {}
      }
      diagnostic?.('superseded', { retry, stage: error.stage || 'synchronization' });
      recoverableSynchronizations.delete(documentState.id);
      throw error;
    }
    const wrapped = error instanceof SavedDocumentSynchronizationError
      ? error
      : new SavedDocumentSynchronizationError(
        `The PDF is saved, but the editor refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    markDocumentSaveState(documentState, 'saved-refresh-failed', {
      requestId: null,
      synchronizationError: wrapped.message,
    });
    diagnostic?.('saved-refresh-failed', { retry, error: wrapped.message });
    recoverableSynchronizations.set(documentState.id, record);
    throw wrapped;
  }
}

export async function synchronizeSavedDocument(input) {
  const documentState = input?.documentState;
  if (!documentState?.id) throw new TypeError('A document owner is required');
  for (const name of [
    'captureViewState',
    'installProxy',
    'invalidateRevision',
    'rebuildRequiredPages',
    'restoreViewState',
    'waitForEditReadiness',
  ]) {
    if (typeof input[name] !== 'function') throw new TypeError(`${name} is required`);
  }
  const active = activeSynchronizations.get(documentState.id);
  if (active) return active.promise;
  const hold = deferred();
  const record = {
    ...input,
    bytes: input.bytes.slice(),
    proxyInstalled: false,
    installResult: null,
    viewState: null,
    viewRestored: false,
    semanticInvalidated: false,
    changedPages: input.changedPages !== undefined
      ? (input.changedPages === null ? null : positivePages(input.changedPages))
      : (initializeDocumentRevisionState(documentState).pendingChangedPages === null
        ? null
        : positivePages(initializeDocumentRevisionState(documentState).pendingChangedPages)),
    invalidateSemanticState: input.invalidateSemanticState
      || invalidateSavedDocumentDerivedState,
    rebuildEditableMetadata: input.rebuildEditableMetadata
      || rebuildSavedDocumentEditableMetadata,
    restartSemanticPreload: input.restartSemanticPreload
      || restartSavedDocumentSemanticPreload,
  };
  const promise = runSynchronization(record)
    .then((result) => {
      hold.resolve(true);
      return result;
    })
    .catch((error) => {
      hold.resolve(false);
      throw error;
    })
    .finally(() => {
      if (activeSynchronizations.get(documentState.id)?.promise === promise) {
        activeSynchronizations.delete(documentState.id);
      }
    });
  activeSynchronizations.set(documentState.id, { promise, editHold: hold.promise });
  return promise;
}

export async function retrySavedDocumentSynchronization(documentId, {
  requestId,
  diagnostic,
  adoptDocumentGeneration,
  assertSynchronizationOwnership,
} = {}) {
  const id = String(documentId || '');
  const active = activeSynchronizations.get(id);
  if (active) return active.promise;
  const record = recoverableSynchronizations.get(id);
  if (!record) throw new RangeError('No recoverable saved-document synchronization is available');
  if (requestId !== undefined) record.requestId = requestId;
  if (diagnostic !== undefined) record.diagnostic = diagnostic;
  if (adoptDocumentGeneration !== undefined) {
    record.adoptDocumentGeneration = adoptDocumentGeneration;
  }
  if (assertSynchronizationOwnership !== undefined) {
    record.assertSynchronizationOwnership = assertSynchronizationOwnership;
  }
  const hold = deferred();
  const promise = runSynchronization(record, { retry: true })
    .then((result) => {
      hold.resolve(true);
      return result;
    })
    .catch((error) => {
      hold.resolve(false);
      throw error;
    })
    .finally(() => {
      if (activeSynchronizations.get(id)?.promise === promise) activeSynchronizations.delete(id);
    });
  activeSynchronizations.set(id, { promise, editHold: hold.promise });
  return promise;
}

export function waitForSavedDocumentSynchronization(documentId) {
  return activeSynchronizations.get(String(documentId || ''))?.editHold || Promise.resolve(true);
}

export function hasRecoverableSavedDocumentSynchronization(documentId) {
  return recoverableSynchronizations.has(String(documentId || ''));
}

export function clearSavedDocumentSynchronization(documentId) {
  const id = String(documentId || '');
  activeSynchronizations.delete(id);
  return recoverableSynchronizations.delete(id);
}
