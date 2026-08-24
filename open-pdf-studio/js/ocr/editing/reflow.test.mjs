import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { createServer } from 'vite';

import { validateAgainstJsonSchema } from '../contracts/schema-validation.js';
import { validateScannedTextEditStateV1 } from '../contracts/scanned-text-edit-state.v1.js';
import { getOwnedOcrTextItems, getPendingOcrTextItems } from '../document-state.js';
import { makeOcrFixture } from '../searchable-layer.test-fixtures.mjs';
import {
  commitScannedTextEditEvaluation,
  createScannedTextEditStateV1,
  evaluateScannedTextEdit,
  materializeScannedTextEditPage,
} from './edit-state.js';
import { fixedRegionTargetFromLineIds } from './fixed-region.js';
import {
  SCANNED_TEXT_REFLOW_LAYOUT_MODE,
  SCANNED_TEXT_REFLOW_SCOPE,
  SCANNED_TEXT_REFLOW_SHAPING,
  ScannedTextReflowError,
  reviseApprovedRegionParagraphReflowContent,
} from './reflow.js';
const FIXTURE_ROOT = new URL('../../../tests/fixtures/ocr/editing-foundation-v1/', import.meta.url);
const FONT_URL = new URL('../../../public/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf', import.meta.url);
const FIXED_TIME = '2026-08-24T12:00:00.000Z';
globalThis.DOMMatrix ||= class DOMMatrix {};
globalThis.window ||= {
  location: new URL('http://localhost/'),
  dispatchEvent() { return true; },
};
globalThis.location ||= globalThis.window.location;
const reflowFontBytes = new Uint8Array(await readFile(FONT_URL));
const { collectOwnedOcrWriterPages } = await import('../pdf-persistence.js');
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const {
  applyScannedTextEditForDocument,
  reviseScannedTextEditForDocument,
} = await vite.ssrLoadModule('/js/ocr/editing/undo-commands.js');

after(async () => vite.close());

