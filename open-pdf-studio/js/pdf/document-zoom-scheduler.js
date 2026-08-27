import { getActiveDocument } from '../core/state.js';
import { smoothWheelZoomFactor } from './zoom-gesture.js';
import { viewport, zoomAtPoint } from './pdf-viewport.js';
import { createZoomFrameState } from './zoom-frame-state.js';

const zoomFrameState = createZoomFrameState({
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (frame) => cancelAnimationFrame(frame),
});

function usesVectorViewport(documentState) {
  return Boolean(
    documentState?.viewMode === 'single'
      && documentState.filePath
      && viewport.active
      && viewport.documentId === documentState.id
      && viewport.documentLifecycleGeneration
        === (Number(documentState.lifecycleGeneration) || 0)
      && viewport.pageNum === documentState.currentPage,
  );
}

export function documentViewportRevision(documentState) {
  if (usesVectorViewport(documentState)) return Number(viewport.viewportRevision) || 0;
  return Number(documentState?.viewportRevision) || 0;
}

export function bumpDocumentViewportRevision(documentState, reason = 'geometry') {
  if (!documentState) return 0;
  documentState.viewportRevision = (Number(documentState.viewportRevision) || 0) + 1;
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('opds:viewport-revision', {
      detail: {
        documentId: documentState.id,
        lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
        pageNum: documentState.currentPage,
        viewportRevision: documentState.viewportRevision,
        reason,
      },
    }));
  }
  return documentState.viewportRevision;
}

function captureOwner(documentState) {
  return {
    documentId: documentState.id,
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    pageNum: documentState.currentPage,
    viewMode: documentState.viewMode,
    viewportRevision: documentViewportRevision(documentState),
    kind: usesVectorViewport(documentState)
      ? 'vector'
      : documentState.viewMode === 'continuous' ? 'continuous' : 'blank',
  };
}

function ownerKey(owner) {
  return [
    owner.documentId,
    owner.lifecycleGeneration,
    owner.pageNum,
    owner.viewMode,
    owner.viewportRevision,
    owner.kind,
  ].join(':');
}

function ownerIsCurrent(owner) {
  const current = getActiveDocument();
  if (!current
      || current.id !== owner.documentId
      || (Number(current.lifecycleGeneration) || 0) !== owner.lifecycleGeneration
      || current.currentPage !== owner.pageNum
      || current.viewMode !== owner.viewMode
      || documentViewportRevision(current) !== owner.viewportRevision) {
    return false;
  }
  if (owner.kind !== 'vector') return true;
  return viewport.active
    && viewport.documentId === owner.documentId
    && viewport.documentLifecycleGeneration === owner.lifecycleGeneration
    && viewport.pageNum === owner.pageNum;
}

/**
 * Coalesce one document's wheel/pinch deltas to one owner-checked zoom per RAF.
 * Points are already expressed in the coordinate system needed by each view.
 */
export function scheduleDocumentZoom({
  delta,
  screenPoint = null,
  clientPoint = null,
  anchorY = null,
} = {}) {
  const documentState = getActiveDocument();
  const amount = Number(delta) || 0;
  if (!documentState?.pdfDoc || !amount) return false;

  const owner = captureOwner(documentState);
  const key = ownerKey(owner);
  return zoomFrameState.enqueue({
    key,
    owner,
    accumulatedDelta: amount,
    screenPoint: screenPoint ? { x: screenPoint.x, y: screenPoint.y } : null,
    clientPoint: clientPoint ? { x: clientPoint.x, y: clientPoint.y } : null,
    anchorY: anchorY == null ? null : Number(anchorY),
  }, async (request, operation) => {
    if (!operation.isCurrent() || !ownerIsCurrent(request.owner)) return;

    const factor = smoothWheelZoomFactor(request.accumulatedDelta);
    if (request.owner.kind === 'vector') {
      const point = request.screenPoint;
      if (point) zoomAtPoint(point.x, point.y, factor);
      return;
    }

    const renderer = await import('./renderer.js');
    if (!operation.isCurrent() || !ownerIsCurrent(request.owner)) return;
    if (request.owner.kind === 'continuous') {
      renderer.continuousZoomByForDocument(
        request.owner.documentId,
        request.owner.lifecycleGeneration,
        request.owner.pageNum,
        factor,
        request.anchorY,
      );
      return;
    }
    const point = request.clientPoint;
    await renderer.legacyZoomByAtPointForDocument(
      request.owner.documentId,
      request.owner.lifecycleGeneration,
      request.owner.pageNum,
      factor,
      point,
    );
  });
}

export function cancelPendingDocumentZoom() {
  zoomFrameState.cancel();
}

export function pendingDocumentZoomState() {
  const pendingZoom = zoomFrameState.snapshot();
  return pendingZoom ? {
    ...pendingZoom.owner,
    accumulatedDelta: pendingZoom.accumulatedDelta,
    scheduled: pendingZoom.scheduled,
  } : null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('opds:viewport-teardown', cancelPendingDocumentZoom);
}
