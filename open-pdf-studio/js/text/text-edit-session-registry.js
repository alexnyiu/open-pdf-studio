import { createTextEditTargetIdentity } from './text-edit-target-identity.js';
import {
  createTextApplyResult,
  isTextApplyResult,
  textApplyResultCompletesInteraction,
} from './text-apply-result.js';

/** Pure registry used by the application wrapper and owner/lifecycle tests. */
export function createTextEditSessionRegistry(resolveDocumentById, { now = Date.now } = {}) {
  if (typeof resolveDocumentById !== 'function') {
    throw new TypeError('A document owner resolver is required');
  }
  let activeSession = null;
  let activeApplyOperation = null;
  let nextSessionId = 0;
  let nextOperationId = 0;
  const lifecycleHistory = [];
  const recordLifecycle = (event, details = {}) => {
    lifecycleHistory.push(Object.freeze({ at: now(), event, ...details }));
    if (lifecycleHistory.length > 64) {
      lifecycleHistory.splice(0, lifecycleHistory.length - 64);
    }
  };

  const ownerMatches = (session) => {
    const owner = session ? resolveDocumentById(session.ownerDocumentId) : null;
    return Boolean(owner
      && (Number(owner.lifecycleGeneration) || 0) === session.ownerDocumentGeneration);
  };
  const resultContext = (session, overrides = {}) => {
    const owner = session ? resolveDocumentById(session.ownerDocumentId) : null;
    const pageNum = Number(overrides.pageNum ?? session?.pageNum) || 1;
    return {
      documentId: String(overrides.documentId ?? session?.ownerDocumentId ?? owner?.id ?? ''),
      documentGeneration: Number(
        overrides.documentGeneration
          ?? session?.ownerDocumentGeneration
          ?? owner?.lifecycleGeneration,
      ) || 0,
      pageNum,
      contentRevision: Number(owner?.revisionState?.contentRevision) || 0,
      pageRevision: Number(owner?.revisionState?.pageContentRevisions?.[pageNum]) || 0,
      editId: null,
      editRevision: null,
    };
  };
  const supersededResult = (session, overrides = {}) => createTextApplyResult({
    status: 'superseded',
    ...resultContext(session, overrides),
  });
  const noLiveDraftResult = (documentId) => {
    const owner = resolveDocumentById(documentId);
    return createTextApplyResult({
      status: 'noop',
      ...resultContext(null, {
        documentId,
        documentGeneration: owner?.lifecycleGeneration,
        pageNum: owner?.currentPage || 1,
      }),
    });
  };
  const clearIfCurrent = (session) => {
    if (activeSession?.sessionId === session?.sessionId) activeSession = null;
  };
  const invalidateApplyOperation = (session, reason) => {
    const operation = activeApplyOperation;
    if (!operation || (session && operation.session !== session)) return false;
    recordLifecycle('apply-invalidated', {
      sessionId: operation.session?.sessionId ?? null,
      operationId: operation.operation?.operationId ?? null,
      reason,
    });
    operation.valid = false;
    operation.reason = reason;
    operation.controller.abort(reason);
    if (activeApplyOperation === operation) activeApplyOperation = null;
    return true;
  };

  const cancelActive = (reason = 'cancelled') => {
    const session = activeSession;
    if (!session) return false;
    recordLifecycle('cancelled', { sessionId: session.sessionId, reason });
    activeSession = null;
    invalidateApplyOperation(session, reason);
    session.cancel(reason);
    return true;
  };

  const applySession = (session, reason = 'apply') => {
    if (!session) return Promise.resolve(noLiveDraftResult(''));
    if (activeApplyOperation?.session === session) return activeApplyOperation.promise;
    if (!ownerMatches(session)) {
      activeSession = null;
      session.cancel('stale-owner');
      return Promise.resolve(supersededResult(session));
    }
    const operationState = {
      session,
      valid: true,
      reason: null,
      operation: null,
      promise: null,
      controller: new AbortController(),
    };
    const operation = Object.freeze({
      operationId: `text-edit-apply-${now().toString(36)}-${(++nextOperationId).toString(36)}`,
      sessionId: session.sessionId,
      ownerDocumentId: session.ownerDocumentId,
      ownerDocumentGeneration: session.ownerDocumentGeneration,
      reason,
      signal: operationState.controller.signal,
      isCurrent() {
        return operationState.valid
          && activeApplyOperation === operationState
          && ownerMatches(session);
      },
    });
    operationState.operation = operation;
    activeApplyOperation = operationState;
    recordLifecycle('apply-started', {
      sessionId: session.sessionId,
      operationId: operation.operationId,
      reason,
    });
    let resolveOperation;
    let rejectOperation;
    operationState.promise = new Promise((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    void (async () => {
      try {
        const result = await session.commit(operation);
        recordLifecycle('commit-returned', {
          sessionId: session.sessionId,
          operationId: operation.operationId,
          status: result?.status ?? typeof result,
          operationCurrent: operation.isCurrent(),
        });
        if (!ownerMatches(session)) {
          invalidateApplyOperation(session, 'stale-owner');
          if (activeSession?.sessionId === session.sessionId) {
            activeSession = null;
            session.cancel('stale-owner');
          }
          resolveOperation(supersededResult(session));
          return;
        }
        if (!operation.isCurrent()) {
          recordLifecycle('apply-superseded', {
            sessionId: session.sessionId,
            operationId: operation.operationId,
            reason: operationState.reason || 'operation-not-current',
          });
          resolveOperation(supersededResult(session));
          return;
        }
        if (!isTextApplyResult(result)) {
          throw new TypeError('Text editor commit callbacks must return TextApplyResult');
        }
        const normalized = result;
        if (textApplyResultCompletesInteraction(normalized)) clearIfCurrent(session);
        else if (normalized.status === 'superseded') clearIfCurrent(session);
        resolveOperation(normalized);
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
      recordLifecycle('registered', {
        sessionId: session.sessionId,
        ownerDocumentId: session.ownerDocumentId,
        ownerDocumentGeneration: session.ownerDocumentGeneration,
        pageNum: session.pageNum,
        kind: session.kind,
      });
      return session;
    },
    active() {
      return activeSession;
    },
    complete(sessionId) {
      const activeSessionId = activeSession?.sessionId ?? null;
      const accepted = activeSessionId === sessionId;
      if (accepted) activeSession = null;
      recordLifecycle('completed', { sessionId, activeSessionId, accepted });
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
      if (!session || session.ownerDocumentId !== documentId) {
        return Promise.resolve(noLiveDraftResult(documentId));
      }
      return applySession(session, reason);
    },
    ownerIsCurrent(session = activeSession) {
      return ownerMatches(session);
    },
    diagnostics() {
      return Object.freeze(lifecycleHistory.map((entry) => Object.freeze({ ...entry })));
    },
  };
}
