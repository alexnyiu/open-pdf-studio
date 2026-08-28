function revisionNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function captureSemanticRevisionIdentity(documentState) {
  if (!documentState?.id || !documentState.pdfDoc) return null;
  return Object.freeze({
    documentId: String(documentState.id),
    lifecycleGeneration: revisionNumber(documentState.lifecycleGeneration),
    pdfDocument: documentState.pdfDoc,
    contentRevision: revisionNumber(documentState.revisionState?.contentRevision),
    livePdfRevision: revisionNumber(documentState.revisionState?.livePdfRevision),
  });
}

export function semanticRevisionIdentityIsCurrent(revisionIdentity, documentState) {
  return Boolean(revisionIdentity && documentState
    && String(documentState.id) === revisionIdentity.documentId
    && revisionNumber(documentState.lifecycleGeneration) === revisionIdentity.lifecycleGeneration
    && documentState.pdfDoc === revisionIdentity.pdfDocument
    && revisionNumber(documentState.revisionState?.contentRevision) === revisionIdentity.contentRevision
    && revisionNumber(documentState.revisionState?.livePdfRevision) === revisionIdentity.livePdfRevision);
}
