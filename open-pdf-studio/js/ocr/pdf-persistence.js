// @ts-check

import * as pdfjsLib from 'pdfjs-dist';
import { getOwnedOcrTextItems } from './document-state.js';
import {
  inspectOwnedInvisibleOcrLayer,
  reconcileOwnedInvisibleOcrLayer,
  removeOwnedInvisibleOcrLayer,
} from './pdf-writer-proof.js';

export const OCR_PDF_APPROVED_FONT_URL = '/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf';
export const OCR_PDF_APPROVED_FONT_SHA256 = 'f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f';
export const OCR_PDFIUM_RENDER_SCALE = 2;
export const OCR_VISIBLE_PIXEL_TOLERANCE = Object.freeze({
  maxChangedPixelsPerPage: 0,
  maxChannelDelta: 0,
});

let approvedFontPromise = null;

export class OcrPdfCandidateValidationError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OcrPdfCandidateValidationError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @param {unknown} [cause] */
function fail(code, message, cause) {
  throw new OcrPdfCandidateValidationError(code, message, cause);
}

/** @param {unknown} value */
function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  fail('INVALID_BYTES', 'PDF candidate validation requires byte arrays');
}

/** @param {[number, number]} point */
function pointObject(point) {
  return { x: point[0], y: point[1] };
}

/** @param {any} item */
function writerLine(item) {
  const baselinePoints = item?.baseline?.points;
  const line = {
    id: item.lineId,
    text: item.text,
    direction: item.direction,
    readingOrder: item.readingOrder,
    polygon: {
      coordinateSpace: item.polygon.coordinateSpace,
      points: item.polygon.points.map(pointObject),
    },
    baseline: item?.baseline?.status === 'provided' && Array.isArray(baselinePoints) && baselinePoints.length >= 2
      ? {
          status: 'provided',
          provenance: item.baseline.provenance,
          coordinateSpace: item.baseline.coordinateSpace,
          start: pointObject(baselinePoints[0]),
          end: pointObject(baselinePoints[baselinePoints.length - 1]),
        }
      : {
          status: item?.baseline?.status || 'unavailable',
          provenance: item?.baseline?.provenance,
          coordinateSpace: item?.baseline?.coordinateSpace,
        },
  };
  if (Array.isArray(item.words) && item.words.length > 0) {
    line.words = item.words.map((word) => ({
      id: word.id,
      text: word.text,
      direction: word.direction,
      polygon: {
        coordinateSpace: word.polygon.coordinateSpace,
        points: word.polygon.points.map(pointObject),
      },
    }));
  }
  return line;
}

/** @param {any} document */
export function collectOwnedOcrWriterPages(document) {
  const livePages = Object.keys(document?.ocr?.pages || {})
    .map(Number)
    .filter((pageNumber) => Number.isSafeInteger(pageNumber) && pageNumber > 0)
    .sort((left, right) => left - right)
    .map((pageNumber) => ({
      pageIndex: pageNumber - 1,
      lines: getOwnedOcrTextItems(document, pageNumber).map(writerLine),
    }))
    .filter((page) => page.lines.length > 0);
  const byPage = new Map(livePages.map((page) => [page.pageIndex, page]));
  for (const page of document?.scannedTextEdits?.pages || []) {
    if (byPage.has(page.index) || !Array.isArray(page.searchableTextSnapshot)
        || page.searchableTextSnapshot.length === 0) continue;
    const edits = new Map(page.selections
      .filter((selection) => selection.repair?.status === 'applied'
        && selection.content?.scope === 'isolated-horizontal-line')
      .map((selection) => [selection.target.targetId, selection]));
    const regionEdits = page.selections.filter((selection) =>
      selection.repair?.status === 'applied'
        && selection.content?.scope === 'fixed-region-multiline');
    const regionBySourceLine = new Map();
    for (const selection of regionEdits) {
      for (const lineId of selection.target.lineIds) regionBySourceLine.set(lineId, selection);
    }
    const lines = page.searchableTextSnapshot.flatMap((line) => {
      const regionEdit = regionBySourceLine.get(line.lineId);
      if (regionEdit) {
        if (regionEdit.target.lineIds[0] !== line.lineId) return [];
        return regionEdit.content.searchableText.lines.map((outputLine) => writerLine({
          lineId: `${regionEdit.id}-line-${outputLine.index}`,
          text: outputLine.text,
          direction: 'ltr',
          readingOrder: line.readingOrder + outputLine.index,
          polygon: outputLine.polygon,
          baseline: outputLine.baseline,
          words: undefined,
        }));
      }
      const edit = edits.get(line.lineId);
      return [writerLine({
        ...line,
        text: edit?.content?.searchableText?.text ?? line.text,
        words: edit ? undefined : line.words,
      })];
    }).map((line, readingOrder) => ({ ...line, readingOrder }));
    byPage.set(page.index, { pageIndex: page.index, lines });
  }
  return [...byPage.values()].sort((left, right) => left.pageIndex - right.pageIndex);
}

