import { cancelTextEditingForDocument } from '../text/text-edit-session.js';
import { cancelApplicationOcrDocumentSync } from '../ocr/application-controller.js';
import { cancelCoordinatedDocumentSaves } from '../pdf/save-coordinator.js';
import { cancelCommittedTextPublicationsForDocument } from '../text/text-edit-publication.js';
import {
  LIFECYCLE_TRANSITION_POLICIES,
  advanceDocumentLifecycleState,
  replaceDocumentPdfProxyState,
} from './document-lifecycle-state.js';

function cancelTransientDocumentWork(documentId, policy) {
  cancelCommittedTextPublicationsForDocument(documentId);
  if (policy.cancelTextEditing) cancelTextEditingForDocument(documentId, policy.id);
  if (policy.cancelOcr) cancelApplicationOcrDocumentSync(documentId, policy.id);
  if (policy.cancelSaves) cancelCoordinatedDocumentSaves(documentId, null, policy.id);
}

/** Advance runtime ownership before replacing or detaching a document proxy. */
export function advanceDocumentLifecycle(
  doc,
  policy = LIFECYCLE_TRANSITION_POLICIES.CONTENT_REPLACEMENT,
) {
  return advanceDocumentLifecycleState(doc, policy, cancelTransientDocumentWork);
}

/** Install a new PDF.js proxy behind the document lifecycle boundary. */
export function replaceDocumentPdfProxy(
  doc,
  nextPdfDocument,
  policy = LIFECYCLE_TRANSITION_POLICIES.CONTENT_REPLACEMENT,
) {
  return replaceDocumentPdfProxyState(
    doc,
    nextPdfDocument,
    policy,
    cancelTransientDocumentWork,
  );
}

export { LIFECYCLE_TRANSITION_POLICIES };
