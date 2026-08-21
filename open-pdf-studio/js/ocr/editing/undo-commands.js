import { executeForDocument } from '../../core/undo-manager.js';
import { deriveScannedTextEditSelectionId } from '../contracts/scanned-text-edit-state.v1.js';
import {
  commitScannedTextEditEvaluation,
  evaluateScannedTextEdit,
  nextSelectionRevision,
} from './edit-state.js';

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
