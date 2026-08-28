import {
  markDocumentSaveState,
  markLivePdfRevision,
  markPageRenderReady,
  markPageSemanticReady,
  setVisibleRequiredPages,
} from '../core/document-revision-state.runtime.js';

const activeSynchronizations = new Map();
const recoverableSynchronizations = new Map();

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
} = {}) {
  if (!documentState) throw new TypeError('A document is required to capture saved view state');
  const scale = Number(documentState.scale) || 1;
  const pageNumber = Math.max(1, Number(documentState.currentPage) || 1);
  let anchor = {
    pageNumber,
    point: {
      x: Math.max(0, Number(scrollContainer?.scrollLeft) || 0) / scale,
      y: Math.max(0, Number(scrollContainer?.scrollTop) || 0) / scale,
    },
  };
  const wrappers = scrollContainer?.querySelectorAll?.('.page-wrapper[data-page]') || [];
  for (const wrapper of wrappers) {
    const top = Number(wrapper.offsetTop) || 0;
    const height = Number(wrapper.offsetHeight) || 0;
    const scrollTop = Number(scrollContainer.scrollTop) || 0;
    if (scrollTop < top || scrollTop >= top + Math.max(1, height)) continue;
    anchor = {
      pageNumber: Math.max(1, Number(wrapper.dataset?.page) || pageNumber),
      point: {
        x: Math.max(0, (Number(scrollContainer.scrollLeft) || 0) - (Number(wrapper.offsetLeft) || 0)) / scale,
        y: Math.max(0, scrollTop - top) / scale,
      },
    };
    break;
  }
  return Object.freeze({
    pageNumber,
    viewMode: documentState.viewMode || 'single',
    bookSpread: documentState.bookSpread === true,
    facingSpread: documentState.facingSpread === true,
    scale,
    pageRotations: Object.freeze({ ...(documentState.pageRotations || {}) }),
    scrollPosition: Object.freeze({
      x: Math.max(0, Number(scrollContainer?.scrollLeft ?? documentState.scrollPosition?.x) || 0),
      y: Math.max(0, Number(scrollContainer?.scrollTop ?? documentState.scrollPosition?.y) || 0),
    }),
    anchor: Object.freeze({
      pageNumber: anchor.pageNumber,
      point: Object.freeze({ ...anchor.point }),
    }),
    activeTool: appState?.currentTool || null,
    selectedAnnotationIds: Object.freeze(
      (documentState.selectedAnnotations || []).map((annotation) => String(annotation.id)),
    ),
    panelState,
    search: cloneSearchState(appState?.search),
  });
}

export function restoreSavedDocumentViewState(documentState, snapshot, {
  appState = null,
  scrollContainer = null,
  restorePanelState = null,
} = {}) {
  if (!documentState || !snapshot) return false;
  const pageCount = Math.max(1, Number(documentState.pdfDoc?.numPages) || 1);
  documentState.currentPage = Math.min(pageCount, Math.max(1, Number(snapshot.pageNumber) || 1));
  documentState.viewMode = snapshot.viewMode === 'continuous' ? 'continuous' : 'single';
  documentState.bookSpread = snapshot.bookSpread === true;
  documentState.facingSpread = snapshot.facingSpread === true;
  documentState.scale = Math.max(0.05, Number(snapshot.scale) || 1);
  documentState.pageRotations = { ...(snapshot.pageRotations || {}) };
  const byId = new Map((documentState.annotations || []).map((annotation) => [String(annotation.id), annotation]));
  documentState.selectedAnnotations = (snapshot.selectedAnnotationIds || [])
    .map((id) => byId.get(String(id)))
    .filter(Boolean);
  documentState.selectedAnnotation = documentState.selectedAnnotations[0] || null;
  documentState.scrollPosition = { ...snapshot.scrollPosition };
  if (appState && snapshot.activeTool) appState.currentTool = snapshot.activeTool;
  if (appState?.search && snapshot.search) {
    Object.assign(appState.search, snapshot.search, {
      results: [],
      currentIndex: -1,
      totalMatches: 0,
      isSearching: false,
    });
  }
  if (typeof restorePanelState === 'function') restorePanelState(snapshot.panelState);
  if (scrollContainer) {
    const wrapper = scrollContainer.querySelector?.(
      `.page-wrapper[data-page="${snapshot.anchor?.pageNumber}"]`,
    );
    if (wrapper) {
      scrollContainer.scrollLeft = Math.max(0,
        (Number(wrapper.offsetLeft) || 0) + (Number(snapshot.anchor.point.x) || 0) * documentState.scale);
      scrollContainer.scrollTop = Math.max(0,
        (Number(wrapper.offsetTop) || 0) + (Number(snapshot.anchor.point.y) || 0) * documentState.scale);
    } else {
      scrollContainer.scrollLeft = snapshot.scrollPosition.x;
      scrollContainer.scrollTop = snapshot.scrollPosition.y;
    }
  }
  return true;
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
    diagnostic,
  } = record;
  const viewState = record.viewState || captureViewState(documentState);
  record.viewState = viewState;
  markDocumentSaveState(documentState, 'synchronizing', {
    requestId,
    synchronizationError: null,
  });
  diagnostic?.('synchronizing', { retry });
  try {
    let installResult = record.installResult;
    if (!record.proxyInstalled) {
      installResult = await installProxy({
        documentState,
        filePath,
        bytes: bytes.slice(),
        preparedPdfJsDocument,
        viewState,
      });
      record.installResult = installResult || {};
      record.proxyInstalled = true;
      markLivePdfRevision(documentState, requestedRevision);
    }
    const requiredPages = Array.isArray(installResult?.requiredPages)
      ? positivePages(installResult.requiredPages)
      : positivePages(null, viewState.pageNumber || documentState.currentPage);
    setVisibleRequiredPages(documentState, requiredPages);
    await invalidateRevision({ documentState, requestedRevision, requiredPages, viewState });
    const readiness = await rebuildRequiredPages({
      documentState,
      requestedRevision,
      requiredPages,
      viewState,
      installResult: installResult || {},
    }) || {};
    for (const page of positivePages(readiness.renderReadyPages)) {
      if (requiredPages.includes(page)) markPageRenderReady(documentState, page, requestedRevision);
    }
    for (const page of positivePages(readiness.semanticReadyPages)) {
      if (requiredPages.includes(page)) markPageSemanticReady(documentState, page, requestedRevision);
    }
    await restoreViewState(documentState, viewState);
    const ready = await waitForEditReadiness({
      documentState,
      requestedRevision,
      requiredPages,
      viewState,
    });
    if (ready !== true) throw new Error('The saved document did not reach edit readiness');
    markDocumentSaveState(documentState, 'saved', {
      requestId: null,
      synchronizationError: null,
    });
    diagnostic?.('saved', { retry, requiredPages });
    recoverableSynchronizations.delete(documentState.id);
    return { saved: true, synchronized: true, requiredPages };
  } catch (error) {
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
} = {}) {
  const id = String(documentId || '');
  const active = activeSynchronizations.get(id);
  if (active) return active.promise;
  const record = recoverableSynchronizations.get(id);
  if (!record) throw new RangeError('No recoverable saved-document synchronization is available');
  if (requestId !== undefined) record.requestId = requestId;
  if (diagnostic !== undefined) record.diagnostic = diagnostic;
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
