import {
  SCANNED_TEXT_EDIT_FEATURE,
  SCANNED_TEXT_EDIT_OWNER,
  SCANNED_TEXT_EDIT_STATE_CONTRACT,
  SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION,
  assertScannedTextEditStateV1,
  toValidatedScannedTextEditStateV1Json,
} from '../contracts/scanned-text-edit-state.v1.js';
import { classifyScannedTextBackground, scoreScannedTextEditEligibility } from './background-classifier.js';
import { repairScannedTextBackground } from './repair.js';
import {
  base64ToBytes,
  blitRgbaBytes,
  bytesToBase64,
  cloneRgbaRaster,
  decodeRgbaPatch,
  extractRgbaBytes,
  sha256Hex,
  throwIfAborted,
  validateRgbaRaster,
  zeroBytes,
} from './raster.js';
import { selectScannedTextEditTarget } from './selection.js';
import {
  buildIsolatedSingleLineContent,
  buildScannedTextSearchablePageSnapshot,
} from './single-line.js';
import { buildFixedRegionMultilineContent } from './fixed-region.js';
import { withScannedRichText } from './rich-text-adapter.js';
import {
  SCANNED_TEXT_REFLOW_LAYOUT_MODE,
  buildApprovedRegionParagraphReflowContent,
} from './reflow.js';

export class ScannedTextEditStateConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScannedTextEditStateConflictError';
    this.code = code;
  }
}

function generatedId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function timestamp(value) {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || !value.endsWith('Z')) {
    throw new TypeError('modifiedAt must be an ISO 8601 UTC timestamp');
  }
  return value;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function sameFingerprint(left, right) {
  return left?.algorithm === right?.algorithm && left?.value === right?.value;
}

