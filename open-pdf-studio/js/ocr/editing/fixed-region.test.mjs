import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { validateAgainstJsonSchema } from '../contracts/schema-validation.js';
import { validateScannedTextEditStateV1 } from '../contracts/scanned-text-edit-state.v1.js';
import { makeOcrFixture } from '../searchable-layer.test-fixtures.mjs';
import { getOwnedOcrTextItems, getPendingOcrTextItems } from '../document-state.js';
import {
  commitScannedTextEditEvaluation,
  createScannedTextEditStateV1,
  evaluateScannedTextEdit,
  materializeScannedTextEditPage,
} from './edit-state.js';
import {
  ScannedTextFixedRegionError,
  fixedRegionTargetFromLineIds,
  reviseFixedRegionMultilineContent,
} from './fixed-region.js';

const FIXTURE_ROOT = new URL('../../../tests/fixtures/ocr/editing-foundation-v1/', import.meta.url);
const FIXED_TIME = '2026-08-24T12:00:00.000Z';
globalThis.DOMMatrix ||= class DOMMatrix {};
const { collectOwnedOcrWriterPages } = await import('../pdf-persistence.js');

async function regionFixture({ lines, unsupportedContentReasons = [], image = 'flat-color.png' } = {}) {
  const decoded = await sharp(fileURLToPath(new URL(image, FIXTURE_ROOT))).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const ocrLines = lines || [
    { id: 'region-line-1', text: 'FIRST SCAN', x: 56, y: 48, width: 144, height: 18, confidence: 0.98 },
    { id: 'region-line-2', text: 'SECOND SCAN', x: 56, y: 74, width: 144, height: 18, confidence: 0.97 },
    { id: 'region-line-3', text: 'THIRD SCAN', x: 56, y: 100, width: 144, height: 18, confidence: 0.96 },
  ];
  const fixture = makeOcrFixture({
    documentId: 'fixed-region-document',
    documentGeneration: 'fixed-region-generation',
    pageId: 'fixed-region-page',
    pageRevision: 0,
    lines: ocrLines,
    width: decoded.info.width,
    height: decoded.info.height,
  });
  fixture.result.unsupportedContentReasons = unsupportedContentReasons;
  return {
    ...fixture,
    raster: {
      widthPx: decoded.info.width,
      heightPx: decoded.info.height,
      rowBytes: decoded.info.width * 4,
      data: new Uint8ClampedArray(decoded.data),
      sourceRasterId: fixture.result.sourceRaster.id,
      sourceRasterFingerprint: fixture.result.sourceRaster.fingerprint,
    },
  };
}

function deterministicVisibleRegion({ basePatchBytes, patch, layout }) {
  const output = new Uint8Array(basePatchBytes);
  for (const [lineIndex, line] of layout.lines.entries()) {
    const y = Math.min(patch.heightPx - 2, 4 + lineIndex * Math.max(5, Math.floor(patch.heightPx / 4)));
    for (let index = 0; index < Math.min(line.text.length, 32); index += 1) {
      const x = Math.min(patch.widthPx - 2, 3 + index * 3);
      const offset = (y * patch.widthPx + x) * 4;
      output.set([12, 12, 12, 255], offset);
    }
  }
  return output;
}

function documentFor(result) {
  return {
    id: result.document.id,
    undoStack: [],
    redoStack: [],
    ocr: { dirty: false },
    scannedTextEdits: createScannedTextEditStateV1({
      document: result.document,
      stateId: 'fixed-region-state',
      instanceId: 'fixed-region-instance',
      createdAt: FIXED_TIME,
    }),
  };
}

function changedPixels(before, after, bounds) {
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < before.heightPx; y += 1) {
    for (let x = 0; x < before.widthPx; x += 1) {
      const offset = (y * before.widthPx + x) * 4;
      const changed = [0, 1, 2, 3].some((channel) => before.data[offset + channel] !== after.data[offset + channel]);
      if (!changed) continue;
      const within = x >= bounds.x && y >= bounds.y
        && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
      if (within) inside += 1;
      else outside += 1;
    }
  }
  return { inside, outside };
}

