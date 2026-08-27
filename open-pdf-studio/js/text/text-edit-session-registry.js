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

  return {
    register({
      ownerDocumentId,
      ownerDocumentGeneration,
      pageNum,
      kind,
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
    async applyActive() {
      const session = activeSession;
      if (!session) return false;
      if (activeApplyOperation?.session === session) return false;
      if (!ownerMatches(session)) {
        activeSession = null;
        session.cancel('stale-owner');
        return false;
      }
      const operationState = {
        session,
        valid: true,
        reason: null,
        operation: null,
      };
      const operation = Object.freeze({
        operationId: `text-edit-apply-${now().toString(36)}-${(++nextOperationId).toString(36)}`,
        sessionId: session.sessionId,
        ownerDocumentId: session.ownerDocumentId,
        ownerDocumentGeneration: session.ownerDocumentGeneration,
        isCurrent() {
          return operationState.valid
            && activeApplyOperation === operationState
            && ownerMatches(session);
        },
      });
      operationState.operation = operation;
      activeApplyOperation = operationState;
      try {
        const result = await session.commit(operation);
        if (!ownerMatches(session)) {
          invalidateApplyOperation(session, 'stale-owner');
          if (activeSession?.sessionId === session.sessionId) {
            activeSession = null;
            session.cancel('stale-owner');
          }
          return false;
        }
        if (!operation.isCurrent() || result === false) return false;
        clearIfCurrent(session);
        return true;
      } catch (error) {
        if (!ownerMatches(session)) {
          invalidateApplyOperation(session, 'stale-owner');
          if (activeSession?.sessionId === session.sessionId) {
            activeSession = null;
            session.cancel('stale-owner');
          }
        }
        throw error;
      } finally {
        if (activeApplyOperation === operationState) activeApplyOperation = null;
      }
    },
    ownerIsCurrent(session = activeSession) {
      return ownerMatches(session);
    },
  };
}
