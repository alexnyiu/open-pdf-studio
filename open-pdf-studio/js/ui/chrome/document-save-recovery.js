import { getDocumentById } from '../../core/state.js';
import { saveFileDialog, writeBinaryFile } from '../../core/platform.js';
import { revealInFileManager } from '../../core/file-manager-reveal.js';
import { showMessage } from '../../solid/stores/dialogStore.js';
import {
  documentHasRevisionPersistenceDebt,
  initializeDocumentRevisionState,
  markDocumentSaveState,
} from '../../core/document-revision-state.runtime.js';
import { createDocumentSaveRecoveryController } from './document-save-status.js';

const controller = createDocumentSaveRecoveryController({
  resolveDocumentById: getDocumentById,
  requestSave: async ({ documentId, documentGeneration }) => {
    const { retryDocumentSave } = await import('../../pdf/saver.js');
    return retryDocumentSave(documentId, documentGeneration);
  },
  requestRefresh: async ({ documentId, documentGeneration }) => {
    const { retryDocumentRefresh } = await import('../../pdf/saver.js');
    return retryDocumentRefresh(documentId, documentGeneration);
  },
  requestReopen: async ({ documentId, documentGeneration }) => {
    const { reopenPersistedDocument } = await import('../../pdf/loader.js');
    return reopenPersistedDocument(documentId, documentGeneration);
  },
});

export const acknowledgeSaveStatus = (documentId) => controller.acknowledge(documentId);
export const retrySaveForDocument = (documentId) => controller.retrySave(documentId);
export const retryRefreshForDocument = (documentId) => controller.retryRefresh(documentId);
export const reopenSavedDocument = (documentId) => controller.reopen(documentId);
export const continueUsingOwnerPublishedPage = (documentId) => controller.continueCurrent(documentId);
export const documentSaveDebugSnapshot = (documentId) => controller.debugSnapshot(documentId);

export async function saveAsForDocument(documentId) {
  const documentState = getDocumentById(String(documentId || ''));
  if (!documentState) return false;
  const { savePDFAs } = await import('../../pdf/saver.js');
  return savePDFAs({
    expectedDocumentId: documentState.id,
    expectedDocumentGeneration: documentState.lifecycleGeneration,
  });
}

export async function listPendingSafeSaveCleanups() {
  const { listPendingMacosSafeSaveCleanups } = await import('../../pdf/macos-safe-save.js');
  return listPendingMacosSafeSaveCleanups();
}

export function revealSaveRecoveryFile(recoveryPath) {
  return revealInFileManager(recoveryPath);
}

export async function retrySaveRecoveryCleanup(recoveryPath, documentId = null) {
  const { retryPendingMacosSafeSaveCleanup } = await import('../../pdf/macos-safe-save.js');
  const result = await retryPendingMacosSafeSaveCleanup(recoveryPath);
  const documentState = documentId ? getDocumentById(String(documentId)) : null;
  if (documentState && ['cleaned', 'already-clean'].includes(result?.status)) {
    const revision = initializeDocumentRevisionState(documentState);
    const warnings = revision.lastSaveWarnings.filter(
      (warning) => warning?.path !== recoveryPath,
    );
    const nextState = warnings.length > 0
      ? 'saved-with-warning'
      : documentHasRevisionPersistenceDebt(documentState)
        ? 'pending'
        : revision.livePdfRevision < revision.persistedRevision
          ? 'saved-refresh-pending'
          : 'saved';
    markDocumentSaveState(documentState, nextState, { warnings });
  }
  return result;
}

function saveDetailsPayload(documentId, statusModel = null) {
  return Object.freeze({
    capturedAt: new Date().toISOString(),
    status: statusModel ? { ...statusModel } : null,
    revision: documentId ? controller.debugSnapshot(documentId) : null,
  });
}

export function viewSaveDetails(documentId, statusModel = null) {
  const details = JSON.stringify(saveDetailsPayload(documentId, statusModel), null, 2);
  showMessage(details, 'Save details');
  return details;
}

export async function exportSaveDetails(documentId, statusModel = null) {
  const target = await saveFileDialog('Open-PDF-Studio-save-details.json', [
    { name: 'JSON', extensions: ['json'] },
  ]);
  if (!target) return false;
  const details = JSON.stringify(saveDetailsPayload(documentId, statusModel), null, 2);
  await writeBinaryFile(target, new TextEncoder().encode(details));
  return true;
}
