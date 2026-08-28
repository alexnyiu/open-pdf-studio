import {
  documentHasRevisionPersistenceDebt,
  documentRevisionDebugSnapshot,
  initializeDocumentRevisionState,
  markDocumentSaveState,
} from '../../core/document-revision-state.runtime.js';

const FAILURE_STATES = new Set(['failed', 'saved-refresh-failed']);

export function documentSaveStatusIdentity(documentState) {
  if (!documentState?.id) return '';
  const revision = initializeDocumentRevisionState(documentState);
  return [
    documentState.id,
    revision.saveState,
    revision.activeSaveRequestId || '',
    revision.contentRevision,
    revision.persistedRevision,
    revision.livePdfRevision,
    revision.lastSaveError || '',
    revision.lastSynchronizationError || '',
  ].join(':');
}

export function acknowledgeDocumentSaveStatus(documentState) {
  if (!documentState?.id) return false;
  documentState.acknowledgedSaveStatus = documentSaveStatusIdentity(documentState);
  return true;
}

export function clearDocumentSaveStatusAcknowledgement(documentState) {
  if (!documentState?.id) return false;
  documentState.acknowledgedSaveStatus = null;
  return true;
}

export function documentSaveStatusModel(documentState) {
  if (!documentState?.id) return Object.freeze({ visible: false, state: 'idle', actions: [] });
  const revision = initializeDocumentRevisionState(documentState);
  const identity = documentSaveStatusIdentity(documentState);
  const acknowledged = FAILURE_STATES.has(revision.saveState)
    && documentState.acknowledgedSaveStatus === identity;
  const common = {
    documentId: String(documentState.id),
    state: revision.saveState,
    identity,
    exactError: revision.saveState === 'saved-refresh-failed'
      ? revision.lastSynchronizationError : revision.lastSaveError,
    progress: false,
    severity: 'neutral',
    actions: [],
  };
  if (acknowledged) return Object.freeze({ ...common, visible: false, acknowledged: true });
  switch (revision.saveState) {
    case 'pending':
      return Object.freeze({
        ...common,
        visible: true,
        severity: 'pending',
        message: 'Save pending',
      });
    case 'saving':
      return Object.freeze({
        ...common,
        visible: true,
        progress: true,
        severity: 'progress',
        message: 'Saving…',
      });
    case 'persisted':
    case 'synchronizing':
      return Object.freeze({
        ...common,
        visible: true,
        progress: true,
        severity: 'progress',
        message: 'Saved; refreshing editor…',
      });
    case 'saved':
      return Object.freeze({
        ...common,
        visible: true,
        severity: 'success',
        message: 'Saved',
      });
    case 'failed':
      return Object.freeze({
        ...common,
        visible: true,
        severity: 'error',
        message: 'Save failed; changes remain pending',
        actions: ['retry-save', 'acknowledge'],
      });
    case 'saved-refresh-failed':
      if (documentHasRevisionPersistenceDebt(documentState)) {
        return Object.freeze({
          ...common,
          visible: true,
          severity: 'error',
          message: 'Editor refresh failed; new changes remain pending',
          actions: ['retry-save', 'acknowledge'],
        });
      }
      return Object.freeze({
        ...common,
        visible: true,
        severity: 'warning',
        message: 'PDF saved; editor refresh failed',
        actions: [
          'retry-refresh',
          ...(documentState.saveRefreshRetryFailed === true ? ['reopen'] : []),
          'acknowledge',
        ],
      });
    default:
      return Object.freeze({ ...common, visible: false });
  }
}

export function createDocumentSaveRecoveryController({
  resolveDocumentById,
  requestSave,
  requestRefresh,
  requestReopen,
} = {}) {
  if (typeof resolveDocumentById !== 'function') throw new TypeError('A document resolver is required');
  if (typeof requestSave !== 'function') throw new TypeError('A save retry is required');
  if (typeof requestRefresh !== 'function') throw new TypeError('A refresh retry is required');
  if (typeof requestReopen !== 'function') throw new TypeError('A document reopen action is required');
  const owner = (documentId) => resolveDocumentById(String(documentId || ''));
  return Object.freeze({
    acknowledge(documentId) {
      return acknowledgeDocumentSaveStatus(owner(documentId));
    },
    async retrySave(documentId) {
      const documentState = owner(documentId);
      if (!documentState) return false;
      clearDocumentSaveStatusAcknowledgement(documentState);
      const revision = initializeDocumentRevisionState(documentState);
      try {
        return await requestSave({
          documentId: String(documentState.id),
          documentGeneration: Number(documentState.lifecycleGeneration) || 0,
          requestedRevision: revision.contentRevision,
        });
      } catch (error) {
        markDocumentSaveState(documentState, 'failed', {
          requestId: null,
          saveError: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    async retryRefresh(documentId) {
      const documentState = owner(documentId);
      if (!documentState) return false;
      const revision = initializeDocumentRevisionState(documentState);
      if (documentHasRevisionPersistenceDebt(documentState)
          || revision.saveState !== 'saved-refresh-failed') return false;
      clearDocumentSaveStatusAcknowledgement(documentState);
      try {
        const recovered = await requestRefresh({
          documentId: String(documentState.id),
          documentGeneration: Number(documentState.lifecycleGeneration) || 0,
          requestedRevision: revision.persistedRevision,
        });
        documentState.saveRefreshRetryFailed = recovered !== true;
        return recovered === true;
      } catch (error) {
        documentState.saveRefreshRetryFailed = true;
        markDocumentSaveState(documentState, 'saved-refresh-failed', {
          requestId: null,
          synchronizationError: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    async reopen(documentId) {
      const documentState = owner(documentId);
      if (!documentState) return false;
      const revision = initializeDocumentRevisionState(documentState);
      if (documentHasRevisionPersistenceDebt(documentState)
          || revision.saveState !== 'saved-refresh-failed'
          || documentState.saveRefreshRetryFailed !== true) return false;
      clearDocumentSaveStatusAcknowledgement(documentState);
      try {
        return await requestReopen({
          documentId: String(documentState.id),
          documentGeneration: Number(documentState.lifecycleGeneration) || 0,
          requestedRevision: revision.persistedRevision,
        });
      } catch (error) {
        documentState.saveRefreshRetryFailed = true;
        markDocumentSaveState(documentState, 'saved-refresh-failed', {
          requestId: null,
          synchronizationError: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    debugSnapshot(documentId) {
      const documentState = owner(documentId);
      return documentState ? documentRevisionDebugSnapshot(documentState) : null;
    },
  });
}
