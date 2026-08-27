/**
 * Return whether an owner document still has state that must cross the PDF
 * persistence boundary. `modified` covers ordinary annotations, metadata,
 * forms, pages, and owned rich text; the explicit OCR/scanned fields keep the
 * decision fail-closed if a caller has not synchronized the generic flag yet.
 */
export function documentHasPendingPersistence(documentState) {
  if (!documentState) return false;
  if (documentState.modified === true || documentState.ocr?.dirty === true) return true;
  if (documentState.scannedTextEditRemovalPending === true) return true;
  const scannedRevision = Number(documentState.scannedTextEdits?.stateRevision ?? 0);
  const persistedScannedRevision = Number(documentState.scannedTextEditPersistedRevision ?? 0);
  return scannedRevision !== persistedScannedRevision;
}

/**
 * An ordinary Save with no intervening mutation is a real no-op. Re-running
 * pdf-lib would otherwise append replacement indirect objects even when their
 * logical contents are identical, defeating byte-for-byte repeat-save
 * idempotence. Explicit Save As and pending save targets must still serialize.
 */
export function canSkipUnmodifiedSamePathSave({
  documentState,
  currentPath,
  outputPath,
  saveAsPath = null,
}) {
  return Boolean(
    documentState
    && currentPath
    && outputPath === currentPath
    && !saveAsPath
    && !documentState.saveTargetPath
    && documentState.isUntitled !== true
    && !documentHasPendingPersistence(documentState),
  );
}
