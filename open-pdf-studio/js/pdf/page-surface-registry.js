let nextMountGeneration = 0;
const surfacesByPage = new Map();
let surfaceByContainer = new WeakMap();
const listeners = new Set();

function nonNegativeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function positivePage(value) {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new TypeError('A page surface requires a positive page number');
  }
  return page;
}

function positiveNumber(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function pageRevision(documentState, pageNum) {
  return nonNegativeRevision(
    documentState?.revisionState?.pageContentRevisions?.[pageNum]
      ?? documentState?.pageRenderRevisions?.[pageNum]
      ?? documentState?.revisionState?.contentRevision,
  );
}

function pageKey(documentId, lifecycleGeneration, pageNum) {
  return `${String(documentId)}:${nonNegativeRevision(lifecycleGeneration)}:${positivePage(pageNum)}`;
}

function currentPageKey(documentState, pageNum) {
  if (!documentState?.id) throw new TypeError('A page surface requires a document owner');
  return pageKey(documentState.id, documentState.lifecycleGeneration, pageNum);
}

function normalizedDimensions(value, prior = null) {
  const width = Number(value?.width ?? value?.widthPt ?? prior?.width);
  const height = Number(value?.height ?? value?.heightPt ?? prior?.height);
  if (!(width > 0) || !(height > 0)) return prior;
  return Object.freeze({ width, height });
}

function supplied(input, key, prior = null) {
  return Object.prototype.hasOwnProperty.call(input, key) ? input[key] : prior;
}

function connected(surface) {
  return surface?.container?.isConnected !== false
    && surface?.baseSurface?.isConnected !== false
    && surface?.overlayCanvas?.isConnected !== false
    && surface?.textLayer?.isConnected !== false;
}

function newestConnectedTextLayer(published, registered) {
  if (!published || published.isConnected === false) return registered ?? null;
  if (!registered || registered.isConnected === false || registered === published) return published;
  const publishedRequest = nonNegativeRevision(published.dataset?.textLayerRequest);
  const registeredRequest = nonNegativeRevision(registered.dataset?.textLayerRequest);
  return registeredRequest > publishedRequest ? registered : published;
}

function emit(type, surface) {
  const event = Object.freeze({ type, surface });
  for (const listener of [...listeners]) {
    try { listener(event); } catch (error) {
      console.warn('[page-surface] Registry listener failed:', error);
    }
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
      && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(`opds:page-surface-${type}`, {
      detail: Object.freeze({
        documentId: surface.documentId,
        lifecycleGeneration: surface.lifecycleGeneration,
        pageNum: surface.pageNum,
        pageContentRevision: surface.pageContentRevision,
        mountGeneration: surface.mountGeneration,
        surfaceKind: surface.surfaceKind,
      }),
    }));
  }
}

function removeCurrent(surface, { emitEvent = true } = {}) {
  if (!surface) return false;
  const registrations = surfacesByPage.get(surface._pageKey);
  if (registrations?.get(surface.mountGeneration)?._surfaceId !== surface._surfaceId) return false;
  registrations.delete(surface.mountGeneration);
  if (registrations.size === 0) surfacesByPage.delete(surface._pageKey);
  if (surface.container && surfaceByContainer.get(surface.container)?._surfaceId === surface._surfaceId) {
    surfaceByContainer.delete(surface.container);
  }
  if (emitEvent) emit('unregistered', surface);
  return true;
}

function surfaceRecord(input, previous = null) {
  const documentState = input.documentState;
  const pageNum = positivePage(input.pageNum ?? previous?.pageNum);
  if (!documentState?.id) throw new TypeError('A page surface requires a document owner');
  const lifecycleGeneration = nonNegativeRevision(documentState.lifecycleGeneration);
  const key = pageKey(documentState.id, lifecycleGeneration, pageNum);
  const requestedMountGeneration = nonNegativeRevision(input.mountGeneration);
  const mountGeneration = previous?.mountGeneration
    ?? (requestedMountGeneration > 0 ? requestedMountGeneration : ++nextMountGeneration);
  const contentRevision = input.pageContentRevision == null
    ? pageRevision(documentState, pageNum)
    : nonNegativeRevision(input.pageContentRevision);
  const proxyPublishedRevision = Math.min(
    contentRevision,
    nonNegativeRevision(documentState.revisionState?.livePdfRevision),
  );
  const surfaceKind = String(input.surfaceKind || previous?.surfaceKind || 'page-surface');
  const container = input.container ?? previous?.container ?? null;
  const record = {
    _pageKey: key,
    _surfaceId: previous?._surfaceId
      || `${key}:${mountGeneration.toString(36)}`,
    documentId: String(documentState.id),
    lifecycleGeneration,
    pageNum,
    pageContentRevision: contentRevision,
    basePublishedRevision: input.basePublishedRevision == null
      ? nonNegativeRevision(previous?.basePublishedRevision ?? proxyPublishedRevision)
      : nonNegativeRevision(input.basePublishedRevision),
    semanticPublishedRevision: input.semanticPublishedRevision == null
      ? nonNegativeRevision(previous?.semanticPublishedRevision ?? proxyPublishedRevision)
      : nonNegativeRevision(input.semanticPublishedRevision),
    surfaceKind,
    container,
    baseSurface: supplied(input, 'baseSurface', previous?.baseSurface ?? null),
    geometryCanvas: supplied(input, 'geometryCanvas', previous?.geometryCanvas ?? null),
    overlayCanvas: supplied(input, 'overlayCanvas', previous?.overlayCanvas ?? null),
    textLayer: supplied(input, 'textLayer', previous?.textLayer ?? null),
    canonicalPageDimensions: normalizedDimensions(
      input.canonicalPageDimensions,
      previous?.canonicalPageDimensions,
    ),
    cssScale: positiveNumber(input.cssScale, previous?.cssScale || 1),
    dpr: positiveNumber(input.dpr, previous?.dpr || 1),
    mountGeneration,
  };
  return Object.freeze(record);
}