async function evaluateRegion(fixture, replacementText, overrides = {}) {
  return evaluateScannedTextEdit({
    ...fixture,
    target: fixedRegionTargetFromLineIds(fixture.result, fixture.result.lines.map((line) => line.id)),
    replacementText,
    renderVisiblePatch: deterministicVisibleRegion,
    repairPaddingPx: 1,
    contextPaddingPx: 30,
    operationId: 'fixed-region-operation',
    modifiedAt: FIXED_TIME,
    ...overrides,
  });
}

test('fixed-region content preserves canonical baselines, measured spacing, alignment, and synchronized lines', async () => {
  const fixture = await regionFixture();
  const source = new Uint8ClampedArray(fixture.raster.data);
  const evaluation = await evaluateRegion(fixture, 'FIRST EDIT\nSECOND EDIT\nTHIRD EDIT');
  const { content } = evaluation.selection;
  assert.equal(content.scope, 'fixed-region-multiline');
  assert.deepEqual(content.source.ocrIds.lineIds, fixture.result.lines.map((line) => line.id));
  assert.equal(content.source.canonicalBaselines.length, 3);
  assert.equal(content.source.lineSpacing.measured, true);
  assert.equal(content.source.lineSpacing.valuePx, 26);
  assert.equal(content.estimatedStyle.alignment.value, 'left');
  assert.equal(content.layout.lines.length, 3);
  assert.equal(content.layout.clippingPrevented, true);
  assert.equal(content.layout.overflow, false);
  assert.deepEqual(
    content.searchableText.lines.map((line) => line.text),
    content.layout.lines.map((line) => line.text),
  );
  assert.equal(content.searchableText.text, content.visibleReplacement.text);
  assert.deepEqual(fixture.raster.data, source, 'the immutable source raster must stay byte-exact');

  const doc = documentFor(fixture.result);
  commitScannedTextEditEvaluation(doc, evaluation, { modifiedAt: FIXED_TIME });
  assert.deepEqual(validateScannedTextEditStateV1(doc.scannedTextEdits), { ok: true, issues: [] });
  const commonSchema = JSON.parse(await readFile(new URL('../contracts/common.schema.json', import.meta.url), 'utf8'));
  const pageGeometrySchema = JSON.parse(await readFile(new URL('../contracts/page-geometry.v1.schema.json', import.meta.url), 'utf8'));
  const editSchema = JSON.parse(await readFile(new URL('../contracts/scanned-text-edit-state.v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateAgainstJsonSchema(doc.scannedTextEdits, editSchema, {
    schemas: [commonSchema, pageGeometrySchema],
  }), { ok: true, issues: [] });

  const materialized = await materializeScannedTextEditPage(fixture.raster, doc.scannedTextEdits, 0);
  const pixels = changedPixels(fixture.raster, materialized, evaluation.selection.repair.approvedRegion);
  assert.equal(pixels.outside, 0);
  assert.ok(pixels.inside > 0);

  doc.ocr = {
    documentId: doc.id,
    generation: fixture.result.document.generation,
    revision: 1,
    dirty: true,
    warnings: [],
    pages: {
      1: {
        pageNumber: 1,
        pageId: fixture.result.page.id,
        pageRevision: fixture.result.page.revision,
        generation: fixture.result.document.generation,
        status: 'ready',
        recognition: {
          revision: 1,
          result: fixture.result,
          geometry: fixture.pageGeometry,
          ownership: { owner: 'open-pdf-studio', stream: 'pending-searchable-text' },
          warnings: [],
        },
        review: { revision: 0, corrections: {}, estimatedBaselines: {}, dirty: true },
        existingText: { meaningful: false },
      },
    },
  };
  const pending = getPendingOcrTextItems(doc, 1);
  assert.deepEqual(pending.map((item) => item.text), ['FIRST EDIT', 'SECOND EDIT', 'THIRD EDIT']);
  assert.ok(pending.every((item) => item.scannedSelection?.id === evaluation.selection.id));
  assert.deepEqual(getOwnedOcrTextItems(doc, 1).map((item) => item.text), pending.map((item) => item.text));
  const [liveWriterPage] = collectOwnedOcrWriterPages(doc);
  assert.deepEqual(liveWriterPage.lines.map((line) => line.text), pending.map((item) => item.text));

  doc.ocr = null;
  const [reopenedWriterPage] = collectOwnedOcrWriterPages(doc);
  assert.deepEqual(reopenedWriterPage.lines.map((line) => line.text), pending.map((item) => item.text));
  assert.deepEqual(
    reopenedWriterPage.lines.map((line) => line.baseline.start),
    pending.map((item) => ({ x: item.baseline.points[0][0], y: item.baseline.points[0][1] })),
  );
});

