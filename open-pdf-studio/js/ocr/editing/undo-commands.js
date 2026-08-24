import { executeForDocument } from '../../core/undo-manager.js';
import { deriveScannedTextEditSelectionId } from '../contracts/scanned-text-edit-state.v1.js';
import {
  commitScannedTextEditEvaluation,
  evaluateScannedTextEdit,
  nextSelectionRevision,
} from './edit-state.js';
import { toValidatedScannedTextEditStateV1Json } from '../contracts/scanned-text-edit-state.v1.js';
import { reviseIsolatedSingleLineContent } from './single-line.js';

function targetId(target) {
  if (target?.kind === 'line') return target.lineId ?? target.targetId;
  if (target?.kind === 'region') return target.regionId;
  return null;
}

/** Evaluate and record one scanned-text eligibility/repair operation atomically. */
export async function applyScannedTextEditForDocument(doc, input) {
  const stableTargetId = targetId(input.target);
  const selectionId = deriveScannedTextEditSelectionId(
    input.result?.page?.id,
    input.target?.kind,
    stableTargetId,
  );
  const { revision, parentRevision } = nextSelectionRevision(doc, selectionId);
  const evaluation = await evaluateScannedTextEdit({
    ...input,
    revision,
    parentRevision,
  });
  const { before, after } = commitScannedTextEditEvaluation(doc, evaluation, {
    modifiedAt: input.modifiedAt,
  });
  const command = {
    type: 'scannedTextEdit',
    operationId: evaluation.selection.ownership.operationId,
    pageNumbers: [evaluation.page.index + 1],
    selectionId: evaluation.selection.id,
    before,
    after,
  };
  executeForDocument(doc, command);
  return { ...evaluation, command };
}

/** Remove one owned visible line edit while retaining exact undo/redo state. */
export function removeScannedTextEditForDocument(doc, selectionId, {
  operationId = `scanned-text-remove-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
  modifiedAt = new Date().toISOString(),
} = {}) {
  const before = doc?.scannedTextEdits
    ? toValidatedScannedTextEditStateV1Json(doc.scannedTextEdits)
    : null;
  if (!before) throw new RangeError('No application-owned scanned-text edit state is available');
  const after = structuredClone(before);
  let pageNumber = null;
  let selection = null;
  for (const page of after.pages) {
    const found = page.selections.find((entry) => entry.id === selectionId);
    if (!found) continue;
    selection = found;
    pageNumber = page.index + 1;
    break;
  }
  if (!selection || selection.repair.status !== 'applied') {
    throw new RangeError('The requested application-owned scanned-text edit is not applied');
  }
  selection.revision += 1;
  selection.repair.status = 'reverted';
  selection.content = null;
  selection.ownership = {
    ...selection.ownership,
    operationId,
    parentRevision: selection.revision - 1,
    revision: selection.revision,
    updatedAt: modifiedAt,
  };
  after.stateRevision += 1;
  after.history = {
    generation: after.history.generation + 1,
    undoDepth: (doc.undoStack?.length ?? 0) + 1,
    redoDepth: 0,
    lastOperationId: operationId,
  };
  after.updatedAt = modifiedAt;
  const validatedAfter = toValidatedScannedTextEditStateV1Json(after);
  doc.scannedTextEdits = validatedAfter;
  doc.scannedTextEditRemovalPending = true;
  if (doc.ocr) doc.ocr.dirty = true;
  const command = {
    type: 'scannedTextEdit',
    operationId,
    pageNumbers: [pageNumber],
    selectionId,
    before,
    after: validatedAfter,
  };
  executeForDocument(doc, command);
  if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
    globalThis.dispatchEvent(new CustomEvent('open-pdf-studio:scanned-text-edit-state-changed', {
      detail: { documentId: doc.id, pageIndex: pageNumber - 1 },
    }));
  }
  return command;
}

/** Revise one applied line from its owned original/repair patches. */
export async function reviseScannedTextEditForDocument(doc, selectionId, {
  replacementText,
  styleOverrides = {},
  renderVisiblePatch,
  operationId = `scanned-text-revise-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
  modifiedAt = new Date().toISOString(),
} = {}) {
  const before = doc?.scannedTextEdits
    ? toValidatedScannedTextEditStateV1Json(doc.scannedTextEdits)
    : null;
  if (!before) throw new RangeError('No application-owned scanned-text edit state is available');
  const after = structuredClone(before);
  let page = null;
  let selection = null;
  for (const entry of after.pages) {
    const found = entry.selections.find((candidate) => candidate.id === selectionId);
    if (!found) continue;
    page = entry;
    selection = found;
    break;
  }
  if (!selection || selection.repair.status !== 'applied' || !selection.content) {
    throw new RangeError('The requested application-owned scanned-text edit is not applied');
  }
  const parentRevision = selection.revision;
  const revision = parentRevision + 1;
  selection.content = await reviseIsolatedSingleLineContent({
    page,
    selection,
    replacementText,
    styleOverrides,
    revision,
    parentRevision,
    renderVisiblePatch,
  });
  selection.revision = revision;
  selection.ownership = {
    ...selection.ownership,
    operationId,
    revision,
    parentRevision,
    updatedAt: modifiedAt,
  };
  after.stateRevision += 1;
  after.history = {
    generation: after.history.generation + 1,
    undoDepth: (doc.undoStack?.length ?? 0) + 1,
    redoDepth: 0,
    lastOperationId: operationId,
  };
  after.updatedAt = modifiedAt;
  const validatedAfter = toValidatedScannedTextEditStateV1Json(after);
  doc.scannedTextEdits = validatedAfter;
  doc.scannedTextEditRemovalPending = false;
  if (doc.ocr) doc.ocr.dirty = true;
  const command = {
    type: 'scannedTextEdit',
    operationId,
    pageNumbers: [page.index + 1],
    selectionId,
    before,
    after: validatedAfter,
  };
  executeForDocument(doc, command);
  if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
    globalThis.dispatchEvent(new CustomEvent('open-pdf-studio:scanned-text-edit-state-changed', {
      detail: { documentId: doc.id, pageIndex: page.index },
    }));
  }
  return command;
}
