// @ts-check

import {
  OPEN_PDF_STUDIO_OCR_OWNER,
  PENDING_OCR_STREAM,
  PERSISTED_OCR_STREAM,
} from './document-state.js';

export const DEFAULT_OCR_LOW_CONFIDENCE_THRESHOLD = 0.8;

/** @param {number} confidence @param {number} threshold */
export function classifyOcrReviewConfidence(
  confidence,
  threshold = DEFAULT_OCR_LOW_CONFIDENCE_THRESHOLD,
) {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { band: 'unknown', label: 'Unknown confidence', percent: null, low: true };
  }
  const low = confidence < threshold;
  return {
    band: low ? 'low' : confidence < 0.95 ? 'medium' : 'high',
    label: low ? 'Low confidence' : confidence < 0.95 ? 'Medium confidence' : 'High confidence',
    percent: Math.round(confidence * 100),
    low,
  };
}

/** @param {any} page */
function ownershipState(page) {
  if (!page?.recognition?.result || !page.recognition.ownership) {
    return page?.review?.dirty === true ? 'pending-removal' : 'none';
  }
  const ownership = page.recognition.ownership;
  if (ownership.owner !== OPEN_PDF_STUDIO_OCR_OWNER) return 'unowned';
  const saved = ownership.stream === PERSISTED_OCR_STREAM || ownership.persisted === true;
  if (saved && page.review?.dirty === true) return 'saved-with-pending-changes';
  if (saved) return 'saved';
  return 'pending';
}

/** @param {any} result @param {string} entityId */
function lineIdForEntity(result, entityId) {
  for (const line of result?.lines ?? []) {
    if (line.id === entityId) return line.id;
    if (line.words?.some((word) => word.id === entityId)) return line.id;
  }
  return null;
}

/** @param {any} page @param {number} pageNumber */
function pageIssues(page, pageNumber) {
  const result = page?.recognition?.result;
  const issues = [];
  const seen = new Set();
  /** @param {any} issue */
  const add = (issue) => {
    const signature = `${issue.kind}\u001f${issue.code}\u001f${issue.message}\u001f${issue.lineId ?? ''}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    issues.push({ ...issue, key: `ocr-issue-${pageNumber}-${issues.length + 1}` });
  };

  for (const warning of result?.warnings ?? page?.recognition?.warnings ?? []) {
    const entityIds = Array.isArray(warning.entityIds) ? [...warning.entityIds] : [];
    add({
      pageNumber,
      kind: 'warning',
      code: warning.code,
      message: warning.message,
      severity: warning.severity,
      entityIds,
      lineId: entityIds.map((id) => lineIdForEntity(result, id)).find(Boolean) ?? null,
    });
  }
  // Non-result failures keep their warnings in application state.
  if (result) {
    for (const warning of page?.recognition?.warnings ?? []) {
      const entityIds = Array.isArray(warning.entityIds) ? [...warning.entityIds] : [];
      add({
        pageNumber,
        kind: 'warning',
        code: warning.code,
        message: warning.message,
        severity: warning.severity,
        entityIds,
        lineId: entityIds.map((id) => lineIdForEntity(result, id)).find(Boolean) ?? null,
      });
    }
  }
  for (const reason of result?.unsupportedContentReasons ?? []) {
    add({
      pageNumber,
      kind: 'unsupported',
      code: reason.code,
      message: reason.message,
      severity: 'error',
      entityIds: [],
      lineId: null,
      reasonId: reason.id,
      polygon: reason.polygon ?? null,
    });
  }
  return issues;
}

/**
 * Builds a read-only review projection. Engine line order is retained exactly;
 * accepted text is overlaid from mutable review state without changing the
 * immutable result snapshot.
 * @param {any} document
 * @param {number} pageNumber
 * @param {{lowConfidenceThreshold?: number}} [options]
 */
export function getOcrReviewPage(document, pageNumber, options = {}) {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError('OCR review page number must be one-based');
  }
  const threshold = options.lowConfidenceThreshold ?? DEFAULT_OCR_LOW_CONFIDENCE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('OCR low-confidence threshold must be between 0 and 1');
  }
  const page = document?.ocr?.pages?.[pageNumber] ?? null;
  const result = page?.recognition?.result ?? null;
  const alternativesCapable = result?.engine?.capabilities?.alternatives === true;
  const issues = pageIssues(page, pageNumber);
  const lines = (result?.lines ?? []).map((line, readingOrder) => {
    const correction = page?.review?.corrections?.[line.id];
    const confidence = classifyOcrReviewConfidence(line.confidence, threshold);
    return {
      id: line.id,
      readingOrder,
      engineText: line.text,
      effectiveText: correction?.status === 'accepted' ? correction.correctedText : line.text,
      correction: correction?.status === 'accepted' ? correction : null,
      confidence: line.confidence,
      confidenceBand: confidence.band,
      confidenceLabel: confidence.label,
      confidencePercent: confidence.percent,
      lowConfidence: confidence.low,
      alternatives: alternativesCapable
        ? (Array.isArray(line.alternatives) ? line.alternatives.map((entry) => ({ ...entry })) : [])
        : null,
      warningCount: issues.filter((issue) => issue.lineId === line.id).length,
    };
  });
  const resultStatus = result?.page?.status ?? null;
  const owned = page?.recognition?.ownership?.owner === OPEN_PDF_STUDIO_OCR_OWNER;
  return {
    pageNumber,
    pageStatus: page?.status ?? 'idle',
    resultStatus,
    hasResult: result !== null,
    ownershipState: ownershipState(page),
    searchableEligible: owned && ['completed', 'partial'].includes(resultStatus),
    alternativesCapable,
    lines,
    lowConfidenceLines: lines.filter((line) => line.lowConfidence),
    warnings: issues.filter((issue) => issue.kind === 'warning'),
    unsupportedReasons: issues.filter((issue) => issue.kind === 'unsupported'),
    issues,
  };
}

/** @param {any} document */
function reviewPageNumbers(document) {
  return Object.keys(document?.ocr?.pages ?? {})
    .map(Number)
    .filter((pageNumber) => Number.isSafeInteger(pageNumber) && pageNumber > 0)
    .sort((left, right) => left - right);
}

/** @param {any} document */
export function getOwnedOcrReviewPageNumbers(document) {
  return reviewPageNumbers(document).filter((pageNumber) =>
    document.ocr.pages[pageNumber]?.recognition?.ownership?.owner === OPEN_PDF_STUDIO_OCR_OWNER);
}

/** @param {any} document @param {{lowConfidenceThreshold?: number}} [options] */
export function getOcrReviewWarningItems(document, options = {}) {
  return reviewPageNumbers(document).flatMap((pageNumber) =>
    getOcrReviewPage(document, pageNumber, options).issues);
}

/** @param {any} document @param {{lowConfidenceThreshold?: number}} [options] */
export function getLowConfidenceOcrReviewItems(document, options = {}) {
  return reviewPageNumbers(document).flatMap((pageNumber) =>
    getOcrReviewPage(document, pageNumber, options).lowConfidenceLines.map((line) => ({
      key: `ocr-low-confidence-${pageNumber}-${line.id}`,
      pageNumber,
      lineId: line.id,
      confidence: line.confidence,
      confidencePercent: line.confidencePercent,
    })));
}

/** @template {{key: string}} T @param {T[]} items @param {string | null | undefined} currentKey */
export function getNextOcrReviewItem(items, currentKey) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const currentIndex = items.findIndex((item) => item.key === currentKey);
  return items[(currentIndex + 1) % items.length];
}