async function regionFixture({ lines, unsupportedContentReasons = [], image = 'flat-color.png' } = {}) {
  const decoded = await sharp(fileURLToPath(new URL(image, FIXTURE_ROOT))).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const ocrLines = lines || [
    { id: 'reflow-line-1', text: 'FIRST SCAN', x: 56, y: 48, width: 144, height: 18, confidence: 0.98 },
    { id: 'reflow-line-2', text: 'SECOND SCAN', x: 56, y: 74, width: 144, height: 18, confidence: 0.97 },
    { id: 'reflow-line-3', text: 'THIRD SCAN', x: 56, y: 100, width: 144, height: 18, confidence: 0.96 },
  ];
  const fixture = makeOcrFixture({
    documentId: 'reflow-document',
    documentGeneration: 'reflow-generation',
    pageId: 'reflow-page',
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
    for (let index = 0; index < Math.min(Array.from(line.text).length, 32); index += 1) {
      const x = Math.min(patch.widthPx - 2, 3 + index * 3);
      output.set([12, 12, 12, 255], (y * patch.widthPx + x) * 4);
    }
  }
  return output;
}

function documentFor(result) {
  return {
    id: result.document.id,
    undoStack: [],
    redoStack: [],
    savedUndoStackLength: 0,
    ocr: { dirty: false },
    scannedTextEdits: createScannedTextEditStateV1({
      document: result.document,
      stateId: 'reflow-state',
      instanceId: 'reflow-instance',
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
      const changed = [0, 1, 2, 3]
        .some((channel) => before.data[offset + channel] !== after.data[offset + channel]);
      if (!changed) continue;
      const within = x >= bounds.x && y >= bounds.y
        && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
      if (within) inside += 1;
      else outside += 1;
    }
  }
  return { inside, outside };
}

async function evaluateReflow(fixture, replacementText, overrides = {}) {
  return evaluateScannedTextEdit({
    ...fixture,
    target: fixedRegionTargetFromLineIds(fixture.result, fixture.result.lines.map((line) => line.id)),
    replacementText,
    renderVisiblePatch: deterministicVisibleRegion,
    reflowFontBytes,
    layoutMode: SCANNED_TEXT_REFLOW_LAYOUT_MODE,
    repairPaddingPx: 1,
    contextPaddingPx: 30,
    operationId: 'reflow-operation',
    modifiedAt: FIXED_TIME,
    ...overrides,
  });
}

function attachOwnedOcr(doc, fixture) {
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
}

test('approved-region reflow wraps multilingual LTR text with owned synchronized geometry', async () => {
  const fixture = await regionFixture();
  const sourceBytes = new Uint8ClampedArray(fixture.raster.data);
  const paragraph = 'Café Ελληνικά Привет reflows safely';
  const evaluation = await evaluateReflow(fixture, paragraph);
  const { content } = evaluation.selection;

  assert.equal(content.scope, SCANNED_TEXT_REFLOW_SCOPE);
  assert.equal(content.replacementText, paragraph);
  assert.equal(content.layout.fontName, 'Liberation Sans');
  assert.equal(content.layout.shaping, SCANNED_TEXT_REFLOW_SHAPING);
  assert.equal(content.layout.direction, 'ltr');
  assert.equal(content.layout.glyphCoverage, 'complete');
  assert.equal(content.layout.clippingPrevented, true);
  assert.equal(content.layout.overflow, false);
  assert.ok(content.layout.lines.length >= 2);
  assert.ok(content.layout.lines.length <= content.source.canonicalBaselines.length);
  assert.equal(content.layout.lines.map((line) => line.text).join(' '), paragraph);
  assert.equal(content.layout.measuredLineSpacingPt, content.source.lineSpacing.valuePt);
  assert.deepEqual(
    content.searchableText.lines.map((line) => line.text),
    content.layout.lines.map((line) => line.text),
  );
  assert.equal(content.searchableText.text, content.visibleReplacement.text);
  assert.equal(content.visibleReplacement.outsideEditRegionChangedPixels, 0);
  assert.deepEqual(fixture.raster.data, sourceBytes, 'reflow must not mutate immutable source pixels');

  const doc = documentFor(fixture.result);
  commitScannedTextEditEvaluation(doc, evaluation, { modifiedAt: FIXED_TIME });
  assert.deepEqual(validateScannedTextEditStateV1(doc.scannedTextEdits), { ok: true, issues: [] });
  const commonSchema = JSON.parse(await readFile(new URL('../contracts/common.schema.json', import.meta.url), 'utf8'));
  const geometrySchema = JSON.parse(await readFile(new URL('../contracts/page-geometry.v1.schema.json', import.meta.url), 'utf8'));
  const editSchema = JSON.parse(await readFile(new URL('../contracts/scanned-text-edit-state.v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateAgainstJsonSchema(doc.scannedTextEdits, editSchema, {
    schemas: [commonSchema, geometrySchema],
  }), { ok: true, issues: [] });
  const mismatchedShaping = structuredClone(doc.scannedTextEdits);
  mismatchedShaping.pages[0].selections[0].content.layout.shaping = 'pdf-lib-standard-font-winansi-v1';
  assert.equal(validateScannedTextEditStateV1(mismatchedShaping).ok, false);
  assert.equal(validateAgainstJsonSchema(mismatchedShaping, editSchema, {
    schemas: [commonSchema, geometrySchema],
  }).ok, false);

  const materialized = await materializeScannedTextEditPage(fixture.raster, doc.scannedTextEdits, 0);
  const pixels = changedPixels(fixture.raster, materialized, evaluation.selection.repair.approvedRegion);
  assert.ok(pixels.inside > 0);
  assert.equal(pixels.outside, 0);

  attachOwnedOcr(doc, fixture);
  const pending = getPendingOcrTextItems(doc, 1);
  assert.deepEqual(pending.map((item) => item.text), content.layout.lines.map((line) => line.text));
  assert.deepEqual(getOwnedOcrTextItems(doc, 1).map((item) => item.text), pending.map((item) => item.text));
  assert.deepEqual(
    collectOwnedOcrWriterPages(doc)[0].lines.map((line) => line.text),
    pending.map((item) => item.text),
  );
  doc.ocr = null;
  assert.deepEqual(
    collectOwnedOcrWriterPages(doc)[0].lines.map((line) => line.text),
    pending.map((item) => item.text),
    'reopened state must preserve visible/searchable line synchronization',
  );
});

test('approved-region reflow preserves measured center and right alignment', async () => {
  const centeredFixture = await regionFixture({ lines: [
    { id: 'center-1', text: 'LONG SOURCE', x: 50, y: 48, width: 140, height: 18, confidence: 0.98 },
    { id: 'center-2', text: 'MEDIUM', x: 60, y: 74, width: 120, height: 18, confidence: 0.97 },
    { id: 'center-3', text: 'SHORT', x: 70, y: 100, width: 100, height: 18, confidence: 0.96 },
  ] });
  const centered = await evaluateReflow(centeredFixture, 'Centered text fits safely');
  assert.equal(centered.selection.content.layout.alignment, 'center');
  const region = centered.selection.content.layout.canonicalRegion.points;
  const regionCenter = (Math.min(...region.map((point) => point[0]))
    + Math.max(...region.map((point) => point[0]))) / 2;
  for (const line of centered.selection.content.layout.lines) {
    const xs = line.canonicalPolygon.points.map((point) => point[0]);
    assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - regionCenter) < 0.01);
  }

  const rightFixture = await regionFixture({ lines: [
    { id: 'right-1', text: 'LONG SOURCE', x: 50, y: 48, width: 140, height: 18, confidence: 0.98 },
    { id: 'right-2', text: 'MEDIUM', x: 70, y: 74, width: 120, height: 18, confidence: 0.97 },
    { id: 'right-3', text: 'SHORT', x: 90, y: 100, width: 100, height: 18, confidence: 0.96 },
  ] });
  const right = await evaluateReflow(rightFixture, 'Right aligned text fits');
  assert.equal(right.selection.content.layout.alignment, 'right');
  const rightEdge = Math.max(...right.selection.content.layout.canonicalRegion.points.map((point) => point[0]));
  for (const line of right.selection.content.layout.lines) {
    assert.ok(Math.abs(Math.max(...line.canonicalPolygon.points.map((point) => point[0])) - rightEdge) < 0.01);
  }
});

