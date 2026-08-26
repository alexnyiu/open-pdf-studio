import { executeForDocument } from '../../core/undo-manager.js';
import { deriveScannedTextEditSelectionId } from '../contracts/scanned-text-edit-state.v1.js';
import {
  commitScannedTextEditEvaluation,
  evaluateScannedTextEdit,
  nextSelectionRevision,
  originalPatchBytes,
} from './edit-state.js';
import { toValidatedScannedTextEditStateV1Json } from '../contracts/scanned-text-edit-state.v1.js';
import { reviseIsolatedSingleLineContent } from './single-line.js';
import {
  SCANNED_TEXT_FIXED_REGION_SCOPE,
  fixedRegionTargetFromLineIds,
  reviseFixedRegionMultilineContent,
} from './fixed-region.js';
import { blitRgbaBytes, zeroBytes } from './raster.js';
import { withScannedRichText } from './rich-text-adapter.js';
import {
  SCANNED_TEXT_REFLOW_LAYOUT_MODE,
  SCANNED_TEXT_REFLOW_SCOPE,
  reviseApprovedRegionParagraphReflowContent,
} from './reflow.js';

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

/** Revise one applied line or fixed region from its owned original/repair patches. */
export async function reviseScannedTextEditForDocument(doc, selectionId, {
  replacementText,
  styleOverrides = {},
  renderVisiblePatch,
  layoutMode = null,
  reflowFontBytes,
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
  if (layoutMode !== null
      && (selection.target?.kind !== 'region'
        || layoutMode !== SCANNED_TEXT_REFLOW_LAYOUT_MODE)) {
    throw new TypeError(`Unsupported scanned-text region layout mode: ${layoutMode}`);
  }
  const paragraphReflow = selection.target?.kind === 'region'
    && (layoutMode === SCANNED_TEXT_REFLOW_LAYOUT_MODE
      || selection.content.scope === SCANNED_TEXT_REFLOW_SCOPE);
  const reviseContent = paragraphReflow
    ? reviseApprovedRegionParagraphReflowContent
    : selection.content.scope === SCANNED_TEXT_FIXED_REGION_SCOPE
      ? reviseFixedRegionMultilineContent
      : reviseIsolatedSingleLineContent;
  selection.content = withScannedRichText(await reviseContent({
    page,
    selection,
    replacementText,
    styleOverrides,
    revision,
    parentRevision,
    renderVisiblePatch,
    reflowFontBytes,
  }));
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

function splitTarget(result, lineIds) {
  return lineIds.length === 1
    ? { kind: 'line', lineId: lineIds[0] }
    : fixedRegionTargetFromLineIds(result, lineIds);
}

function patchBounds(patch) {
  return { x: patch.originX, y: patch.originY, width: patch.widthPx, height: patch.heightPx };
}

function containsBounds(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

export function prepareScannedTextRegionSplit(selection, boundaryIndex) {
  if (selection?.repair?.status !== 'applied'
      || selection?.content?.scope !== SCANNED_TEXT_FIXED_REGION_SCOPE
      || selection?.target?.kind !== 'region') {
    throw new RangeError('Only an applied fixed OCR region can be split');
  }
  const lineIds = selection.target.lineIds;
  if (!Number.isInteger(boundaryIndex) || boundaryIndex <= 0 || boundaryIndex >= lineIds.length) {
    throw new RangeError('Split boundary must leave two non-empty source-line groups');
  }
  const layoutLines = selection.content.layout?.lines;
  if (!Array.isArray(layoutLines) || layoutLines.length !== lineIds.length) {
    throw new RangeError('The edited layout no longer has an exact source-line partition');
  }
  return {
    leftLineIds: lineIds.slice(0, boundaryIndex),
    rightLineIds: lineIds.slice(boundaryIndex),
    leftText: layoutLines.slice(0, boundaryIndex).map((line) => line.text).join('\n'),
    rightText: layoutLines.slice(boundaryIndex).map((line) => line.text).join('\n'),
  };
}

/** Atomically replace one owned fixed region with two independently validated children. */
export async function splitScannedTextEditRegionForDocument(doc, selectionId, {
  result,
  pageGeometry,
  boundaryIndex,
  leftText,
  rightText,
  renderVisiblePatch,
  operationId = `scanned-text-split-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
  modifiedAt = new Date().toISOString(),
} = {}) {
  const before = doc?.scannedTextEdits
    ? toValidatedScannedTextEditStateV1Json(doc.scannedTextEdits) : null;
  if (!before) throw new RangeError('No application-owned scanned-text edit state is available');
  const page = before.pages.find((entry) => entry.selections.some((selection) => selection.id === selectionId));
  const parent = page?.selections.find((selection) => selection.id === selectionId);
  const prepared = prepareScannedTextRegionSplit(parent, boundaryIndex);
  if (!String(leftText ?? '').trim() || !String(rightText ?? '').trim()) {
    throw new RangeError('Both split OCR regions require non-empty text');
  }
  if (!result || !pageGeometry
      || result.document.id !== before.document.id
      || result.document.generation !== before.document.generation
      || result.page.id !== page.id || result.page.revision !== page.revision
      || result.sourceRaster.id !== page.sourceRaster.id
      || pageGeometry.geometryId !== page.pageGeometry.geometryId) {
    throw new RangeError('The OCR/source identity changed before the split was committed');
  }
  const byteLength = page.sourceRaster.widthPx * page.sourceRaster.heightPx * 4;
  if (!Number.isSafeInteger(byteLength) || byteLength > 512 * 1024 * 1024) {
    throw new RangeError('The source raster is too large for a safe atomic split');
  }
  const parentBytes = await originalPatchBytes(parent);
  const rasterBytes = new Uint8ClampedArray(byteLength);
  try {
    blitRgbaBytes({
      widthPx: page.sourceRaster.widthPx,
      heightPx: page.sourceRaster.heightPx,
      rowBytes: page.sourceRaster.widthPx * 4,
      data: rasterBytes,
    }, parentBytes, patchBounds(parent.originalPatch));
    const raster = {
      widthPx: page.sourceRaster.widthPx,
      heightPx: page.sourceRaster.heightPx,
      rowBytes: page.sourceRaster.widthPx * 4,
      data: rasterBytes,
      sourceRasterId: page.sourceRaster.id,
      sourceRasterFingerprint: page.sourceRaster.fingerprint,
    };
    const inputs = [
      { lineIds: prepared.leftLineIds, replacementText: String(leftText) },
      { lineIds: prepared.rightLineIds, replacementText: String(rightText) },
    ];
    const evaluations = [];
    for (const input of inputs) {
      const evaluation = await evaluateScannedTextEdit({
        result, pageGeometry, raster, target: splitTarget(result, input.lineIds),
        replacementText: input.replacementText, contextPaddingPx: 24,
        operationId, revision: 1, parentRevision: 0, modifiedAt, renderVisiblePatch,
      });
      if (!evaluation.selection.analysis.eligibility.eligible || !evaluation.selection.content) {
        throw new RangeError('A split child did not pass repair and layout validation');
      }
      if (!containsBounds(patchBounds(parent.originalPatch), patchBounds(evaluation.selection.originalPatch))) {
        throw new RangeError('A split child lacks exact original-patch repair coverage');
      }
      evaluations.push(evaluation);
    }
    const after = structuredClone(before);
    const afterPage = after.pages.find((entry) => entry.index === page.index);
    const replacementIds = new Set(evaluations.map((evaluation) => evaluation.selection.id));
    if (afterPage.selections.some((selection) => selection.id !== parent.id && replacementIds.has(selection.id))) {
      throw new RangeError('A stable split child selection already exists');
    }
    afterPage.selections = afterPage.selections
      .filter((selection) => selection.id !== parent.id)
      .concat(evaluations.map((evaluation) => evaluation.selection))
      .sort((left, right) => left.id.localeCompare(right.id));
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
      type: 'scannedTextEdit', operationId, pageNumbers: [page.index + 1],
      selectionId: parent.id, before, after: validatedAfter,
    };
    executeForDocument(doc, command);
    if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent('open-pdf-studio:scanned-text-edit-state-changed', {
        detail: { documentId: doc.id, pageIndex: page.index },
      }));
    }
    return { command, selections: evaluations.map((evaluation) => evaluation.selection) };
  } finally {
    zeroBytes(parentBytes);
    zeroBytes(rasterBytes);
  }
}

function writeOwnedPatchIntoRaster(rasterBytes, pageWidth, patch, bytes, coverage) {
  for (let row = 0; row < patch.heightPx; row += 1) {
    for (let column = 0; column < patch.widthPx; column += 1) {
      const pagePixel = (patch.originY + row) * pageWidth + patch.originX + column;
      const pageOffset = pagePixel * 4;
      const patchOffset = (row * patch.widthPx + column) * 4;
      if (coverage[pagePixel]) {
        for (let channel = 0; channel < 4; channel += 1) {
          if (rasterBytes[pageOffset + channel] !== bytes[patchOffset + channel]) {
            throw new RangeError('Overlapping original patches disagree');
          }
        }
      } else {
        rasterBytes.set(bytes.subarray(patchOffset, patchOffset + 4), pageOffset);
        coverage[pagePixel] = 1;
      }
    }
  }
}

function coverageContainsPatch(coverage, pageWidth, patch) {
  for (let row = 0; row < patch.heightPx; row += 1) {
    for (let column = 0; column < patch.widthPx; column += 1) {
      if (!coverage[(patch.originY + row) * pageWidth + patch.originX + column]) return false;
    }
  }
  return true;
}

/** Atomically merge two adjacent owned OCR selections from their verified original patches. */
export async function mergeScannedTextEditRegionsForDocument(doc, selectionIds, {
  result,
  pageGeometry,
  replacementText = null,
  renderVisiblePatch,
  operationId = `scanned-text-merge-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
  modifiedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(selectionIds) || selectionIds.length !== 2 || selectionIds[0] === selectionIds[1]) {
    throw new RangeError('Owned OCR merge requires exactly two selections');
  }
  const before = doc?.scannedTextEdits
    ? toValidatedScannedTextEditStateV1Json(doc.scannedTextEdits) : null;
  if (!before) throw new RangeError('No application-owned scanned-text edit state is available');
  const page = before.pages.find((entry) => selectionIds.every((id) => entry.selections.some((selection) => selection.id === id)));
  let selections = selectionIds.map((id) => page?.selections.find((selection) => selection.id === id));
  if (!page || selections.some((selection) => selection?.repair?.status !== 'applied' || !selection.content)) {
    throw new RangeError('Both owned OCR selections must be applied and on one page');
  }
  if (!result || !pageGeometry || result.page.id !== page.id || result.page.revision !== page.revision
      || result.sourceRaster.id !== page.sourceRaster.id || pageGeometry.geometryId !== page.pageGeometry.geometryId) {
    throw new RangeError('The OCR/source identity changed before the merge was committed');
  }
  const readingOrder = new Map(result.lines.map((line, index) => [line.id, index]));
  selections.sort((left, right) => readingOrder.get(left.target.lineIds[0]) - readingOrder.get(right.target.lineIds[0]));
  const combinedLineIds = selections.flatMap((selection) => selection.target.lineIds);
  if (combinedLineIds.some((id) => !readingOrder.has(id))
      || combinedLineIds.some((id, index) => index > 0
        && readingOrder.get(id) !== readingOrder.get(combinedLineIds[index - 1]) + 1)) {
    throw new RangeError('Owned OCR merge requires adjacent current source lines');
  }
  const target = fixedRegionTargetFromLineIds(result, combinedLineIds);
  const text = replacementText ?? selections.map((selection) => selection.content.replacementText).join('\n');
  if (!String(text).trim()) throw new RangeError('Merged OCR text must not be empty');
  if (!/[\r\n\u2028\u2029]/u.test(String(text))) {
    throw new RangeError('Merged OCR regions must preserve a hard break between their existing texts');
  }
  const pagePixels = page.sourceRaster.widthPx * page.sourceRaster.heightPx;
  const byteLength = pagePixels * 4;
  if (!Number.isSafeInteger(byteLength) || byteLength > 512 * 1024 * 1024) {
    throw new RangeError('The source raster is too large for a safe atomic merge');
  }
  const rasterBytes = new Uint8ClampedArray(byteLength);
  const coverage = new Uint8Array(pagePixels);
  const patchBytes = [];
  try {
    for (const selection of selections) {
      const bytes = await originalPatchBytes(selection);
      patchBytes.push(bytes);
      writeOwnedPatchIntoRaster(rasterBytes, page.sourceRaster.widthPx, selection.originalPatch, bytes, coverage);
    }
    const evaluation = await evaluateScannedTextEdit({
      result, pageGeometry,
      raster: {
        widthPx: page.sourceRaster.widthPx, heightPx: page.sourceRaster.heightPx,
        rowBytes: page.sourceRaster.widthPx * 4, data: rasterBytes,
        sourceRasterId: page.sourceRaster.id, sourceRasterFingerprint: page.sourceRaster.fingerprint,
      },
      target, replacementText: String(text), contextPaddingPx: 24,
      operationId, revision: 1, parentRevision: 0, modifiedAt, renderVisiblePatch,
    });
    if (!evaluation.selection.analysis.eligibility.eligible || !evaluation.selection.content
        || !coverageContainsPatch(coverage, page.sourceRaster.widthPx, evaluation.selection.originalPatch)) {
      throw new RangeError('The merged region lacks complete original repair coverage or failed validation');
    }
    const after = structuredClone(before);
    const afterPage = after.pages.find((entry) => entry.index === page.index);
    const removed = new Set(selections.map((selection) => selection.id));
    if (afterPage.selections.some((selection) => !removed.has(selection.id)
      && selection.id === evaluation.selection.id)) {
      throw new RangeError('The stable merged selection already exists');
    }
    afterPage.selections = afterPage.selections.filter((selection) => !removed.has(selection.id));
    afterPage.selections.push(evaluation.selection);
    afterPage.selections.sort((left, right) => left.id.localeCompare(right.id));
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
      type: 'scannedTextEdit', operationId, pageNumbers: [page.index + 1],
      selectionId: evaluation.selection.id, before, after: validatedAfter,
    };
    executeForDocument(doc, command);
    return { command, selection: evaluation.selection };
  } finally {
    patchBytes.forEach(zeroBytes);
    zeroBytes(rasterBytes);
    zeroBytes(coverage);
  }
}
