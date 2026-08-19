import { createSignal } from 'solid-js';
import { getActiveDocument } from '../../core/state.js';
import { undo, redo } from '../../core/undo-manager.js';
import {
  correctRecognizedOcrText,
  removeApplicationOwnedOcr,
} from '../../ocr/undo-commands.js';
import {
  DEFAULT_OCR_LOW_CONFIDENCE_THRESHOLD,
  getLowConfidenceOcrReviewItems,
  getNextOcrReviewItem,
  getOcrReviewPage,
  getOcrReviewWarningItems,
  getOwnedOcrReviewPageNumbers,
} from '../../ocr/review-model.js';
import {
  DEFAULT_OCR_WORKFLOW_RECOGNITION_POLICY,
} from '../../ocr/workflow-action.js';
import {
  activeDocumentOcrWorkflow,
  startOcrFromApplicationAction,
} from './ocrWorkflowStore.js';

const OCR_REVIEW_COMMAND_TYPES = new Set([
  'ocrApplyCompound',
  'ocrCorrectPage',
  'ocrRemoveOwned',
]);

const [lowConfidenceOnly, setLowConfidenceOnlySignal] = createSignal(false);
const [selectedLinesByDocument, setSelectedLinesByDocument] = createSignal({});
const [warningCursorsByDocument, setWarningCursorsByDocument] = createSignal({});
const [lowConfidenceCursorsByDocument, setLowConfidenceCursorsByDocument] = createSignal({});
const [announcement, setAnnouncement] = createSignal('');

function setDocumentValue(setter, documentId, value) {
  setter((current) => ({ ...current, [documentId]: value }));
}

export { lowConfidenceOnly as ocrReviewLowConfidenceOnly };
export { announcement as ocrReviewAnnouncement };

export function setOcrReviewLowConfidenceOnly(value) {
  setLowConfidenceOnlySignal(value === true);
}

export function announceOcrReview(message) {
  const text = typeof message === 'string' ? message : '';
  setAnnouncement('');
  queueMicrotask(() => setAnnouncement(text));
}

export function activeOcrReviewDocument() {
  return getActiveDocument();
}

export function activeOcrReviewPage() {
  const document = getActiveDocument();
  const pageNumber = document?.currentPage ?? 1;
  return document ? getOcrReviewPage(document, pageNumber) : null;
}

export function visibleOcrReviewLines() {
  const review = activeOcrReviewPage();
  if (!review) return [];
  return lowConfidenceOnly() ? review.lowConfidenceLines : review.lines;
}

export function selectedOcrReviewLineId() {
  const documentId = getActiveDocument()?.id;
  return documentId ? selectedLinesByDocument()[documentId] ?? null : null;
}

export function selectOcrReviewLine(lineId) {
  const documentId = getActiveDocument()?.id;
  if (!documentId) return false;
  setDocumentValue(setSelectedLinesByDocument, documentId, lineId ?? null);
  return true;
}

export async function navigateToOcrReviewPage(pageNumber, { lineId = null, status = null } = {}) {
  const document = getActiveDocument();
  const pageCount = document?.pdfDoc?.numPages ?? 0;
  if (!document || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
    return false;
  }
  const { goToPage } = await import('../../pdf/renderer.js');
  await goToPage(pageNumber);
  selectOcrReviewLine(lineId);
  announceOcrReview(status ?? `OCR review page ${pageNumber} of ${pageCount}`);
  return true;
}

export async function navigateToNextOcrReviewWarning() {
  const document = getActiveDocument();
  if (!document) return null;
  const items = getOcrReviewWarningItems(document);
  const next = getNextOcrReviewItem(items, warningCursorsByDocument()[document.id]);
  if (!next) {
    announceOcrReview('No OCR warnings in this document');
    return null;
  }
  setDocumentValue(setWarningCursorsByDocument, document.id, next.key);
  await navigateToOcrReviewPage(next.pageNumber, {
    lineId: next.lineId,
    status: `OCR warning on page ${next.pageNumber}: ${next.message}`,
  });
  return next;
}

