export function updateThumbnailDocumentOwner(previousState, documentState, pdfDocument) {
  if (!documentState?.id || !pdfDocument) {
    throw new TypeError('Thumbnail generation requires a document owner and PDF proxy');
  }
  const sameProxy = previousState?.pdfDoc === pdfDocument;
  return {
    pdfDoc: pdfDocument,
    // Background thumbnail renders must resolve paths, rotations, and
    // annotations against this immutable owner rather than the active tab.
    doc: documentState,
    numPages: Number(pdfDocument.numPages) || 0,
    nextPage: sameProxy ? previousState.nextPage : 1,
    startPage: sameProxy ? previousState.startPage : 1,
    wrapped: sameProxy ? previousState.wrapped : false,
  };
}