test('reflow revisions reuse the reversible owned repair patch and enter undo history', async () => {
  const fixture = await regionFixture();
  const first = await evaluateReflow(fixture, 'First approved paragraph reflows safely');
  const page = { ...first.page, pageGeometry: first.pageGeometry, sourceRaster: first.sourceRaster };
  const revised = await reviseApprovedRegionParagraphReflowContent({
    page,
    selection: first.selection,
    replacementText: 'Revised Café Ελληνικά Привет',
    revision: 2,
    parentRevision: 1,
    renderVisiblePatch: deterministicVisibleRegion,
    reflowFontBytes,
  });
  assert.equal(revised.repairPatch.sha256, first.selection.repair.repairedPatch.sha256);
  assert.equal(revised.undo.before.text, first.selection.content.replacementText);
  assert.equal(revised.undo.after.text, 'Revised Café Ελληνικά Привет');

  const doc = documentFor(fixture.result);
  const applied = await applyScannedTextEditForDocument(doc, {
    ...fixture,
    target: fixedRegionTargetFromLineIds(fixture.result, fixture.result.lines.map((line) => line.id)),
    replacementText: 'First command paragraph wraps safely',
    renderVisiblePatch: deterministicVisibleRegion,
    reflowFontBytes,
    layoutMode: SCANNED_TEXT_REFLOW_LAYOUT_MODE,
    contextPaddingPx: 30,
    modifiedAt: FIXED_TIME,
  });
  assert.equal(doc.undoStack.length, 1);
  assert.equal(applied.command.before.pages.length, 0);
  assert.equal(applied.command.after.pages[0].selections[0].content.scope, SCANNED_TEXT_REFLOW_SCOPE);
  await reviseScannedTextEditForDocument(doc, applied.selection.id, {
    replacementText: 'Second command paragraph remains bounded',
    layoutMode: SCANNED_TEXT_REFLOW_LAYOUT_MODE,
    renderVisiblePatch: deterministicVisibleRegion,
    reflowFontBytes,
    modifiedAt: '2026-08-24T12:00:01.000Z',
  });
  assert.equal(doc.undoStack.length, 2);
  assert.equal(doc.undoStack[1].before.pages[0].selections[0].content.replacementText,
    'First command paragraph wraps safely');
  assert.equal(doc.undoStack[1].after.pages[0].selections[0].content.replacementText,
    'Second command paragraph remains bounded');
});