test('fixed-region layout safely wraps only into available original lines', async () => {
  const fixture = await regionFixture();
  const evaluation = await evaluateRegion(
    fixture,
    'FIRST EDIT SECOND EDIT',
  );
  assert.equal(evaluation.selection.content.layout.safeWrapped, true);
  assert.ok(evaluation.selection.content.layout.lines.length >= 2);
  assert.equal(
    evaluation.selection.content.replacementText,
    evaluation.selection.content.layout.lines.map((line) => line.text).join('\n'),
  );
});

test('fixed-region detects centered alignment and keeps every output line centered', async () => {
  const fixture = await regionFixture({ lines: [
    { id: 'center-1', text: 'LONG SOURCE', x: 50, y: 48, width: 140, height: 18, confidence: 0.98 },
    { id: 'center-2', text: 'MEDIUM', x: 60, y: 74, width: 120, height: 18, confidence: 0.97 },
    { id: 'center-3', text: 'SHORT', x: 70, y: 100, width: 100, height: 18, confidence: 0.96 },
  ] });
  const evaluation = await evaluateRegion(fixture, 'FIRST\nSECOND\nTHIRD');
  const { layout } = evaluation.selection.content;
  assert.equal(layout.alignment, 'center');
  const centers = layout.lines.map((line) => {
    const xs = line.canonicalPolygon.points.map((point) => point[0]);
    return (Math.min(...xs) + Math.max(...xs)) / 2;
  });
  assert.ok(Math.max(...centers) - Math.min(...centers) < 0.01);
});

test('fixed-region target identity is stable, ordered, and delimiter-safe', async () => {
  const fixture = await regionFixture({ lines: [
    { id: 'line:a', text: 'FIRST', x: 56, y: 48, width: 144, height: 18, confidence: 0.98 },
    { id: 'line', text: 'SECOND', x: 56, y: 74, width: 144, height: 18, confidence: 0.97 },
    { id: 'a:line', text: 'THIRD', x: 56, y: 100, width: 144, height: 18, confidence: 0.96 },
  ] });
  const first = fixedRegionTargetFromLineIds(fixture.result, ['a:line', 'line:a']);
  const reordered = fixedRegionTargetFromLineIds(fixture.result, ['line:a', 'a:line']);
  const different = fixedRegionTargetFromLineIds(fixture.result, ['line:a', 'line']);
  assert.deepEqual(first, reordered);
  assert.notEqual(first.regionId, different.regionId);
  assert.match(first.regionId, /^fixed-region-/u);
});

test('fixed-region revision reuses the owned repair patch and remains reversible', async () => {
  const fixture = await regionFixture();
  const evaluation = await evaluateRegion(fixture, 'FIRST EDIT\nSECOND EDIT\nTHIRD EDIT');
  const page = {
    ...evaluation.page,
    pageGeometry: evaluation.pageGeometry,
    sourceRaster: evaluation.sourceRaster,
  };
  const revised = await reviseFixedRegionMultilineContent({
    page,
    selection: evaluation.selection,
    replacementText: 'REVISED ONE\nREVISED TWO',
    revision: 2,
    parentRevision: 1,
    renderVisiblePatch: deterministicVisibleRegion,
  });
  assert.equal(revised.repairPatch.sha256, evaluation.selection.repair.repairedPatch.sha256);
  assert.equal(revised.undo.before.text, evaluation.selection.content.replacementText);
  assert.equal(revised.undo.after.text, 'REVISED ONE\nREVISED TWO');
  assert.equal(revised.undo.parentRevision, 1);
});

