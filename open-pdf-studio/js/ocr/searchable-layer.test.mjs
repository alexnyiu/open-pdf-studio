import assert from 'node:assert/strict';
import test from 'node:test';

import { assessMeaningfulPdfText } from './existing-text.js';
import {
  acceptOcrLineCorrection,
  applyOcrPageResult,
  beginOcrPageAttempt,
  clearOpenPdfStudioOcrPage,
  createDocumentOcrState,
  ensureOcrPageState,
  estimateOcrLineBaseline,
  finishOcrPageAttempt,
  getOwnedOcrTextItems,
  getPendingOcrTextItems,
  markOwnedOcrPersisted,
  recordOcrExistingTextAssessment,
} from './document-state.js';
import { extractPageText } from '../search/text-extraction.js';
import { invalidateTextCache, textCacheSnapshot } from '../search/text-cache.js';
import { fakePdfDocument, makeOcrFixture } from './searchable-layer.test-fixtures.mjs';
import { assertOcrResultV2 } from './contracts/v2.js';
import { assertOcrPageGeometryV1 } from './contracts/page-geometry.v1.js';

function makeDocument(id, pdfDoc) {
  return {
    id,
    pdfDoc,
    currentPage: 1,
    viewMode: 'single',
    scale: 1,
    textEdits: [],
    pageRotations: {},
    modified: false,
    ocr: createDocumentOcrState(id),
  };
}

async function applyFixture(doc, pageNum = 1, lines, options = {}) {
  const attempt = await beginOcrPageAttempt(doc, pageNum, options);
  assert.equal(attempt.skipped, false);
  const fixture = makeOcrFixture({
    documentId: doc.id,
    documentGeneration: attempt.token.documentGeneration,
    pageId: attempt.token.pageId,
    pageRevision: attempt.token.pageRevision,
    pageIndex: pageNum - 1,
    pageCount: doc.pdfDoc.numPages,
    lines,
  });
  const applied = applyOcrPageResult(doc, { ...fixture, token: attempt.token });
  assert.deepEqual(applied, { applied: true, reason: null });
  return { ...fixture, token: attempt.token };
}

test('meaningful PDF.js text heuristics ignore isolated labels and detect real text', () => {
  assert.equal(assessMeaningfulPdfText([]).meaningful, false);
  assert.equal(assessMeaningfulPdfText([{ str: '12' }]).meaningful, false);
  assert.equal(assessMeaningfulPdfText([{ str: 'Hello world' }]).meaningful, true);
  assert.equal(assessMeaningfulPdfText([{ str: 'A' }, { str: 'B' }, { str: 'C' }]).meaningful, true);
});

test('recognized data is immutable and accepted corrections stay separate', async () => {
  const doc = makeDocument('document-immutable', fakePdfDocument([]));
  const { result } = await applyFixture(doc);
  const stored = doc.ocr.pages[1].recognition.result;

  assert.notEqual(stored, result);
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.lines), true);
  assert.equal(assertOcrResultV2(stored), stored);
  assert.equal(
    assertOcrPageGeometryV1(doc.ocr.pages[1].recognition.geometry),
    doc.ocr.pages[1].recognition.geometry,
  );
  acceptOcrLineCorrection(doc, 1, 'line-1', 'Corrected searchable line');

  assert.equal(result.lines[0].text, 'First searchable line');
  assert.equal(stored.lines[0].text, 'First searchable line');
  assert.equal(doc.ocr.pages[1].review.corrections['line-1'].correctedText, 'Corrected searchable line');
  assert.equal(getPendingOcrTextItems(doc, 1)[0].text, 'Corrected searchable line');
  assert.equal(doc.textEdits.length, 0);
  assert.equal(doc.ocr.dirty, true);
  assert.equal(doc.modified, true);
  assert.equal(stored.lines[0].baseline.status, 'unavailable');
  assert.equal(getOwnedOcrTextItems(doc, 1)[0].baseline.status, 'provided');
  assert.equal(getOwnedOcrTextItems(doc, 1)[0].baseline.provenance, 'estimated');
});

test('baseline estimation is deterministic for supported skewed lines and rejects vertical or ambiguous geometry', () => {
  const supported = {
    polygon: {
      coordinateSpace: 'source-raster-pixels',
      points: [[10, 10], [210, 20], [208, 44], [8, 34]],
    },
    baseline: { status: 'unavailable', coordinateSpace: 'source-raster-pixels' },
  };
  const first = estimateOcrLineBaseline(supported);
  assert.deepEqual(estimateOcrLineBaseline(supported), first);
  assert.equal(first.status, 'provided');
  assert.equal(first.provenance, 'estimated');
  assert.equal(first.points.length, 2);

  assert.equal(estimateOcrLineBaseline({
    ...supported,
    polygon: { ...supported.polygon, points: [[10, 10], [30, 10], [30, 30], [10, 30]] },
  }), null);
  assert.equal(estimateOcrLineBaseline({
    ...supported,
    polygon: { ...supported.polygon, points: [[10, 10], [30, 10], [30, 210], [10, 210]] },
  }), null);
});

