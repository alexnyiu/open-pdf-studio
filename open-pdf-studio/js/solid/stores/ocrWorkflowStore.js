import { createSignal } from 'solid-js';
import { getActiveDocument } from '../../core/state.js';
import {
  DEFAULT_OCR_PAGE_SCOPE,
  DEFAULT_OCR_WORKFLOW_RECOGNITION_POLICY,
  isMacOcrProductionRuntime,
  startActiveDocumentOcr,
} from '../../ocr/workflow-action.js';
import { ocrWorkflowService } from '../../ocr/workflow-service.js';

const [workflowSnapshot, setWorkflowSnapshot] = createSignal(ocrWorkflowService.snapshot());
const [modelPackState, setModelPackState] = createSignal(ocrWorkflowService.modelStatus());
const [selectedPageScope, setSelectedPageScopeSignal] = createSignal(DEFAULT_OCR_PAGE_SCOPE);
const [selectedRecognitionPolicy, setSelectedRecognitionPolicySignal] = createSignal(
  DEFAULT_OCR_WORKFLOW_RECOGNITION_POLICY,
);
const [actionFailure, setActionFailure] = createSignal(null);

ocrWorkflowService.subscribe(setWorkflowSnapshot);
ocrWorkflowService.subscribeModelStatus(setModelPackState);

export { actionFailure as ocrWorkflowActionFailure };
export { modelPackState as ocrModelPackState };

export function ocrWorkflowAvailable() {
  return isMacOcrProductionRuntime();
}

export function activeDocumentOcrWorkflow() {
  const documentId = getActiveDocument()?.id;
  return documentId ? workflowSnapshot().jobsByDocumentId[documentId] ?? null : null;
}

export function setOcrPageScope(scope) {
  setSelectedPageScopeSignal(structuredClone(scope));
}

export function setOcrRecognitionPolicy(policy) {
  setSelectedRecognitionPolicySignal(structuredClone(policy));
}

export async function startOcrFromApplicationAction(options = {}) {
  setActionFailure(null);
  try {
    return await startActiveDocumentOcr({
      pageScope: options.pageScope ?? selectedPageScope(),
      recognitionPolicy: options.recognitionPolicy ?? selectedRecognitionPolicy(),
    });
  } catch (error) {
    setActionFailure({
      code: typeof error?.code === 'string' ? error.code : 'OCR_WORKFLOW_FAILED',
      retryable: error?.retryable === true,
    });
    throw error;
  }
}

export function refreshOcrModelPackState(options = {}) {
  return ocrWorkflowService.refreshModelStatus(options);
}

export async function cancelActiveDocumentOcr() {
  const documentId = getActiveDocument()?.id;
  if (!documentId) return null;
  return ocrWorkflowService.cancel(documentId, 'user-cancelled');
}

export function dismissOcrWorkflowFailure() {
  setActionFailure(null);
}
