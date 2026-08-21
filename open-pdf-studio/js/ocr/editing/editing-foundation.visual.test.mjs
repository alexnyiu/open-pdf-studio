import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCanvas } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';

import {
  SCANNED_TEXT_EDIT_MIN_GEOMETRY_CONFIDENCE,
  assertScannedTextEditStateV1,
} from '../contracts/scanned-text-edit-state.v1.js';
import {
  createScannedTextEditStateV1,
  evaluateScannedTextEdit,
} from './edit-state.js';
import {
  inspectOwnedScannedTextRepairLayer,
  removeOwnedScannedTextRepairLayer,
  writeOwnedScannedTextRepairLayer,
} from './pdf-repair-layer.js';
import { makeOcrFixture } from '../searchable-layer.test-fixtures.mjs';

const FIXTURE_ROOT = new URL('../../../tests/fixtures/ocr/editing-foundation-v1/', import.meta.url);
const FIXED_PDF_TIME = 'D:20260820120000Z';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function manifest() {
  return JSON.parse(await readFile(new URL('manifest.v1.json', FIXTURE_ROOT), 'utf8'));
}

async function fixtureRaster(entry) {
  const decoded = await sharp(fileURLToPath(new URL(entry.file, FIXTURE_ROOT)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    widthPx: decoded.info.width,
    heightPx: decoded.info.height,
    rowBytes: decoded.info.width * 4,
    data: new Uint8ClampedArray(decoded.data),
  };
}

function ocrFixture(entry) {
  return makeOcrFixture({
    documentId: `visual-edit-document-${entry.id}`,
    documentGeneration: `visual-edit-generation-${entry.id}`,
    pageId: `visual-edit-page-${entry.id}`,
    pageRevision: 0,
    lines: [entry.ocrLine],
    width: entry.widthPx,
    height: entry.heightPx,
  });
}

async function evaluateFixture(entry) {
  const raster = await fixtureRaster(entry);
  const fixture = ocrFixture(entry);
  const evaluation = await evaluateScannedTextEdit({
    ...fixture,
    raster: {
      ...raster,
      sourceRasterId: fixture.result.sourceRaster.id,
      sourceRasterFingerprint: fixture.result.sourceRaster.fingerprint,
    },
    target: { kind: 'line', lineId: entry.ocrLine.id },
    contextPaddingPx: 24,
    operationId: `visual-operation-${entry.id}`,
    modifiedAt: '2026-08-20T12:00:00.000Z',
  });
  return { evaluation, fixture, raster };
}

async function renderPdfPage(bytes) {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    verbosity: 0,
  });
  const document = await loadingTask.promise;
  try {
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const widthPx = Math.round(viewport.width);
    const heightPx = Math.round(viewport.height);
    const canvas = createCanvas(widthPx, heightPx);
    const context = canvas.getContext('2d');
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const image = context.getImageData(0, 0, widthPx, heightPx);
    page.cleanup();
    return { widthPx, heightPx, data: new Uint8ClampedArray(image.data) };
  } finally {
    await document.destroy();
  }
}

function comparePixels(before, after, approvedRegion) {
  assert.equal(after.widthPx, before.widthPx);
  assert.equal(after.heightPx, before.heightPx);
  let changedPixelCount = 0;
  let outsideApprovedChangedPixels = 0;
  let minX = before.widthPx;
  let minY = before.heightPx;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < before.heightPx; y += 1) {
    for (let x = 0; x < before.widthPx; x += 1) {
      const offset = (y * before.widthPx + x) * 4;
      const changed = [0, 1, 2, 3]
        .some((channel) => before.data[offset + channel] !== after.data[offset + channel]);
      if (!changed) continue;
      changedPixelCount += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const inside = approvedRegion && x >= approvedRegion.x && y >= approvedRegion.y
        && x < approvedRegion.x + approvedRegion.width
        && y < approvedRegion.y + approvedRegion.height;
      if (!inside) outsideApprovedChangedPixels += 1;
    }
  }
  return {
    changedPixelCount,
    outsideApprovedChangedPixels,
    actualBounds: changedPixelCount === 0 ? null : {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    },
  };
}

