// @ts-check

import { getActiveDocument } from '../core/state.js';
import { isTauri } from '../core/platform.js';
import {
  DEFAULT_OCR_RECOGNITION_OPTIONS,
  normalizeOcrRecognitionOptions,
} from './application-request.js';
import { ocrWorkflowService } from './workflow-service.js';

export const DEFAULT_OCR_PAGE_SCOPE = Object.freeze({ kind: 'current-page' });
export const DEFAULT_OCR_WORKFLOW_RECOGNITION_POLICY = Object.freeze({
  existingText: 'skip',
  keepCompletedPages: true,
  useCache: true,
  maximumRetries: 1,
  recognitionOptions: DEFAULT_OCR_RECOGNITION_OPTIONS,
});

function workflowError(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

/** The production action is deliberately absent outside a native macOS runtime. */
export function isMacOcrProductionRuntime() {
  if (!isTauri()) return false;
  try {
    const type = window.__TAURI__?.os?.type?.();
    return type === 'macos' || type === 'darwin';
  } catch {
    return false;
  }
}

/**
 * @param {import('../types/ocr.js').OcrPageScope} scope
 * @param {{currentPage: number, pageCount: number}} documentPages
 */
export function resolveOcrPageScope(scope, { currentPage, pageCount }) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw workflowError('OCR_PAGE_COUNT_INVALID', 'OCR requires the loaded PDF page count');
  }
  const selected = scope ?? DEFAULT_OCR_PAGE_SCOPE;
  if (selected.kind === 'current-page') {
    if (!Number.isSafeInteger(currentPage) || currentPage < 1 || currentPage > pageCount) {
      throw workflowError('OCR_CURRENT_PAGE_INVALID', 'The selected OCR page is unavailable');
    }
    return [currentPage];
  }
  if (selected.kind === 'entire-document') {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  if (selected.kind === 'range') {
    const start = selected.startPage;
    const end = selected.endPage;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > pageCount) {
      throw workflowError('OCR_PAGE_RANGE_INVALID', 'The selected OCR page range is invalid');
    }
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }
  throw workflowError('OCR_PAGE_SCOPE_INVALID', 'The selected OCR page scope is unsupported');
}

/** @param {Partial<import('../types/ocr.js').OcrWorkflowRecognitionPolicy>} [policy] */
export function resolveOcrRecognitionPolicy(policy = {}) {
  const existingText = policy.existingText ?? DEFAULT_OCR_WORKFLOW_RECOGNITION_POLICY.existingText;
  if (existingText !== 'skip' && existingText !== 'force-rerun') {
    throw workflowError('OCR_RECOGNITION_POLICY_INVALID', 'The selected OCR existing-text policy is unsupported');
  }
  const maximumRetries = policy.maximumRetries ?? DEFAULT_OCR_WORKFLOW_RECOGNITION_POLICY.maximumRetries;
  if (!Number.isSafeInteger(maximumRetries) || maximumRetries < 0 || maximumRetries > 3) {
    throw workflowError('OCR_RECOGNITION_POLICY_INVALID', 'The selected OCR retry policy is unsupported');
  }
  return {
    existingText,
    keepCompletedPages: policy.keepCompletedPages !== false,
    useCache: policy.useCache !== false,
    maximumRetries,
    // This normalizer rejects any policy the approved core model does not
    // support, so the UI bridge cannot broaden engine accuracy behavior.
    recognitionOptions: normalizeOcrRecognitionOptions(policy.recognitionOptions ?? {}),
  };
}

/**
 * Normal application entry point used by the macOS Organize ribbon action.
 * @param {{
 *   pageScope?: import('../types/ocr.js').OcrPageScope,
 *   recognitionPolicy?: Partial<import('../types/ocr.js').OcrWorkflowRecognitionPolicy>,
 *   workflow?: OcrWorkflowServiceLike,
 *   document?: any,
 * }} [options]
 */
export async function startActiveDocumentOcr(options = {}) {
  if (!isMacOcrProductionRuntime()) {
    throw workflowError('OCR_MACOS_ONLY', 'Production OCR is available on macOS only');
  }
  const workflow = options.workflow ?? ocrWorkflowService;
  const document = options.document ?? getActiveDocument();
  if (!document?.pdfDoc) {
    throw workflowError('OCR_DOCUMENT_UNAVAILABLE', 'OCR requires an active loaded PDF');
  }
  const pageCount = document.pdfDoc.numPages;
  const sourcePdfPath = document.filePath;
  if (typeof sourcePdfPath !== 'string' || sourcePdfPath.length === 0) {
    throw workflowError('OCR_SOURCE_PATH_UNAVAILABLE', 'OCR requires a parent-side source PDF path');
  }
  const pageScope = structuredClone(options.pageScope ?? DEFAULT_OCR_PAGE_SCOPE);
  const pageNumbers = resolveOcrPageScope(pageScope, {
    currentPage: document.currentPage,
    pageCount,
  });
  const recognitionPolicy = resolveOcrRecognitionPolicy(options.recognitionPolicy);
  const modelState = await workflow.requireCurrentModelState();
  return workflow.start({
    document,
    sourcePdfPath,
    pageNumbers,
    pageScope,
    recognitionPolicy,
    modelState,
    documentRevision: Number.isSafeInteger(document.ocr?.revision) ? document.ocr.revision : 0,
  });
}

/** @typedef {Pick<import('./workflow-service.js').OcrWorkflowService, 'requireCurrentModelState'|'start'>} OcrWorkflowServiceLike */
