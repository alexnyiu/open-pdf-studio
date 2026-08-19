import { render } from 'solid-js/web';

import { state } from '/js/core/state.ts';
import { ocrWorkflowService } from '/js/ocr/workflow-service.js';
import DialogHost from '/js/solid/components/DialogHost.jsx';
import { openDialog } from '/js/solid/stores/dialogStore.js';

const documentId = 'ocr-recognition-ui-document';
const sourceDocument = {
  id: documentId,
  filePath: '/parent/recognition-ui.pdf',
  fileName: 'recognition-ui.pdf',
  pdfDoc: { numPages: 5 },
  currentPage: 2,
  ocr: {
    documentId,
    generation: 'ocr-recognition-ui-generation',
    revision: 3,
    pages: {},
    warnings: [],
    dirty: false,
  },
};
state.documents = [sourceDocument];
state.activeDocumentIndex = 0;

let receivedStart = null;
const completion = new Promise(() => {});
const retainedHandle = {
  jobId: 'ocr-recognition-ui-job',
  documentId,
  completion,
  cancel: async () => null,
  summary: () => ({
    jobId: 'ocr-recognition-ui-job',
    documentId,
    status: 'running',
    progress: 0,
    pages: [],
    startedAt: '2026-08-18T00:00:00.000Z',
  }),
};
ocrWorkflowService.controller.startDocumentJob = (options) => {
  receivedStart = options;
  return retainedHandle;
};

const root = document.getElementById('test-root');
render(() => <DialogHost />, root);
openDialog('recognize-text');

window.__ocrRecognitionHarness = {
  result() {
    return {
      receivedStart: receivedStart ? {
        pageNumbers: receivedStart.pageNumbers,
        force: receivedStart.force,
        keepCompletedPages: receivedStart.keepCompletedPages,
        languagePolicy: receivedStart.recognitionOptions.languagePolicy,
        orientation: receivedStart.recognitionOptions.orientation,
        deskew: receivedStart.recognitionOptions.deskew,
      } : null,
      retainedRealHandle: ocrWorkflowService.activeJobs.get(documentId)?.handle === retainedHandle,
    };
  },
};
window.__ocrHarnessReady = true;