test('visual fixtures classify every supported background and reject uncertainty explicitly', async () => {
  const fixtureManifest = await manifest();
  assert.equal(fixtureManifest.deterministic, true);
  assert.equal(fixtureManifest.modelUsed, false);
  assert.equal(fixtureManifest.fixtures.length, 9);
  const observedClasses = new Set();
  for (const entry of fixtureManifest.fixtures) {
    const { evaluation } = await evaluateFixture(entry);
    const { analysis, repair, geometry } = evaluation.selection;
    observedClasses.add(analysis.classification);
    assert.equal(analysis.classification, entry.expectedClassification, entry.id);
    assert.equal(analysis.eligibility.eligible, entry.expectedEligible, entry.id);
    assert.ok(analysis.eligibility.score >= 0 && analysis.eligibility.score <= 1, entry.id);
    assert.equal(
      Object.values(analysis.eligibility.components).every((component) => (
        typeof component.value === 'number' && typeof component.weight === 'number'
      )),
      true,
      entry.id,
    );
    if (entry.expectedEligible) {
      assert.equal(repair.status, 'applied', entry.id);
      assert.ok(['flat-median-fill-v1', 'near-flat-edge-interpolation-v1'].includes(repair.method), entry.id);
      assert.equal(repair.changedRegion.outsideApprovedChangedPixels, 0, entry.id);
    } else {
      assert.equal(repair.status, 'rejected', entry.id);
      assert.equal(repair.repairedPatch, null, entry.id);
      assert.ok(analysis.eligibility.rejectionReasons.length > 0, entry.id);
    }
    if (entry.id === 'low-confidence-geometry') {
      assert.ok(analysis.eligibility.rejectionReasons.some((reason) => reason.code === 'GEOMETRY_CONFIDENCE_LOW'));
      assert.ok(geometry.confidence < SCANNED_TEXT_EDIT_MIN_GEOMETRY_CONFIDENCE);
    }
  }
  assert.deepEqual([...observedClasses].sort(), [
    'flat',
    'gradient',
    'near-flat',
    'photographic',
    'table-line-art',
    'textured',
  ]);
});

test('PDF.js proves exact approved-region pixels, preserved scan content, owned reopen state, and reversible removal', async () => {
  const fixtureManifest = await manifest();
  const sourceBytes = new Uint8Array(await readFile(new URL(fixtureManifest.pdfProof.source, FIXTURE_ROOT)));
  const repairedBytes = new Uint8Array(await readFile(new URL(fixtureManifest.pdfProof.repaired, FIXTURE_ROOT)));
  const revertedBytes = new Uint8Array(await readFile(new URL(fixtureManifest.pdfProof.reverted, FIXTURE_ROOT)));
  assert.equal(digest(sourceBytes), fixtureManifest.pdfProof.sourceSha256);
  assert.equal(digest(repairedBytes), fixtureManifest.pdfProof.repairedSha256);
  assert.equal(digest(revertedBytes), fixtureManifest.pdfProof.revertedSha256);

  const [sourceInspection] = await inspectOwnedScannedTextRepairLayer(sourceBytes);
  const [repairedInspection] = await inspectOwnedScannedTextRepairLayer(repairedBytes);
  const [revertedInspection] = await inspectOwnedScannedTextRepairLayer(revertedBytes);
  assert.equal(sourceInspection.owned, false);
  assert.equal(repairedInspection.owned, true);
  assert.equal(revertedInspection.owned, false);
  assert.equal(repairedInspection.stateId, fixtureManifest.pdfProof.stateId);
  assert.equal(repairedInspection.stateRevision, fixtureManifest.pdfProof.stateRevision);
  assertScannedTextEditStateV1(repairedInspection.state);
  assert.deepEqual(
    repairedInspection.contentRefs.filter((ref) => ref !== repairedInspection.contentRef),
    sourceInspection.contentRefs,
    'the original scanned-image content stream must remain present and unchanged',
  );
  assert.deepEqual(revertedInspection.contentRefs, sourceInspection.contentRefs);

  const [sourceRaster, repairedRaster, revertedRaster] = await Promise.all([
    renderPdfPage(sourceBytes),
    renderPdfPage(repairedBytes),
    renderPdfPage(revertedBytes),
  ]);
  const repairComparison = comparePixels(sourceRaster, repairedRaster, fixtureManifest.pdfProof.approvedRegion);
  assert.equal(repairComparison.changedPixelCount, fixtureManifest.pdfProof.changedRegion.changedPixelCount);
  assert.equal(repairComparison.outsideApprovedChangedPixels, 0);
  assert.deepEqual(repairComparison.actualBounds, {
    x: fixtureManifest.pdfProof.changedRegion.actualBounds.x,
    y: fixtureManifest.pdfProof.changedRegion.actualBounds.y,
    width: fixtureManifest.pdfProof.changedRegion.actualBounds.width,
    height: fixtureManifest.pdfProof.changedRegion.actualBounds.height,
  });
  assert.deepEqual(comparePixels(sourceRaster, revertedRaster, null), {
    changedPixelCount: 0,
    outsideApprovedChangedPixels: 0,
    actualBounds: null,
  });

  const flatEntry = fixtureManifest.fixtures.find((entry) => entry.id === 'flat-color');
  const canonicalGeometry = makeOcrFixture({
    documentId: 'scanned-text-edit-fixture-document',
    documentGeneration: 'scanned-text-edit-fixture-generation',
    pageId: 'scanned-text-edit-fixture-page',
    pageRevision: 0,
    lines: [flatEntry.ocrLine],
    width: flatEntry.widthPx,
    height: flatEntry.heightPx,
  }).pageGeometry;
  const repeatedBytes = await writeOwnedScannedTextRepairLayer({
    pdfBytes: repairedBytes,
    state: repairedInspection.state,
    pageGeometries: [canonicalGeometry],
    modifiedAt: FIXED_PDF_TIME,
  });
  const [repeatedInspection] = await inspectOwnedScannedTextRepairLayer(repeatedBytes);
  assert.equal(repeatedInspection.owned, true);
  assert.equal(repeatedInspection.contentRefs.length, sourceInspection.contentRefs.length + 1);
  const repeatedRaster = await renderPdfPage(repeatedBytes);
  assert.deepEqual(repeatedRaster.data, repairedRaster.data, 'repeat save must replace, not duplicate, the owned repair layer');

  const removedBytes = await removeOwnedScannedTextRepairLayer({ pdfBytes: repeatedBytes });
  const [removedInspection] = await inspectOwnedScannedTextRepairLayer(removedBytes);
  assert.equal(removedInspection.owned, false);
  const removedRaster = await renderPdfPage(removedBytes);
  assert.deepEqual(removedRaster.data, sourceRaster.data, 'removing the owned repair layer must reveal the preserved original scan');
});

