// @ts-check

import { executeForDocument } from '../core/undo-manager.js';
import {
  OPEN_PDF_STUDIO_OCR_OWNER,
  acceptOcrLineCorrection,
  clearOpenPdfStudioOcrPage,
  sameOcrState,
  selectOcrCommandSnapshot,
  snapshotOcrCommandState,
} from './document-state.js';

let operationSequence = 0;

function operationId(kind) {
  operationSequence += 1;
  return `ocr-${kind}-${Date.now()}-${operationSequence}`;
}

/**
 * Record results already applied by a multi-page job as one typed compound
 * command. The caller captures `before` before page attempts begin.
 * @param {any} document
 * @param {ReturnType<typeof snapshotOcrCommandState>} before
 * @param {number[]} appliedPageNumbers
 */
export function recordAppliedOcrCompound(document, before, appliedPageNumbers) {
  const pages = [...new Set(appliedPageNumbers)].sort((left, right) => left - right);
  if (pages.length === 0) return null;
  const selectedBefore = selectOcrCommandSnapshot(before, pages);
  const after = snapshotOcrCommandState(document, pages);
  if (sameOcrState(selectedBefore, after)) return null;
  const command = {
    type: 'ocrApplyCompound',
    operationId: operationId('apply'),
    pageNumbers: pages,
    before: selectedBefore,
    after,
  };
  executeForDocument(document, command);
  return command;
}

/**
 * Correct one recognized line through a typed page-level command.
 * @param {any} document
 * @param {number} pageNumber
 * @param {string} lineId
 * @param {string} correctedText
 */
export function correctRecognizedOcrText(document, pageNumber, lineId, correctedText) {
  const before = snapshotOcrCommandState(document, [pageNumber]);
  const correction = acceptOcrLineCorrection(document, pageNumber, lineId, correctedText);
  const after = snapshotOcrCommandState(document, [pageNumber]);
  if (sameOcrState(before, after)) return correction;
  executeForDocument(document, {
    type: 'ocrCorrectPage',
    operationId: operationId('correct'),
    pageNumbers: [pageNumber],
    pageNumber,
    lineId,
    before,
    after,
  });
  return correction;
}

/**
 * Remove only Open PDF Studio-owned OCR through a typed command.
 * @param {any} document
 * @param {number[]} [pageNumbers]
 */
export function removeApplicationOwnedOcr(document, pageNumbers = []) {
  const candidates = pageNumbers.length > 0
    ? pageNumbers
    : Object.keys(document?.ocr?.pages ?? {}).map(Number);
  const ownedPages = [...new Set(candidates)]
    .filter((pageNumber) => document?.ocr?.pages?.[pageNumber]?.recognition?.ownership?.owner ===
      OPEN_PDF_STUDIO_OCR_OWNER)
    .sort((left, right) => left - right);
  if (ownedPages.length === 0) return { removed: 0, command: null };
  const before = snapshotOcrCommandState(document, ownedPages);
  const removed = ownedPages.reduce(
    (count, pageNumber) => count + (clearOpenPdfStudioOcrPage(document, pageNumber) ? 1 : 0),
    0,
  );
  const after = snapshotOcrCommandState(document, ownedPages);
  const command = {
    type: 'ocrRemoveOwned',
    operationId: operationId('remove'),
    pageNumbers: ownedPages,
    before,
    after,
  };
  executeForDocument(document, command);
  return { removed, command };
}
