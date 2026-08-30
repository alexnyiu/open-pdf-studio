const candidatesByOwner = new Map();
const disposedCandidates = new WeakSet();

function ownerKey(documentId, lifecycleGeneration) {
  const id = String(documentId || '');
  const generation = Number(lifecycleGeneration) || 0;
  if (!id) throw new TypeError('SaveCandidate documentId is required');
  return `${id}:${generation}`;
}

function revision(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RangeError('SaveCandidate requestedRevision must be a non-negative safe integer');
  }
  return normalized;
}

export function createSaveCandidate({
  documentId,
  lifecycleGeneration,
  requestedRevision,
  outputPath,
  bytes,
  pageCount,
  preparedPdfJsDocument = null,
  metadata = null,
} = {}) {
  const id = String(documentId || '');
  const generation = Number(lifecycleGeneration) || 0;
  const requested = revision(requestedRevision);
  const path = String(outputPath || '');
  if (!id || !path) throw new TypeError('SaveCandidate owner and output path are required');
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new TypeError('SaveCandidate bytes are required');
  }
  const pages = Number(pageCount);
  if (!Number.isSafeInteger(pages) || pages < 1) {
    throw new RangeError('SaveCandidate pageCount must be a positive safe integer');
  }
  return Object.freeze({
    documentId: id,
    lifecycleGeneration: generation,
    requestedRevision: requested,
    outputPath: path,
    pageCount: pages,
    bytes: bytes.slice(),
    candidateBytes: bytes.byteLength,
    preparedPdfJsDocument,
    metadata: metadata && typeof metadata === 'object'
      ? Object.freeze({ ...metadata }) : metadata,
  });
}

export function latestSaveCandidate(documentId, lifecycleGeneration, requestedRevision = null) {
  const candidate = candidatesByOwner.get(ownerKey(documentId, lifecycleGeneration)) || null;
  if (!candidate || requestedRevision == null) return candidate;
  return candidate.requestedRevision === revision(requestedRevision) ? candidate : null;
}

export async function disposeSaveCandidate(candidate) {
  if (!candidate || disposedCandidates.has(candidate)) return false;
  disposedCandidates.add(candidate);
  try {
    await candidate.preparedPdfJsDocument?.destroy?.();
  } catch {}
  return true;
}

export async function storeSaveCandidate(candidate) {
  if (!candidate?.documentId) throw new TypeError('A SaveCandidate is required');
  const key = ownerKey(candidate.documentId, candidate.lifecycleGeneration);
  const previous = candidatesByOwner.get(key);
  if (previous === candidate) return candidate;
  candidatesByOwner.set(key, candidate);
  if (previous) await disposeSaveCandidate(previous);
  return candidate;
}

export async function releaseSaveCandidate(candidate, { destroyPreparedDocument = true } = {}) {
  if (!candidate) return false;
  const key = ownerKey(candidate.documentId, candidate.lifecycleGeneration);
  if (candidatesByOwner.get(key) === candidate) candidatesByOwner.delete(key);
  if (destroyPreparedDocument) await disposeSaveCandidate(candidate);
  return true;
}

export async function clearSaveCandidates(documentId = null) {
  const id = documentId == null ? null : String(documentId);
  const removals = [];
  for (const [key, candidate] of candidatesByOwner) {
    if (id !== null && candidate.documentId !== id) continue;
    candidatesByOwner.delete(key);
    removals.push(disposeSaveCandidate(candidate));
  }
  await Promise.all(removals);
  return removals.length;
}
