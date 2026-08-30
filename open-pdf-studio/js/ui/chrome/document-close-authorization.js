import { initializeDocumentRevisionState } from '../../core/document-revision-state.runtime.js';
import { saveResultAllowsClose } from '../../pdf/save-result.js';

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
      if (typeof saveDocument !== 'function') {
        throw new TypeError('saveDocument is required for the Save action');
      }
      // The owner-scoped save coordinator performs the text-edit commit
      // barrier, promotes that final revision into the request, and flushes it
      // immediately. Close is authorized only by a durable typed result for
      // the latest post-commit revision.
      const result = await saveDocument(documentState);
      const latestRevision = initializeDocumentRevisionState(documentState).contentRevision;
      if (!saveResultAllowsClose(result, latestRevision)
          || documentState.ocr?.dirty === true) return false;
    }
  }

  // This is deliberately the first editor mutation. A Cancel decision or
  // failed Save returns above and leaves the complete transient draft intact.
  cancelTextEditingForDocument(documentState.id, 'document-close');
  return true;
}