/** Register or update one mounted page-local render/semantic surface. */
export function registerPageSurface(input = {}) {
  const existingForContainer = input.container && surfaceByContainer.get(input.container);
  const requestedKey = currentPageKey(input.documentState, input.pageNum);
  const previous = existingForContainer?._pageKey === requestedKey
    ? existingForContainer : null;
  if (existingForContainer && !previous) removeCurrent(existingForContainer);
  const record = surfaceRecord(input, previous);
  let registrations = surfacesByPage.get(record._pageKey);
  if (!registrations) {
    registrations = new Map();
    surfacesByPage.set(record._pageKey, registrations);
  }
  registrations.set(record.mountGeneration, record);
  if (record.container) surfaceByContainer.set(record.container, record);
  if (record.container?.dataset) {
    record.container.dataset.pageSurfaceMount = String(record.mountGeneration);
    record.container.dataset.documentId = record.documentId;
    record.container.dataset.documentGeneration = String(record.lifecycleGeneration);
    record.container.dataset.page = String(record.pageNum);
    record.container.dataset.pageContentRevision = String(record.pageContentRevision);
    if (record.pageContentRevision >= pageRevision(input.documentState, record.pageNum)) {
      delete record.container.dataset.staleDisplayRevision;
    }
  }
  emit(previous ? 'updated' : 'registered', record);
  return record;
}

/** Resolve only a connected surface owned by this exact document lifecycle/page. */
export function resolvePageSurface(documentState, pageNum, { targetRevision = null } = {}) {
  if (!documentState?.id) return null;
  const page = positivePage(pageNum);
  const registrations = surfacesByPage.get(currentPageKey(documentState, page));
  if (!registrations) return null;
  const target = targetRevision == null ? pageRevision(documentState, page)
    : nonNegativeRevision(targetRevision);
  return [...registrations.values()]
    .filter((surface) => connected(surface) && surface.pageContentRevision <= target)
    .sort((left, right) => right.mountGeneration - left.mountGeneration)[0] || null;
}

/** Restamp the exact live mount after base and/or semantic publication. */
export function markPageSurfacePublication(surface, {
  documentState,
  revision,
  basePublished = false,
  semanticPublished = false,
  baseSurface,
  geometryCanvas,
  overlayCanvas,
  textLayer,
  surfaceKind,
} = {}) {
  if (!surface || !documentState?.id) return false;
  const currentRevision = pageRevision(documentState, surface.pageNum);
  const publishedRevision = nonNegativeRevision(revision);
  if (String(documentState.id) !== surface.documentId
      || nonNegativeRevision(documentState.lifecycleGeneration) !== surface.lifecycleGeneration
      || currentRevision !== publishedRevision) return false;
  const registrations = surfacesByPage.get(surface._pageKey);
  const live = registrations?.get(surface.mountGeneration);
  if (!live || live._surfaceId !== surface._surfaceId || !connected(live)) return false;
  registerPageSurface({
    documentState,
    pageNum: surface.pageNum,
    pageContentRevision: publishedRevision,
    surfaceKind: surfaceKind || live.surfaceKind,
    container: live.container,
    baseSurface: baseSurface ?? live.baseSurface,
    geometryCanvas: geometryCanvas ?? live.geometryCanvas,
    overlayCanvas: overlayCanvas ?? live.overlayCanvas,
    // A later text-layer request can register while an older publication is
    // awaiting its final raster/semantic barrier. Never let that older
    // acknowledgement replace the newer connected layer with a detached or
    // lower-request-generation node.
    textLayer: newestConnectedTextLayer(textLayer, live.textLayer),
    canonicalPageDimensions: live.canonicalPageDimensions,
    cssScale: live.cssScale,
    dpr: live.dpr,
    basePublishedRevision: basePublished ? publishedRevision : live.basePublishedRevision,
    semanticPublishedRevision: semanticPublished
      ? publishedRevision : live.semanticPublishedRevision,
  });
  return true;
}

