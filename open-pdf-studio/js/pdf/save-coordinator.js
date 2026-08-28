import {
  initializeDocumentRevisionState,
  markDocumentSaveState,
} from '../core/document-revision-state.runtime.js';

const DEFAULT_EDITOR_DEADLINE_MS = 15_000;
const DEFAULT_AUTOMATIC_RETRY_MS = 50;
const DEFAULT_AUTOMATIC_MAX_COALESCE_MS = 800;
const lifecycleCoordinators = new Set();

export function cancelCoordinatedDocumentSaves(documentId, documentGeneration, reason) {
  let cancelled = false;
  for (const coordinator of lifecycleCoordinators) {
    cancelled = coordinator.cancelDocument(documentId, documentGeneration, reason) || cancelled;
  }
  return cancelled;
}

export class SaveRequestSupersededError extends Error {
  constructor(stage) {
    super(`Save request lost ownership at ${stage}`);
    this.name = 'SaveRequestSupersededError';
    this.code = 'SAVE_REQUEST_SUPERSEDED';
    this.stage = stage;
  }
}

export class SaveEditorDeadlineError extends Error {
  constructor(deadlineMs) {
    super(`The text editor did not finish within ${deadlineMs} ms`);
    this.name = 'SaveEditorDeadlineError';
    this.code = 'SAVE_EDITOR_DEADLINE';
    this.deadlineMs = deadlineMs;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function immutableRequestSnapshot(request) {
  return Object.freeze({
    requestId: request.requestId,
    documentId: request.documentId,
    documentGeneration: request.documentGeneration,
    requestedRevision: request.requestedRevision,
    kind: request.kind,
    saveAsPath: request.saveAsPath,
  });
}

export function createSaveCoordinator({
  resolveDocumentById,
  waitForEditor = async () => true,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  editorDeadlineMs = DEFAULT_EDITOR_DEADLINE_MS,
  automaticRetryMs = DEFAULT_AUTOMATIC_RETRY_MS,
  automaticMaxCoalesceMs = DEFAULT_AUTOMATIC_MAX_COALESCE_MS,
  shouldDeferAutomatic = () => null,
  onDiagnostic = () => {},
  registerForLifecycleCancellation = false,
} = {}) {
  if (typeof resolveDocumentById !== 'function') {
    throw new TypeError('A document resolver is required');
  }
  if (typeof waitForEditor !== 'function') {
    throw new TypeError('An editor completion promise is required');
  }
  if (typeof shouldDeferAutomatic !== 'function') {
    throw new TypeError('An automatic-save admission function is required');
  }

  const records = new Map();
  let requestSequence = 0;

  const recordFor = (documentId) => {
    let record = records.get(documentId);
    if (!record) {
      record = {
        documentId,
        active: null,
        pending: null,
        timer: null,
        cancelledGeneration: null,
      };
      records.set(documentId, record);
    }
    return record;
  };

  const emit = (event, request, details = {}) => {
    const owner = resolveDocumentById(request.documentId);
    const currentRevision = owner
      ? initializeDocumentRevisionState(owner).contentRevision
      : null;
    onDiagnostic(Object.freeze({
      at: now(),
      event,
      documentId: request.documentId,
      requestId: request.requestId,
      requestedRevision: request.requestedRevision,
      currentRevision,
      ...details,
    }));
  };

  const requestOwnerMatches = (request) => {
    const owner = resolveDocumentById(request.documentId);
    return Boolean(owner
      && (Number(owner.lifecycleGeneration) || 0) === request.documentGeneration);
  };

  const hasNewerWork = (record, request) => Boolean(record.pending
    && record.pending.requestedRevision > request.requestedRevision);

  const ownsBoundary = (record, request, stage) => {
    if (record.active !== request || !requestOwnerMatches(request)) return false;
    if (record.cancelledGeneration === request.documentGeneration) return false;
    const owner = resolveDocumentById(request.documentId);
    const currentRevision = initializeDocumentRevisionState(owner).contentRevision;
    if (stage === 'before-replacement') {
      return currentRevision === request.requestedRevision && !hasNewerWork(record, request);
    }
    return currentRevision === request.requestedRevision && !hasNewerWork(record, request);
  };

  const resolveWaiters = (request, value) => {
    for (const waiter of request.waiters.splice(0)) waiter.resolve(value);
  };

  const rejectWaiters = (request, error) => {
    for (const waiter of request.waiters.splice(0)) waiter.reject(error);
  };

  const transferWaiters = (source, target) => {
    target.waiters.push(...source.waiters.splice(0));
  };

  const withEditorDeadline = async (request) => {
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(waitForEditor(immutableRequestSnapshot(request))),
        new Promise((_, reject) => {
          timer = setTimer(
            () => reject(new SaveEditorDeadlineError(editorDeadlineMs)),
            editorDeadlineMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimer(timer);
    }
  };

  const automaticDueAt = (request) => Math.min(
    Number(request.readyAt) || 0,
    Number(request.mustRunByAt) || Number.POSITIVE_INFINITY,
  );

  const scheduleRun = (record, delayMs = null) => {
    if (record.active || !record.pending) return;
    if (record.timer) clearTimer(record.timer);
    const currentTime = now();
    const effectiveDelay = delayMs == null
      ? record.pending.kind === 'auto'
        ? Math.max(0, automaticDueAt(record.pending) - currentTime)
        : 0
      : Math.max(0, Number(delayMs) || 0);
    if (effectiveDelay > 0) {
      const dueAt = currentTime + effectiveDelay;
      record.timer = setTimer(() => {
        record.timer = null;
        void runNext(record, dueAt);
      }, effectiveDelay);
      return;
    }
    void runNext(record);
  };

  const runNext = async (record, timerDueAt = null) => {
    if (record.active || !record.pending) return;
    if (record.timer) {
      clearTimer(record.timer);
      record.timer = null;
    }
    const request = record.pending;
    const currentTime = Math.max(now(), Number(timerDueAt) || 0);
    if (request.kind === 'auto') {
      const anotherSaveActive = [...records.values()].some((candidate) => candidate.active);
      const externalDeferral = anotherSaveActive
        ? { reason: 'save-in-progress', retryAfterMs: automaticRetryMs }
        : shouldDeferAutomatic(immutableRequestSnapshot(request));
      if (externalDeferral) {
        const reason = typeof externalDeferral === 'string'
          ? externalDeferral
          : externalDeferral.reason || 'automatic-save-deferred';
        const retryAfterMs = Math.max(
          1,
          Number(externalDeferral.retryAfterMs) || Number(automaticRetryMs) || 1,
        );
        emit('automatic-save-deferred', request, { reason, retryAfterMs });
        scheduleRun(record, retryAfterMs);
        return;
      }
      const dueAt = automaticDueAt(request);
      if (currentTime < dueAt) {
        scheduleRun(record, dueAt - currentTime);
        return;
      }
    }
    record.pending = null;
    record.active = request;
    const ownerAtStart = resolveDocumentById(request.documentId);
    if (!ownerAtStart || !requestOwnerMatches(request)) {
      emit('superseded', request, { stage: 'before-editor' });
      resolveWaiters(request, false);
      record.active = null;
      if (record.pending) scheduleRun(record);
      return;
    }

    markDocumentSaveState(ownerAtStart, 'saving', {
      requestId: request.requestId,
      saveError: null,
      synchronizationError: null,
    });
    let serializationStartedAt = null;
    try {
      emit('waiting-for-edit-commit', request);
      const editorReady = await withEditorDeadline(request);
      if (editorReady !== true) throw new Error('The active text edit rejected the save commit barrier');
      if (!requestOwnerMatches(request)) throw new SaveRequestSupersededError('after-editor');

      const ownerAfterEditor = resolveDocumentById(request.documentId);
      const revisionAfterEditor = initializeDocumentRevisionState(ownerAfterEditor).contentRevision;
      if (revisionAfterEditor > request.requestedRevision && !record.pending) {
        request.requestedRevision = revisionAfterEditor;
      }

      const context = Object.freeze({
        ...immutableRequestSnapshot(request),
        diagnostic(event, details = {}) {
          emit(event, request, details);
        },
        assertPersistenceOwnership() {
          if (!ownsBoundary(record, request, 'before-replacement')) {
            throw new SaveRequestSupersededError('before-replacement');
          }
          return true;
        },
        ownsPublication() {
          return ownsBoundary(record, request, 'after-replacement');
        },
        adoptDocumentGeneration(nextGeneration) {
          const generation = Number(nextGeneration) || 0;
          const previousGeneration = request.documentGeneration;
          const owner = resolveDocumentById(request.documentId);
          if (record.active !== request
              || record.cancelledGeneration === previousGeneration
              || !owner
              || (Number(owner.lifecycleGeneration) || 0) !== generation) {
            throw new SaveRequestSupersededError('proxy-generation-adoption');
          }
          request.documentGeneration = generation;
          if (record.pending?.documentGeneration === previousGeneration) {
            record.pending.documentGeneration = generation;
          }
          emit('proxy-generation-adopted', request, {
            previousGeneration,
            documentGeneration: generation,
          });
          return true;
        },
        assertSynchronizationOwnership(stage = 'synchronization') {
          if (!ownsBoundary(record, request, stage)) {
            throw new SaveRequestSupersededError(stage);
          }
          return true;
        },
        ownsDocument() {
          return record.active === request
            && requestOwnerMatches(request)
            && record.cancelledGeneration !== request.documentGeneration;
        },
        owner() {
          return resolveDocumentById(request.documentId);
        },
      });
      serializationStartedAt = now();
      emit('serializing', request);
      const result = await request.execute(context);
      const saved = result === true || result?.saved === true;
      const durationMs = Math.max(0, now() - serializationStartedAt);
      const candidateBytes = Number.isSafeInteger(result?.candidateBytes)
        ? result.candidateBytes : null;
      emit('completed', request, { saved, durationMs, candidateBytes });
      const needsFollowUp = result?.followUpNeeded === true || !context.ownsPublication();
      if (saved && needsFollowUp && record.pending) {
        emit('superseded', request, { stage: 'after-replacement' });
        transferWaiters(request, record.pending);
      } else {
        resolveWaiters(request, saved);
      }
    } catch (error) {
      if (error instanceof SaveRequestSupersededError) {
        emit('superseded', request, { stage: error.stage });
        if (record.pending) transferWaiters(request, record.pending);
        else resolveWaiters(request, false);
      } else {
        const owner = resolveDocumentById(request.documentId);
        if (owner && requestOwnerMatches(request)) {
          markDocumentSaveState(owner, 'failed', {
            requestId: request.requestId,
            saveError: error instanceof Error ? error.message : String(error),
          });
        }
        emit('failed', request, {
          code: error?.code || null,
          error: error instanceof Error ? error.message : String(error),
          durationMs: serializationStartedAt == null
            ? null : Math.max(0, now() - serializationStartedAt),
          candidateBytes: null,
        });
        rejectWaiters(request, error);
      }
    } finally {
      if (record.active === request) record.active = null;
      if (record.pending) scheduleRun(record);
      else if (!record.active && !record.timer) records.delete(record.documentId);
    }
  };

  const coordinator = {
    request({
      documentId,
      documentGeneration,
      requestedRevision,
      kind = 'manual',
      saveAsPath = null,
      delayMs = 0,
      execute,
    }) {
      const id = String(documentId || '');
      if (!id || typeof execute !== 'function') return Promise.resolve(false);
      const generation = Number(documentGeneration) || 0;
      const owner = resolveDocumentById(id);
      const revision = Number.isSafeInteger(requestedRevision)
        ? requestedRevision
        : owner ? initializeDocumentRevisionState(owner).contentRevision : 0;
      const record = recordFor(id);
      record.cancelledGeneration = null;
      const waiter = deferred();
      const requestTime = now();
      const normalizedDelayMs = Math.max(0, Number(delayMs) || 0);

      const canJoinActive = record.active
        && record.active.documentGeneration === generation
        && revision <= record.active.requestedRevision
        && (!saveAsPath || saveAsPath === record.active.saveAsPath);
      if (canJoinActive) {
        record.active.waiters.push(waiter);
        emit('save-requested', record.active, { coalesced: true, joinedActive: true, kind });
        return waiter.promise;
      }

      if (record.pending) {
        record.pending.requestedRevision = Math.max(record.pending.requestedRevision, revision);
        record.pending.documentGeneration = generation;
        record.pending.execute = execute;
        record.pending.kind = kind === 'manual' ? 'manual' : record.pending.kind;
        if (kind === 'manual') {
          record.pending.readyAt = requestTime;
          record.pending.mustRunByAt = requestTime;
        } else if (record.pending.kind === 'auto') {
          record.pending.readyAt = Math.min(
            requestTime + normalizedDelayMs,
            record.pending.mustRunByAt,
          );
        }
        if (saveAsPath) record.pending.saveAsPath = saveAsPath;
        record.pending.waiters.push(waiter);
        emit('save-requested', record.pending, { coalesced: true, kind });
      } else {
        requestSequence += 1;
        record.pending = {
          requestId: `save-${now().toString(36)}-${requestSequence.toString(36)}`,
          documentId: id,
          documentGeneration: generation,
          requestedRevision: revision,
          kind,
          saveAsPath,
          execute,
          waiters: [waiter],
          firstRequestedAt: requestTime,
          readyAt: requestTime + normalizedDelayMs,
          mustRunByAt: kind === 'auto'
            ? requestTime + Math.max(0, Number(automaticMaxCoalesceMs) || 0)
            : requestTime,
        };
        emit('save-requested', record.pending, { coalesced: false, kind });
      }

      if (kind === 'manual') scheduleRun(record, 0);
      else if (!record.active) scheduleRun(record);
      return waiter.promise;
    },

    cancelDocument(documentId, documentGeneration = null, reason = 'document-cancelled') {
      const id = String(documentId || '');
      const record = records.get(id);
      if (!record) return false;
      const generation = documentGeneration == null
        ? record.active?.documentGeneration ?? record.pending?.documentGeneration ?? 0
        : Number(documentGeneration) || 0;
      record.cancelledGeneration = generation;
      if (record.timer) {
        clearTimer(record.timer);
        record.timer = null;
      }
      if (record.pending) {
        emit('superseded', record.pending, { stage: reason });
        resolveWaiters(record.pending, false);
        record.pending = null;
      }
      if (!record.active) records.delete(id);
      return true;
    },

    debugSnapshot(documentId) {
      const record = records.get(String(documentId || ''));
      if (!record) return null;
      return Object.freeze({
        documentId: record.documentId,
        active: record.active ? immutableRequestSnapshot(record.active) : null,
        pending: record.pending ? immutableRequestSnapshot(record.pending) : null,
        hasTimer: Boolean(record.timer),
        cancelledGeneration: record.cancelledGeneration,
      });
    },
  };
  if (registerForLifecycleCancellation) lifecycleCoordinators.add(coordinator);
  return coordinator;
}