test('fixed-region rejects clipping, overflow, missing glyphs, columns, disallowed content, direction, warp, and low confidence', async () => {
  const fixture = await regionFixture();
  await assert.rejects(
    () => evaluateRegion(fixture, 'UNBREAKABLETOKEN'.repeat(30)),
    (error) => error instanceof ScannedTextFixedRegionError && error.code === 'REPLACEMENT_OVERFLOW',
  );
  await assert.rejects(
    () => evaluateRegion(fixture, 'MISSING 😀 GLYPH'),
    (error) => error instanceof ScannedTextFixedRegionError && error.code === 'MISSING_GLYPH',
  );
  await assert.rejects(
    () => evaluateRegion(fixture, 'TOO TALL', { styleOverrides: { fontSize: 72 } }),
    (error) => error instanceof ScannedTextFixedRegionError && error.code === 'REPLACEMENT_OVERFLOW',
  );

  const columns = await regionFixture({ lines: [
    { id: 'column-1', text: 'LEFT', x: 40, y: 48, width: 60, height: 18, confidence: 0.98 },
    { id: 'column-2', text: 'RIGHT', x: 150, y: 74, width: 60, height: 18, confidence: 0.98 },
  ] });
  await assert.rejects(
    () => evaluateRegion(columns, 'ONE\nTWO'),
    (error) => error instanceof ScannedTextFixedRegionError && error.code === 'INSEPARABLE_COLUMNS',
  );

  const handwriting = await regionFixture({
    unsupportedContentReasons: [{
      id: 'handwriting-region',
      code: 'handwriting',
      message: 'handwriting detected',
      polygon: {
        coordinateSpace: 'source-raster-pixels',
        points: [[50, 40], [210, 40], [210, 120], [50, 120]],
      },
    }],
  });
  await assert.rejects(
    () => evaluateRegion(handwriting, 'ONE\nTWO'),
    (error) => error instanceof ScannedTextFixedRegionError && error.code === 'UNSUPPORTED_CONTENT',
  );

  for (const code of ['table', 'vertical-text', 'curved-text']) {
    const unsupported = await regionFixture({
      unsupportedContentReasons: [{
        id: `${code}-region`,
        code,
        message: `${code} detected`,
        polygon: {
          coordinateSpace: 'source-raster-pixels',
          points: [[50, 40], [210, 40], [210, 120], [50, 120]],
        },
      }],
    });
    await assert.rejects(
      () => evaluateRegion(unsupported, 'ONE\nTWO'),
      (error) => error instanceof ScannedTextFixedRegionError && error.code === 'UNSUPPORTED_CONTENT',
      code,
    );
  }

  const photographic = await regionFixture({ image: 'photo.png' });
  await assert.rejects(
    () => evaluateRegion(photographic, 'ONE\nTWO'),
    (error) => error instanceof ScannedTextFixedRegionError && error.code === 'INELIGIBLE_EDIT_REGION',
  );

  const rtl = await regionFixture();
  rtl.result.engine.engineId = 'fixture-writing-direction-engine';
  rtl.result.engine.capabilities.writingDirectionDetection = true;
  rtl.result.lines[1].detectedWritingDirection = 'rtl';
  await assert.rejects(
    () => evaluateRegion(rtl, 'ONE\nTWO'),
    (error) => error instanceof ScannedTextFixedRegionError && error.code === 'UNSUPPORTED_TEXT_DIRECTION',
  );

  const warped = await regionFixture();
  warped.result.lines[1].polygon.points[1][1] += 10;
  await assert.rejects(
    () => evaluateRegion(warped, 'ONE\nTWO'),
    (error) => error?.code === 'WARPED_TEXT_GEOMETRY' || error?.code === 'INCOHERENT_BASELINES',
  );

  const lowConfidence = await regionFixture();
  lowConfidence.result.lines[1].confidence = 0.5;
  await assert.rejects(
    () => evaluateRegion(lowConfidence, 'ONE\nTWO'),
    (error) => error instanceof ScannedTextFixedRegionError && error.code === 'LOW_CONFIDENCE_GEOMETRY',
  );
});
