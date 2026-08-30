import { initializeDocumentViewMutationState } from '../pdf/view-state-transaction.js';

const GUARDED_FIELDS = Object.freeze(['page', 'mode', 'spread', 'zoom', 'scroll']);

function result(status, reason, detail = {}) {
  return Object.freeze({ status, reason, ...detail });
}

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/**
 * Capture the native continuous scroll owner before a click-away Apply removes
 * its focused, page-local editor portal. WebKit may anchor that DOM removal to
 * the top of the scroll container even though the user did not navigate.
 */
export function captureTextEditViewportGuard({
  documentState,
  activeDocument,
  scrollContainer,
  sessionId = null,
  mountGeneration = 0,
} = {}) {
  if (!documentState?.id || activeDocument !== documentState) {
    return result('inactive', 'inactive-document-owner');
  }
  if (documentState.viewMode !== 'continuous' || documentState.facingSpread === true) {
    return result('inactive', 'not-continuous');
  }
  if (!scrollContainer) return result('inactive', 'missing-scroll-container');
  const state = initializeDocumentViewMutationState(documentState);
  return Object.freeze({
    status: 'captured',
    documentId: String(documentState.id),
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    activationRevision: Number(state.activationRevision) || 0,
    sessionId: sessionId == null ? null : String(sessionId),
    mountGeneration: Number(mountGeneration) || 0,
    pageNum: Math.max(1, Number(documentState.currentPage) || 1),
    scale: Math.max(0.05, Number(documentState.scale) || 1),
    viewMode: documentState.viewMode,
    bookSpread: documentState.bookSpread === true,
    facingSpread: documentState.facingSpread === true,
    scrollLeft: finiteCoordinate(scrollContainer.scrollLeft),
    scrollTop: finiteCoordinate(scrollContainer.scrollTop),
    stamps: Object.freeze(Object.fromEntries(
      GUARDED_FIELDS.map((field) => [field, Number(state.fields[field]) || 0]),
    )),
  });
}

/**
 * Restore only drift produced by editor teardown. Every owner and user-view
 * stamp must still match; a real navigation or a newer editor always wins.
 */
export function restoreTextEditViewportGuard(snapshot, {
  documentState,
  activeDocument,
  scrollContainer,
  currentSessionId = null,
  currentMountGeneration = 0,
} = {}) {
  if (snapshot?.status !== 'captured') {
    return result('inactive', snapshot?.reason || 'not-captured');
  }
  const identity = {
    documentId: snapshot.documentId,
    sessionId: snapshot.sessionId,
    mountGeneration: snapshot.mountGeneration,
  };
  if (!documentState?.id || String(documentState.id) !== snapshot.documentId
      || activeDocument !== documentState) {
    return result('superseded', 'inactive-document-owner', identity);
  }
  if ((Number(documentState.lifecycleGeneration) || 0) !== snapshot.lifecycleGeneration) {
    return result('superseded', 'document-lifecycle-changed', identity);
  }
  const state = initializeDocumentViewMutationState(documentState);
  if ((Number(state.activationRevision) || 0) !== snapshot.activationRevision) {
    return result('superseded', 'document-activation-changed', identity);
  }
  if (documentState.viewMode !== snapshot.viewMode
      || documentState.viewMode !== 'continuous'
      || (documentState.bookSpread === true) !== snapshot.bookSpread
      || (documentState.facingSpread === true) !== snapshot.facingSpread
      || Math.abs((Number(documentState.scale) || 1) - snapshot.scale) > 1e-9) {
    return result('superseded', 'renderer-state-changed', identity);
  }
  const changedField = GUARDED_FIELDS.find((field) => (
    (Number(state.fields[field]) || 0) !== (Number(snapshot.stamps?.[field]) || 0)
  ));
  if (changedField) {
    return result('superseded', `newer-user-${changedField}`, identity);
  }
  if ((Number(currentMountGeneration) || 0) !== snapshot.mountGeneration) {
    return result('superseded', 'editor-mount-changed', identity);
  }
  if (currentSessionId != null && String(currentSessionId) !== snapshot.sessionId) {
    return result('superseded', 'editor-session-changed', identity);
  }
  if (!scrollContainer || scrollContainer.isConnected === false) {
    return result('superseded', 'scroll-container-detached', identity);
  }

  const before = Object.freeze({
    pageNum: Math.max(1, Number(documentState.currentPage) || 1),
    scrollLeft: finiteCoordinate(scrollContainer.scrollLeft),
    scrollTop: finiteCoordinate(scrollContainer.scrollTop),
  });
  scrollContainer.scrollLeft = snapshot.scrollLeft;
  scrollContainer.scrollTop = snapshot.scrollTop;
  documentState.currentPage = snapshot.pageNum;
  documentState.scrollPosition = {
    x: snapshot.scrollLeft,
    y: snapshot.scrollTop,
  };
  const changed = before.pageNum !== snapshot.pageNum
    || before.scrollLeft !== snapshot.scrollLeft
    || before.scrollTop !== snapshot.scrollTop;
  return result(changed ? 'restored' : 'unchanged', changed ? 'teardown-drift' : 'already-stable', {
    ...identity,
    before,
    after: Object.freeze({
      pageNum: snapshot.pageNum,
      scrollLeft: snapshot.scrollLeft,
      scrollTop: snapshot.scrollTop,
    }),
  });
}
