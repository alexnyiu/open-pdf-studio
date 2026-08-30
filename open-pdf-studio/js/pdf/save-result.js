const SAVE_RESULT_STATUSES = new Set([
  'saved',
  'saved-with-warning',
  'saved-refresh-pending',
  'saved-refresh-failed',
  'save-as-required',
  'deferred',
  'superseded',
  'failed',
]);

const DURABLE_SAVE_RESULT_STATUSES = new Set([
  'saved',
  'saved-with-warning',
  'saved-refresh-pending',
  'saved-refresh-failed',
]);

function nonNegativeRevision(value, fieldName, { nullable = true } = {}) {
  if (value == null && nullable) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RangeError(`${fieldName} must be a non-negative safe integer${nullable ? ' or null' : ''}`);
  }
  return normalized;
}

function immutableWarnings(warnings) {
  if (!Array.isArray(warnings)) throw new TypeError('SaveResult warnings must be an array');
  return Object.freeze(warnings.map((warning) => {
    if (typeof warning === 'string') {
      return Object.freeze({ code: 'SAVE_WARNING', message: warning });
    }
    if (!warning || typeof warning !== 'object') {
      throw new TypeError('SaveResult warnings must be strings or records');
    }
    return Object.freeze({ ...warning });
  }));
}

/**
 * Build the one terminal result type used by save scheduling, persistence,
 * proxy adoption, close authorization, and UI recovery.
 */
export function createSaveResult({
  status,
  documentId,
  requestedRevision,
  serializedRevision = null,
  persistedRevision = null,
  proxyRevision = null,
  bytesPersisted = false,
  proxyAdopted = false,
  candidateBytes = null,
  warnings = [],
  recovery = null,
  errorCode = null,
  errorMessage = null,
} = {}) {
  if (!SAVE_RESULT_STATUSES.has(status)) throw new TypeError(`Unsupported SaveResult status: ${status}`);
  const id = String(documentId || '');
  if (!id) throw new TypeError('SaveResult documentId is required');
  const requested = nonNegativeRevision(requestedRevision, 'requestedRevision', { nullable: false });
  const serialized = nonNegativeRevision(serializedRevision, 'serializedRevision');
  const persisted = nonNegativeRevision(persistedRevision, 'persistedRevision');
  const proxy = nonNegativeRevision(proxyRevision, 'proxyRevision');
  if (serialized != null && serialized > requested) {
    throw new RangeError('serializedRevision cannot exceed requestedRevision');
  }
  if (persisted != null && (serialized == null || persisted > serialized)) {
    throw new RangeError('persistedRevision cannot exceed serializedRevision');
  }
  if (proxy != null && persisted != null && proxy > persisted) {
    throw new RangeError('proxyRevision cannot exceed persistedRevision');
  }
  const size = candidateBytes == null ? null : Number(candidateBytes);
  if (size != null && (!Number.isSafeInteger(size) || size < 0)) {
    throw new RangeError('candidateBytes must be a non-negative safe integer or null');
  }
  const durable = DURABLE_SAVE_RESULT_STATUSES.has(status);
  if (durable && bytesPersisted !== true) {
    throw new TypeError(`${status} requires bytesPersisted`);
  }
  if (!durable && bytesPersisted === true) {
    throw new TypeError(`${status} cannot report persisted bytes`);
  }
  return Object.freeze({
    status,
    documentId: id,
    requestedRevision: requested,
    serializedRevision: serialized,
    persistedRevision: persisted,
    proxyRevision: proxy,
    bytesPersisted: bytesPersisted === true,
    proxyAdopted: proxyAdopted === true,
    candidateBytes: size,
    warnings: immutableWarnings(warnings),
    recovery: recovery && typeof recovery === 'object'
      ? Object.freeze({ ...recovery }) : recovery == null ? null : String(recovery),
    errorCode: errorCode == null ? null : String(errorCode),
    errorMessage: errorMessage == null ? null : String(errorMessage),
  });
}

export function isSaveResult(value) {
  return Boolean(value
    && typeof value === 'object'
    && SAVE_RESULT_STATUSES.has(value.status)
    && typeof value.documentId === 'string'
    && Number.isSafeInteger(value.requestedRevision));
}

export function saveResultIsDurable(result) {
  return isSaveResult(result)
    && DURABLE_SAVE_RESULT_STATUSES.has(result.status)
    && result.bytesPersisted === true;
}

export function saveResultAllowsClose(result, requiredRevision = result?.requestedRevision) {
  if (!saveResultIsDurable(result)) return false;
  const required = Number(requiredRevision);
  return Number.isSafeInteger(required)
    && Number(result.persistedRevision) >= required;
}

export { SAVE_RESULT_STATUSES };
