import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeOcrFixture } from '../searchable-layer.test-fixtures.mjs';
import {
  OCR_PARAGRAPH_LINE_LIMIT_REASON,
  buildOcrParagraphRegions,
  paragraphRegionForLine,
  partitionSelectionByParagraph,
} from './paragraph-regions.js';
import {
  resetOcrParagraphGroupingForDocument,
  setOcrParagraphBoundaryOverrideForDocument,
} from './paragraph-grouping-state.js';
import { validateAgainstJsonSchema } from '../contracts/schema-validation.js';
import { readFile } from 'node:fs/promises';

function fixture(lines) {
  return makeOcrFixture({
    documentId: 'paragraph-document', documentGeneration: 'paragraph-generation',
    pageId: 'paragraph-page', pageRevision: 0, width: 600, height: 800, lines,
  });
}

test('infers multiline paragraphs in canonical source geometry and keeps IDs stable', () => {
  const value = fixture([
    { id: 'p1-a', text: 'A paragraph that keeps going', x: 40, y: 40, width: 190, height: 12 },
    { id: 'p1-b', text: 'onto another line', x: 40, y: 56, width: 180, height: 12 },
    { id: 'p1-c', text: 'and ends here.', x: 40, y: 72, width: 92, height: 12 },
    { id: 'p2-a', text: 'A separate paragraph starts', x: 40, y: 104, width: 190, height: 12 },
    { id: 'p2-b', text: 'with a continuation', x: 40, y: 120, width: 180, height: 12 },
  ]);
  const first = buildOcrParagraphRegions(value);
  const second = buildOcrParagraphRegions(value);
  assert.deepEqual(first.map((region) => region.lineIds), [['p1-a', 'p1-b', 'p1-c'], ['p2-a', 'p2-b']]);
  assert.deepEqual(first.map((region) => region.id), second.map((region) => region.id));
  assert.ok(first.every((region) => region.bounds.coordinateSpace === 'source-raster-pixels'));
  assert.equal(paragraphRegionForLine(first, 'p1-b')?.id, first[0].id);
});

test('detects independent columns before scoring and never applies a cross-column merge override', () => {
  const value = fixture([
    { id: 'left-1', text: 'Left column continues', x: 30, y: 40, width: 180, height: 12 },
    { id: 'right-1', text: 'Right column continues', x: 330, y: 40, width: 180, height: 12 },
    { id: 'left-2', text: 'on the left side', x: 30, y: 56, width: 170, height: 12 },
    { id: 'right-2', text: 'on the right side', x: 330, y: 56, width: 170, height: 12 },
  ]);
  const regions = buildOcrParagraphRegions({ ...value, overrides: [{
    beforeLineId: 'left-1', afterLineId: 'right-1', decision: 'merge',
  }] });
  assert.equal(regions.length, 2);
  assert.deepEqual(regions.map((region) => region.lineIds), [['left-1', 'left-2'], ['right-1', 'right-2']]);
  assert.notEqual(regions[0].columnId, regions[1].columnId);
});

test('manual boundary overrides take precedence only for adjacent safe same-column lines', () => {
  const value = fixture([
    { id: 'a', text: 'Short.', x: 40, y: 40, width: 70, height: 12 },
    { id: 'b', text: 'Next', x: 40, y: 56, width: 70, height: 12 },
  ]);
  assert.equal(buildOcrParagraphRegions(value).length, 2);
  const merged = buildOcrParagraphRegions({ ...value, overrides: [{
    beforeLineId: 'a', afterLineId: 'b', decision: 'merge',
  }] });
  assert.equal(merged.length, 1);
  const split = buildOcrParagraphRegions({ ...value, overrides: [{
    beforeLineId: 'a', afterLineId: 'b', decision: 'split',
  }] });
  assert.equal(split.length, 2);
});

test('selection is partitioned into complete inferred regions', () => {
  const value = fixture([
    { id: 'a', text: 'First continues', x: 40, y: 40, width: 180, height: 12 },
    { id: 'b', text: 'onto this line.', x: 40, y: 56, width: 130, height: 12 },
    { id: 'c', text: 'Second continues', x: 40, y: 88, width: 180, height: 12 },
    { id: 'd', text: 'onto this line', x: 40, y: 104, width: 150, height: 12 },
  ]);
  const regions = buildOcrParagraphRegions(value);
  assert.deepEqual(partitionSelectionByParagraph(regions, ['b', 'c']).map((region) => region.lineIds),
    [['a', 'b'], ['c', 'd']]);
});

test('handles short final lines, first-line indents, and hanging bullet continuations', () => {
  const value = fixture([
    { id: 'indent-1', text: 'An indented first line continues', x: 58, y: 32, width: 180, height: 12 },
    { id: 'indent-2', text: 'on the aligned body line', x: 40, y: 48, width: 180, height: 12 },
    { id: 'indent-3', text: 'and ends short.', x: 40, y: 64, width: 82, height: 12 },
    { id: 'bullet-1', text: '• A bullet item continues', x: 40, y: 96, width: 180, height: 12 },
    { id: 'bullet-2', text: 'on a hanging indent.', x: 58, y: 112, width: 140, height: 12 },
    { id: 'bullet-3', text: '• A separate bullet', x: 40, y: 128, width: 150, height: 12 },
  ]);
  const regions = buildOcrParagraphRegions(value);
  assert.deepEqual(regions.map((region) => region.lineIds), [
    ['indent-1', 'indent-2', 'indent-3'],
    ['bullet-1', 'bullet-2'],
    ['bullet-3'],
  ]);
});

