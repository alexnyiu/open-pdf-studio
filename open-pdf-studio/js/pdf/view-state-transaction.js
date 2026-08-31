export const VIEW_STATE_FIELDS = Object.freeze([
  'page',
  'mode',
  'spread',
  'zoom',
  'pan',
  'scroll',
  'rotation',
  'tool',
  'selection',
  'panels',
  'search',
]);

const VIEW_STATE_FIELD_SET = new Set(VIEW_STATE_FIELDS);
const SHARED_UI_FIELDS = new Set(['pan', 'scroll', 'tool', 'selection', 'panels', 'search']);

export function resolveViewportFitAction({
  fitPolicy = 'auto',
  logicalDocumentChanged = false,
  rotationChanged = false,
} = {}) {
  if (!['auto', 'initial', 'preserve', 'rotation'].includes(fitPolicy)) {
    throw new TypeError(`Unsupported viewport fit policy: ${fitPolicy}`);
  }
  if (fitPolicy === 'preserve') return 'preserve';
  if (fitPolicy === 'initial') return 'initial';
  if (fitPolicy === 'rotation') return 'rotation';
  if (logicalDocumentChanged) return 'initial';
  if (rotationChanged) return 'rotation';
  return 'preserve';
}

function immutableClone(value) {
  if (value == null || typeof value !== 'object') return value;
  const clone = typeof structuredClone === 'function'
    ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const freeze = (item) => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(clone);
}

export function initializeDocumentViewMutationState(documentState) {
  if (!documentState?.id) throw new TypeError('A document owner is required');
  const existing = documentState.viewMutationState;
  if (existing && typeof existing === 'object'
      && existing.fields && typeof existing.fields === 'object') return existing;
  const fields = Object.fromEntries(VIEW_STATE_FIELDS.map((field) => [field, 0]));
  documentState.viewMutationState = {
    userRevision: 0,
    activationRevision: 0,
    fields,
  };
  return documentState.viewMutationState;
}

export function noteDocumentViewMutation(
  documentState,
  fields,
  { origin = 'user' } = {},
) {
  if (!documentState?.id) return 0;
  const state = initializeDocumentViewMutationState(documentState);
  if (origin !== 'user') return state.userRevision;
  const names = [...new Set(Array.isArray(fields) ? fields : [fields])];
  for (const field of names) {
    if (!VIEW_STATE_FIELD_SET.has(field)) throw new TypeError(`Unsupported view field: ${field}`);
  }
  state.userRevision += 1;
  for (const field of names) state.fields[field] = state.userRevision;
  return state.userRevision;
}

export function noteDocumentViewActivation(documentState) {
  const state = initializeDocumentViewMutationState(documentState);
  state.activationRevision += 1;
  return state.activationRevision;
}

export function captureSharedUiLease(documentState) {
  const state = initializeDocumentViewMutationState(documentState);
  return Object.freeze({
    documentId: String(documentState.id),
    activationRevision: state.activationRevision,
  });
}

export function captureSinglePageViewportState({
  documentId,
  pageNum,
  rotation = 0,
  zoom,
  offsetX,
  offsetY,
  canvasWidth,
  canvasHeight,
  viewportRevision = 0,
} = {}) {
  const scale = Number(zoom);
  const width = Number(canvasWidth);
  const height = Number(canvasHeight);
  if (!String(documentId || '') || !Number.isSafeInteger(Number(pageNum))
      || !(scale > 0) || !(width > 0) || !(height > 0)) {
    throw new TypeError('Complete single-page viewport state is required');
  }
  const screenPoint = Object.freeze({ x: width / 2, y: height / 2 });
  const pdfPoint = Object.freeze({
    x: (screenPoint.x - (Number(offsetX) || 0)) / scale,
    y: (screenPoint.y - (Number(offsetY) || 0)) / scale,
  });
  return Object.freeze({
    kind: 'single-viewport',
    documentId: String(documentId),
    pageNum: Number(pageNum),
    rotation: Number(rotation) || 0,
    zoom: scale,
    offsetX: Number(offsetX) || 0,
    offsetY: Number(offsetY) || 0,
    canvasWidth: width,
    canvasHeight: height,
    viewportRevision: Number(viewportRevision) || 0,
    anchor: Object.freeze({ screenPoint, pdfPoint }),
  });
}