/**
 * A dirty OCR page with no effective owned text is an explicit typed-state
 * removal. Pages absent from typed state are intentionally preserved: this is
 * essential after reopening a PDF whose older owned streams were not hydrated
 * into the current session.
 * @param {any} document
 */
export function collectOwnedOcrRemovalPageIndexes(document) {
  return Object.keys(document?.ocr?.pages || {})
    .map(Number)
    .filter((pageNumber) => Number.isSafeInteger(pageNumber) && pageNumber > 0)
    .filter((pageNumber) => document.ocr.pages[pageNumber]?.review?.dirty === true
      && getOwnedOcrTextItems(document, pageNumber).length === 0)
    .map((pageNumber) => pageNumber - 1)
    .sort((left, right) => left - right);
}

export async function loadApprovedOcrPdfFont() {
  if (!approvedFontPromise) {
    approvedFontPromise = (async () => {
      if (typeof fetch !== 'function') fail('APPROVED_FONT_UNAVAILABLE', 'The approved OCR PDF font cannot be loaded in this runtime');
      const response = await fetch(OCR_PDF_APPROVED_FONT_URL, { cache: 'force-cache' });
      if (!response.ok) fail('APPROVED_FONT_UNAVAILABLE', `Approved OCR PDF font returned HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    })().catch((error) => {
      approvedFontPromise = null;
      throw error;
    });
  }
  return (await approvedFontPromise).slice();
}

/** @param {Uint8Array} pdfBytes @returns {Promise<any>} */
async function openPdfJs(pdfBytes) {
  try {
    return await pdfjsLib.getDocument({
      data: pdfBytes.slice(),
      cMapUrl: '/pdfjs/web/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/web/standard_fonts/',
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypted/iu.test(message)) {
      fail('ENCRYPTED_PDF_UNSUPPORTED', 'Encrypted or password-protected PDFs cannot enter the OCR save path', error);
    }
    fail('PDFJS_REOPEN_FAILED', `PDF.js could not reopen the candidate: ${message}`, error);
  }
}

/** @param {any} document @param {number[]} pageIndexes */
async function extractedPageText(document, pageIndexes) {
  const result = new Map();
  for (const pageIndex of pageIndexes) {
    try {
      const content = await (await document.getPage(pageIndex + 1)).getTextContent();
      result.set(pageIndex, content.items.map((item) => item.str).filter(Boolean).join('\n'));
    } catch (error) {
      fail('PDFJS_EXTRACTION_FAILED', `PDF.js text extraction failed on page ${pageIndex + 1}`, error);
    }
  }
  return result;
}

/** @param {string} text @param {string} token */
function occurrenceCount(text, token) {
  if (!token) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(token, offset)) >= 0) {
    count += 1;
    offset += token.length;
  }
  return count;
}

/** @param {any} page */
function pageTokens(page) {
  const runs = page.lines.flatMap((line) => Array.isArray(line.words) && line.words.length > 0
    ? line.words.map((word) => word.text)
    : [line.text]);
  if (runs.length <= 6) return runs;
  const indexes = [0, 1, Math.floor(runs.length / 2), runs.length - 2, runs.length - 1];
  return [...new Set(indexes.map((index) => runs[index]))];
}

/** @param {any[]} writerPages */
function tokensByPage(writerPages) {
  const result = new Map();
  for (const page of writerPages) {
    const selected = pageTokens(page);
    const allRuns = page.lines.flatMap((line) => Array.isArray(line.words) && line.words.length > 0
      ? line.words.map((word) => word.text)
      : [line.text]);
    result.set(page.pageIndex, selected.map((token) => ({
      token,
      desiredOccurrences: allRuns.filter((value) => value === token).length,
    })));
  }
  return result;
}

/** @param {number[]} indexes @param {number} limit */
function sampledIndexes(indexes, limit) {
  const sorted = [...new Set(indexes)].sort((left, right) => left - right);
  if (sorted.length <= limit) return sorted;
  return [...new Set([sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]])];
}

/** @param {any} document */
export async function destroyPreparedPdfJsDocument(document) {
  try { await document?.destroy?.(); } catch (_) {}
}

/**
 * Opens ordinary non-OCR output before replacement, so the live PDF.js handle
 * can be swapped without a post-replacement parse failure.
 * @param {Uint8Array|ArrayBuffer} value
 * @param {number} expectedPageCount
 */
export async function preparePdfJsSaveCandidate(value, expectedPageCount) {
  const document = await openPdfJs(bytes(value));
  if (document.numPages !== expectedPageCount) {
    await destroyPreparedPdfJsDocument(document);
    fail('PAGE_COUNT_CHANGED', `Candidate page count ${document.numPages} does not match ${expectedPageCount}`);
  }
  return document;
}

/**
 * Builds and validates candidate bytes entirely before native replacement.
 * PDFium validation follows after the private same-volume files are written.
 * @param {{document?:any,baseBytes:Uint8Array|ArrayBuffer,fontBytes?:Uint8Array|ArrayBuffer,writerPages?:any[],removePageIndexes?:number[],expectedPageCount:number,modifiedAt?:string}} input
 */
export async function buildAndValidateOcrPdfCandidate(input) {
  const baseBytes = bytes(input.baseBytes);
  const writerPages = input.writerPages || collectOwnedOcrWriterPages(input.document);
  const removePageIndexes = input.removePageIndexes
    || collectOwnedOcrRemovalPageIndexes(input.document);
  const fontBytes = writerPages.length > 0
    ? bytes(input.fontBytes || await loadApprovedOcrPdfFont())
    : new Uint8Array();
  const existingInspection = await inspectOwnedInvisibleOcrLayer(baseBytes);
  const relevantPageIndexes = [...new Set([
    ...writerPages.map((page) => page.pageIndex),
    ...existingInspection.filter((page) => page.owned).map((page) => page.pageIndex),
  ])].sort((left, right) => left - right);
  if (relevantPageIndexes.length === 0 && input.expectedPageCount > 0) relevantPageIndexes.push(0);
  const writerInput = {
    fontBytes,
    fontSha256: OCR_PDF_APPROVED_FONT_SHA256,
    pages: writerPages,
    removePageIndexes,
    modifiedAt: input.modifiedAt,
  };

  const baselineWithoutOwned = await removeOwnedInvisibleOcrLayer({ pdfBytes: baseBytes });
  const candidateBytes = await reconcileOwnedInvisibleOcrLayer({ pdfBytes: baseBytes, ...writerInput });
  const repeatedBytes = await reconcileOwnedInvisibleOcrLayer({ pdfBytes: candidateBytes, ...writerInput });
  const removedBytes = await removeOwnedInvisibleOcrLayer({ pdfBytes: repeatedBytes });
  const candidateInspection = await inspectOwnedInvisibleOcrLayer(candidateBytes);
  const repeatedInspection = await inspectOwnedInvisibleOcrLayer(repeatedBytes);
  const desiredPageIndexes = new Set(
    existingInspection
      .filter((page) => page.owned && !removePageIndexes.includes(page.pageIndex))
      .map((page) => page.pageIndex),
  );
  writerPages.forEach((page) => desiredPageIndexes.add(page.pageIndex));

  for (const page of candidateInspection) {
    if (page.owned !== desiredPageIndexes.has(page.pageIndex)) {
      fail('OWNERSHIP_SET_MISMATCH', `Candidate ownership does not match typed OCR state on page ${page.pageIndex + 1}`);
    }
    if (page.owned && (page.renderingMode3Count !== 1 || page.textMatrixCount < 1 || page.showTextCount < 1)) {
      fail('INVALID_OWNED_STREAM', `Owned OCR stream on page ${page.pageIndex + 1} lacks canonical invisible text operators`);
    }
  }
  for (const page of repeatedInspection) {
    const first = candidateInspection[page.pageIndex];
    if (page.owned !== first.owned || page.contentRefs.length !== first.contentRefs.length) {
      fail('REPEATED_WRITE_DUPLICATED_STREAM', `Repeated OCR write changed the owned stream count on page ${page.pageIndex + 1}`);
    }
  }

  let baselineDocument;
  let candidateDocument;
  let repeatedDocument;
  let removedDocument;
  try {
    [baselineDocument, candidateDocument, repeatedDocument, removedDocument] = await Promise.all([
      openPdfJs(baselineWithoutOwned),
      openPdfJs(candidateBytes),
      openPdfJs(repeatedBytes),
      openPdfJs(removedBytes),
    ]);
    for (const [label, document] of [
      ['baseline', baselineDocument],
      ['candidate', candidateDocument],
      ['repeated', repeatedDocument],
      ['removed', removedDocument],
    ]) {
      if (document.numPages !== input.expectedPageCount) {
        fail('PAGE_COUNT_CHANGED', `${label} page count ${document.numPages} does not match ${input.expectedPageCount}`);
      }
    }

    const [baselineText, candidateText, repeatedText, removedText] = await Promise.all([
      extractedPageText(baselineDocument, relevantPageIndexes),
      extractedPageText(candidateDocument, relevantPageIndexes),
      extractedPageText(repeatedDocument, relevantPageIndexes),
      extractedPageText(removedDocument, relevantPageIndexes),
    ]);
    const selectedTokens = tokensByPage(writerPages);
    for (const [pageIndex, entries] of selectedTokens) {
      let orderOffset = 0;
      for (const entry of entries) {
        const baselineCount = occurrenceCount(baselineText.get(pageIndex) || '', entry.token);
        const expectedCount = baselineCount + entry.desiredOccurrences;
        const candidatePageText = candidateText.get(pageIndex) || '';
        if (occurrenceCount(candidatePageText, entry.token) !== expectedCount
          || occurrenceCount(repeatedText.get(pageIndex) || '', entry.token) !== expectedCount) {
          fail('OCR_TOKEN_COUNT_MISMATCH', `Selected OCR token ${JSON.stringify(entry.token)} was missing or duplicated on page ${pageIndex + 1}`);
        }
        const offset = candidatePageText.indexOf(entry.token, orderOffset);
        if (offset < 0) fail('READING_ORDER_MISMATCH', `Selected OCR token order changed on page ${pageIndex + 1}`);
        orderOffset = offset + entry.token.length;
      }
    }
    for (const pageIndex of relevantPageIndexes) {
      if ((removedText.get(pageIndex) || '') !== (baselineText.get(pageIndex) || '')) {
        fail('REMOVE_OWNED_OCR_MISMATCH', `Removing owned OCR did not restore PDF.js extraction on page ${pageIndex + 1}`);
      }
      if ((repeatedText.get(pageIndex) || '') !== (candidateText.get(pageIndex) || '')) {
        fail('REPEATED_WRITE_TEXT_MISMATCH', `Repeated OCR write changed PDF.js extraction on page ${pageIndex + 1}`);
      }
    }

    await Promise.all([
      destroyPreparedPdfJsDocument(baselineDocument),
      destroyPreparedPdfJsDocument(repeatedDocument),
      destroyPreparedPdfJsDocument(removedDocument),
    ]);
    return {
      candidateBytes,
      validationBaselineBytes: baselineWithoutOwned,
      candidatePdfJsDocument: candidateDocument,
      inspection: candidateInspection,
      pdfiumPlan: {
        selectedPageIndexes: sampledIndexes(relevantPageIndexes, 3),
        tokensByPage: Object.fromEntries([...selectedTokens].map(([pageIndex, entries]) => [pageIndex, entries])),
      },
    };
  } catch (error) {
    await Promise.all([
      destroyPreparedPdfJsDocument(baselineDocument),
      destroyPreparedPdfJsDocument(candidateDocument),
      destroyPreparedPdfJsDocument(repeatedDocument),
      destroyPreparedPdfJsDocument(removedDocument),
    ]);
    throw error;
  }
}

/** @param {any} plan @param {any} result */
export function validateOcrPdfiumCandidateResult(plan, result, { allowOwnedVisibleChanges = false } = {}) {
  if (!result || result.status !== 'pass'
    || result.renderScale !== OCR_PDFIUM_RENDER_SCALE
    || result.maxChangedPixelsPerPage !== OCR_VISIBLE_PIXEL_TOLERANCE.maxChangedPixelsPerPage
    || result.maxChannelDeltaTolerance !== OCR_VISIBLE_PIXEL_TOLERANCE.maxChannelDelta) {
    fail('PDFIUM_VALIDATION_FAILED', 'PDFium did not return the approved exact-pixel validation policy');
  }
  const returned = new Map((result.pages || []).map((page) => [page.pageIndex, page]));
  for (const pageIndex of plan.selectedPageIndexes) {
    const page = returned.get(pageIndex);
    if (!page || (!allowOwnedVisibleChanges
      && (page.changedPixels > OCR_VISIBLE_PIXEL_TOLERANCE.maxChangedPixelsPerPage
        || page.maxChannelDelta > OCR_VISIBLE_PIXEL_TOLERANCE.maxChannelDelta))
      || (allowOwnedVisibleChanges
        && (page.outsideAllowedChangedPixels !== 0 || page.outsideAllowedMaxChannelDelta !== 0))) {
      fail('VISIBLE_PIXEL_REGRESSION', `PDFium found visible pixel changes on page ${pageIndex + 1}`);
    }
    for (const entry of plan.tokensByPage[pageIndex] || []) {
      const baselineCount = occurrenceCount(page.baselineText || '', entry.token);
      const candidateCount = occurrenceCount(page.candidateText || '', entry.token);
      const expectedCount = baselineCount + entry.desiredOccurrences;
      if (candidateCount !== expectedCount) {
        fail('PDFIUM_TOKEN_COUNT_MISMATCH',
          `PDFium reopened selected token ${JSON.stringify(entry.token)} ${candidateCount} time(s); expected ${expectedCount} (${baselineCount} baseline + ${entry.desiredOccurrences} owned)`);
      }
    }
  }
  return true;
}