test('separates headings and same-style adjacent paragraphs', () => {
  const value = fixture([
    { id: 'heading', text: 'SECTION TITLE', x: 40, y: 24, width: 110, height: 14 },
    { id: 'body-1', text: 'The body paragraph continues', x: 40, y: 48, width: 190, height: 12 },
    { id: 'body-2', text: 'onto its second line.', x: 40, y: 64, width: 145, height: 12 },
    { id: 'next-1', text: 'A same-style paragraph continues', x: 40, y: 96, width: 190, height: 12 },
    { id: 'next-2', text: 'onto another line', x: 40, y: 112, width: 160, height: 12 },
  ]);
  assert.deepEqual(buildOcrParagraphRegions(value).map((region) => region.lineIds), [
    ['heading'], ['body-1', 'body-2'], ['next-1', 'next-2'],
  ]);
});

test('keeps a 33-line semantic paragraph intact but rejects editing with a split instruction reason', () => {
  const value = fixture(Array.from({ length: 33 }, (_, index) => ({
    id: `line-${index + 1}`, text: `continued line ${index + 1}`,
    x: 40, y: 20 + index * 16, width: 180, height: 12,
  })));
  const regions = buildOcrParagraphRegions(value);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].lineIds.length, 33);
  assert.equal(regions[0].editable, false);
  assert.equal(regions[0].rejectionReason, OCR_PARAGRAPH_LINE_LIMIT_REASON);
});

test('unsupported direction or invalid geometry remains singleton and ineligible', () => {
  const value = fixture([
    { id: 'a', text: 'Normal', x: 40, y: 40, width: 180, height: 12 },
    { id: 'b', text: 'Unsupported', x: 40, y: 56, width: 180, height: 12 },
  ]);
  value.result.lines[1].detectedWritingDirection = 'rtl';
  const regions = buildOcrParagraphRegions(value);
  assert.equal(regions.length, 2);
  assert.equal(regions[1].editable, false);
  assert.equal(regions[1].rejectionReason, 'UNSUPPORTED_PARAGRAPH_GEOMETRY');
});

test('persists metadata-only overrides, supports undo snapshots, and prunes state on Reset', async () => {
  const value = fixture([
    { id: 'a', text: 'Short.', x: 40, y: 40, width: 70, height: 12 },
    { id: 'b', text: 'Next', x: 40, y: 56, width: 70, height: 12 },
  ]);
  const raster = {
    widthPx: value.result.sourceRaster.widthPx,
    heightPx: value.result.sourceRaster.heightPx,
    rowBytes: value.result.sourceRaster.widthPx * 4,
    data: new Uint8ClampedArray(value.result.sourceRaster.widthPx * value.result.sourceRaster.heightPx * 4),
  };
  const doc = {
    id: value.result.document.id, scannedTextEdits: null, undoStack: [], redoStack: [],
    savedUndoStackLength: 0, modified: false,
  };
  const command = await setOcrParagraphBoundaryOverrideForDocument(doc, {
    ...value, raster, beforeLineId: 'a', afterLineId: 'b', decision: 'merge',
    operationId: 'paragraph-override-1', modifiedAt: '2026-08-25T12:00:00.000Z',
    executeCommand(target, entry) { target.undoStack.push(entry); },
  });
  assert.equal(command.type, 'scannedTextEdit');
  assert.equal(doc.undoStack.length, 1);
  assert.equal(doc.scannedTextEdits.pages[0].selections.length, 0);
  assert.deepEqual(doc.scannedTextEdits.pages[0].paragraphGrouping.boundaries, [{
    beforeLineId: 'a', afterLineId: 'b', decision: 'merge',
  }]);

  const commonSchema = JSON.parse(await readFile(new URL('../contracts/common.schema.json', import.meta.url), 'utf8'));
  const pageGeometrySchema = JSON.parse(await readFile(new URL('../contracts/page-geometry.v1.schema.json', import.meta.url), 'utf8'));
  const editSchema = JSON.parse(await readFile(new URL('../contracts/scanned-text-edit-state.v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateAgainstJsonSchema(doc.scannedTextEdits, editSchema, {
    schemas: [commonSchema, pageGeometrySchema],
  }), { ok: true, issues: [] });

  await resetOcrParagraphGroupingForDocument(doc, {
    pageIndex: 0, lineIds: ['a', 'b'], operationId: 'paragraph-reset-1',
    modifiedAt: '2026-08-25T12:01:00.000Z',
    executeCommand(target, entry) { target.undoStack.push(entry); },
  });
  assert.equal(doc.scannedTextEdits, null);
  assert.equal(doc.undoStack.length, 2);
  assert.equal(doc.undoStack[1].before.pages[0].paragraphGrouping.boundaries.length, 1);
  assert.equal(doc.undoStack[1].after, null);
});

test('legacy V1 pages without paragraphGrouping continue to hydrate', async () => {
  const fixedTestModule = await import('./edit-state.js');
  const value = fixture([{ id: 'a', text: 'Line', x: 40, y: 40, width: 100, height: 12 }]);
  const legacy = fixedTestModule.createScannedTextEditStateV1({
    document: value.result.document,
    stateId: 'legacy-state', instanceId: 'legacy-instance', createdAt: '2026-08-25T12:00:00.000Z',
  });
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.pages.length, 0);
});