export function restoreSinglePageViewportState(snapshot, {
  canvasWidth,
  canvasHeight,
  currentZoom,
  currentOffsetX,
  currentOffsetY,
  restoreZoom = true,
  restorePan = true,
} = {}) {
  if (snapshot?.kind !== 'single-viewport') throw new TypeError('Single-page snapshot is required');
  const width = Number(canvasWidth);
  const height = Number(canvasHeight);
  if (!(width > 0) || !(height > 0)) throw new TypeError('Current canvas dimensions are required');
  const zoom = restoreZoom ? snapshot.zoom : Number(currentZoom) || snapshot.zoom;
  const screenPoint = { x: width / 2, y: height / 2 };
  return Object.freeze({
    zoom,
    offsetX: restorePan
      ? screenPoint.x - snapshot.anchor.pdfPoint.x * zoom
      : Number(currentOffsetX) || 0,
    offsetY: restorePan
      ? screenPoint.y - snapshot.anchor.pdfPoint.y * zoom
      : Number(currentOffsetY) || 0,
    anchor: Object.freeze({
      screenPoint: Object.freeze(screenPoint),
      pdfPoint: snapshot.anchor.pdfPoint,
    }),
  });
}

export function captureContinuousRendererState({
  documentId,
  pageNum,
  scale,
  layout = 'continuous',
  pageRect,
  scrollLeft,
  scrollTop,
  viewportWidth,
  viewportHeight,
  horizontalOffsetPx = 0,
  verticalOffsetPx = 0,
  viewportRevision = 0,
} = {}) {
  const normalizedScale = Number(scale);
  const rect = pageRect || null;
  if (!String(documentId || '') || !Number.isSafeInteger(Number(pageNum))
      || !(normalizedScale > 0) || !rect) {
    throw new TypeError('Complete continuous renderer state is required');
  }
  const anchorViewportX = Math.max(0, Number(viewportWidth) || 0) / 2;
  const anchorViewportY = Math.max(0, Number(viewportHeight) || 0) / 2;
  const pageX = (Number(rect.x) || 0) + (Number(horizontalOffsetPx) || 0);
  const pageY = (Number(rect.y) || 0) + (Number(verticalOffsetPx) || 0);
  const normalizedViewportWidth = Math.max(0, Number(viewportWidth) || 0);
  const normalizedViewportHeight = Math.max(0, Number(viewportHeight) || 0);
  return Object.freeze({
    kind: 'continuous-renderer',
    documentId: String(documentId),
    pageNum: Number(pageNum),
    scale: normalizedScale,
    layout: String(layout || 'continuous'),
    viewportRevision: Number(viewportRevision) || 0,
    exactRepresentation: Object.freeze({
      pageRect: Object.freeze({
        x: Number(rect.x) || 0,
        y: Number(rect.y) || 0,
        width: Number(rect.width) || 0,
        height: Number(rect.height) || 0,
      }),
      horizontalOffsetPx: Number(horizontalOffsetPx) || 0,
      verticalOffsetPx: Number(verticalOffsetPx) || 0,
      viewportWidth: normalizedViewportWidth,
      viewportHeight: normalizedViewportHeight,
      scrollLeft: Math.max(0, Number(scrollLeft) || 0),
      scrollTop: Math.max(0, Number(scrollTop) || 0),
    }),
    anchor: Object.freeze({
      pageNum: Number(pageNum),
      pdfPoint: Object.freeze({
        x: ((Number(scrollLeft) || 0) + anchorViewportX - pageX) / normalizedScale,
        y: ((Number(scrollTop) || 0) + anchorViewportY - pageY) / normalizedScale,
      }),
      viewportPoint: Object.freeze({ x: anchorViewportX, y: anchorViewportY }),
    }),
  });
}