function notifyStateChanged(doc, pageIndex) {
  if (typeof globalThis.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') return;
  globalThis.dispatchEvent(new CustomEvent('open-pdf-studio:scanned-text-edit-state-changed', {
    detail: { documentId: doc.id, pageIndex },
  }));
}

async function notifyStage(callback, stage, detail) {
  if (typeof callback === 'function') await callback({ stage, ...detail });
}

function patchFromBytes(bytes, bounds, digest) {
  return {
    encoding: 'rgba8-base64',
    coordinateSpace: 'source-raster-pixels',
    originX: bounds.x,
    originY: bounds.y,
    widthPx: bounds.width,
    heightPx: bounds.height,
    rowBytes: bounds.width * 4,
    byteLength: bytes.byteLength,
    sha256: digest,
    data: bytesToBase64(bytes),
  };
}

export function createScannedTextEditStateV1({
  document,
  stateId = generatedId('scanned-text-edit-state'),
  instanceId = generatedId('scanned-text-edit-instance'),
  createdAt,
}) {
  const now = timestamp(createdAt);
  return toValidatedScannedTextEditStateV1Json({
    contract: SCANNED_TEXT_EDIT_STATE_CONTRACT,
    schemaVersion: SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION,
    stateId,
    owner: {
      application: SCANNED_TEXT_EDIT_OWNER,
      feature: SCANNED_TEXT_EDIT_FEATURE,
      instanceId,
    },
    document: clone(document),
    stateRevision: 0,
    pages: [],
    history: { generation: 0, undoDepth: 0, redoDepth: 0, lastOperationId: null },
    createdAt: now,
    updatedAt: now,
  });
}

function assertRasterMatchesSelection(raster, selected) {
  validateRgbaRaster(raster);
  if (raster.widthPx !== selected.sourceRaster.widthPx
      || raster.heightPx !== selected.sourceRaster.heightPx) {
    throw new TypeError('Source raster dimensions do not match the immutable OCR result');
  }
  if (raster.sourceRasterId !== undefined && raster.sourceRasterId !== selected.sourceRaster.id) {
    throw new TypeError('Source raster ID does not match the immutable OCR result');
  }
  if (raster.sourceRasterFingerprint !== undefined
      && !sameFingerprint(raster.sourceRasterFingerprint, selected.sourceRaster.fingerprint)) {
    throw new TypeError('Source raster fingerprint does not match the immutable OCR result');
  }
}

/**
 * Run selection, extraction, deterministic classification, eligibility, and
 * optional repair as an atomic operation. No document state is mutated here.
 */
export async function evaluateScannedTextEdit({
  result,
  pageGeometry,
  raster,
  target,
  signal,
  repairPaddingPx = 1,
  contextPaddingPx = null,
  operationId = generatedId('scanned-text-edit'),
  revision = 1,
  parentRevision = 0,
  modifiedAt,
  onStage,
  onCleanup,
  replacementText = null,
  styleOverrides = {},
  renderVisiblePatch,
  layoutMode = null,
  reflowFontBytes,
}) {
  const ephemeral = [];
  let completed = false;
  let sourceBefore = null;
  const now = timestamp(modifiedAt);
  try {
    throwIfAborted(signal, 'selection');
    const selected = selectScannedTextEditTarget({
      result,
      pageGeometry,
      target,
      repairPaddingPx,
      contextPaddingPx,
    });
    assertRasterMatchesSelection(raster, selected);
    sourceBefore = await sha256Hex(raster.data);
    await notifyStage(onStage, 'selected', { selectionId: selected.id });
    throwIfAborted(signal, 'patch extraction');

    const patchBytes = extractRgbaBytes(raster, selected.geometry.extractionBounds);
    ephemeral.push(patchBytes);
    const patchDigest = await sha256Hex(patchBytes);
    const originalPatch = patchFromBytes(
      patchBytes,
      selected.geometry.extractionBounds,
      patchDigest,
    );
    await notifyStage(onStage, 'extracted', {
      selectionId: selected.id,
      byteLength: patchBytes.byteLength,
      patchDigest,
    });
    throwIfAborted(signal, 'background classification');

    const background = classifyScannedTextBackground({
      patchBytes,
      patch: originalPatch,
      approvedRegion: selected.geometry.repairBounds,
    });
    const eligibility = scoreScannedTextEditEligibility(background, selected.geometry);
    const analysis = { ...background, eligibility };
    await notifyStage(onStage, 'classified', {
      selectionId: selected.id,
      classification: analysis.classification,
      eligible: eligibility.eligible,
    });
    throwIfAborted(signal, 'background repair');

    let repair;
    if (!eligibility.eligible) {
      repair = {
        status: 'rejected',
        method: null,
        approvedRegion: clone(selected.geometry.repairBounds),
        repairedPatch: null,
        changedRegion: null,
      };
    } else {
      const repaired = await repairScannedTextBackground({
        patchBytes,
        patch: originalPatch,
        approvedRegion: selected.geometry.repairBounds,
        classification: analysis.classification,
      });
      ephemeral.push(repaired.repairedExtractionBytes);
      repair = {
        status: 'applied',
        method: repaired.method,
        approvedRegion: clone(selected.geometry.repairBounds),
        repairedPatch: repaired.repairedPatch,
        changedRegion: repaired.changedRegion,
      };
      await notifyStage(onStage, 'repaired', {
        selectionId: selected.id,
        changedPixelCount: repair.changedRegion.changedPixelCount,
      });
      throwIfAborted(signal, 'repair finalization');
    }

    const sourceAfter = await sha256Hex(raster.data);
    if (sourceAfter !== sourceBefore) {
      throw new Error('The original scanned raster was mutated during repair evaluation');
    }
    if (layoutMode !== null
        && (selected.target.kind !== 'region'
          || layoutMode !== SCANNED_TEXT_REFLOW_LAYOUT_MODE)) {
      throw new TypeError(`Unsupported scanned-text region layout mode: ${layoutMode}`);
    }
    const buildContent = selected.target.kind === 'region'
      ? layoutMode === SCANNED_TEXT_REFLOW_LAYOUT_MODE
        ? buildApprovedRegionParagraphReflowContent
        : buildFixedRegionMultilineContent
      : buildIsolatedSingleLineContent;
    const content = replacementText === null ? null : withScannedRichText(await buildContent({
      result,
      pageGeometry,
      raster,
      selected,
      originalPatch,
      repair,
      analysis,
      replacementText,
      styleOverrides,
      revision,
      parentRevision,
      renderVisiblePatch,
      reflowFontBytes,
    }));
    if (content) {
      await notifyStage(onStage, 'replacement-rendered', {
        selectionId: selected.id,
        replacementText: content.replacementText,
      });
      throwIfAborted(signal, 'replacement finalization');
    }
    const selection = {
      id: selected.id,
      revision,
      target: selected.target,
      geometry: selected.geometry,
      originalPatch,
      analysis,
      repair,
      content,
      ownership: {
        owner: SCANNED_TEXT_EDIT_OWNER,
        operationId,
        revision,
        parentRevision,
        createdAt: now,
        updatedAt: now,
      },
    };
    completed = true;
    return {
      selection,
      page: selected.page,
      pageGeometry: clone(pageGeometry),
      sourceRaster: {
        ...selected.sourceRaster,
        rgbaSha256: sourceBefore,
      },
      document: selected.document,
      searchableTextSnapshot: content
        ? buildScannedTextSearchablePageSnapshot(result, pageGeometry)
        : [],
    };
  } finally {
    for (const bytes of ephemeral) zeroBytes(bytes);
    if (typeof onCleanup === 'function') {
      await onCleanup({
        completed,
        bufferCount: ephemeral.length,
        allBuffersZeroed: ephemeral.every((bytes) => bytes.every((byte) => byte === 0)),
      });
    }
  }
}

function pageForEvaluation(evaluation) {
  return {
    id: evaluation.page.id,
    index: evaluation.page.index,
    revision: evaluation.page.revision,
    sourceRaster: clone(evaluation.sourceRaster),
    pageGeometry: clone(evaluation.pageGeometry),
    searchableTextSnapshot: clone(evaluation.searchableTextSnapshot || []),
    selections: [],
  };
}

function assertCurrentOwnedOcrSource(doc, evaluation) {
  const ocr = doc?.ocr;
  // Low-level contract consumers may commit without application OCR state. In
  // the production document path, a generation identifies the authoritative
  // source and must still own the exact result and geometry being committed.
  if (typeof ocr?.generation !== 'string') return;
  const page = ocr.pages?.[evaluation.page.index + 1];
  const result = page?.recognition?.result;
  const geometry = page?.recognition?.geometry;
  const matches = ocr.documentId === doc.id
    && ocr.generation === evaluation.document.generation
    && page?.generation === evaluation.document.generation
    && page?.pageId === evaluation.page.id
    && page?.pageRevision === evaluation.page.revision
    && page?.recognition?.ownership?.owner === SCANNED_TEXT_EDIT_OWNER
    && result?.document?.id === evaluation.document.id
    && result?.document?.revision === evaluation.document.revision
    && result?.document?.generation === evaluation.document.generation
    && result?.page?.id === evaluation.page.id
    && result?.page?.index === evaluation.page.index
    && result?.page?.revision === evaluation.page.revision
    && result?.sourceRaster?.id === evaluation.sourceRaster.id
    && sameFingerprint(result?.sourceRaster?.fingerprint, evaluation.sourceRaster.fingerprint)
    && result?.sourceRaster?.widthPx === evaluation.sourceRaster.widthPx
    && result?.sourceRaster?.heightPx === evaluation.sourceRaster.heightPx
    && geometry?.geometryId === evaluation.pageGeometry.geometryId;
  if (!matches) {
    throw new ScannedTextEditStateConflictError(
      'STALE_OCR_SOURCE',
      'Scanned-text edit evaluation no longer matches the current application-owned OCR source',
    );
  }
}

export function commitScannedTextEditEvaluation(doc, evaluation, {
  modifiedAt,
} = {}) {
  const now = timestamp(modifiedAt ?? evaluation.selection.ownership.updatedAt);
  assertCurrentOwnedOcrSource(doc, evaluation);
  const before = doc.scannedTextEdits ? toValidatedScannedTextEditStateV1Json(doc.scannedTextEdits) : null;
  const next = before ? clone(before) : createScannedTextEditStateV1({
    document: evaluation.document,
    createdAt: evaluation.selection.ownership.createdAt,
  });
  if (next.document.id !== doc.id || next.document.id !== evaluation.document.id
      || next.document.revision !== evaluation.document.revision
      || next.document.generation !== evaluation.document.generation) {
    throw new TypeError('Scanned-text edit state is stale for the target document revision');
  }
  let page = next.pages.find((entry) => entry.index === evaluation.page.index);
  if (!page) {
    page = pageForEvaluation(evaluation);
    next.pages.push(page);
    next.pages.sort((left, right) => left.index - right.index);
  } else if (page.id !== evaluation.page.id || page.revision !== evaluation.page.revision
      || page.sourceRaster.id !== evaluation.sourceRaster.id
      || page.sourceRaster.rgbaSha256 !== evaluation.sourceRaster.rgbaSha256
      || page.pageGeometry.geometryId !== evaluation.pageGeometry.geometryId) {
    throw new TypeError('Scanned-text edit page is stale for the source raster or canonical geometry');
  }
  const index = page.selections.findIndex((entry) => entry.id === evaluation.selection.id);
  const currentRevision = index >= 0 ? page.selections[index].revision : 0;
  if (evaluation.selection.ownership.parentRevision !== currentRevision
      || evaluation.selection.revision !== currentRevision + 1) {
    throw new ScannedTextEditStateConflictError(
      'STALE_EDIT_REVISION',
      'Scanned-text edit evaluation is stale for the current target revision',
    );
  }
  if (index >= 0) page.selections[index] = clone(evaluation.selection);
  else page.selections.push(clone(evaluation.selection));
  page.selections.sort((left, right) => left.id.localeCompare(right.id));
  next.stateRevision += 1;
  next.history = {
    generation: next.history.generation + 1,
    undoDepth: (doc.undoStack?.length ?? 0) + 1,
    redoDepth: 0,
    lastOperationId: evaluation.selection.ownership.operationId,
  };
  next.updatedAt = now;
  const after = toValidatedScannedTextEditStateV1Json(next);
  doc.scannedTextEdits = after;
  doc.scannedTextEditRemovalPending = false;
  if (evaluation.selection.content && doc.ocr) doc.ocr.dirty = true;
  notifyStateChanged(doc, evaluation.page.index);
  return { before, after };
}

export function snapshotScannedTextEditCommandState(doc) {
  return doc?.scannedTextEdits ? toValidatedScannedTextEditStateV1Json(doc.scannedTextEdits) : null;
}

export function restoreScannedTextEditCommandState(doc, snapshot) {
  if (snapshot === null) {
    doc.scannedTextEdits = null;
    doc.scannedTextEditRemovalPending = true;
    if (doc?.ocr) doc.ocr.dirty = true;
    notifyStateChanged(doc, null);
    return null;
  }
  doc.scannedTextEdits = toValidatedScannedTextEditStateV1Json(snapshot);
  doc.scannedTextEditRemovalPending = doc.scannedTextEdits.pages
    .some((page) => page.selections.some((selection) => selection.repair.status === 'reverted'));
  if (doc?.ocr) doc.ocr.dirty = true;
  notifyStateChanged(doc, null);
  return doc.scannedTextEdits;
}

export async function materializeScannedTextEditPage(originalRaster, state, pageIndex) {
  validateRgbaRaster(originalRaster);
  assertScannedTextEditStateV1(state);
  const page = state.pages.find((entry) => entry.index === pageIndex);
  if (!page) return cloneRgbaRaster(originalRaster);
  const digest = await sha256Hex(originalRaster.data);
  if (digest !== page.sourceRaster.rgbaSha256
      || originalRaster.widthPx !== page.sourceRaster.widthPx
      || originalRaster.heightPx !== page.sourceRaster.heightPx) {
    throw new TypeError('Original raster does not match the application-owned edit-state source image');
  }
  const materialized = cloneRgbaRaster(originalRaster);
  for (const selection of page.selections) {
    if (selection.repair.status !== 'applied') continue;
    const bytes = await decodeRgbaPatch(selection.repair.repairedPatch);
    try {
      blitRgbaBytes(materialized, bytes, selection.repair.approvedRegion);
    } finally {
      zeroBytes(bytes);
    }
  }
  return materialized;
}

export function nextSelectionRevision(doc, selectionId) {
  for (const page of doc?.scannedTextEdits?.pages ?? []) {
    const selection = page.selections.find((entry) => entry.id === selectionId);
    if (selection) return { revision: selection.revision + 1, parentRevision: selection.revision };
  }
  return { revision: 1, parentRevision: 0 };
}

export async function originalPatchBytes(selection) {
  const bytes = base64ToBytes(selection.originalPatch.data);
  if (await sha256Hex(bytes) !== selection.originalPatch.sha256) {
    zeroBytes(bytes);
    throw new TypeError('Original patch ownership digest mismatch');
  }
  return bytes;
}
