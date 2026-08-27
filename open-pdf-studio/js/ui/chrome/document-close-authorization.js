const CLOSE_ACTIONS = new Set(['save', 'dontsave', 'cancel']);

/**
 * Resolve the user's close decision before tearing down an owner-scoped text
 * editor. This small state machine is kept independent from the tab teardown
 * so cancellation ordering can be verified without a browser or PDF runtime.
 */
export async function authorizeDocumentClose({
  documentState,
  force = false,
  requestAction,
  saveDocument,
  isTextEditingDirtyForDocument = () => false,
  cancelTextEditingForDocument,
} = {}) {
  if (!documentState?.id) return false;
  if (typeof cancelTextEditingForDocument !== 'function') {
    throw new TypeError('cancelTextEditingForDocument is required');
  }

  const dirtyTextEdit = !force && isTextEditingDirtyForDocument(documentState.id) === true;
  if (!force && (documentState.modified || dirtyTextEdit)) {
    if (typeof requestAction !== 'function') {
      throw new TypeError('requestAction is required for unsaved document or editor changes');
    }
    const requestedAction = await requestAction({
      documentId: documentState.id,
      fileName: documentState.fileName || 'Untitled.pdf',
      dirtyTextEdit,
      documentModified: documentState.modified === true,
    });
    const action = CLOSE_ACTIONS.has(requestedAction) ? requestedAction : 'cancel';
    if (action === 'cancel') return false;
    if (action === 'save') {
      // A transient editor commits through visible Apply, its keyboard
      // shortcut, or a completed ordinary click-away. Save itself must never
      // imply Apply or discard an editor that is still active.
      if (dirtyTextEdit) return false;
      if (typeof saveDocument !== 'function') {
        throw new TypeError('saveDocument is required for the Save action');
      }
      const saved = await saveDocument(documentState);
      if (!saved || documentState.ocr?.dirty === true) return false;
    }
  }

  // This is deliberately the first editor mutation. A Cancel decision or
  // failed Save returns above and leaves the complete transient draft intact.
  cancelTextEditingForDocument(documentState.id, 'document-close');
  return true;
}