test('PDF writer failure returns no partial output and leaves source bytes untouched', async () => {
  const fixtureManifest = await manifest();
  const sourceBytes = new Uint8Array(await readFile(new URL(fixtureManifest.pdfProof.source, FIXTURE_ROOT)));
  const repairedBytes = new Uint8Array(await readFile(new URL(fixtureManifest.pdfProof.repaired, FIXTURE_ROOT)));
  const sourceBefore = sourceBytes.slice();
  const [inspection] = await inspectOwnedScannedTextRepairLayer(repairedBytes);
  const invalidGeometry = structuredClone(inspection.state.pages[0].pageGeometry);
  invalidGeometry.geometryId = 'missing-canonical-geometry';
  await assert.rejects(
    () => writeOwnedScannedTextRepairLayer({
      pdfBytes: sourceBytes,
      state: inspection.state,
      pageGeometries: [invalidGeometry],
      modifiedAt: FIXED_PDF_TIME,
    }),
    (error) => error.code === 'MISSING_PAGE_GEOMETRY',
  );
  assert.deepEqual(sourceBytes, sourceBefore);

  const tamperedPatchState = structuredClone(inspection.state);
  const originalPatch = tamperedPatchState.pages[0].selections[0].originalPatch;
  originalPatch.data = `${originalPatch.data[0] === 'A' ? 'B' : 'A'}${originalPatch.data.slice(1)}`;
  await assert.rejects(
    () => writeOwnedScannedTextRepairLayer({
      pdfBytes: sourceBytes,
      state: tamperedPatchState,
      pageGeometries: [],
      modifiedAt: FIXED_PDF_TIME,
    }),
    (error) => error.code === 'PATCH_DIGEST_MISMATCH',
  );
  assert.deepEqual(sourceBytes, sourceBefore);

  const tamperedRegionState = structuredClone(inspection.state);
  tamperedRegionState.pages[0].selections[0].repair.changedRegion.beforeSha256 = '0'.repeat(64);
  await assert.rejects(
    () => writeOwnedScannedTextRepairLayer({
      pdfBytes: sourceBytes,
      state: tamperedRegionState,
      pageGeometries: [],
      modifiedAt: FIXED_PDF_TIME,
    }),
    (error) => error.code === 'INVALID_OWNED_EDIT_STATE',
  );
  assert.deepEqual(sourceBytes, sourceBefore);

  const tamperedChangedCountState = structuredClone(inspection.state);
  tamperedChangedCountState.pages[0].selections[0].repair.changedRegion.changedPixelCount += 1;
  await assert.rejects(
    () => writeOwnedScannedTextRepairLayer({
      pdfBytes: sourceBytes,
      state: tamperedChangedCountState,
      pageGeometries: [],
      modifiedAt: FIXED_PDF_TIME,
    }),
    (error) => error.code === 'INVALID_OWNED_EDIT_STATE',
  );
  assert.deepEqual(sourceBytes, sourceBefore);

  const empty = createScannedTextEditStateV1({
    document: inspection.state.document,
    stateId: 'empty-visual-state',
    instanceId: 'empty-visual-instance',
    createdAt: '2026-08-20T12:00:00.000Z',
  });
  const unchanged = await writeOwnedScannedTextRepairLayer({
    pdfBytes: sourceBytes,
    state: empty,
    pageGeometries: [],
    modifiedAt: FIXED_PDF_TIME,
  });
  assert.deepEqual(unchanged, sourceBytes);

  const reconciledUndo = await writeOwnedScannedTextRepairLayer({
    pdfBytes: repairedBytes,
    state: empty,
    pageGeometries: [],
    modifiedAt: FIXED_PDF_TIME,
  });
  const [reconciledInspection] = await inspectOwnedScannedTextRepairLayer(reconciledUndo);
  assert.equal(reconciledInspection.owned, false);
  assert.deepEqual(
    (await renderPdfPage(reconciledUndo)).data,
    (await renderPdfPage(sourceBytes)).data,
    'saving the authoritative empty undo state must remove the owned repair and restore source pixels',
  );
});
