import test from 'node:test';
import assert from 'node:assert/strict';
import { captureOutputSnapshot, assertOutputRasterSize, createOutputBufferBudget } from './output-snapshot.js';
test('output owns submitted bytes, rotations and annotation state after source changes', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const doc = { id: 'a', pdfDoc: {}, fileName: 'a.pdf', annotations: [{ page: 1, text: 'original' }], pageRotations: { 1: 90 } };
  const snapshot = captureOutputSnapshot(doc, bytes);
  bytes.fill(0); doc.annotations[0].text = 'edited'; doc.pageRotations[1] = 180; doc.pdfDoc = null;
  assert.deepEqual(snapshot.bytes, new Uint8Array([1, 2, 3]));
  assert.equal(snapshot.annotations[0].text, 'original'); assert.equal(snapshot.pageRotations[1], 90);
});
test('output rejects oversized or invalid canvases before allocation', () => {
  assert.doesNotThrow(() => assertOutputRasterSize(2550, 3300));
  for (const dims of [[10000, 10000], [Infinity, 1], [-1, 50], [0, 0]]) assert.throws(() => assertOutputRasterSize(...dims));
});

test('multi-page output stops before exceeding retained encoded-page memory', () => {
  const budget = createOutputBufferBudget(100);
  assert.equal(budget.retain(60), 60);
  assert.equal(budget.retain(40), 100);
  assert.throws(() => budget.retain(1), /fewer pages/);
  assert.equal(budget.retainedBytes, 100);
});

test('unsaved owned text is captured for independent serialization without changing its source', () => {
  const doc = { id:'owned', pdfDoc:{}, textEdits:[{schema:'owned',id:'edit',page:1,text:'submitted'}],
    revisionState:{contentRevision:3,persistedRevision:1}, scannedTextEditPersistedRevision:0 };
  const snapshot = captureOutputSnapshot(doc,new Uint8Array([1]));
  doc.textEdits[0].text='later';
  doc.revisionState.contentRevision=4;
  assert.equal(snapshot.needsTextPersistence,true);
  assert.equal(snapshot.textEdits[0].text,'submitted');
  assert.equal(snapshot.revisionState.contentRevision,3);
  assert.equal(doc.revisionState.persistedRevision,1);
});
