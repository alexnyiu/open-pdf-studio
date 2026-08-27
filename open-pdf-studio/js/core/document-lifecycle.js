import { cancelTextEditingForDocument } from '../text/text-edit-session.js';
import { cancelApplicationOcrDocumentSync } from '../ocr/application-controller.js';
import {
  advanceDocumentLifecycleState,
  replaceDocumentPdfProxyState,
} from './document-lifecycle-state.js';

function cancelTransientDocumentWork(documentId, reason) {
  cancelTextEditingForDocument(documentId, reason);
  cancelApplicationOcrDocumentSync(documentId, reason);
}

/** Advance runtime ownership before replacing or detaching a document proxy. */
export function advanceDocumentLifecycle(doc, reason = 'pdf-content-replaced') {
  return advanceDocumentLifecycleState(doc, reason, cancelTransientDocumentWork);
}

/** Install a new PDF.js proxy behind the document lifecycle boundary. */
export function replaceDocumentPdfProxy(doc, nextPdfDocument, reason = 'pdf-proxy-replaced') {
  return replaceDocumentPdfProxyState(
    doc,
    nextPdfDocument,
    reason,
    cancelTransientDocumentWork,
  );
}
