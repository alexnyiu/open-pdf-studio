import { closeDialog, openDialog } from '../../solid/stores/dialogStore.js';

const VALID_ACTIONS = new Set(['save', 'dontsave', 'cancel']);

export function createUnsavedClosePromptCoordinator({
  open = openDialog,
  close = closeDialog,
} = {}) {
  const pendingByOwner = new Map();
  let nextPromptId = 0;

  function request({ documentId, fileName, dirtyTextEdit = false, documentModified = false } = {}) {
    if (!documentId) return Promise.resolve('cancel');
    const existing = pendingByOwner.get(documentId);
    if (existing) return existing.promise;

    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const entry = {
      dialogId: null,
      promise,
      settled: false,
      settle(requestedAction) {
        if (entry.settled) return false;
        entry.settled = true;
        const action = VALID_ACTIONS.has(requestedAction) ? requestedAction : 'cancel';
        if (pendingByOwner.get(documentId) === entry) pendingByOwner.delete(documentId);
        if (entry.dialogId) close(entry.dialogId);
        resolvePromise(action);
        return true;
      },
    };
    pendingByOwner.set(documentId, entry);
    try {
      entry.dialogId = open(`unsaved-close:${documentId}:${++nextPromptId}`, {
        documentId,
        fileName: fileName || 'Untitled.pdf',
        dirtyTextEdit: dirtyTextEdit === true,
        documentModified: documentModified === true,
        settle: entry.settle,
      });
    } catch (error) {
      pendingByOwner.delete(documentId);
      entry.settled = true;
      resolvePromise('cancel');
      throw error;
    }
    return promise;
  }

  return {
    request,
    hasPending(documentId) {
      return pendingByOwner.has(documentId);
    },
  };
}

const unsavedClosePrompts = createUnsavedClosePromptCoordinator();

export function showUnsavedClosePrompt(options) {
  return unsavedClosePrompts.request(options);
}
