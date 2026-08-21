import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { createServer } from 'vite';

import {
  SCANNED_TEXT_EDIT_STATE_CONTRACT,
  assertScannedTextEditStateV1,
  validateScannedTextEditStateV1,
} from '../contracts/scanned-text-edit-state.v1.js';
import { validateAgainstJsonSchema } from '../contracts/schema-validation.js';
import { createOcrPageGeometryV1 } from '../contracts/page-geometry.v1.js';
import { classifyScannedTextBackground } from './background-classifier.js';
import {
  commitScannedTextEditEvaluation,
  createScannedTextEditStateV1,
  evaluateScannedTextEdit,
  materializeScannedTextEditPage,
} from './edit-state.js';
import { selectScannedTextEditTarget } from './selection.js';
import { makeOcrFixture } from '../searchable-layer.test-fixtures.mjs';

const FIXTURE_ROOT = new URL('../../../tests/fixtures/ocr/editing-foundation-v1/', import.meta.url);
const FIXED_TIME = '2026-08-20T12:00:00.000Z';

globalThis.window = {
  location: new URL('http://localhost/'),
  dispatchEvent() { return true; },
};
globalThis.location = globalThis.window.location;

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});
const { state } = await vite.ssrLoadModule('/js/core/state.js');
const { redo, undo } = await vite.ssrLoadModule('/js/core/undo-manager.js');
const { applyScannedTextEditForDocument } = await vite.ssrLoadModule('/js/ocr/editing/undo-commands.js');

after(async () => {
  state.documents.splice(0, state.documents.length);
  state.activeDocumentIndex = -1;
  await vite.close();
});

