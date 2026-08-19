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
const [collapsedJobIds, setCollapsedJobIds] = createSignal(new Set());
const [dismissedJobIds, setDismissedJobIds] = createSignal(new Set());

ocrWorkflowService.subscribe((snapshot) => {
  setWorkflowSnapshot(snapshot);
  const retainedJobIds = new Set(
    Object.values(snapshot.jobsByDocumentId).map((job) => job.jobId),
  );
  const retainKnownJobs = (current) => {
    const next = new Set([...current].filter((jobId) => retainedJobIds.has(jobId)));
    return next.size === current.size ? current : next;
  };
  setCollapsedJobIds(retainKnownJobs);
  setDismissedJobIds(retainKnownJobs);
});
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

export function ocrWorkflowCollapsed(jobId) {
  return typeof jobId === 'string' && collapsedJobIds().has(jobId);
}

export function ocrWorkflowDismissed(jobId) {
  return typeof jobId === 'string' && dismissedJobIds().has(jobId);
}

export function collapseOcrWorkflow(jobId) {
  if (typeof jobId !== 'string') return;
  setCollapsedJobIds((current) => new Set(current).add(jobId));
}

export function expandOcrWorkflow(jobId) {
  if (typeof jobId !== 'string') return;
  setCollapsedJobIds((current) => {
    const next = new Set(current);
    next.delete(jobId);
    return next;
  });
}

export function dismissOcrWorkflow(jobId) {
  if (typeof jobId !== 'string') return false;
  const job = Object.values(workflowSnapshot().jobsByDocumentId)
    .find((entry) => entry.jobId === jobId);
  if (!job || job.finishedAt === null) return false;
  setDismissedJobIds((current) => new Set(current).add(jobId));
  return true;
}

export function ocrWorkflowHasRetryableFailure(job) {
  return job?.status === 'failed' && job?.finishedAt !== null &&
    job.failureDetails.some((failure) => failure.retryable === true);
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

export async function retryOcrWorkflow(job) {
  if (!ocrWorkflowHasRetryableFailure(job)) return null;
  setActionFailure(null);
  return startOcrFromApplicationAction({
    pageScope: structuredClone(job.pageScope),
    recognitionPolicy: structuredClone(job.recognitionPolicy),
  });
}

export function dismissOcrWorkflowFailure() {
  setActionFailure(null);
}