test('approved-region reflow explicitly rejects unsafe fit, scripts, direction, geometry, and content', async () => {
  const fixture = await regionFixture();
  const reflowRejects = async (text, code, overrides = {}) => assert.rejects(
    () => evaluateReflow(fixture, text, overrides),
    (error) => error instanceof ScannedTextReflowError && error.code === code,
  );
  await reflowRejects('UNBREAKABLETOKEN'.repeat(30), 'REFLOW_OVERFLOW');
  await reflowRejects('Missing 😀 glyph', 'MISSING_GLYPH');
  await reflowRejects('Unsupported 漢 script', 'UNSUPPORTED_SCRIPT');
  await reflowRejects('שלום direction', 'UNSUPPORTED_TEXT_DIRECTION');
  await reflowRejects('مرحبا direction', 'UNSUPPORTED_TEXT_DIRECTION');
  await reflowRejects('Too tall', 'REFLOW_OVERFLOW', { styleOverrides: { fontSize: 72 } });
  await reflowRejects('Unsupported font style', 'UNSUPPORTED_REFLOW_FONT_STYLE', {
    styleOverrides: { weight: 'bold' },
  });
  await reflowRejects(`Malformed ${String.fromCharCode(0xd800)}`, 'INVALID_UNICODE');
  await reflowRejects('First paragraph\u2029Second paragraph', 'MULTIPLE_PARAGRAPHS_UNSUPPORTED');

  const columns = await regionFixture({ lines: [
    { id: 'column-1', text: 'LEFT', x: 40, y: 48, width: 60, height: 18, confidence: 0.98 },
    { id: 'column-2', text: 'RIGHT', x: 150, y: 74, width: 60, height: 18, confidence: 0.98 },
  ] });
  await assert.rejects(
    () => evaluateReflow(columns, 'Columns cannot reflow'),
    (error) => error?.code === 'INSEPARABLE_COLUMNS',
  );

  for (const code of ['table', 'handwriting', 'vertical-text', 'curved-text']) {
    const unsupported = await regionFixture({ unsupportedContentReasons: [{
      id: `${code}-region`,
      code,
      message: `${code} detected`,
      polygon: {
        coordinateSpace: 'source-raster-pixels',
        points: [[50, 40], [210, 40], [210, 120], [50, 120]],
      },
    }] });
    await assert.rejects(
      () => evaluateReflow(unsupported, 'Unsafe content cannot reflow'),
      (error) => error?.code === 'UNSUPPORTED_CONTENT',
      code,
    );
  }

  const photographic = await regionFixture({ image: 'photo.png' });
  await assert.rejects(
    () => evaluateReflow(photographic, 'Complex backgrounds cannot reflow'),
    (error) => error instanceof ScannedTextReflowError && error.code === 'UNAPPROVED_REFLOW_REGION',
  );

  const lowConfidence = await regionFixture();
  lowConfidence.result.lines[1].confidence = 0.5;
  await assert.rejects(
    () => evaluateReflow(lowConfidence, 'Low confidence cannot reflow'),
    (error) => error?.code === 'LOW_CONFIDENCE_GEOMETRY',
  );

  const warped = await regionFixture();
  warped.result.lines[1].polygon.points[1][1] += 10;
  await assert.rejects(
    () => evaluateReflow(warped, 'Warped text cannot reflow'),
    (error) => ['WARPED_TEXT_GEOMETRY', 'INCOHERENT_BASELINES'].includes(error?.code),
  );
});
