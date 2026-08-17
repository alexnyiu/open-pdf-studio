// @ts-check

import { $PROXY } from 'solid-js';
import { unwrap } from 'solid-js/store';
import { assertOcrResultV2 } from './contracts/v2.js';
import {
  assertOcrPageGeometryV1,
} from './contracts/page-geometry.v1.js';
import {
  OCR_PDF_USER_SPACE,
  mapPointBetweenSpaces,
  mapPolygonBetweenSpaces,
} from './contracts/geometry.js';
import { invalidateTextCache } from '../search/text-cache.js';
import { assessPdfJsTextContent } from './existing-text.js';

export const OPEN_PDF_STUDIO_OCR_OWNER = 'open-pdf-studio';
export const PENDING_OCR_STREAM = 'pending-searchable-text';
const assessmentPdfDocuments = new WeakMap();

/** @returns {string} */
function generationId() {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `ocr-generation-${suffix}`;
}

/** @template T @param {T} value @returns {T} */
function clone(value) {
  return structuredClone(value);
}

/** @template T @param {T} value @returns {Readonly<T>} */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/** @template T @param {T} value @returns {Readonly<T>} */
function immutableContractSnapshot(value) {
  const snapshot = clone(value);
  // Solid lazily defines its proxy marker on plain objects. Install a
  // non-enumerable self marker before freezing so the snapshot remains a plain
  // JSON object (and can be revalidated) without Solid trying to mutate it.
  Object.defineProperty(snapshot, $PROXY, { value: snapshot });
  return deepFreeze(snapshot);
}

/** @param {unknown} left @param {unknown} right */
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** @param {any} doc @param {number} pageNum */
function notifyPageChanged(doc, pageNum) {
  invalidateTextCache(doc?.id, pageNum);
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('open-pdf-studio:ocr-page-state-changed', {
      detail: { documentId: doc?.id, pageNum },
    }));
  }
}

/** @param {unknown} left @param {unknown} right */
export function sameOcrState(left, right) {
  return sameJson(left, right);
}

/**
 * @param {string} documentId
 * @returns {import('../types/ocr.js').DocumentOcrState}
 */
export function createDocumentOcrState(documentId) {
  return {
    documentId,
    generation: generationId(),
    revision: 0,
    pages: {},
    warnings: [],
    dirty: false,
  };
}

/** @param {any} doc */
export function ensureDocumentOcrState(doc) {
  if (!doc || typeof doc.id !== 'string') throw new TypeError('OCR document state requires a document ID');
  if (!doc.ocr || doc.ocr.documentId !== doc.id) doc.ocr = createDocumentOcrState(doc.id);
  return doc.ocr;
}

/** @param {any} doc @param {number} pageNum */
export function ensureOcrPageState(doc, pageNum) {
  if (!Number.isSafeInteger(pageNum) || pageNum < 1) throw new RangeError('OCR page number must be one-based');
  const ocr = ensureDocumentOcrState(doc);
  if (!ocr.pages[pageNum]) {
    ocr.pages[pageNum] = {
      pageNumber: pageNum,
      pageId: `ocr-page-${pageNum}`,
      status: 'idle',
      // Seed from the document OCR revision so a page created after a
      // structure-generation reset cannot collide with a persistent cache key
      // from the earlier page occupying this one-based position.
      pageRevision: ocr.revision,
      generation: ocr.generation,
      recognition: {
        revision: 0,
        result: null,
        geometry: null,
        ownership: null,
        warnings: [],
      },
      review: {
        revision: 0,
        corrections: {},
        dirty: false,
      },
      existingText: null,
    };
  }
  return ocr.pages[pageNum];
}

/**
 * Records only aggregate PDF.js evidence; source text remains owned by PDF.js
 * and is never copied into or removed by OCR state.
 * @param {any} doc
 * @param {number} pageNum
 * @param {import('../types/ocr.js').OcrExistingTextAssessment} assessment
 */
export function recordOcrExistingTextAssessment(doc, pageNum, assessment) {
  const page = ensureOcrPageState(doc, pageNum);
  const rawDocument = unwrap(doc);
  let sources = assessmentPdfDocuments.get(rawDocument);
  if (!sources) {
    sources = new Map();
    assessmentPdfDocuments.set(rawDocument, sources);
  }
  sources.set(pageNum, doc.pdfDoc);
  const comparable = { ...assessment, revision: 0 };
  const previous = page.existingText ? { ...page.existingText, revision: 0 } : null;
  if (previous && sameJson(previous, comparable)) return page.existingText;

  page.existingText = {
    ...clone(comparable),
    revision: (page.existingText?.revision || 0) + 1,
  };
  if (assessment.meaningful && !page.recognition.result) page.status = 'skipped-existing-text';
  ensureDocumentOcrState(doc).revision += 1;
  notifyPageChanged(doc, pageNum);
  return page.existingText;
}

