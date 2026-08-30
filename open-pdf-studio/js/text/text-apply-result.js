const TEXT_APPLY_STATUSES = new Set(['noop', 'applied', 'rejected', 'superseded']);
const RECOVERY_ACTIONS = new Set(['expand-to-fit', 'insert-line-break', 'keep-editing']);

function revision(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function pageNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

function optionalString(value) {
  return value == null || value === '' ? null : String(value);
}

function freezeLayoutAdjustment(value) {
  if (!value) return null;
  if (!['auto-grow-width', 'auto-grow-height'].includes(value.kind)) {
    throw new TypeError(`Unsupported text layout adjustment: ${String(value.kind)}`);
  }
  const deltaWidthPt = Number(value.deltaWidthPt) || 0;
  const deltaHeightPt = Number(value.deltaHeightPt) || 0;
  if (!Number.isFinite(deltaWidthPt) || !Number.isFinite(deltaHeightPt)) {
    throw new TypeError('Text layout adjustment deltas must be finite PDF points');
  }
  return Object.freeze({ kind: value.kind, deltaWidthPt, deltaHeightPt });
}

/** Create the immutable publication/persistence result for one Apply request. */
export function createTextApplyResult({
  status,
  changed,
  ownerCommitted = false,
  visiblePublished = false,
  semanticPublished = false,
  documentId = '',
  documentGeneration = 0,
  pageNum = 1,
  contentRevision = 0,
  pageRevision = 0,
  editId = null,
  editRevision = null,
  layoutAdjusted,
  layoutAdjustment = null,
  rejectionCode = null,
  recoveryActions = [],
  publicationError = null,
} = {}) {
  if (!TEXT_APPLY_STATUSES.has(status)) {
    throw new TypeError(`Unsupported TextApplyResult status: ${String(status)}`);
  }
  const frozenAdjustment = freezeLayoutAdjustment(layoutAdjustment);
  const frozenRecoveryActions = Object.freeze([...new Set(recoveryActions.map(String))]);
  if (frozenRecoveryActions.some((action) => !RECOVERY_ACTIONS.has(action))) {
    throw new TypeError('Unsupported text Apply recovery action');
  }
  const result = {
    status,
    changed: changed == null ? status === 'applied' : changed === true,
    ownerCommitted: ownerCommitted === true,
    visiblePublished: visiblePublished === true,
    semanticPublished: semanticPublished === true,
    documentId: String(documentId || ''),
    documentGeneration: revision(documentGeneration),
    pageNum: pageNumber(pageNum),
    contentRevision: revision(contentRevision),
    pageRevision: revision(pageRevision),
    editId: optionalString(editId),
    editRevision: editRevision == null ? null : revision(editRevision),
    layoutAdjusted: layoutAdjusted == null ? Boolean(frozenAdjustment) : layoutAdjusted === true,
    layoutAdjustment: frozenAdjustment,
    rejectionCode: optionalString(rejectionCode),
    recoveryActions: frozenRecoveryActions,
    publicationError: optionalString(publicationError),
  };
  if (result.status !== 'applied' && result.changed) {
    throw new TypeError(`${result.status} TextApplyResult cannot report a committed change`);
  }
  if (result.status === 'noop' && (result.ownerCommitted || result.layoutAdjusted)) {
    throw new TypeError('A no-op cannot report an owner commit or layout adjustment');
  }
  if (result.status !== 'rejected' && result.rejectionCode) {
    throw new TypeError('Only rejected Apply results may expose a rejection code');
  }
  return Object.freeze(result);
}

export function isTextApplyResult(value) {
  return Boolean(value && typeof value === 'object' && TEXT_APPLY_STATUSES.has(value.status));
}

export function textApplyResultCompletesInteraction(value) {
  return isTextApplyResult(value) && (value.status === 'noop' || value.status === 'applied');
}

export function textApplyResultSchedulesPersistence(value) {
  return isTextApplyResult(value)
    && value.status === 'applied'
    && value.changed === true
    && value.ownerCommitted === true;
}
