import { getDocumentById } from '../../core/state.js';
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
export const documentSaveDebugSnapshot = (documentId) => controller.debugSnapshot(documentId);
