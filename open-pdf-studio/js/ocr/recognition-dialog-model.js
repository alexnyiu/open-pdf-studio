// @ts-check

import { DEFAULT_OCR_CACHE_MAX_BYTES } from './cache.js';
import { DEFAULT_OCR_RECOGNITION_OPTIONS } from './application-request.js';
import {
  resolveOcrPageScope,
  resolveOcrRecognitionPolicy,
} from './workflow-action.js';
import { OCR_CONTRACT_LIMITS } from './contracts/validation.js';

// The accepted macOS v2 quality report recorded this peak serialized result.
// Add the full geometry-contract allowance so the dialog does not understate
// cache impact for pages with unusually rich geometry.
export const APPROVED_OCR_BENCHMARK_PEAK_RESULT_BYTES = 32_670;
export const OCR_CACHE_ESTIMATE_BYTES_PER_PAGE =
  APPROVED_OCR_BENCHMARK_PEAK_RESULT_BYTES + OCR_CONTRACT_LIMITS.maxPageGeometryBytes;

export const CORE_OCR_RECOGNITION_UI_PROFILE = Object.freeze({
  recognitionMode: 'automatic-multilingual',
  specificLanguageSelection: false,
  automaticOrientation: false,
  deskew: false,
  offline: true,
});

/** @param {unknown} value */
function pageNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return Number.NaN;
  return Number(value);
}

/**
 * Validate exactly the page-scope shape accepted by the production action.
 * @param {{scopeKind: string, startPage?: unknown, endPage?: unknown, currentPage: number, pageCount: number}} input
 */
export function resolveOcrDialogPageSelection(input) {
  /** @type {import('../types/ocr.js').OcrPageScope} */
  let pageScope;
  if (input.scopeKind === 'current-page') {
    pageScope = { kind: 'current-page' };
  } else if (input.scopeKind === 'entire-document') {
    pageScope = { kind: 'entire-document' };
  } else if (input.scopeKind === 'range') {
    pageScope = {
      kind: 'range',
      startPage: pageNumber(input.startPage),
      endPage: pageNumber(input.endPage),
    };
  } else {
    throw Object.assign(new Error('The selected OCR page scope is unsupported'), {
      code: 'OCR_PAGE_SCOPE_INVALID', retryable: false,
    });
  }
  const pageNumbers = resolveOcrPageScope(pageScope, {
    currentPage: input.currentPage,
    pageCount: input.pageCount,
  });
  return { pageScope, pageNumbers };
}

/**
 * Build only options accepted by the bundled production core pack.
 * @param {{existingText?: 'skip'|'force-rerun', keepCompletedPages?: boolean}} [input]
 */
export function resolveOcrDialogRecognitionPolicy(input = {}) {
  return resolveOcrRecognitionPolicy({
    existingText: input.existingText ?? 'skip',
    keepCompletedPages: input.keepCompletedPages !== false,
    useCache: true,
    maximumRetries: 1,
    recognitionOptions: DEFAULT_OCR_RECOGNITION_OPTIONS,
  });
}

/** @param {any} modelState */
export function ocrModelPackAssetBytes(modelState) {
  if (modelState?.status !== 'installed' || !modelState.manifest?.assets) return 0;
  return Object.values(modelState.manifest.assets).reduce((total, asset) => {
    const bytes = Number(asset?.bytes);
    return total + (Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0);
  }, 0);
}

/**
 * A conservative estimate, not a promise: approved benchmark peak result size
 * plus the maximum page-geometry envelope, bounded by the production cache cap.
 * @param {{pageCount: number, modelState: any}} input
 */
export function estimateOcrStorageImpact({ pageCount, modelState }) {
  const selectedPages = Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : 0;
  return {
    modelPackBytes: ocrModelPackAssetBytes(modelState),
    estimatedCacheBytes: Math.min(
      DEFAULT_OCR_CACHE_MAX_BYTES,
      selectedPages * OCR_CACHE_ESTIMATE_BYTES_PER_PAGE,
    ),
    cacheMaximumBytes: DEFAULT_OCR_CACHE_MAX_BYTES,
    selectedPages,
  };
}