async function loadVisualFixture(id) {
  const manifest = JSON.parse(await readFile(new URL('manifest.v1.json', FIXTURE_ROOT), 'utf8'));
  const entry = manifest.fixtures.find((fixture) => fixture.id === id);
  assert.ok(entry, `missing fixture ${id}`);
  const decoded = await sharp(fileURLToPath(new URL(entry.file, FIXTURE_ROOT)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    entry,
    raster: {
      widthPx: decoded.info.width,
      heightPx: decoded.info.height,
      rowBytes: decoded.info.width * 4,
      data: new Uint8ClampedArray(decoded.data),
    },
  };
}

function ocrFor(entry, suffix = entry.id) {
  return makeOcrFixture({
    documentId: `edit-document-${suffix}`,
    documentGeneration: `edit-generation-${suffix}`,
    pageId: `edit-page-${suffix}`,
    pageRevision: 0,
    lines: [entry.ocrLine],
    width: entry.widthPx,
    height: entry.heightPx,
  });
}

function boundRaster(raster, result) {
  return {
    ...raster,
    sourceRasterId: result.sourceRaster.id,
    sourceRasterFingerprint: result.sourceRaster.fingerprint,
  };
}

function documentFor(result) {
  return {
    id: result.document.id,
    undoStack: [],
    redoStack: [],
    savedUndoStackLength: 0,
    modified: false,
    ocr: { dirty: false },
    scannedTextEdits: createScannedTextEditStateV1({
      document: result.document,
      stateId: `edit-state-${result.page.id}`,
      instanceId: `edit-instance-${result.page.id}`,
      createdAt: FIXED_TIME,
    }),
  };
}

function pixelsOutsideEqual(before, after, bounds) {
  let outsideChanged = 0;
  let insideChanged = 0;
  for (let y = 0; y < before.heightPx; y += 1) {
    for (let x = 0; x < before.widthPx; x += 1) {
      const offset = (y * before.widthPx + x) * 4;
      const changed = [0, 1, 2, 3].some((channel) => before.data[offset + channel] !== after.data[offset + channel]);
      if (!changed) continue;
      const inside = x >= bounds.x && y >= bounds.y
        && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
      if (inside) insideChanged += 1;
      else outsideChanged += 1;
    }
  }
  return { outsideChanged, insideChanged };
}

test('selects stable OCR line and region IDs into canonical source geometry without mutating results', () => {
  const { result, pageGeometry } = makeOcrFixture({
    documentId: 'edit-document-selection',
    documentGeneration: 'edit-generation-selection',
    pageId: 'edit-page-selection',
    pageRevision: 2,
    width: 256,
    height: 160,
    lines: [
      { id: 'line-stable-1', text: 'first', x: 20, y: 30, width: 80, height: 14, confidence: 0.98 },
      { id: 'line-stable-2', text: 'second', x: 20, y: 52, width: 92, height: 14, confidence: 0.96 },
    ],
  });
  const immutableBefore = structuredClone(result);
  const line = selectScannedTextEditTarget({
    result,
    pageGeometry,
    target: { kind: 'line', lineId: 'line-stable-1' },
    contextPaddingPx: 16,
  });
  const region = selectScannedTextEditTarget({
    result,
    pageGeometry,
    target: { kind: 'region', regionId: 'region-stable-1', lineIds: ['line-stable-1', 'line-stable-2'] },
    contextPaddingPx: 16,
  });
  assert.equal(line.id, 'scan-edit-edit-page-selection-line-line-stable-1');
  assert.deepEqual(line.target.lineIds, ['line-stable-1']);
  assert.equal(region.id, 'scan-edit-edit-page-selection-region-region-stable-1');
  assert.deepEqual(region.target.lineIds, ['line-stable-1', 'line-stable-2']);
  assert.equal(region.geometry.coordinateSpace, 'source-raster-pixels');
  assert.equal(region.geometry.lineGeometry.length, 2);
  assert.ok(region.geometry.lineGeometry.every((entry) => entry.transform.matrix.length === 9
    && entry.transform.inverseMatrix.length === 9 && entry.roundTripMaxErrorPx <= 1e-6));
  assert.deepEqual(result, immutableBefore);
  assert.equal(Object.hasOwn(result, 'editState'), false);
  assert.equal(Object.hasOwn(result.lines[0], 'repair'), false);
});

test('canonical source geometry stores an invertible non-identity OCR transform', () => {
  const { result } = makeOcrFixture({
    documentId: 'edit-document-rotated-geometry',
    documentGeneration: 'edit-generation-rotated-geometry',
    pageId: 'edit-page-rotated-geometry',
    pageRevision: 3,
    width: 256,
    height: 160,
    lines: [{ id: 'line-rotated', text: 'rotated', x: 20, y: 30, width: 60, height: 20, confidence: 0.99 }],
  });
  result.engine.engineId = 'fixture-preprocessing-engine';
  result.engine.capabilities.preprocessingMetadata = true;
  result.preprocessing = {
    status: 'applied',
    operations: [{ kind: 'orientation', applied: true, value: 90, unit: 'degrees-clockwise' }],
    outputRaster: {
      id: 'preprocessed-raster-rotated-edit-proof',
      fingerprint: { algorithm: 'sha256', value: 'd'.repeat(64) },
      coordinateSpace: 'preprocessed-raster-pixels',
      widthPx: 160,
      heightPx: 256,
      dpi: 72,
    },
    transform: {
      fromSpace: 'source-raster-pixels',
      toSpace: 'preprocessed-raster-pixels',
      matrix: [0, 1, -1, 0, 160, 0],
      inverseMatrix: [0, -1, 1, 0, 0, 160],
    },
  };
  result.lines[0].polygon.coordinateSpace = 'preprocessed-raster-pixels';
  result.lines[0].boundingBox.coordinateSpace = 'preprocessed-raster-pixels';
  result.lines[0].baseline.coordinateSpace = 'preprocessed-raster-pixels';
  const pageGeometry = createOcrPageGeometryV1({
    geometryId: 'geometry-rotated-edit-proof',
    document: result.document,
    page: { id: result.page.id, index: result.page.index, revision: result.page.revision },
    boxes: {
      mediaBox: { coordinateSpace: 'pdf-default-user-space', x: 0, y: 0, width: 256, height: 160 },
      cropBox: { coordinateSpace: 'pdf-default-user-space', x: 0, y: 0, width: 256, height: 160 },
      bleedBox: null,
      trimBox: null,
      artBox: null,
    },
    userUnit: 1,
    userUnitProvenance: 'pdf-default',
    intrinsicRotationDegrees: 0,
    applicationRotationDegrees: 0,
    requestedDpi: 72,
    sourceRaster: result.sourceRaster,
    annotationsExcluded: true,
    formsExcluded: true,
    preprocessing: {
      orientationDegrees: 90,
      orientationProvenance: 'requested',
      outputWidthPx: 160,
      outputHeightPx: 256,
    },
    engineGeometry: { width: 160, height: 256 },
  });
  const selected = selectScannedTextEditTarget({
    result,
    pageGeometry,
    target: { kind: 'line', lineId: 'line-rotated' },
    repairPaddingPx: 1,
    contextPaddingPx: 16,
  });
  const transform = selected.geometry.lineGeometry[0].transform;
  assert.notDeepEqual(transform.matrix, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(transform.matrix, [0, 1, 0, -1, 0, 160, 0, 0, 1]);
  assert.deepEqual(transform.inverseMatrix, [0, -1, 160, 1, 0, 0, 0, 0, 1]);
  assert.equal(selected.geometry.roundTripMaxErrorPx, 0);
  assert.deepEqual(selected.geometry.repairBounds, {
    coordinateSpace: 'source-raster-pixels',
    x: 29,
    y: 79,
    width: 22,
    height: 62,
  });
});

test('extracts an owned original patch, repairs flat pixels, and changes nothing outside the approved region', async () => {
  const { entry, raster } = await loadVisualFixture('flat-color');
  const fixture = ocrFor(entry);
  const sourceBefore = new Uint8ClampedArray(raster.data);
  const evaluation = await evaluateScannedTextEdit({
    ...fixture,
    raster: boundRaster(raster, fixture.result),
    target: { kind: 'line', lineId: entry.ocrLine.id },
    repairPaddingPx: 1,
    contextPaddingPx: 24,
    operationId: 'flat-repair-operation',
    modifiedAt: FIXED_TIME,
  });
  assert.equal(evaluation.selection.analysis.classification, 'flat');
  assert.equal(evaluation.selection.analysis.eligibility.eligible, true);
  assert.equal(evaluation.selection.repair.status, 'applied');
  assert.equal(evaluation.selection.repair.method, 'flat-median-fill-v1');
  assert.equal(evaluation.selection.repair.changedRegion.outsideApprovedChangedPixels, 0);
  assert.ok(evaluation.selection.originalPatch.byteLength > evaluation.selection.repair.repairedPatch.byteLength);
  assert.deepEqual(raster.data, sourceBefore, 'the original scan raster must remain byte-exact');

  const doc = documentFor(fixture.result);
  const applied = await evaluateScannedTextEdit({
    ...fixture,
    raster: boundRaster(raster, fixture.result),
    target: { kind: 'line', lineId: entry.ocrLine.id },
    repairPaddingPx: 1,
    contextPaddingPx: 24,
    operationId: 'flat-repair-commit',
    modifiedAt: FIXED_TIME,
  });
  commitScannedTextEditEvaluation(doc, applied);
  const materialized = await materializeScannedTextEditPage(raster, doc.scannedTextEdits, 0);
  const comparison = pixelsOutsideEqual(raster, materialized, applied.selection.repair.approvedRegion);
  assert.equal(comparison.outsideChanged, 0);
  assert.equal(comparison.insideChanged, applied.selection.repair.changedRegion.changedPixelCount);
  assert.ok(comparison.insideChanged > 0);
});

test('unknown and complex backgrounds carry explicit rejection reasons and never produce repair pixels', async () => {
  const patch = {
    originX: 0,
    originY: 0,
    widthPx: 8,
    heightPx: 8,
  };
  const bytes = new Uint8Array(8 * 8 * 4).fill(255);
  const unknown = classifyScannedTextBackground({
    patchBytes: bytes,
    patch,
    approvedRegion: { x: 1, y: 1, width: 6, height: 6 },
  });
  assert.equal(unknown.classification, 'unknown');

  const { entry, raster } = await loadVisualFixture('table');
  const fixture = ocrFor(entry);
  const evaluation = await evaluateScannedTextEdit({
    ...fixture,
    raster: boundRaster(raster, fixture.result),
    target: { kind: 'line', lineId: entry.ocrLine.id },
    contextPaddingPx: 24,
    operationId: 'table-rejection-operation',
    modifiedAt: FIXED_TIME,
  });
  assert.equal(evaluation.selection.analysis.classification, 'table-line-art');
  assert.equal(evaluation.selection.analysis.eligibility.eligible, false);
  assert.ok(evaluation.selection.analysis.eligibility.rejectionReasons
    .some((reason) => reason.code === 'BACKGROUND_NOT_REPAIRABLE'));
  assert.equal(evaluation.selection.repair.status, 'rejected');
  assert.equal(evaluation.selection.repair.repairedPatch, null);
  assert.equal(evaluation.selection.repair.changedRegion, null);
});

test('clipped classifier context is rejected before near-flat interpolation', async () => {
  const { entry, raster } = await loadVisualFixture('compression-noise');
  const edgeEntry = {
    ...entry,
    ocrLine: { ...entry.ocrLine, x: 0 },
  };
  const fixture = ocrFor(edgeEntry, 'edge-context');
  const evaluation = await evaluateScannedTextEdit({
    ...fixture,
    raster: boundRaster(raster, fixture.result),
    target: { kind: 'line', lineId: edgeEntry.ocrLine.id },
    repairPaddingPx: 0,
    contextPaddingPx: 24,
    operationId: 'edge-context-rejection',
    modifiedAt: FIXED_TIME,
  });
  assert.equal(evaluation.selection.geometry.clipped, true);
  assert.equal(evaluation.selection.analysis.eligibility.eligible, false);
  assert.ok(evaluation.selection.analysis.eligibility.rejectionReasons
    .some((reason) => reason.code === 'GEOMETRY_CLIPPED'));
  assert.equal(evaluation.selection.repair.status, 'rejected');
  assert.equal(evaluation.selection.repair.repairedPatch, null);
});

test('separate edit-state contract validates through runtime and JSON Schema paths', async () => {
  const { entry, raster } = await loadVisualFixture('compression-noise');
  const fixture = ocrFor(entry);
  const doc = documentFor(fixture.result);
  const evaluation = await evaluateScannedTextEdit({
    ...fixture,
    raster: boundRaster(raster, fixture.result),
    target: { kind: 'line', lineId: entry.ocrLine.id },
    contextPaddingPx: 24,
    operationId: 'near-flat-contract-operation',
    modifiedAt: FIXED_TIME,
  });
  commitScannedTextEditEvaluation(doc, evaluation);
  assert.equal(doc.scannedTextEdits.contract, SCANNED_TEXT_EDIT_STATE_CONTRACT);
  assert.equal(doc.scannedTextEdits.pages[0].selections[0].repair.method, 'near-flat-edge-interpolation-v1');
  assertScannedTextEditStateV1(doc.scannedTextEdits);
  assert.deepEqual(validateScannedTextEditStateV1(doc.scannedTextEdits), { ok: true, issues: [] });
  const commonSchema = JSON.parse(await readFile(new URL('../contracts/common.schema.json', import.meta.url), 'utf8'));
  const editSchema = JSON.parse(await readFile(new URL('../contracts/scanned-text-edit-state.v1.schema.json', import.meta.url), 'utf8'));
  const schemaValidation = validateAgainstJsonSchema(doc.scannedTextEdits, editSchema, {
    schemas: [commonSchema],
  });
  assert.deepEqual(schemaValidation, { ok: true, issues: [] });

  const tampered = structuredClone(doc.scannedTextEdits);
  tampered.pages[0].selections[0].repair.changedRegion.outsideApprovedChangedPixels = 1;
  assert.equal(validateScannedTextEditStateV1(tampered).ok, false);
});

test('application and operation ownership retain monotonic state and target revisions', async () => {
  const { entry, raster } = await loadVisualFixture('flat-color');
  const fixture = ocrFor(entry, 'ownership-revision');
  const doc = documentFor(fixture.result);
  const input = {
    ...fixture,
    raster: boundRaster(raster, fixture.result),
    target: { kind: 'line', lineId: entry.ocrLine.id },
    contextPaddingPx: 24,
    modifiedAt: FIXED_TIME,
  };
  const first = await applyScannedTextEditForDocument(doc, {
    ...input,
    operationId: 'ownership-operation-1',
  });
  const second = await applyScannedTextEditForDocument(doc, {
    ...input,
    operationId: 'ownership-operation-2',
  });
  const selection = doc.scannedTextEdits.pages[0].selections[0];
  assert.equal(doc.scannedTextEdits.owner.application, 'open-pdf-studio');
  assert.equal(doc.scannedTextEdits.owner.feature, 'scanned-text-editing');
  assert.equal(doc.scannedTextEdits.stateRevision, 2);
  assert.deepEqual(doc.scannedTextEdits.history, {
    generation: 2,
    undoDepth: 2,
    redoDepth: 0,
    lastOperationId: 'ownership-operation-2',
  });
  assert.equal(selection.revision, 2);
  assert.equal(selection.ownership.revision, 2);
  assert.equal(selection.ownership.parentRevision, 1);
  assert.equal(selection.ownership.operationId, 'ownership-operation-2');
  assert.equal(first.command.after.pages[0].selections[0].revision, 1);
  assert.equal(second.command.before.pages[0].selections[0].revision, 1);
  assert.equal(second.command.after.pages[0].selections[0].revision, 2);
  assertScannedTextEditStateV1(doc.scannedTextEdits);
});

test('typed undo and redo restore the original patch and the exact repaired patch', async () => {
  const { entry, raster } = await loadVisualFixture('flat-color');
  const fixture = ocrFor(entry, 'undo-redo');
  const doc = documentFor(fixture.result);
  state.documents.splice(0, state.documents.length, doc);
  state.activeDocumentIndex = 0;
  try {
    const activeDocument = state.documents[0];
    const applied = await applyScannedTextEditForDocument(activeDocument, {
      ...fixture,
      raster: boundRaster(raster, fixture.result),
      target: { kind: 'line', lineId: entry.ocrLine.id },
      contextPaddingPx: 24,
      operationId: 'undo-redo-operation',
      modifiedAt: FIXED_TIME,
    });
    const repaired = await materializeScannedTextEditPage(raster, activeDocument.scannedTextEdits, 0);
    assert.ok(pixelsOutsideEqual(raster, repaired, applied.selection.repair.approvedRegion).insideChanged > 0);
    assert.equal(activeDocument.undoStack.length, 1);
    assert.equal(activeDocument.undoStack[0].before.pages.length, 0);

    await undo();
    assert.equal(activeDocument.scannedTextEdits?.pages.length ?? 0, 0, 'undo must restore the pre-edit state snapshot');
    const afterUndo = activeDocument.scannedTextEdits === null
      ? { ...raster, data: new Uint8ClampedArray(raster.data) }
      : await materializeScannedTextEditPage(raster, activeDocument.scannedTextEdits, 0);
    assert.deepEqual(afterUndo.data, raster.data, 'undo must restore the original extracted pixels');

    await redo();
    const afterRedo = await materializeScannedTextEditPage(raster, activeDocument.scannedTextEdits, 0);
    assert.deepEqual(afterRedo.data, repaired.data, 'redo must restore the exact repair patch');
  } finally {
    state.documents.splice(0, state.documents.length);
    state.activeDocumentIndex = -1;
  }
});

test('cancellation and failures zero temporary buffers and leave edit state untouched', async () => {
  const { entry, raster } = await loadVisualFixture('flat-color');
  const fixture = ocrFor(entry, 'cleanup');
  const doc = documentFor(fixture.result);
  const initialState = structuredClone(doc.scannedTextEdits);
  const controller = new AbortController();
  let cleanup = null;
  await assert.rejects(
    () => evaluateScannedTextEdit({
      ...fixture,
      raster: boundRaster(raster, fixture.result),
      target: { kind: 'line', lineId: entry.ocrLine.id },
      contextPaddingPx: 24,
      operationId: 'cancelled-operation',
      modifiedAt: FIXED_TIME,
      signal: controller.signal,
      onStage({ stage }) {
        if (stage === 'extracted') controller.abort();
      },
      onCleanup(result) { cleanup = result; },
    }),
    (error) => error.name === 'AbortError' && error.code === 'EDIT_CANCELLED',
  );
  assert.deepEqual(cleanup, { completed: false, bufferCount: 1, allBuffersZeroed: true });
  assert.deepEqual(doc.scannedTextEdits, initialState);
  assert.equal(doc.undoStack.length, 0);

  let failureCleanup = null;
  await assert.rejects(
    () => evaluateScannedTextEdit({
      ...fixture,
      raster: boundRaster(raster, fixture.result),
      target: { kind: 'line', lineId: entry.ocrLine.id },
      contextPaddingPx: 24,
      operationId: 'failed-operation',
      modifiedAt: FIXED_TIME,
      onStage({ stage }) {
        if (stage === 'repaired') throw new Error('simulated downstream failure');
      },
      onCleanup(result) { failureCleanup = result; },
    }),
    /simulated downstream failure/u,
  );
  assert.deepEqual(failureCleanup, { completed: false, bufferCount: 2, allBuffersZeroed: true });
  assert.deepEqual(doc.scannedTextEdits, initialState);
  assert.equal(doc.undoStack.length, 0);
});
