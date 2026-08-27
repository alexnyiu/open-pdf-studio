function captureProperty(target, key) {
  return {
    present: Object.prototype.hasOwnProperty.call(target, key),
    value: target[key],
    arrayItems: Array.isArray(target[key]) ? [...target[key]] : null,
  };
}

function restoreProperty(target, key, snapshot) {
  if (!snapshot.present) {
    delete target[key];
    return;
  }
  if (snapshot.arrayItems) {
    snapshot.value.splice(0, snapshot.value.length, ...snapshot.arrayItems);
  }
  target[key] = snapshot.value;
}

export function textEditValidationReason(error) {
  if (!error || typeof error.code !== 'string'
      || error.code === 'SCANNED_TEXT_EDIT_OPERATION_INVALIDATED') return null;
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  return message || error.code;
}

/**
 * Run the synchronous owner mutation + undo-recording portion of Apply as one
 * recoverable transaction. A recorder is allowed to reject with `false` or to
 * throw after partially touching document history; either outcome restores
 * the prior history and asks the caller to restore its owner mutation.
 *
 * The live editor is deliberately outside this helper. Callers close it only
 * after this function returns `true`, so a failed Apply can retry the exact
 * same session and draft.
 */
export function runOwnerScopedTextCommit({
  ownerDocument,
  attempt,
  rollback = () => {},
} = {}) {
  if (!ownerDocument || typeof attempt !== 'function' || typeof rollback !== 'function') {
    return false;
  }
  const history = {
    undoStack: captureProperty(ownerDocument, 'undoStack'),
    redoStack: captureProperty(ownerDocument, 'redoStack'),
    savedUndoStackLength: captureProperty(ownerDocument, 'savedUndoStackLength'),
    modified: captureProperty(ownerDocument, 'modified'),
  };
  const restore = () => {
    try {
      rollback();
    } finally {
      restoreProperty(ownerDocument, 'undoStack', history.undoStack);
      restoreProperty(ownerDocument, 'redoStack', history.redoStack);
      restoreProperty(ownerDocument, 'savedUndoStackLength', history.savedUndoStackLength);
      restoreProperty(ownerDocument, 'modified', history.modified);
    }
  };

  try {
    if (attempt() === true) return true;
  } catch (error) {
    restore();
    throw error;
  }
  restore();
  return false;
}
