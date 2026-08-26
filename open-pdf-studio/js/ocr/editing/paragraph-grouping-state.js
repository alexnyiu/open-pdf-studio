import {
  SCANNED_TEXT_EDIT_OWNER,
  toValidatedScannedTextEditStateV1Json,
} from '../contracts/scanned-text-edit-state.v1.js';
import { createScannedTextEditStateV1 } from './edit-state.js';
import { sha256Hex, validateRgbaRaster } from './raster.js';
import { OCR_PARAGRAPH_ALGORITHM, buildOcrParagraphRegions } from './paragraph-regions.js';

function now(value) {
  const timestamp = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp)) || !timestamp.endsWith('Z')) {
    throw new TypeError('modifiedAt must be an ISO 8601 UTC timestamp');
  }
  return timestamp;
}

function operationId(value) {
  return value ?? `ocr-paragraph-grouping-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
}

function currentPage(doc, pageIndex) {
  return doc?.ocr?.pages?.[pageIndex + 1] ?? null;
}

function assertCurrentSource(doc, result, pageGeometry) {
  const page = currentPage(doc, result.page.index);
  if (!page) return;
  if (doc.ocr.documentId !== result.document.id
      || doc.ocr.generation !== result.document.generation
      || page.pageId !== result.page.id
      || page.pageRevision !== result.page.revision
      || page.recognition?.result !== result
      || page.recognition?.geometry?.geometryId !== pageGeometry.geometryId) {
    throw new RangeError('OCR paragraph grouping source is stale');
  }
}

function adjacentBoundary(result, beforeLineId, afterLineId) {
  const order = result.lines.map((line) => line.id);
  const before = order.indexOf(beforeLineId);
  const after = order.indexOf(afterLineId);
  if (before < 0 || after !== before + 1) {
    throw new RangeError('Paragraph grouping overrides require adjacent current OCR lines');
  }
}

function pageState(result, pageGeometry, raster, rgbaSha256) {
  return {
    id: result.page.id,
    index: result.page.index,
    revision: result.page.revision,
    sourceRaster: { ...structuredClone(result.sourceRaster), rgbaSha256 },
    pageGeometry: structuredClone(pageGeometry),
    selections: [],
  };
}

async function finish(doc, before, after, pageIndex, id, executeCommand) {
  const validated = after.pages.length === 0 ? null : toValidatedScannedTextEditStateV1Json(after);
  doc.scannedTextEdits = validated;
  doc.scannedTextEditRemovalPending = validated === null;
  if (doc.ocr) doc.ocr.dirty = true;
  const command = {
    type: 'scannedTextEdit', operationId: id, pageNumbers: [pageIndex + 1],
    selectionId: null, before, after: validated,
  };
  const record = executeCommand ?? (await import('../../core/undo-manager.js')).executeForDocument;
  record(doc, command);
  if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
    globalThis.dispatchEvent(new CustomEvent('open-pdf-studio:scanned-text-edit-state-changed', {
      detail: { documentId: doc.id, pageIndex },
    }));
  }
  return command;
}

/** Persist or replace one adjacent-line grouping decision as one undo command. */
export async function setOcrParagraphBoundaryOverrideForDocument(doc, {
  result, pageGeometry, raster, beforeLineId, afterLineId, decision,
  operationId: requestedOperationId, modifiedAt,
  executeCommand,
}) {
  if (!['merge', 'split'].includes(decision)) throw new TypeError('Paragraph boundary decision must be merge or split');
  assertCurrentSource(doc, result, pageGeometry);
  adjacentBoundary(result, beforeLineId, afterLineId);
  if (decision === 'merge') {
    const existingGrouping = doc.scannedTextEdits?.pages
      ?.find((page) => page.index === result.page.index)?.paragraphGrouping;
    const regions = buildOcrParagraphRegions({ result, pageGeometry, overrides: existingGrouping });
    const boundary = regions.boundaries?.find((entry) => entry.beforeLineId === beforeLineId
      && entry.afterLineId === afterLineId);
    if (boundary?.decision !== 'ambiguous') {
      throw new RangeError('Manual merges are limited to ambiguous same-column OCR boundaries');
    }
  }
  validateRgbaRaster(raster);
  if (raster.widthPx !== result.sourceRaster.widthPx || raster.heightPx !== result.sourceRaster.heightPx) {
    throw new RangeError('Paragraph grouping raster does not match the current OCR source');
  }
  const changedAt = now(modifiedAt);
  const id = operationId(requestedOperationId);
  const before = doc.scannedTextEdits ? toValidatedScannedTextEditStateV1Json(doc.scannedTextEdits) : null;
  const after = before ? structuredClone(before) : createScannedTextEditStateV1({
    document: result.document, createdAt: changedAt,
  });
  let page = after.pages.find((entry) => entry.index === result.page.index);
  if (!page) {
    page = pageState(result, pageGeometry, raster, await sha256Hex(raster.data));
    after.pages.push(page);
    after.pages.sort((left, right) => left.index - right.index);
  } else if (page.id !== result.page.id || page.revision !== result.page.revision
      || page.sourceRaster.id !== result.sourceRaster.id
      || page.pageGeometry.geometryId !== pageGeometry.geometryId) {
    throw new RangeError('Paragraph grouping page state is stale');
  }
  const previous = page.paragraphGrouping;
  const boundaries = previous ? structuredClone(previous.boundaries) : [];
  const index = boundaries.findIndex((entry) => entry.beforeLineId === beforeLineId
    && entry.afterLineId === afterLineId);
  const boundary = { beforeLineId, afterLineId, decision };
  if (index >= 0) boundaries[index] = boundary;
  else boundaries.push(boundary);
  boundaries.sort((left, right) => `${left.beforeLineId}\u0000${left.afterLineId}`
    .localeCompare(`${right.beforeLineId}\u0000${right.afterLineId}`));
  const revision = (previous?.ownership?.revision ?? 0) + 1;
  page.paragraphGrouping = {
    algorithm: OCR_PARAGRAPH_ALGORITHM,
    geometryId: pageGeometry.geometryId,
    boundaries,
    ownership: {
      owner: SCANNED_TEXT_EDIT_OWNER, operationId: id, revision, parentRevision: revision - 1,
      createdAt: previous?.ownership?.createdAt ?? changedAt, updatedAt: changedAt,
    },
  };
  after.stateRevision += 1;
  after.history = {
    generation: after.history.generation + 1,
    undoDepth: (doc.undoStack?.length ?? 0) + 1,
    redoDepth: 0,
    lastOperationId: id,
  };
  after.updatedAt = changedAt;
  return finish(doc, before, after, result.page.index, id, executeCommand);
}

/** Remove overrides touching a region; pages/state with no remaining ownership are pruned. */
export async function resetOcrParagraphGroupingForDocument(doc, {
  pageIndex, lineIds, operationId: requestedOperationId, modifiedAt, executeCommand,
}) {
  const before = doc?.scannedTextEdits ? toValidatedScannedTextEditStateV1Json(doc.scannedTextEdits) : null;
  if (!before) return null;
  const after = structuredClone(before);
  const page = after.pages.find((entry) => entry.index === pageIndex);
  if (!page?.paragraphGrouping) return null;
  const selected = new Set(lineIds);
  page.paragraphGrouping.boundaries = page.paragraphGrouping.boundaries.filter((entry) =>
    !selected.has(entry.beforeLineId) && !selected.has(entry.afterLineId));
  if (page.paragraphGrouping.boundaries.length === 0) delete page.paragraphGrouping;
  if (page.selections.length === 0 && !page.paragraphGrouping) {
    after.pages = after.pages.filter((entry) => entry !== page);
  }
  const changedAt = now(modifiedAt);
  const id = operationId(requestedOperationId);
  after.stateRevision += 1;
  after.history = {
    generation: after.history.generation + 1,
    undoDepth: (doc.undoStack?.length ?? 0) + 1,
    redoDepth: 0,
    lastOperationId: after.pages.length === 0 ? null : id,
  };
  after.updatedAt = changedAt;
  if (after.pages.length > 0 && page.paragraphGrouping) {
    const revision = page.paragraphGrouping.ownership.revision + 1;
    page.paragraphGrouping.ownership = {
      ...page.paragraphGrouping.ownership, operationId: id, revision,
      parentRevision: revision - 1, updatedAt: changedAt,
    };
  }
  if (after.pages.length > 0 && !after.pages.some((entry) => entry.paragraphGrouping?.ownership.operationId === id)) {
    const lastSelection = after.pages.flatMap((entry) => entry.selections).at(-1);
    after.history.lastOperationId = lastSelection?.ownership?.operationId ?? null;
  }
  return finish(doc, before, after, pageIndex, id, executeCommand);
}
