export const PAGE_EDIT_READY_LAYERS = Object.freeze([
  'raster',
  'annotations',
  'text',
  'links',
  'forms',
  'editableMetadata',
]);

function pageNumber(value) {
  const page = Number(value);
  if (!Number.isInteger(page) || page <= 0) throw new TypeError('Page readiness requires a positive page');
  return page;
}

function contentRevision(documentState) {
  return Number(documentState?.revisionState?.contentRevision) || 0;
}

function pageRevision(documentState, pageNum) {
  return Number(documentState?.revisionState?.pageContentRevisions?.[pageNum]
    ?? documentState?.pageRenderRevisions?.[pageNum]
    ?? documentState?.revisionState?.contentRevision) || 0;
}

export function capturePageEditReadinessIdentity(documentState, pageNum) {
  const page = pageNumber(pageNum);
  if (!documentState?.id || !documentState.pdfDoc) {
    throw new TypeError('Page readiness requires a live document');
  }
  return Object.freeze({
    documentId: String(documentState.id),
    pdfDocument: documentState.pdfDoc,
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    contentRevision: contentRevision(documentState),
    pageRevision: pageRevision(documentState, page),
    livePdfRevision: Number(documentState.revisionState?.livePdfRevision) || 0,
    pageNum: page,
  });
}

function identityMatchesDocument(identity, documentState) {
  if (!identity || !documentState) return false;
  return identity.documentId === String(documentState.id)
    && identity.lifecycleGeneration === (Number(documentState.lifecycleGeneration) || 0)
    && identity.contentRevision === contentRevision(documentState)
    && identity.pageRevision === pageRevision(documentState, identity.pageNum);
}

function tokenMatchesIdentity(token, identity) {
  const ownerRevisionMatches = Boolean(token
    && token.documentId === identity.documentId
    && token.lifecycleGeneration === identity.lifecycleGeneration
    && token.contentRevision === identity.contentRevision
    && token.pageRevision === identity.pageRevision
    && token.pageNum === identity.pageNum);
  if (!ownerRevisionMatches) return false;
  if (token.revisionAuthority === 'model') return true;
  return token.pdfDocument === identity.pdfDocument
    && token.livePdfRevision === identity.livePdfRevision;
}

function readinessMap(documentState) {
  if (!documentState.pageEditReadiness || typeof documentState.pageEditReadiness !== 'object') {
    documentState.pageEditReadiness = {};
  }
  return documentState.pageEditReadiness;
}

function currentEntry(documentState, pageNum, { create = false } = {}) {
  const page = pageNumber(pageNum);
  const map = readinessMap(documentState);
  const existing = map[page];
  if (existing && identityMatchesDocument(existing.identity, documentState)) return existing;
  if (!create) return null;
  const entry = {
    identity: capturePageEditReadinessIdentity(documentState, page),
    layers: {},
    failure: null,
  };
  map[page] = entry;
  return map[page] || entry;
}