test('successful persistence moves typed OCR out of the pending projection and explicit clear remains dirty', async () => {
  const doc = makeDocument('document-persisted', fakePdfDocument([]));
  await applyFixture(doc);
  assert.equal(getPendingOcrTextItems(doc, 1).length, 2);
  markOwnedOcrPersisted(doc, [{
    pageIndex: 0,
    owned: true,
    schemaVersion: 1,
    writerVersion: 'invisible-unicode-v1',
    ownedStreamRef: '20 0 R',
    fontRef: '21 0 R',
    contentDigest: 'a'.repeat(64),
  }]);
  assert.equal(getPendingOcrTextItems(doc, 1).length, 0);
  assert.equal(getOwnedOcrTextItems(doc, 1).length, 2);
  assert.equal(doc.ocr.pages[1].recognition.ownership.persisted, true);
  assert.equal(doc.ocr.dirty, false);

  assert.equal(clearOpenPdfStudioOcrPage(doc, 1), true);
  assert.equal(getOwnedOcrTextItems(doc, 1).length, 0);
  assert.equal(doc.ocr.pages[1].review.dirty, true);
  assert.equal(doc.ocr.dirty, true);
});

test('page revision and document generation tokens reject stale results', async () => {
  const doc = makeDocument('document-stale', fakePdfDocument([]));
  const first = (await beginOcrPageAttempt(doc, 1)).token;
  const staleFixture = makeOcrFixture({
    documentId: doc.id,
    documentGeneration: first.documentGeneration,
    pageId: first.pageId,
    pageRevision: first.pageRevision,
  });
  const second = (await beginOcrPageAttempt(doc, 1)).token;
  assert.ok(second.pageRevision > first.pageRevision);
  assert.deepEqual(
    applyOcrPageResult(doc, { ...staleFixture, token: first }),
    { applied: false, reason: 'stale-generation' },
  );
  assert.equal(doc.ocr.pages[1].recognition.result, null);
  assert.equal(finishOcrPageAttempt(doc, second, 'stale'), true);
  assert.equal(doc.ocr.pages[1].status, 'stale');
});

test('meaningful native or third-party text skips by default and suppresses duplicates', async () => {
  const nativeItems = [{
    str: 'Meaningful native contract text',
    transform: [12, 0, 0, 12, 20, 700],
    width: 180,
    height: 12,
  }];
  const doc = makeDocument('document-native-skip', fakePdfDocument(nativeItems));
  const attempt = await beginOcrPageAttempt(doc, 1);
  assert.equal(attempt.skipped, true);
  assert.equal(attempt.reason, 'meaningful-existing-text');
  assert.equal(doc.ocr.pages[1].status, 'skipped-existing-text');
  assert.equal(getPendingOcrTextItems(doc, 1).length, 0);
});

test('OCR does not start when existing PDF.js text cannot be verified', async () => {
  const doc = makeDocument('document-text-check-failed', {
    numPages: 1,
    async getPage() { throw new Error('damaged text stream'); },
  });
  const attempt = await beginOcrPageAttempt(doc, 1, { force: true });
  assert.equal(attempt.skipped, true);
  assert.equal(attempt.reason, 'existing-text-unverified');
  assert.equal(attempt.token, null);
  assert.equal(doc.ocr.pages[1].status, 'failed');
  assert.equal(doc.ocr.pages[1].recognition.warnings[0].code, 'existing-text-unverified');
});