/** @param {any} doc @param {number} pageNum */
export function clearOpenPdfStudioOcrPage(doc, pageNum) {
  const page = ensureOcrPageState(doc, pageNum);
  if (page.recognition.ownership?.owner !== OPEN_PDF_STUDIO_OCR_OWNER) return false;
  page.recognition.result = null;
  page.recognition.geometry = null;
  page.recognition.ownership = null;
  page.recognition.warnings = [];
  page.recognition.revision += 1;
  page.review.corrections = {};
  page.review.revision += 1;
  page.status = page.existingText?.meaningful ? 'skipped-existing-text' : 'idle';
  page.review.dirty = true;
  const ocr = ensureDocumentOcrState(doc);
  ocr.revision += 1;
  ocr.dirty = true;
  doc.modified = true;
  notifyPageChanged(doc, pageNum);
  return true;
}

/**
 * Capture plain application state for typed OCR undo commands. Recognized
 * result and geometry contracts remain immutable after the snapshot is
 * restored; the snapshot itself is never used as an engine result boundary.
 * @param {any} doc
 * @param {number[]} pageNumbers
 */
export function snapshotOcrCommandState(doc, pageNumbers) {
  const ocr = ensureDocumentOcrState(doc);
  const uniquePages = [...new Set(pageNumbers)].sort((left, right) => left - right);
  for (const pageNum of uniquePages) {
    if (!Number.isSafeInteger(pageNum) || pageNum < 1) {
      throw new RangeError('OCR undo snapshot page numbers must be one-based');
    }
  }
  return {
    documentId: doc.id,
    documentGeneration: ocr.generation,
    documentRevision: ocr.revision,
    dirty: ocr.dirty === true,
    pages: uniquePages.map((pageNum) => {
      const exists = Object.prototype.hasOwnProperty.call(ocr.pages, pageNum);
      return {
        pageNumber: pageNum,
        exists,
        state: exists ? clone(unwrap(ocr.pages[pageNum])) : null,
      };
    }),
  };
}

/**
 * Select a page subset from an earlier command snapshot without recapturing
 * already-mutated state.
 * @param {ReturnType<typeof snapshotOcrCommandState>} snapshot
 * @param {number[]} pageNumbers
 */
export function selectOcrCommandSnapshot(snapshot, pageNumbers) {
  const selected = new Set(pageNumbers);
  return {
    ...clone(snapshot),
    pages: snapshot.pages.filter((page) => selected.has(page.pageNumber)).map(clone),
  };
}

/**
 * Restore typed OCR command state. This is the authoritative undo/redo path:
 * it changes application state, invalidates search, and asks every rendered
 * text layer to re-project from state. It never treats DOM nodes as storage.
 * @param {any} doc
 * @param {ReturnType<typeof snapshotOcrCommandState>} snapshot
 */
export function restoreOcrCommandState(doc, snapshot, { restoreDocumentState = true } = {}) {
  const ocr = ensureDocumentOcrState(doc);
  if (!snapshot || snapshot.documentId !== doc.id ||
      snapshot.documentGeneration !== ocr.generation || !Array.isArray(snapshot.pages)) {
    return false;
  }
  for (const pageSnapshot of snapshot.pages) {
    const pageNum = pageSnapshot.pageNumber;
    if (!Number.isSafeInteger(pageNum) || pageNum < 1) return false;
    if (pageSnapshot.exists) {
      ocr.pages[pageNum] = clone(pageSnapshot.state);
    } else {
      delete ocr.pages[pageNum];
    }
  }
  if (restoreDocumentState) {
    ocr.revision = snapshot.documentRevision;
    ocr.dirty = snapshot.dirty === true;
  } else {
    ocr.revision += 1;
    ocr.dirty = Object.values(ocr.pages).some((page) => page?.review?.dirty === true);
  }
  const undoDepth = Array.isArray(doc.undoStack) ? doc.undoStack.length : 0;
  const atSavedPoint = Number.isSafeInteger(doc.savedUndoStackLength) &&
    doc.savedUndoStackLength >= 0 && undoDepth === doc.savedUndoStackLength;
  doc.modified = !atSavedPoint || ocr.dirty;
  for (const pageSnapshot of snapshot.pages) notifyPageChanged(doc, pageSnapshot.pageNumber);
  return true;
}