function dispatchReadinessEvent(type, detail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function'
      || typeof CustomEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function detailFor(entry) {
  return Object.freeze({
    ...entry.identity,
    pdfDocument: undefined,
    layers: Object.freeze({ ...entry.layers }),
    failure: entry.failure,
    ready: !entry.failure
      && PAGE_EDIT_READY_LAYERS.every(
        (layer) => Number(entry.layers[layer]) >= entry.identity.pageRevision,
      ),
  });
}

export function clearPageEditReadiness(documentState, pages = null) {
  if (!documentState) return false;
  const map = readinessMap(documentState);
  if (pages === null) {
    documentState.pageEditReadiness = {};
  } else {
    for (const page of pages) delete map[pageNumber(page)];
  }
  dispatchReadinessEvent('opds:page-edit-readiness-cleared', {
    documentId: String(documentState.id || ''),
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    contentRevision: contentRevision(documentState),
    pages: pages === null ? null : [...new Set(pages.map(pageNumber))],
  });
  return true;
}

/** Restamp ready unchanged pages after a validated same-document proxy swap. */
export function adoptPageEditReadinessForDocumentLifecycle(documentState, changedPages = []) {
  if (!documentState?.id || !documentState.pdfDoc) return [];
  const changed = new Set((changedPages || []).map(Number));
  const map = readinessMap(documentState);
  const adopted = [];
  for (const [pageText, entry] of Object.entries(map)) {
    const pageNum = Number(pageText);
    if (changed.has(pageNum) || !entry?.identity) continue;
    const nextIdentity = capturePageEditReadinessIdentity(documentState, pageNum);
    if (Number(entry.identity.pageRevision) !== nextIdentity.pageRevision) continue;
    entry.identity = nextIdentity;
    adopted.push(pageNum);
  }
  return adopted.sort((left, right) => left - right);
}

export function markPageEditLayerReady(documentState, pageNum, layer, publicationToken) {
  if (!PAGE_EDIT_READY_LAYERS.includes(layer)) throw new TypeError(`Unsupported readiness layer: ${layer}`);
  const identity = capturePageEditReadinessIdentity(documentState, pageNum);
  if (!tokenMatchesIdentity(publicationToken, identity)) return false;
  const entry = currentEntry(documentState, pageNum, { create: true });
  if (!entry || !identityMatchesDocument(entry.identity, documentState)) return false;
  const publishedRevision = Number(publicationToken.publishedPageRevision
    ?? publicationToken.pageRevision) || 0;
  if (publishedRevision > identity.pageRevision) return false;
  entry.layers[layer] = Math.max(Number(entry.layers[layer]) || 0, publishedRevision);
  const detail = detailFor(entry);
  dispatchReadinessEvent('opds:page-edit-readiness', detail);
  if (detail.ready) dispatchReadinessEvent('opds:page-edit-ready', detail);
  return true;
}

export function failPageEditReadiness(documentState, pageNum, reason, publicationToken) {
  const identity = capturePageEditReadinessIdentity(documentState, pageNum);
  if (!tokenMatchesIdentity(publicationToken, identity)) return false;
  const entry = currentEntry(documentState, pageNum, { create: true });
  entry.failure = String(reason || 'page-edit-readiness-failed');
  dispatchReadinessEvent('opds:page-edit-readiness-failed', detailFor(entry));
  return true;
}

export function pageEditReadinessSatisfied(
  documentState,
  pageNum,
  { requiredLayers = PAGE_EDIT_READY_LAYERS } = {},
) {
  const entry = currentEntry(documentState, pageNum);
  return Boolean(entry
    && !entry.failure
    && requiredLayers.every(
      (layer) => Number(entry.layers[layer]) >= entry.identity.pageRevision,
    ));
}

export function pageEditReadinessSnapshot(documentState, pageNum) {
  const entry = currentEntry(documentState, pageNum);
  return entry ? detailFor(entry) : null;
}

export function awaitPageEditReady(
  documentState,
  pageNum,
  { requiredLayers = PAGE_EDIT_READY_LAYERS, signal = null } = {},
) {
  const page = pageNumber(pageNum);
  const expected = capturePageEditReadinessIdentity(documentState, page);
  const initialSnapshot = pageEditReadinessSnapshot(documentState, page);
  if (initialSnapshot?.failure) return Promise.reject(new Error(initialSnapshot.failure));
  if (pageEditReadinessSatisfied(documentState, page, { requiredLayers })) {
    return Promise.resolve(initialSnapshot);
  }
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return Promise.reject(new Error('Page readiness events are unavailable'));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('opds:page-edit-readiness', inspect);
      window.removeEventListener('opds:page-edit-readiness-failed', inspect);
      window.removeEventListener('opds:page-edit-readiness-cleared', inspectRevision);
      window.removeEventListener('opds:document-lifecycle-changed', inspectLifecycle);
      signal?.removeEventListener?.('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason || new DOMException('Page edit readiness was cancelled', 'AbortError'));
    };
    const inspectLifecycle = (event) => {
      if (event.detail?.documentId !== expected.documentId) return;
      if (event.detail?.lifecycleGeneration === expected.lifecycleGeneration) return;
      cleanup();
      reject(new DOMException('Document lifecycle changed before page edit readiness', 'AbortError'));
    };
    const inspectRevision = (event) => {
      if (event.detail?.documentId !== expected.documentId) return;
      const affectedPages = event.detail?.pages;
      if (Array.isArray(affectedPages) && !affectedPages.includes(page)) return;
      if (identityMatchesDocument(expected, documentState)) return;
      cleanup();
      reject(new DOMException('Document revision changed before page edit readiness', 'AbortError'));
    };
    const inspect = (event) => {
      const detail = event.detail;
      if (detail?.documentId !== expected.documentId || detail?.pageNum !== page) return;
      if (!identityMatchesDocument(expected, documentState)) return inspectLifecycle({
        detail: {
          documentId: expected.documentId,
          lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
        },
      });
      const entry = currentEntry(documentState, page);
      if (entry?.failure) {
        cleanup();
        reject(new Error(entry.failure));
        return;
      }
      if (!pageEditReadinessSatisfied(documentState, page, { requiredLayers })) return;
      cleanup();
      resolve(pageEditReadinessSnapshot(documentState, page));
    };
    window.addEventListener('opds:page-edit-readiness', inspect);
    window.addEventListener('opds:page-edit-readiness-failed', inspect);
    window.addEventListener('opds:page-edit-readiness-cleared', inspectRevision);
    window.addEventListener('opds:document-lifecycle-changed', inspectLifecycle);
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else inspect({ detail: pageEditReadinessSnapshot(documentState, page) });
  });
}
