import { initializeDocumentRevisionState } from '../core/document-revision-state.runtime.js';

function positivePage(value) {
  const pageNum = Number(value);
  if (!Number.isSafeInteger(pageNum) || pageNum < 1) {
    throw new RangeError('A page edit intent requires a positive page');
  }
  return pageNum;
}

function frozenPoint(point) {
  if (!point) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError('A page edit intent point must be finite');
  }
  return Object.freeze({ x, y });
}

const pendingIntentCounts = new Map();

const TERMINAL_SYNCHRONIZATION_FAILURES = new Set([
  'failed',
  'save-as-required',
  'saved-refresh-failed',
]);

function readinessFailure(error) {
  const errorCode = String(error?.code || 'PAGE_EDIT_READINESS_FAILED');
  const reasons = {
    PAGE_EDIT_READINESS_TIMEOUT: 'readiness-timeout',
    PAGE_EDIT_READINESS_ABORTED: 'readiness-aborted',
    PAGE_EDIT_READINESS_LIFECYCLE_CHANGED: 'document-lifecycle-changed',
    PAGE_EDIT_READINESS_REVISION_CHANGED: 'document-revision-changed',
    PAGE_EDIT_READINESS_EVENTS_UNAVAILABLE: 'readiness-events-unavailable',
  };
  return Object.freeze({
    activated: false,
    reason: reasons[errorCode] || 'readiness-failed',
    errorCode,
    message: error instanceof Error ? error.message : String(error),
    action: 'retry-page-edit',
  });
}

function beginIntent(documentId) {
  pendingIntentCounts.set(documentId, (pendingIntentCounts.get(documentId) || 0) + 1);
}

function endIntent(documentId) {
  const remaining = (pendingIntentCounts.get(documentId) || 0) - 1;
  if (remaining > 0) pendingIntentCounts.set(documentId, remaining);
  else pendingIntentCounts.delete(documentId);
}

export function pageEditIntentPendingForDocument(documentId) {
  return (pendingIntentCounts.get(String(documentId || '')) || 0) > 0;
}

/**
 * A click-away save may deliberately persist without replacing the live PDF.js
 * proxy. Native provenance still belongs to that live byte revision, so the
 * next text-edit activation must finish the deferred synchronization first.
 */
export function textEditActivationNeedsSynchronization(
  documentState,
  saveCoordinatorSnapshot = null,
) {
  if (!documentState?.id) return false;
  const revisions = initializeDocumentRevisionState(documentState);
  return Boolean(
    saveCoordinatorSnapshot?.active
    || saveCoordinatorSnapshot?.pending
    || revisions.persistedRevision > revisions.livePdfRevision,
  );
}

/**
 * Wait for any active saved-document transition, then join/upgrade an in-flight
 * save or run the synchronization-only path. The bounded retry covers joining
 * an automatic persistence request that finishes with proxy adoption deferred.
 */
export async function synchronizeTextEditActivation({
  documentId,
  waitForSynchronization,
  resolveDocument,
  getSaveCoordinatorSnapshot,
  requestSynchronization,
  maxAttempts = 3,
} = {}) {
  const id = String(documentId || '');
  if (!id) throw new TypeError('A text-edit synchronization owner is required');
  for (const [name, callback] of Object.entries({
    waitForSynchronization,
    resolveDocument,
    getSaveCoordinatorSnapshot,
    requestSynchronization,
  })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} is required`);
  }
  if ((await waitForSynchronization(id)) !== true) return false;
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const owner = resolveDocument(id);
    if (!owner) return false;
    const coordinator = await getSaveCoordinatorSnapshot(id);
    if (!textEditActivationNeedsSynchronization(owner, coordinator)) return true;
    if (attempt === attempts) return false;
    const result = await requestSynchronization({
      documentId: id,
      documentGeneration: Number(owner.lifecycleGeneration) || 0,
      requestedRevision: initializeDocumentRevisionState(owner).contentRevision,
    });
    const currentOwner = resolveDocument(id);
    const currentCoordinator = await getSaveCoordinatorSnapshot(id);
    if (currentOwner
        && !textEditActivationNeedsSynchronization(currentOwner, currentCoordinator)) {
      return true;
    }
    if (TERMINAL_SYNCHRONIZATION_FAILURES.has(result?.status)) return false;
  }
  return false;
}

/**
 * Preserve a page/point through saved-document synchronization, then replay
 * exactly once against the current proxy generation after page edit readiness.
 */
export async function runPageEditIntent({
  documentState,
  pageNum,
  point = null,
  waitForSynchronization,
  resolveDocument,
  awaitReadiness,
  activate,
  acquireLease = null,
  releaseLease = null,
  signal = null,
  readinessTimeoutMs = 15_000,
}) {
  if (!documentState?.id) throw new TypeError('A page edit intent requires a document owner');
  for (const [name, callback] of Object.entries({
    waitForSynchronization,
    resolveDocument,
    awaitReadiness,
    activate,
  })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} is required`);
  }
  const documentId = String(documentState.id);
  const page = positivePage(pageNum);
  const preservedPoint = frozenPoint(point);
  const lease = typeof acquireLease === 'function' ? acquireLease({
    documentId,
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    pageNum: page,
    reason: 'page-edit-intent',
  }) : null;
  const readinessController = new AbortController();
  const abortReadiness = () => readinessController.abort(signal?.reason);
  signal?.addEventListener?.('abort', abortReadiness, { once: true });
  beginIntent(documentId);
  try {
    if ((await waitForSynchronization(documentId)) !== true) {
      return Object.freeze({ activated: false, reason: 'synchronization-failed' });
    }
    const readyOwner = resolveDocument(documentId);
    if (!readyOwner) return Object.freeze({ activated: false, reason: 'document-closed' });
    const readyGeneration = Number(readyOwner.lifecycleGeneration) || 0;
    try {
      await awaitReadiness(readyOwner, page, {
        signal: readinessController.signal,
        timeoutMs: readinessTimeoutMs,
      });
    } catch (error) {
      return readinessFailure(error);
    }
    const currentOwner = resolveDocument(documentId);
    if (currentOwner !== readyOwner
        || (Number(currentOwner?.lifecycleGeneration) || 0) !== readyGeneration) {
      return Object.freeze({
        activated: false,
        reason: 'document-lifecycle-changed',
        errorCode: 'PAGE_EDIT_READINESS_LIFECYCLE_CHANGED',
        message: 'Document lifecycle changed before edit replay',
        action: 'retry-page-edit',
      });
    }
    const value = await activate({
      documentState: currentOwner,
      pageNum: page,
      point: preservedPoint,
    });
    return Object.freeze({ activated: true, value });
  } finally {
    readinessController.abort();
    signal?.removeEventListener?.('abort', abortReadiness);
    endIntent(documentId);
    if (lease && typeof releaseLease === 'function') releaseLease(lease);
  }
}
