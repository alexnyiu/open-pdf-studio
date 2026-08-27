import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyNativeTextSourceProjection,
  applyNativeTextSourceProjectionToLayer,
  createNativeTextSourceProjection,
} from './native-text-source-projection.js';

function sourceSpan(text, { markerIds = '', itemIndex = '', editId = null } = {}) {
  const dataset = {
    pdfTransform: '[12,0,0,12,20,40]',
    nativeTextMarkerIds: markerIds,
    itemIndex: String(itemIndex),
  };
  if (editId) dataset.editId = String(editId);
  return {
    dataset,
    textContent: text,
    style: {
      visibility: '',
      removeProperty(key) {
        if (key === 'visibility') this.visibility = '';
      },
    },
  };
}

function layer(spans) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, 'span[data-pdf-transform]');
      return spans;
    },
  };
}

test('native source projection captures exact before/after span text without entering the V2 record', () => {
  const first = sourceSpan('First', { markerIds: 'marker-1', itemIndex: 2 });
  const suffix = sourceSpan(' suffix', { markerIds: 'marker-2', itemIndex: 3 });
  const second = sourceSpan('Second', { markerIds: 'marker-3', itemIndex: 4 });
  const projection = createNativeTextSourceProjection({
    pageNum: 1,
    editId: 'native-edit-1',
    lineData: [{ spans: [first, suffix] }, { spans: [second] }],
    replacementText: 'Replacement\nNext',
  });
  const persistedRecord = { schema: 'open-pdf-studio.text-edit-record', version: 2, id: 'native-edit-1' };
  const command = { type: 'addTextEdit', textEdit: { ...persistedRecord }, nativeSourceProjection: projection };

  assert.deepEqual(projection.spans.map((entry) => [entry.beforeText, entry.afterText]), [
    ['First', 'Replacement'],
    [' suffix', ''],
    ['Second', 'Next'],
  ]);
  assert.equal(first.textContent, 'First');
  assert.equal(Object.hasOwn(command.textEdit, 'nativeSourceProjection'), false);
  assert.deepEqual(command.textEdit, persistedRecord);
});

test('undo and redo restore source text and edit ids using stable native markers', () => {
  const first = sourceSpan('First', { markerIds: 'marker-1', itemIndex: 2 });
  const suffix = sourceSpan(' suffix', { markerIds: 'marker-2', itemIndex: 3 });
  const projection = createNativeTextSourceProjection({
    pageNum: 1,
    editId: 'native-edit-1',
    lineData: [{ spans: [first, suffix] }],
    replacementText: 'Replacement',
  });
  const textLayer = layer([first, suffix]);

  assert.deepEqual(applyNativeTextSourceProjectionToLayer(textLayer, projection, 'redo'), {
    applied: 2,
    missing: 0,
  });
  assert.equal(first.textContent, 'Replacement');
  assert.equal(suffix.textContent, '');
  assert.equal(first.dataset.editId, 'native-edit-1');
  assert.equal(suffix.dataset.editId, 'native-edit-1');

  first.style.visibility = 'hidden';
  assert.deepEqual(applyNativeTextSourceProjectionToLayer(textLayer, projection, 'undo'), {
    applied: 2,
    missing: 0,
  });
  assert.equal(first.textContent, 'First');
  assert.equal(suffix.textContent, ' suffix');
  assert.equal(first.dataset.editId, undefined);
  assert.equal(suffix.dataset.editId, undefined);
  assert.equal(first.style.visibility, '');
});

test('a newly rendered layer falls back to PDF.js item indexes and page scoping', () => {
  const original = sourceSpan('Original', { itemIndex: 2 });
  const projection = createNativeTextSourceProjection({
    pageNum: 3,
    editId: 'native-edit-2',
    lineData: [{ spans: [original] }],
    replacementText: 'After render',
  });
  const rerendered = sourceSpan('Original', { itemIndex: 2 });
  const textLayer = layer([rerendered]);
  const root = {
    querySelectorAll(selector) {
      return selector === '.textLayer[data-page="3"]' ? [textLayer] : [];
    },
  };

  assert.deepEqual(applyNativeTextSourceProjection(projection, 'redo', root), {
    applied: 1,
    missing: 0,
    layers: 1,
  });
  assert.equal(rerendered.textContent, 'After render');
  assert.equal(rerendered.dataset.editId, 'native-edit-2');
});
