/** Pure lifecycle boundary shared by the application wrapper and unit tests. */
export function advanceDocumentLifecycleState(
  documentState,
  reason = 'pdf-content-replaced',
  cancelForDocument = () => false,
) {
  if (!documentState) return 0;
  cancelForDocument(documentState.id, reason);
  documentState.lifecycleGeneration = (Number(documentState.lifecycleGeneration) || 0) + 1;
  return documentState.lifecycleGeneration;
}

export function replaceDocumentPdfProxyState(
  documentState,
  nextPdfDocument,
  reason = 'pdf-proxy-replaced',
  cancelForDocument = () => false,
) {
  if (!documentState) throw new TypeError('Document state is required');
  const previous = documentState.pdfDoc;
  advanceDocumentLifecycleState(documentState, reason, cancelForDocument);
  documentState.pdfDoc = nextPdfDocument;
  return previous;
}
