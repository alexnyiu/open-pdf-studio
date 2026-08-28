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

/** The persistence path may begin only after this document's live draft commits. */
export async function textEditCommitAllowsSave(documentState, reason, commitForDocument) {
  if (!documentState?.id) return true;
  if (typeof commitForDocument !== 'function') {
    throw new TypeError('Saving requires a document-scoped text-edit commit barrier');
  }
  return (await commitForDocument(documentState.id, reason)) === true;
}

/**
 * Reactive stores may return a different proxy identity after an async commit.
 * A save stays bound to the immutable document ID and lifecycle generation,
 * rather than the JavaScript wrapper object observed before the await.
 */
export function documentLifecycleOwnerMatches(ownerDocument, currentDocument) {
  if (!ownerDocument || !currentDocument) return false;
  return String(currentDocument.id) === String(ownerDocument.id)
    && (Number(currentDocument.lifecycleGeneration) || 0)
      === (Number(ownerDocument.lifecycleGeneration) || 0);
}

const OUTLOOK_TEMP_PATH = /[\\/]INetCache[\\/]Content\.Outlook[\\/]|Microsoft\.OutlookForWindows/i;

/**
 * Click-away may persist automatically only when the document already owns a
 * normal user-visible file target. A document using an application-owned
 * render-temporary file is still eligible when `saveTargetPath` points back to
 * its normal original. Untitled, Outlook-locked, and known PDF/A documents keep
 * their committed in-memory edit and require the explicit Save As flow instead
 * of opening a surprise picker or replacing a protected original.
 */
export function canAutoSaveCommittedTextEdit(documentState) {
  if (!documentState?.id || documentState.isUntitled === true) return false;
  const targetPath = documentState.saveTargetPath || documentState.filePath;
  if (!targetPath) return false;
  if (documentState._renderTemp === true && !documentState.saveTargetPath) return false;
  if (documentState.pdfaCompliance) return false;
  return !OUTLOOK_TEMP_PATH.test(String(targetPath));
}
