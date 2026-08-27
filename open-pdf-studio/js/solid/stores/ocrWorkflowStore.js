import { createSignal } from 'solid-js';
import { getActiveDocument, state } from '../../core/state.js';
import {
  DEFAULT_OCR_PAGE_SCOPE,
  DEFAULT_OCR_WORKFLOW_RECOGNITION_POLICY,
  isMacOcrProductionRuntime,
  retryDocumentOcr,
  startActiveDocumentOcr,
  startDocumentOcr,
} from '../../ocr/workflow-action.js';
import { cancelOcrWorkflow, ocrWorkflowService } from '../../ocr/workflow-service.js';

const [workflowSnapshot, setWorkflowSnapshot] = createSignal(ocrWorkflowService.snapshot());
const [modelPackState, setModelPackState] = createSignal(ocrWorkflowService.modelStatus());
const [selectedPageScope, setSelectedPageScopeSignal] = createSignal(DEFAULT_OCR_PAGE_SCOPE);
const [selectedRecognitionPolicy, setSelectedRecognitionPolicySignal] = createSignal(
  DEFAULT_OCR_WORKFLOW_RECOGNITION_POLICY,
);
const [actionFailure, setActionFailure] = createSignal(null);
const [collapsedJobIds, setCollapsedJobIds] = createSignal(new Set());
const [dismissedJobIds, setDismissedJobIds] = createSignal(new Set());

ocrWorkflowService.subscribeUpdates((update) => {
  setWorkflowSnapshot((current) => {
    if (update.kind === 'snapshot') return update.snapshot;
    if (update.kind === 'progress') {
      const existing = current.jobsByDocumentId[update.documentId];
      if (!existing || existing.jobId !== update.jobId) return current;
      const changedPages = new Map(update.pages.map((page) => [page.pageNumber, page]));
      const job = {
        ...existing,
        status: update.status,
        progress: update.progress,
        pages: existing.pages.map((page) => changedPages.get(page.pageNumber) ?? page),
        counts: update.counts,
        currentPageNumber: update.currentPageNumber,
        currentPageState: update.currentPageState,
        failureDetails: update.failureDetails,
        cancellationAvailable: update.cancellationAvailable,
        cancellationRequested: update.cancellationRequested,
      };
      return {
        jobsByDocumentId: { ...current.jobsByDocumentId, [update.documentId]: job },
      };
    }
    const jobsByDocumentId = { ...current.jobsByDocumentId };
    if (update.job) jobsByDocumentId[update.documentId] = update.job;
    else delete jobsByDocumentId[update.documentId];
    return { jobsByDocumentId };
  });
  const snapshot = workflowSnapshot();
  const retainedJobIds = new Set(
    Object.values(snapshot.jobsByDocumentId).map((job) => job.jobId),
  );
  const retainKnownJobs = (current) => {
    const next = new Set([...current].filter((jobId) => retainedJobIds.has(jobId)));
    return next.size === current.size && [...next].every((jobId) => current.has(jobId))
      ? current
      : next;
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
  return ocrWorkflowForDocument(documentId);
}

export function ocrWorkflowForDocument(documentId) {
  return typeof documentId === 'string'
    ? workflowSnapshot().jobsByDocumentId[documentId] ?? null
    : null;
}

export function allOcrWorkflows() {
  return Object.values(workflowSnapshot().jobsByDocumentId)
    .sort((left, right) => {
      const leftTerminal = left.finishedAt === null ? 0 : 1;
      const rightTerminal = right.finishedAt === null ? 0 : 1;
      return leftTerminal - rightTerminal || right.startedAt.localeCompare(left.startedAt);
    });
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

export async function startOcrForDocument(documentId, options = {}) {
  setActionFailure(null);
  try {
    return await startDocumentOcr(documentId, {
      pageScope: options.pageScope ?? selectedPageScope(),
      recognitionPolicy: options.recognitionPolicy ?? selectedRecognitionPolicy(),
    });
  } catch (error) {
    setActionFailure({
      documentId,
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
  return cancelOcrForDocument(documentId);
}

export async function cancelOcrForDocument(documentId) {
  if (typeof documentId !== 'string' || documentId.length === 0) return null;
  return cancelOcrWorkflow(documentId, 'user-cancelled');
}

export async function retryOcrForDocument(documentId) {
  const job = ocrWorkflowForDocument(documentId);
  if (!ocrWorkflowHasRetryableFailure(job)) return null;
  setActionFailure(null);
  try {
    return await retryDocumentOcr(documentId);
  } catch (error) {
    setActionFailure({
      documentId,
      code: typeof error?.code === 'string' ? error.code : 'OCR_WORKFLOW_FAILED',
      retryable: error?.retryable === true,
    });
    throw error;
  }
}

export function retryOcrWorkflow(job) {
  return retryOcrForDocument(job?.documentId);
}

export async function navigateToOcrWorkflowDocument(documentId) {
  const index = state.documents.findIndex((document) => document.id === documentId);
  if (index < 0) return false;
  const { switchToTab } = await import('../../ui/chrome/tabs.js');
  switchToTab(index);
  return true;
}

export function dismissOcrWorkflowFailure() {
  setActionFailure(null);
}