export async function navigateToNextLowConfidenceOcrItem() {
  const document = getActiveDocument();
  if (!document) return null;
  const items = getLowConfidenceOcrReviewItems(document, {
    lowConfidenceThreshold: DEFAULT_OCR_LOW_CONFIDENCE_THRESHOLD,
  });
  const next = getNextOcrReviewItem(items, lowConfidenceCursorsByDocument()[document.id]);
  if (!next) {
    announceOcrReview('No low-confidence OCR text in this document');
    return null;
  }
  setDocumentValue(setLowConfidenceCursorsByDocument, document.id, next.key);
  await navigateToOcrReviewPage(next.pageNumber, {
    lineId: next.lineId,
    status: `Low-confidence OCR text on page ${next.pageNumber}, ${next.confidencePercent} percent`,
  });
  return next;
}

export function acceptActiveOcrReviewCorrection(lineId, correctedText) {
  const document = getActiveDocument();
  if (!document) throw new TypeError('OCR review requires an active document');
  const pageNumber = document.currentPage;
  const correction = correctRecognizedOcrText(document, pageNumber, lineId, correctedText);
  selectOcrReviewLine(lineId);
  announceOcrReview(`Accepted OCR correction on page ${pageNumber}`);
  return correction;
}

export async function rerunActiveOcrReviewPage() {
  const document = getActiveDocument();
  const review = activeOcrReviewPage();
  if (!document?.pdfDoc || !review) throw new TypeError('OCR review requires an active PDF page');
  if (!getOwnedOcrReviewPageNumbers(document).includes(document.currentPage)) {
    throw Object.assign(new Error('Only Open PDF Studio-owned OCR can be force-rerun'), {
      code: 'OCR_RERUN_UNOWNED', retryable: false,
    });
  }
  const currentWorkflow = activeDocumentOcrWorkflow();
  if (currentWorkflow && currentWorkflow.finishedAt === null) {
    throw Object.assign(new Error('OCR is already running for this document'), {
      code: 'OCR_DOCUMENT_JOB_ACTIVE', retryable: false,
    });
  }
  const recognitionPolicy = structuredClone(DEFAULT_OCR_WORKFLOW_RECOGNITION_POLICY);
  recognitionPolicy.existingText = 'force-rerun';
  recognitionPolicy.useCache = false;
  recognitionPolicy.keepCompletedPages = true;
  const handle = await startOcrFromApplicationAction({
    pageScope: { kind: 'current-page' },
    recognitionPolicy,
  });
  announceOcrReview(`Rerunning OCR on page ${document.currentPage}`);
  return handle;
}

export function removeActiveOcrReviewPage() {
  const document = getActiveDocument();
  if (!document) return { removed: 0, command: null };
  const pageNumber = document.currentPage;
  const result = removeApplicationOwnedOcr(document, [pageNumber]);
  if (result.removed > 0) {
    selectOcrReviewLine(null);
    announceOcrReview(`Removed Open PDF Studio OCR from page ${pageNumber}`);
  }
  return result;
}

export function removeActiveOcrReviewDocument() {
  const document = getActiveDocument();
  if (!document) return { removed: 0, command: null };
  const result = removeApplicationOwnedOcr(document);
  if (result.removed > 0) {
    selectOcrReviewLine(null);
    announceOcrReview(`Removed Open PDF Studio OCR from ${result.removed} pages`);
  }
  return result;
}

export function canUndoOcrReviewAction() {
  const command = getActiveDocument()?.undoStack?.at(-1);
  return OCR_REVIEW_COMMAND_TYPES.has(command?.type);
}

export function canRedoOcrReviewAction() {
  const command = getActiveDocument()?.redoStack?.at(-1);
  return OCR_REVIEW_COMMAND_TYPES.has(command?.type);
}

export async function undoOcrReviewAction() {
  if (!canUndoOcrReviewAction()) return false;
  await undo();
  announceOcrReview('Undid OCR review action');
  return true;
}

export async function redoOcrReviewAction() {
  if (!canRedoOcrReviewAction()) return false;
  await redo();
  announceOcrReview('Redid OCR review action');
  return true;
}