/**
 * Begins an attempt and returns the only token that may accept its result.
 * The caller must put its generation, page ID, and page revision into the
 * production request contract.
 * @param {any} doc
 * @param {number} pageNum
 * @param {{force?: boolean}} [options]
 */
export async function beginOcrPageAttempt(doc, pageNum, { force = false } = {}) {
  const page = ensureOcrPageState(doc, pageNum);
  const rawDocument = unwrap(doc);
  const assessedPdfDoc = assessmentPdfDocuments.get(rawDocument)?.get(pageNum);
  if (!page.existingText || assessedPdfDoc !== doc.pdfDoc) {
    const generation = ensureDocumentOcrState(doc).generation;
    const pdfDoc = doc.pdfDoc;
    page.status = 'checking-existing-text';
    notifyPageChanged(doc, pageNum);
    try {
      const pdfPage = await pdfDoc?.getPage(pageNum);
      const textContent = await pdfPage?.getTextContent();
      if (!textContent) throw new TypeError('PDF.js text content is unavailable');
      if (doc.pdfDoc !== pdfDoc || ensureDocumentOcrState(doc).generation !== generation) {
        return { skipped: true, reason: 'stale-before-attempt', token: null };
      }
      recordOcrExistingTextAssessment(doc, pageNum, assessPdfJsTextContent(textContent));
    } catch (error) {
      page.status = 'failed';
      page.recognition.warnings = [{
        code: 'existing-text-unverified',
        message: error instanceof Error ? error.message : 'PDF.js text content could not be inspected',
        severity: 'warning',
        entityIds: [],
      }];
      notifyPageChanged(doc, pageNum);
      return { skipped: true, reason: 'existing-text-unverified', token: null };
    }
  }
  if (page.existingText?.meaningful && !force) {
    page.status = 'skipped-existing-text';
    return { skipped: true, reason: 'meaningful-existing-text', token: null };
  }
  // A second recognition pass is a rerun and must be explicit. This also
  // prevents an ordinary attempt from replacing state whose ownership is not
  // known to Open PDF Studio.
  if (page.recognition.result && !force) {
    return { skipped: true, reason: 'existing-ocr-result', token: null };
  }
  if (force && page.recognition.result &&
      page.recognition.ownership?.owner !== OPEN_PDF_STUDIO_OCR_OWNER) {
    return { skipped: true, reason: 'unowned-ocr-state', token: null };
  }
  if (force) clearOpenPdfStudioOcrPage(doc, pageNum);
  page.pageRevision += 1;
  page.generation = ensureDocumentOcrState(doc).generation;
  page.status = 'queued';
  page.recognition.warnings = [];
  const token = {
    documentId: doc.id,
    documentGeneration: page.generation,
    pageId: page.pageId,
    pageNumber: pageNum,
    pageRevision: page.pageRevision,
  };
  notifyPageChanged(doc, pageNum);
  return { skipped: false, reason: null, token };
}

/** @param {any} doc @param {import('../types/ocr.js').OcrPageGenerationToken} token */
export function isCurrentOcrPageToken(doc, token) {
  const ocr = doc?.ocr;
  const page = ocr?.pages?.[token?.pageNumber];
  return !!page && token.documentId === doc.id && token.documentGeneration === ocr.generation &&
    token.documentGeneration === page.generation && token.pageId === page.pageId &&
    token.pageRevision === page.pageRevision;
}

/** @param {any} doc @param {import('../types/ocr.js').OcrPageGenerationToken} token */
export function markOcrPageRecognizing(doc, token) {
  return markOcrPageStage(doc, token, 'recognizing');
}

/**
 * Publish a non-terminal application stage without changing OCR ownership or
 * dirty state.
 * @param {any} doc
 * @param {import('../types/ocr.js').OcrPageGenerationToken} token
 * @param {'queued'|'rasterizing'|'preprocessing'|'recognizing'|'validating'|'applying'} stage
 */
export function markOcrPageStage(doc, token, stage) {
  if (!['queued', 'rasterizing', 'preprocessing', 'recognizing', 'validating', 'applying'].includes(stage)) {
    throw new TypeError('OCR page stage is unsupported');
  }
  if (!isCurrentOcrPageToken(doc, token)) return false;
  doc.ocr.pages[token.pageNumber].status = stage;
  notifyPageChanged(doc, token.pageNumber);
  return true;
}

