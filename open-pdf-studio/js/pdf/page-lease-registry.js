let nextLeaseId = 0;
const leases = new Map();
const listeners = new Set();

function normalizedGeneration(value) {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

function normalizedPage(value) {
  const pageNum = Number(value);
  if (!Number.isSafeInteger(pageNum) || pageNum < 1) {
    throw new RangeError('A page lease requires a positive page number');
  }
  return pageNum;
}

function emit(type, lease) {
  const event = Object.freeze({ type, lease });
  for (const listener of [...listeners]) {
    try { listener(event); } catch (error) {
      console.warn('[page-lease] Listener failed:', error);
    }
  }
}

/** Retain one page-local shell through an asynchronous interaction handoff. */
export function acquirePageLease({
  documentId,
  lifecycleGeneration = 0,
  pageNum,
  reason = 'unspecified',
} = {}) {
  const ownerId = String(documentId || '').trim();
  if (!ownerId) throw new TypeError('A page lease requires a document owner');
  const lease = Object.freeze({
    leaseId: `page-lease-${(++nextLeaseId).toString(36)}`,
    documentId: ownerId,
    lifecycleGeneration: normalizedGeneration(lifecycleGeneration),
    pageNum: normalizedPage(pageNum),
    reason: String(reason || 'unspecified'),
  });
  leases.set(lease.leaseId, lease);
  emit('acquired', lease);
  return lease;
}

export function releasePageLease(lease) {
  const leaseId = typeof lease === 'string' ? lease : lease?.leaseId;
  const current = leaseId ? leases.get(String(leaseId)) : null;
  if (!current) return false;
  leases.delete(current.leaseId);
  emit('released', current);
  return true;
}

export function leasedPagesForDocument(documentId, lifecycleGeneration = 0) {
  const ownerId = String(documentId || '');
  const generation = normalizedGeneration(lifecycleGeneration);
  return Object.freeze([...new Set([...leases.values()]
    .filter((lease) => lease.documentId === ownerId
      && lease.lifecycleGeneration === generation)
    .map((lease) => lease.pageNum))].sort((left, right) => left - right));
}

export function subscribePageLeases(listener) {
  if (typeof listener !== 'function') throw new TypeError('A page-lease listener is required');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pageLeaseSnapshot() {
  return Object.freeze([...leases.values()]);
}

export function clearPageLeasesForTests() {
  leases.clear();
  listeners.clear();
  nextLeaseId = 0;
}
