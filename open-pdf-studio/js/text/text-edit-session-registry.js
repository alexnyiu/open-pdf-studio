import { createTextEditTargetIdentity } from './text-edit-target-identity.js';

/** Pure registry used by the application wrapper and owner/lifecycle tests. */
export function createTextEditSessionRegistry(resolveDocumentById, { now = Date.now } = {}) {
  if (typeof resolveDocumentById !== 'function') {
    throw new TypeError('A document owner resolver is required');
  }
  let activeSession = null;
  let activeApplyOperation = null;
  let nextSessionId = 0;
  let nextOperationId = 0;

  const ownerMatches = (session) => {
    const owner = session ? resolveDocumentById(session.ownerDocumentId) : null;
    return Boolean(owner
      && (Number(owner.lifecycleGeneration) || 0) === session.ownerDocumentGeneration);
  };
  const clearIfCurrent = (session) => {
    if (activeSession?.sessionId === session?.sessionId) activeSession = null;
  };
  const invalidateApplyOperation = (session, reason) => {
    const operation = activeApplyOperation;
    if (!operation || (session && operation.session !== session)) return false;
    operation.valid = false;
    operation.reason = reason;
    if (activeApplyOperation === operation) activeApplyOperation = null;
    return true;
  };

  const cancelActive = (reason = 'cancelled') => {
    const session = activeSession;
    if (!session) return false;
    activeSession = null;
    invalidateApplyOperation(session, reason);
    session.cancel(reason);
    return true;
  };

  const applySession = (session, reason = 'apply') => {
    if (!session) return Promise.resolve(false);
    if (activeApplyOperation?.session === session) return activeApplyOperation.promise;
    if (!ownerMatches(session)) {
      activeSession = null;
      session.cancel('stale-owner');
      return Promise.resolve(false);
    }
    const operationState = {
      session,
      valid: true,
      reason: null,
      operation: null,
      promise: null,
    };
    const operation = Object.freeze({
      operationId: `text-edit-apply-${now().toString(36)}-${(++nextOperationId).toString(36)}`,
      sessionId: session.sessionId,
      ownerDocumentId: session.ownerDocumentId,
      ownerDocumentGeneration: session.ownerDocumentGeneration,
      reason,
      isCurrent() {
        return operationState.valid
          && activeApplyOperation === operationState
          && ownerMatches(session);
      },
    });
    operationState.operation = operation;
    activeApplyOperation = operationState;
    let resolveOperation;
    let rejectOperation;
    operationState.promise = new Promise((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    void (async () => {
      try {
        const result = await session.commit(operation);
        if (!ownerMatches(session)) {
          invalidateApplyOperation(session, 'stale-owner');
          if (activeSession?.sessionId === session.sessionId) {
            activeSession = null;
            session.cancel('stale-owner');
          }
          resolveOperation(false);
          return;
        }
        if (!operation.isCurrent() || result === false) {
          resolveOperation(false);
          return;
        }
        clearIfCurrent(session);
        resolveOperation(true);
      } catch (error) {
        if (!ownerMatches(session)) {
          invalidateApplyOperation(session, 'stale-owner');
          if (activeSession?.sessionId === session.sessionId) {
            activeSession = null;
            session.cancel('stale-owner');
          }
        }
        rejectOperation(error);
      } finally {
        if (activeApplyOperation === operationState) activeApplyOperation = null;
      }
    })();
    return operationState.promise;
  };

  return {
    register({
      ownerDocumentId,
      ownerDocumentGeneration,
      pageNum,
      kind,
      targetIdentity = null,
      isDirty = () => false,
      commit,
      cancel,
    }) {
      if (!ownerDocumentId || !Number.isInteger(pageNum) || typeof commit !== 'function'
          || typeof cancel !== 'function') {
        throw new TypeError('A text-edit session requires immutable owner, page, commit, and cancel callbacks');
      }
      if (activeSession) cancelActive('superseded');
      else invalidateApplyOperation(null, 'superseded');
      const session = Object.freeze({
        sessionId: `text-edit-${now().toString(36)}-${(++nextSessionId).toString(36)}`,
        ownerDocumentId,
        ownerDocumentGeneration: Number(ownerDocumentGeneration) || 0,
        pageNum,
        kind: kind || 'unknown',
        targetIdentity: targetIdentity ? createTextEditTargetIdentity(targetIdentity) : null,
        isDirty,
        commit,
        cancel,
      });
      if (!ownerMatches(session)) {
        cancel('stale-owner');
        return null;
      }
      activeSession = session;
      return session;
    },
    active() {
      return activeSession;
    },
    complete(sessionId) {
      if (activeSession?.sessionId === sessionId) activeSession = null;
    },
    cancelActive,
    cancelForDocument(documentId, reason = 'document-transition') {
      if (!activeSession || activeSession.ownerDocumentId !== documentId) return false;
      return cancelActive(reason);
    },
    isDirtyForDocument(documentId) {
      if (!activeSession || activeSession.ownerDocumentId !== documentId) return false;
      try {
        return activeSession.isDirty() === true;
      } catch {
        // Closing must fail safe if a live editor cannot report its draft state.
        return true;
      }
    },
    applyActive(reason = 'apply') {
      return applySession(activeSession, reason);
    },
    commitForDocument(documentId, reason = 'document-command') {
      const session = activeSession;
      if (!session || session.ownerDocumentId !== documentId) return Promise.resolve(true);
      return applySession(session, reason);
    },
    ownerIsCurrent(session = activeSession) {
      return ownerMatches(session);
    },
  };
}