export function unregisterPageSurface(surfaceOrContainer) {
  const surface = surfaceOrContainer?._surfaceId
    ? surfaceOrContainer : surfaceByContainer.get(surfaceOrContainer);
  return removeCurrent(surface);
}

export function subscribePageSurfaceRegistry(listener) {
  if (typeof listener !== 'function') throw new TypeError('A page-surface listener is required');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolve the exact registered surface containing one page-local DOM node. */
export function resolvePageSurfaceForElement(element, documentState = null) {
  let current = element || null;
  while (current) {
    const surface = surfaceByContainer.get(current);
    if (surface && connected(surface)
        && (!documentState
          || (surface.documentId === String(documentState.id)
            && surface.lifecycleGeneration
              === (Number(documentState.lifecycleGeneration) || 0)))) return surface;
    current = current.parentElement || null;
  }
  return null;
}

/** Enumerate connected mounted surfaces without querying arbitrary DOM layers. */
export function mountedPageSurfaces(documentState = null) {
  return Object.freeze([...surfacesByPage.values()]
    .flatMap((registrations) => [...registrations.values()])
    .filter((surface) => connected(surface)
      && (!documentState
        || (surface.documentId === String(documentState.id)
          && surface.lifecycleGeneration
            === (Number(documentState.lifecycleGeneration) || 0))))
    .sort((left, right) => left.pageNum - right.pageNum
      || left.mountGeneration - right.mountGeneration));
}

/**
 * Rebind connected same-document surfaces to a validated replacement proxy.
 * Their published revision is intentionally preserved, so a changed page is
 * stale-but-displayable until the replacement surface publishes atomically.
 */
export function adoptPageSurfacesForDocumentLifecycle(documentState) {
  if (!documentState?.id) return Object.freeze([]);
  const documentId = String(documentState.id);
  const generation = nonNegativeRevision(documentState.lifecycleGeneration);
  const candidates = [...surfacesByPage.values()]
    .flatMap((registrations) => [...registrations.values()])
    .filter((surface) => connected(surface)
      && surface.documentId === documentId
      && surface.lifecycleGeneration !== generation);
  const adopted = [];
  for (const surface of candidates) {
    const next = registerPageSurface({
      documentState,
      pageNum: surface.pageNum,
      pageContentRevision: surface.pageContentRevision,
      basePublishedRevision: surface.basePublishedRevision,
      semanticPublishedRevision: surface.semanticPublishedRevision,
      surfaceKind: surface.surfaceKind,
      container: surface.container,
      baseSurface: surface.baseSurface,
      geometryCanvas: surface.geometryCanvas,
      overlayCanvas: surface.overlayCanvas,
      textLayer: surface.textLayer,
      canonicalPageDimensions: surface.canonicalPageDimensions,
      cssScale: surface.cssScale,
      dpr: surface.dpr,
    });
    if (next.container?.dataset) {
      const targetRevision = pageRevision(documentState, next.pageNum);
      next.container.dataset.staleDisplayRevision = next.pageContentRevision < targetRevision
        ? String(next.pageContentRevision) : '';
    }
    adopted.push(next);
  }
  return Object.freeze(adopted);
}

function elementDebugState(element) {
  if (!element) return null;
  return Object.freeze({
    tagName: String(element.tagName || '').toLowerCase() || null,
    id: String(element.id || '') || null,
    className: typeof element.className === 'string' ? element.className : null,
    connected: element.isConnected !== false,
  });
}

export function pageSurfaceRegistrySnapshot(documentState = null) {
  const ownerId = documentState?.id == null ? null : String(documentState.id);
  const ownerGeneration = documentState == null
    ? null : nonNegativeRevision(documentState.lifecycleGeneration);
  return Object.freeze([...surfacesByPage.values()]
    .flatMap((registrations) => [...registrations.values()])
    .filter((surface) => ownerId == null || (
      surface.documentId === ownerId
      && surface.lifecycleGeneration === ownerGeneration
    ))
    .sort((left, right) => left.pageNum - right.pageNum
      || left.mountGeneration - right.mountGeneration)
    .map((surface) => Object.freeze({
      documentId: surface.documentId,
      lifecycleGeneration: surface.lifecycleGeneration,
      pageNum: surface.pageNum,
      pageContentRevision: surface.pageContentRevision,
      basePublishedRevision: surface.basePublishedRevision,
      semanticPublishedRevision: surface.semanticPublishedRevision,
      surfaceKind: surface.surfaceKind,
      mountGeneration: surface.mountGeneration,
      connected: connected(surface),
      container: elementDebugState(surface.container),
      baseSurface: elementDebugState(surface.baseSurface),
      geometryCanvas: elementDebugState(surface.geometryCanvas),
      overlayCanvas: elementDebugState(surface.overlayCanvas),
      textLayer: elementDebugState(surface.textLayer),
    })));
}

export function clearPageSurfaceRegistryForTests() {
  surfacesByPage.clear();
  surfaceByContainer = new WeakMap();
  nextMountGeneration = 0;
  listeners.clear();
}