/** @param {any} result @param {any} geometry */
function assertMatchingGeometry(result, geometry) {
  const issues = [];
  for (const key of ['id', 'revision', 'generation', 'pageCount']) {
    if (!sameJson(result.document[key], geometry.document[key])) issues.push(`document.${key}`);
  }
  for (const key of ['id', 'index', 'revision']) {
    if (!sameJson(result.page[key], geometry.page[key])) issues.push(`page.${key}`);
  }
  for (const key of ['id', 'fingerprint', 'coordinateSpace', 'widthPx', 'heightPx', 'dpi']) {
    if (!sameJson(result.sourceRaster[key], geometry.sourceRaster[key])) issues.push(`sourceRaster.${key}`);
  }
  if (issues.length > 0) throw new TypeError(`OCR result/page geometry identity mismatch: ${issues.join(', ')}`);
}

/**
 * Validates, clones, and freezes engine-owned data before publishing it.
 * Stale results are ignored without altering the newer page attempt.
 * @param {any} doc
 * @param {{result: unknown, pageGeometry: unknown, token: import('../types/ocr.js').OcrPageGenerationToken}} input
 */
export function applyOcrPageResult(doc, { result, pageGeometry, token }) {
  const validatedResult = assertOcrResultV2(result);
  const validatedGeometry = assertOcrPageGeometryV1(pageGeometry);
  if (!isCurrentOcrPageToken(doc, token)) return { applied: false, reason: 'stale-generation' };
  if (validatedResult.document.id !== token.documentId ||
      validatedResult.document.generation !== token.documentGeneration ||
      validatedResult.page.id !== token.pageId ||
      validatedResult.page.index !== token.pageNumber - 1 ||
      validatedResult.page.revision !== token.pageRevision ||
      validatedResult.document.pageCount !== doc.pdfDoc?.numPages) {
    return { applied: false, reason: 'stale-contract-identity' };
  }
  assertMatchingGeometry(validatedResult, validatedGeometry);

  const page = ensureOcrPageState(doc, token.pageNumber);
  // Assign snapshots through the raw nested state. Solid's normal setter
  // unwraps frozen objects into mutable clones before storing them.
  const rawRecognition = unwrap(page.recognition);
  rawRecognition.result = immutableContractSnapshot(validatedResult);
  rawRecognition.geometry = immutableContractSnapshot(validatedGeometry);
  page.recognition.revision += 1;
  page.recognition.ownership = {
    owner: OPEN_PDF_STUDIO_OCR_OWNER,
    stream: PENDING_OCR_STREAM,
    jobId: validatedResult.jobId,
    requestId: validatedResult.requestId,
    createdAt: new Date().toISOString(),
  };
  page.recognition.warnings = clone(validatedResult.warnings || []);
  page.review.corrections = {};
  page.review.revision += 1;
  page.status = validatedResult.page.status === 'unsupported'
    ? 'unsupported'
    : validatedResult.page.status === 'failed'
      ? 'failed'
      : validatedResult.page.status === 'cancelled'
        ? 'cancelled'
        : 'ready';
  page.review.dirty = true;
  const ocr = ensureDocumentOcrState(doc);
  ocr.revision += 1;
  ocr.dirty = true;
  doc.modified = true;
  notifyPageChanged(doc, token.pageNumber);
  return { applied: true, reason: null };
}

/**
 * Completes a non-result terminal path such as cancellation or failure.
 * @param {any} doc
 * @param {import('../types/ocr.js').OcrPageGenerationToken} token
 * @param {'cancelled'|'failed'|'stale'} status
 * @param {Array<import('../types/ocr.js').OcrWarning>} [warnings]
 */
export function finishOcrPageAttempt(doc, token, status, warnings = []) {
  if (!isCurrentOcrPageToken(doc, token)) return false;
  const page = doc.ocr.pages[token.pageNumber];
  page.status = status;
  page.recognition.warnings = clone(warnings);
  notifyPageChanged(doc, token.pageNumber);
  return true;
}

/**
 * Accepts review text separately from the immutable recognized result.
 * @param {any} doc
 * @param {number} pageNum
 * @param {string} lineId
 * @param {string} correctedText
 */
