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
  beginIntent(documentId);
  try {
    if ((await waitForSynchronization(documentId)) !== true) {
      return Object.freeze({ activated: false, reason: 'synchronization-failed' });
    }
    const readyOwner = resolveDocument(documentId);
    if (!readyOwner) return Object.freeze({ activated: false, reason: 'document-closed' });
    const readyGeneration = Number(readyOwner.lifecycleGeneration) || 0;
    await awaitReadiness(readyOwner, page);
    const currentOwner = resolveDocument(documentId);
    if (currentOwner !== readyOwner
        || (Number(currentOwner?.lifecycleGeneration) || 0) !== readyGeneration) {
      throw new DOMException('Document lifecycle changed before edit replay', 'AbortError');
    }
    const value = await activate({
      documentState: currentOwner,
      pageNum: page,
      point: preservedPoint,
    });
    return Object.freeze({ activated: true, value });
  } finally {
    endIntent(documentId);
    if (lease && typeof releaseLease === 'function') releaseLease(lease);
  }
}
