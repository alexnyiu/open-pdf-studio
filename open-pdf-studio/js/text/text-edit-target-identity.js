function normalizedString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || '';
}

export function normalizeNativeTextMarkerIds(value) {
  const candidates = Array.isArray(value) ? value : [value];
  const markerIds = candidates
    .flatMap((candidate) => String(candidate ?? '').split(/[\s,]+/u))
    .map((markerId) => markerId.trim())
    .filter(Boolean);
  return Object.freeze([...new Set(markerIds)].sort());
}

/** Create the immutable identity of one native-PDF paragraph edit target. */
export function createTextEditTargetIdentity({
  documentId,
  pageNum,
  recordId = '',
  markerIds = [],
} = {}) {
  const ownerDocumentId = normalizedString(documentId);
  const ownerPageNum = Number(pageNum);
  if (!ownerDocumentId || !Number.isInteger(ownerPageNum) || ownerPageNum < 1) return null;

  const ownedRecordId = normalizedString(recordId);
  if (ownedRecordId) {
    return Object.freeze({
      type: 'owned-record',
      documentId: ownerDocumentId,
      pageNum: ownerPageNum,
      recordId: ownedRecordId,
    });
  }

  const nativeMarkerIds = normalizeNativeTextMarkerIds(markerIds);
  if (nativeMarkerIds.length === 0) return null;
  return Object.freeze({
    type: 'native-provenance',
    documentId: ownerDocumentId,
    pageNum: ownerPageNum,
    markerIds: nativeMarkerIds,
  });
}

export function sameTextEditTarget(sourceIdentity, targetIdentity) {
  if (!sourceIdentity || !targetIdentity
      || sourceIdentity.documentId !== targetIdentity.documentId
      || sourceIdentity.pageNum !== targetIdentity.pageNum
      || sourceIdentity.type !== targetIdentity.type) return false;

  if (sourceIdentity.type === 'owned-record') {
    return sourceIdentity.recordId === targetIdentity.recordId;
  }
  if (sourceIdentity.type !== 'native-provenance') return false;
  const sourceMarkerIds = new Set(sourceIdentity.markerIds || []);
  return (targetIdentity.markerIds || []).some((markerId) => sourceMarkerIds.has(markerId));
}