export function restoreContinuousRendererState(snapshot, {
  pageRect,
  scale,
  horizontalOffsetPx = 0,
  verticalOffsetPx = 0,
  restoreZoom = true,
  restoreScroll = true,
  currentScrollLeft = 0,
  currentScrollTop = 0,
  viewportWidth = 0,
  viewportHeight = 0,
} = {}) {
  if (snapshot?.kind !== 'continuous-renderer') {
    throw new TypeError('Continuous renderer snapshot is required');
  }
  if (!pageRect) {
    return Object.freeze({ status: 'deferred-unmounted', snapshot });
  }
  const nextScale = restoreZoom ? snapshot.scale : Number(scale) || snapshot.scale;
  if (!restoreScroll) {
    return Object.freeze({
      status: 'restored',
      scale: nextScale,
      scrollLeft: Number(currentScrollLeft) || 0,
      scrollTop: Number(currentScrollTop) || 0,
    });
  }
  const exact = snapshot.exactRepresentation;
  const same = (left, right) => Math.abs((Number(left) || 0) - (Number(right) || 0)) <= 0.001;
  const exactRepresentationIsCurrent = Boolean(exact
    && same(nextScale, snapshot.scale)
    && same(pageRect.x, exact.pageRect?.x)
    && same(pageRect.y, exact.pageRect?.y)
    && same(pageRect.width, exact.pageRect?.width)
    && same(pageRect.height, exact.pageRect?.height)
    && same(horizontalOffsetPx, exact.horizontalOffsetPx)
    && same(verticalOffsetPx, exact.verticalOffsetPx)
    && same(viewportWidth, exact.viewportWidth)
    && same(viewportHeight, exact.viewportHeight));
  if (exactRepresentationIsCurrent) {
    return Object.freeze({
      status: 'restored',
      scale: nextScale,
      scrollLeft: exact.scrollLeft,
      scrollTop: exact.scrollTop,
      source: 'exact-representation',
    });
  }
  const pageX = (Number(pageRect.x) || 0) + (Number(horizontalOffsetPx) || 0);
  const pageY = (Number(pageRect.y) || 0) + (Number(verticalOffsetPx) || 0);
  return Object.freeze({
    status: 'restored',
    scale: nextScale,
    scrollLeft: Math.max(0,
      pageX + snapshot.anchor.pdfPoint.x * nextScale - snapshot.anchor.viewportPoint.x),
    scrollTop: Math.max(0,
      pageY + snapshot.anchor.pdfPoint.y * nextScale - snapshot.anchor.viewportPoint.y),
  });
}

function sharedUiLeaseMatches(documentState, captured, current) {
  if (!captured || !current) return false;
  const state = initializeDocumentViewMutationState(documentState);
  return captured.documentId === String(documentState.id)
    && current.documentId === captured.documentId
    && current.activationRevision === captured.activationRevision
    && state.activationRevision === captured.activationRevision;
}

export function captureViewStateTransaction(
  documentState,
  values,
  { sharedUiLease = undefined } = {},
) {
  if (!values || typeof values !== 'object') throw new TypeError('View values are required');
  const state = initializeDocumentViewMutationState(documentState);
  const normalizedValues = {};
  const stamps = {};
  for (const [field, value] of Object.entries(values)) {
    if (!VIEW_STATE_FIELD_SET.has(field)) throw new TypeError(`Unsupported view field: ${field}`);
    normalizedValues[field] = immutableClone(value);
    stamps[field] = Number(state.fields[field]) || 0;
  }
  return Object.freeze({
    documentId: String(documentState.id),
    capturedLifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    capturedUserRevision: Number(state.userRevision) || 0,
    values: Object.freeze(normalizedValues),
    stamps: Object.freeze(stamps),
    sharedUiLease: sharedUiLease === undefined
      ? captureSharedUiLease(documentState) : sharedUiLease,
  });
}

export function mergeViewStateTransaction(documentState, snapshot, {
  ownerActive = false,
  sharedUiLease = null,
  apply,
  onConflict = () => {},
} = {}) {
  if (!documentState?.id || String(documentState.id) !== String(snapshot?.documentId || '')) {
    throw new TypeError('View transaction owner does not match the document');
  }
  if (typeof apply !== 'function') throw new TypeError('A view restore callback is required');
  const state = initializeDocumentViewMutationState(documentState);
  const restored = [];
  const skipped = [];
  for (const [field, value] of Object.entries(snapshot.values || {})) {
    let reason = null;
    if ((Number(state.fields[field]) || 0) !== (Number(snapshot.stamps?.[field]) || 0)) {
      reason = 'newer-user-mutation';
    } else if (SHARED_UI_FIELDS.has(field) && !ownerActive) {
      reason = 'inactive-shared-ui-owner';
    } else if (SHARED_UI_FIELDS.has(field)
        && !sharedUiLeaseMatches(documentState, snapshot.sharedUiLease, sharedUiLease)) {
      reason = 'stale-shared-ui-lease';
    }
    if (reason) {
      const conflict = Object.freeze({ field, reason });
      skipped.push(conflict);
      onConflict(conflict);
      continue;
    }
    apply(field, immutableClone(value));
    restored.push(field);
  }
  return Object.freeze({
    documentId: String(documentState.id),
    restored: Object.freeze(restored),
    skipped: Object.freeze(skipped),
  });
}