test('force rerun replaces only Open PDF Studio-owned state', async () => {
  const doc = makeDocument('document-force', fakePdfDocument([]));
  const first = await applyFixture(doc, 1, [
    { id: 'line-old', text: 'Old owned OCR', x: 20, y: 30, width: 100, height: 14 },
  ]);
  const firstStored = doc.ocr.pages[1].recognition.result;
  const ordinaryAttempt = await beginOcrPageAttempt(doc, 1);
  assert.equal(ordinaryAttempt.skipped, true);
  assert.equal(ordinaryAttempt.reason, 'existing-ocr-result');
  assert.equal(doc.ocr.pages[1].recognition.result, firstStored);
  const rerun = await beginOcrPageAttempt(doc, 1, { force: true });
  assert.equal(rerun.skipped, false);
  assert.equal(doc.ocr.pages[1].recognition.result, null);
  const replacement = makeOcrFixture({
    documentId: doc.id,
    documentGeneration: rerun.token.documentGeneration,
    pageId: rerun.token.pageId,
    pageRevision: rerun.token.pageRevision,
    lines: [{ id: 'line-new', text: 'New owned OCR', x: 20, y: 30, width: 100, height: 14 }],
  });
  assert.equal(applyOcrPageResult(doc, { ...replacement, token: rerun.token }).applied, true);
  assert.notEqual(doc.ocr.pages[1].recognition.result, firstStored);
  assert.equal(getPendingOcrTextItems(doc, 1)[0].text, 'New owned OCR');

  const page = ensureOcrPageState(doc, 1);
  page.recognition.ownership = { ...page.recognition.ownership, owner: 'third-party' };
  const refused = await beginOcrPageAttempt(doc, 1, { force: true });
  assert.equal(refused.skipped, true);
  assert.equal(refused.reason, 'unowned-ocr-state');
  assert.equal(doc.ocr.pages[1].recognition.result.text, replacement.result.text);
  assert.equal(first.result.lines[0].text, 'Old owned OCR');
});

test('search extraction works before save and anchors OCR with canonical estimated baseline geometry', async () => {
  const doc = makeDocument('document-search-before-save', fakePdfDocument([]));
  await applyFixture(doc, 1, [
    { id: 'search-line', text: 'Unsaved searchable phrase', x: 40, y: 60, width: 220, height: 18 },
  ]);
  const pageText = await extractPageText(doc.pdfDoc, 1, doc);
  assert.ok(pageText.text.includes('searchable phrase'));
  assert.equal(pageText.items[0].source, 'ocr');
  assert.equal(pageText.items[0].geometry.anchor.source, 'baseline');
  assert.equal(getOwnedOcrTextItems(doc, 1)[0].baseline.provenance, 'estimated');
  assert.equal(doc.textEdits.length, 0);
  invalidateTextCache(doc.id);
});

test('only the affected page text cache is invalidated', async () => {
  const counters = new Map();
  const pdfDoc = fakePdfDocument([[], []], counters);
  const doc = makeDocument('document-cache-pages', pdfDoc);
  await extractPageText(pdfDoc, 1, doc);
  await extractPageText(pdfDoc, 2, doc);
  assert.deepEqual(Object.fromEntries(counters), { 1: 1, 2: 1 });

  await applyFixture(doc, 1, [
    { id: 'cache-line', text: 'Page one cache change', x: 20, y: 40, width: 150, height: 14 },
  ]);
  await extractPageText(pdfDoc, 2, doc);
  await extractPageText(pdfDoc, 1, doc);
  assert.deepEqual(Object.fromEntries(counters), { 1: 2, 2: 1 });
  assert.deepEqual(
    textCacheSnapshot().find((entry) => entry.documentId === doc.id)?.pages,
    [1, 2],
  );
  invalidateTextCache(doc.id);
});

test('dense and multi-column results preserve declared reading order above 64 lines', async () => {
  const doc = makeDocument('document-dense-order', fakePdfDocument([]));
  const lines = Array.from({ length: 70 }, (_, index) => ({
    id: `dense-line-${index + 1}`,
    text: index < 35 ? `Left ${index + 1}` : `Right ${index - 34}`,
    x: index < 35 ? 24 : 320,
    y: 20 + (index % 35) * 20,
    width: 100,
    height: 12,
  }));
  await applyFixture(doc, 1, lines);
  const items = getPendingOcrTextItems(doc, 1);
  assert.equal(items.length, 70);
  assert.equal(new Set(items.map((item) => item.id)).size, 70);
  assert.deepEqual(items.map((item) => item.text), lines.map((line) => line.text));
  assert.deepEqual(items.map((item) => item.readingOrder), Array.from({ length: 70 }, (_, index) => index));
});

test('native assessment changes retain source data while suppressing owned OCR', async () => {
  const doc = makeDocument('document-assessment-suppression', fakePdfDocument([]));
  await applyFixture(doc);
  assert.equal(getPendingOcrTextItems(doc, 1).length, 2);
  const assessment = assessMeaningfulPdfText([{ str: 'Third-party searchable text layer' }]);
  recordOcrExistingTextAssessment(doc, 1, assessment);
  assert.equal(getPendingOcrTextItems(doc, 1).length, 0);
  assert.ok(doc.ocr.pages[1].recognition.result);
  assert.equal(doc.ocr.pages[1].existingText.meaningful, true);
});