export function acceptOcrLineCorrection(doc, pageNum, lineId, correctedText) {
  const page = ensureOcrPageState(doc, pageNum);
  const line = page.recognition.result?.lines?.find((entry) => entry.id === lineId);
  if (!line) throw new RangeError(`OCR line ${lineId} is not present on page ${pageNum}`);
  if (typeof correctedText !== 'string') throw new TypeError('OCR correction text must be a string');
  const existing = page.review.corrections[lineId];
  if (existing?.correctedText === correctedText) return existing;
  const revision = page.review.revision + 1;
  page.review.revision = revision;
  const now = new Date().toISOString();
  page.review.corrections[lineId] = {
    id: `ocr-correction-${pageNum}-${revision}`,
    target: { kind: 'line', id: lineId },
    originalText: line.text,
    correctedText,
    status: 'accepted',
    createdAt: now,
    updatedAt: now,
  };
  page.review.dirty = true;
  const ocr = ensureDocumentOcrState(doc);
  ocr.revision += 1;
  ocr.dirty = true;
  doc.modified = true;
  notifyPageChanged(doc, pageNum);
  return page.review.corrections[lineId];
}

/** @param {string} documentId @param {number} pageNum @param {string} lineId */
export function stableOcrTextId(documentId, pageNum, lineId) {
  const input = `${documentId}\u001f${pageNum}\u001f${lineId}`;
  const encoded = [...new TextEncoder().encode(input)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `opds-ocr-p${pageNum}-${encoded}`;
}

/**
 * Returns effective line text in engine reading order, with geometry mapped
 * to canonical raw PDF user space. No word geometry is inferred.
 * @param {any} doc
 * @param {number} pageNum
 */
export function getPendingOcrTextItems(doc, pageNum) {
  const page = doc?.ocr?.pages?.[pageNum];
  if (!page?.recognition.result || !page.recognition.geometry ||
      page.recognition.ownership?.owner !== OPEN_PDF_STUDIO_OCR_OWNER ||
      page.existingText?.meaningful) return [];

  return page.recognition.result.lines
    .filter((line) => typeof line.text === 'string' && line.text.length > 0)
    .map((line, readingOrder) => {
      const correction = page.review.corrections[line.id];
      const polygon = mapPolygonBetweenSpaces(
        page.recognition.geometry.transformChain,
        line.polygon,
        OCR_PDF_USER_SPACE,
      );
      const baseline = line.baseline.status === 'provided'
        ? {
            ...line.baseline,
            coordinateSpace: OCR_PDF_USER_SPACE,
            points: line.baseline.points.map((point) => mapPointBetweenSpaces(
              page.recognition.geometry.transformChain,
              point,
              line.baseline.coordinateSpace,
              OCR_PDF_USER_SPACE,
            )),
          }
        : { ...line.baseline, coordinateSpace: OCR_PDF_USER_SPACE };
      const xs = polygon.points.map((point) => point[0]);
      const ys = polygon.points.map((point) => point[1]);
      const anchor = baseline.status === 'provided' && baseline.points?.length
        ? { x: baseline.points[0][0], y: baseline.points[0][1], source: 'baseline' }
        : { x: Math.min(...xs), y: Math.max(...ys), source: 'polygon' };
      return {
        id: stableOcrTextId(doc.id, pageNum, line.id),
        lineId: line.id,
        pageNum,
        readingOrder,
        text: correction?.correctedText ?? line.text,
        confidence: line.confidence,
        polygon,
        baseline,
        anchor,
        pageGeometry: page.recognition.geometry,
        resultRevision: page.recognition.revision,
        correctionRevision: page.review.revision,
        language: line.detectedLanguage?.tag || null,
        direction: line.detectedWritingDirection || null,
        ownership: page.recognition.ownership,
      };
    });
}

/**
 * Invalidates every pending result after page-structure replacement. Late
 * children retain old tokens and therefore cannot publish into the new state.
 * @param {any} doc
 */
export function resetDocumentOcrGeneration(doc) {
  const previous = ensureDocumentOcrState(doc);
  // Page-structure replacement invalidates every cached revision registered
  // for this document. Cache storage remains path-private and performs its own
  // exact page matching.
  void import('./cache.js')
    .then(({ invalidateRegisteredDocumentOcrCache }) => invalidateRegisteredDocumentOcrCache(doc.id))
    .catch(() => {});
  doc.ocr = createDocumentOcrState(doc.id);
  doc.ocr.revision = previous.revision + 1;
  invalidateTextCache(doc.id);
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('open-pdf-studio:ocr-document-state-changed', {
      detail: { documentId: doc.id },
    }));
  }
  return doc.ocr.generation;
}
