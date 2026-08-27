import test from 'node:test';
import assert from 'node:assert/strict';
import { createMutable as createBrowserMutable } from 'solid-js/store/dist/store.js';
import {
  applyTextFormat,
  assertRichTextDocumentV2,
  cloneOwnedTextEditPersistenceState,
  cloneRichTextDocument,
  cloneTextEditRecord,
  createRichTextDocument,
  createTextLine,
  createTextRun,
  graphemeLength,
  migrateLegacyTextEditRecord,
  removeTextEditRecordFromDocument,
  replaceTextRange,
  richTextInsertionContext,
  richTextFromPlainText,
  richTextToPlainText,
  shouldInsertRichHardBreak,
  textFormatState,
} from './rich-text.js';

const normal = {
  faceId: 'liberation-sans-regular',
  size: 12,
  color: '#112233',
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
  direction: 'ltr',
};

function fixture() {
  return createRichTextDocument([
    createTextLine([
      createTextRun('A👨‍👩‍👧‍👦B', normal, { id: 'run-a' }),
      createTextRun(' colored', { ...normal, color: '#ff0000' }, { id: 'run-b' }),
    ], { id: 'line-1', baseline: 80, baselineAdvance: 17, alignment: 'left' }),
  ], { x: 10, y: 60, width: 240, height: 30, rotation: 0 });
}

test('plain Enter inserts rich hard breaks only for multiline editors', () => {
  assert.equal(shouldInsertRichHardBreak({ key: 'Enter' }), true);
  assert.equal(shouldInsertRichHardBreak({ key: 'Enter' }, { singleLine: true }), false);
  assert.equal(shouldInsertRichHardBreak({ key: 'Enter', metaKey: true }), false);
  assert.equal(shouldInsertRichHardBreak({ key: 'Enter', ctrlKey: true }), false);
  assert.equal(shouldInsertRichHardBreak({ key: 'a' }), false);
});

test('reactive rich-text proxies are normalized before persistence', () => {
  const document = fixture();
  const reactiveProxy = new Proxy(document, {});
  assert.throws(() => structuredClone(reactiveProxy), { name: 'DataCloneError' });

  const copy = cloneRichTextDocument(reactiveProxy);
  assert.deepEqual(copy, document);
  assert.notEqual(copy, reactiveProxy);
  assert.doesNotThrow(() => structuredClone(copy));
});

test('owned text edit removal snapshots a browser Solid proxy before mutation and remains undoable', () => {
  const record = {
    id: 'inserted-delete-1',
    page: 1,
    richText: fixture(),
    original: null,
  };
  const documentState = createBrowserMutable({ textEdits: [record] });
  assert.throws(() => structuredClone(documentState.textEdits[0]), { name: 'DataCloneError' });

  const commands = [];
  const removed = removeTextEditRecordFromDocument(
    documentState,
    record.id,
    (snapshot, index) => {
      commands.push({ type: 'removeTextEdit', textEdit: snapshot, index });
      return true;
    },
  );
  assert.equal(removed, true);
  assert.equal(documentState.textEdits.length, 0);
  assert.equal(commands.length, 1);
  assert.doesNotThrow(() => structuredClone(commands[0].textEdit));
  assert.deepEqual(commands[0].textEdit, cloneTextEditRecord(record));

  // Undo restores the detached record at its exact owner index; a subsequent
  // removal (redo-equivalent) must remain proxy-safe.
  documentState.textEdits.splice(commands[0].index, 0, commands[0].textEdit);
  assert.deepEqual(cloneTextEditRecord(documentState.textEdits[0]), cloneTextEditRecord(record));
  assert.equal(removeTextEditRecordFromDocument(documentState, record.id, () => true), true);
  assert.equal(documentState.textEdits.length, 0);
});

test('failed owned text edit removal recording restores the original owner record', () => {
  const record = { id: 'inserted-delete-rollback', page: 1, richText: fixture(), original: null };
  const documentState = createBrowserMutable({ textEdits: [record] });
  const removed = removeTextEditRecordFromDocument(documentState, record.id, () => false);
  assert.equal(removed, false);
  assert.equal(documentState.textEdits.length, 1);
  assert.deepEqual(cloneTextEditRecord(documentState.textEdits[0]), cloneTextEditRecord(record));
});

test('native text persistence payload detaches Solid records and manifest before mocked IPC', async () => {
  const record = {
    id: 'native-ipc-1',
    page: 1,
    richText: fixture(),
    original: fixture(),
    sourceProvenance: [{ streamObjectId: 4, operatorIndex: 2 }],
  };
  const manifest = {
    schema: 'open-pdf-studio.owned-text-edit-manifest',
    version: 3,
    pages: [{ page: 1, edits: [record] }],
  };
  const documentState = createBrowserMutable({ textEdits: [record], textEditManifest: manifest });
  assert.throws(() => structuredClone(documentState.textEdits), { name: 'DataCloneError' });
  assert.throws(() => structuredClone(documentState.textEditManifest), { name: 'DataCloneError' });

  const plain = cloneOwnedTextEditPersistenceState(documentState);
  const invokeNative = async (command, payload) => {
    assert.equal(command, 'apply_native_text_edit_plan');
    assert.doesNotThrow(() => structuredClone(payload));
    return { pdfBytes: [1, 2, 3], updatedRecords: payload.records };
  };
  const result = await invokeNative('apply_native_text_edit_plan', {
    documentBytes: [37, 80, 68, 70],
    records: plain.records,
    previousManifest: plain.previousManifest,
  });

  assert.deepEqual(result.updatedRecords, [cloneTextEditRecord(record)]);
  assert.deepEqual(plain.previousManifest, cloneTextEditRecord(manifest));
});

test('selection formatting splits only at grapheme boundaries and preserves untouched runs', () => {
  const document = fixture();
  assert.equal(graphemeLength('A👨‍👩‍👧‍👦B'), 3);
  const untouched = structuredClone(document.lines[0].runs[1]);
  const result = applyTextFormat(document, {
    anchor: { line: 0, offset: 1 },
    focus: { line: 0, offset: 2 },
  }, { bold: true, faceId: 'liberation-sans-bold' });
  assert.deepEqual(result.document.lines[0].runs.map((run) => run.text), ['A', '👨‍👩‍👧‍👦', 'B', ' colored']);
  assert.equal(result.document.lines[0].runs[1].bold, true);
  assert.deepEqual(result.document.lines[0].runs[3], untouched);
  assert.equal(richTextToPlainText(result.document), richTextToPlainText(document));
});

test('mixed selection exposes indeterminate formatting and collapsed caret changes typing style only', () => {
  const document = fixture();
  const mixed = textFormatState(document, {
    anchor: { line: 0, offset: 0 },
    focus: { line: 0, offset: graphemeLength(richTextToPlainText(document)) },
  });
  assert.equal(mixed.color, null);
  assert.equal(mixed.size, 12);
  const collapsed = applyTextFormat(document, {
    anchor: { line: 0, offset: 2 },
    focus: { line: 0, offset: 2 },
  }, { italic: true, faceId: 'liberation-sans-italic' });
  assert.equal(collapsed.collapsed, true);
  assert.deepEqual(collapsed.document, document);
  assert.deepEqual(collapsed.typingStyle, { italic: true, faceId: 'liberation-sans-italic' });
});

test('selection formatting reports canonical line-spacing multipliers including mixed paragraphs', () => {
  const document = createRichTextDocument([
    createTextLine([createTextRun('First', { ...normal, size: 10 })], {
      id: 'spacing-a', baseline: 80, baselineAdvance: 15, alignment: 'left', breakAfter: 'hard',
    }),
    createTextLine([createTextRun('Second', { ...normal, size: 8 })], {
      id: 'spacing-b', baseline: 65, baselineAdvance: 12, alignment: 'left', breakAfter: 'hard',
    }),
  ], { x: 10, y: 45, width: 240, height: 50 });
  const uniform = textFormatState(document, {
    anchor: { line: 0, offset: 0 },
    focus: { line: 1, offset: 6 },
  });
  assert.equal(uniform.lineSpacingMultiplier, 1.5);

  document.lines[1].baselineAdvance = 16;
  const mixed = textFormatState(document, {
    anchor: { line: 0, offset: 0 },
    focus: { line: 1, offset: 6 },
  });
  assert.equal(mixed.lineSpacingMultiplier, null);
});

test('replacement preserves surrounding run styles and supports editor-local multiline insertion', () => {
  const document = fixture();
  const result = replaceTextRange(document, {
    anchor: { line: 0, offset: 1 },
    focus: { line: 0, offset: 2 },
  }, 'x\ny', { underline: true });
  assert.equal(richTextToPlainText(result.document), 'Ax\nyB colored');
  assert.equal(result.document.lines[0].baselineAdvance, 17);
  assert.equal(result.document.lines[1].baselineAdvance, 17);
  assert.equal(result.document.lines[0].runs[0].text, 'A');
  assert.equal(result.document.lines[0].runs[0].underline, false);
  assert.equal(result.document.lines[0].runs[1].text, 'x');
  assert.equal(result.document.lines[0].runs[1].underline, true);
  assert.equal(result.document.lines[1].runs[1].text, 'B');
  assert.equal(result.document.lines[1].runs[1].underline, false);
});

test('collapsed caret typing style affects only inserted graphemes', () => {
  const document = fixture();
  const selection = {
    anchor: { line: 0, offset: 1 },
    focus: { line: 0, offset: 1 },
  };
  const collapsed = applyTextFormat(document, selection, {
    italic: true,
    faceId: 'liberation-sans-italic',
  });
  const inserted = replaceTextRange(document, selection, 'x', collapsed.typingStyle);
  assert.deepEqual(inserted.document.lines[0].runs.slice(0, 3).map((run) => ({
    text: run.text,
    italic: run.italic,
  })), [
    { text: 'A', italic: false },
    { text: 'x', italic: true },
    { text: '👨‍👩‍👧‍👦B', italic: false },
  ]);
});

test('caret insertion context is backward-biased at mixed-format run boundaries', () => {
  const document = fixture();
  const boundary = graphemeLength(document.lines[0].runs[0].text);
  const atBoundary = richTextInsertionContext(document, { line: 0, offset: boundary });
  const atStart = richTextInsertionContext(document, { line: 0, offset: 0 });
  assert.equal(atBoundary.sourceRunId, 'run-a');
  assert.equal(atBoundary.runStyle.color, normal.color);
  assert.equal(atStart.sourceRunId, 'run-a');
  assert.deepEqual(atBoundary.lineStyle, {
    alignment: 'left',
    baselineAdvance: 17,
    lineSpacingMultiplier: 1.4166667,
  });
});

test('Enter preserves caret formatting and stable surrounding identities', () => {
  const document = createRichTextDocument([
    createTextLine([
      createTextRun('Blue', {
        ...normal,
        faceId: 'liberation-sans-bold-italic',
        size: 8.7,
        color: '#0057a8',
        bold: true,
        italic: true,
        underline: true,
        strikeout: true,
      }, { id: 'blue-run' }),
      createTextRun(' gray', {
        ...normal,
        size: 6.8,
        color: '#666666',
      }, { id: 'gray-run' }),
    ], {
      id: 'mixed-line', baseline: 80, baselineAdvance: 15,
      alignment: 'right', breakAfter: 'hard',
    }),
    createTextLine([createTextRun('Untouched', normal, { id: 'untouched-run' })], {
      id: 'untouched-line', baseline: 65, baselineAdvance: 15,
      alignment: 'left', breakAfter: 'hard',
    }),
  ], { x: 10, y: 45, width: 240, height: 50 });
  const untouched = structuredClone(document.lines[1]);
  const result = replaceTextRange(document, {
    anchor: { line: 0, offset: 4 },
    focus: { line: 0, offset: 4 },
  }, '\n');
  const inserted = result.document.lines[1].runs[0];
  assert.equal(result.document.lines[0].id, 'mixed-line');
  assert.equal(inserted.text, '');
  assert.deepEqual({
    faceId: inserted.faceId,
    size: inserted.size,
    color: inserted.color,
    bold: inserted.bold,
    italic: inserted.italic,
    underline: inserted.underline,
    strikeout: inserted.strikeout,
  }, {
    faceId: 'liberation-sans-bold-italic',
    size: 8.7,
    color: '#0057a8',
    bold: true,
    italic: true,
    underline: true,
    strikeout: true,
  });
  assert.equal(result.document.lines[1].alignment, 'right');
  assert.equal(result.document.lines[1].baselineAdvance, 15);
  assert.equal(result.document.lines[2].id, untouched.id);
  assert.equal(result.document.lines[2].alignment, untouched.alignment);
  assert.equal(result.document.lines[2].baselineAdvance, untouched.baselineAdvance);
  assert.equal(result.document.lines[2].breakAfter, untouched.breakAfter);
  assert.deepEqual(result.document.lines[2].runs, untouched.runs);
  assert.equal(result.document.lines[2].baseline, untouched.baseline - 15);
});

test('multiple inserted lines share the caret format while explicit typing style wins', () => {
  const document = fixture();
  const result = replaceTextRange(document, {
    anchor: { line: 0, offset: 1 },
    focus: { line: 0, offset: 1 },
  }, '\nΩ\n', {
    faceId: 'liberation-serif-bold',
    color: '#abcdef',
    bold: true,
    italic: false,
  });
  assert.equal(result.document.lines.length, 3);
  for (const line of result.document.lines.slice(1)) {
    assert.equal(line.runs[0].faceId, 'liberation-serif-bold');
    assert.equal(line.runs[0].color, '#abcdef');
    assert.equal(line.runs[0].bold, true);
  }
  assert.equal(result.document.lines[1].runs[0].text, 'Ω');
  assert.equal(result.document.lines[2].runs[0].text, '');
});

test('multiline replacement preserves surrounding runs and intentionally uses the selection-start style', () => {
  const document = createRichTextDocument([
    createTextLine([
      createTextRun('Before ', { ...normal, bold: true }, { id: 'before-run' }),
      createTextRun('selected', { ...normal, color: '#ff0000' }, { id: 'selected-run' }),
    ], { id: 'first-line', baseline: 80, baselineAdvance: 14, alignment: 'center' }),
    createTextLine([
      createTextRun(' range', { ...normal, italic: true }, { id: 'range-run' }),
      createTextRun(' After', { ...normal, color: '#00aa00' }, { id: 'after-run' }),
    ], { id: 'second-line', baseline: 66, baselineAdvance: 18, alignment: 'right' }),
  ], { x: 10, y: 40, width: 200, height: 50 });
  const before = structuredClone(document.lines[0].runs[0]);
  const after = structuredClone(document.lines[1].runs[1]);
  const result = replaceTextRange(document, {
    anchor: { line: 0, offset: 7 },
    focus: { line: 1, offset: 6 },
  }, 'red\ncontinuation');
  assert.equal(richTextToPlainText(result.document), 'Before red\ncontinuation After');
  assert.deepEqual(result.document.lines[0].runs[0], before);
  assert.deepEqual(result.document.lines[1].runs.at(-1), after);
  assert.equal(result.document.lines[0].runs.at(-1).bold, true);
  assert.equal(result.document.lines[1].runs[0].bold, true);
  assert.equal(result.document.lines[0].id, 'first-line');
  assert.equal(result.document.lines[1].id, 'second-line');
  assert.equal(result.document.lines[0].alignment, 'center');
  assert.equal(result.document.lines[1].alignment, 'center');
  assert.equal(result.document.lines[1].baselineAdvance, 14);
});

test('select-all multiline replacement uses an explicit active typing format', () => {
  const document = fixture();
  const active = {
    faceId: 'liberation-mono-bold-italic',
    size: 9.25,
    color: '#abcdef',
    bold: true,
    italic: true,
    underline: true,
    strikeout: true,
  };
  const result = replaceTextRange(document, {
    anchor: { line: 0, offset: 0 },
    focus: { line: 0, offset: graphemeLength(richTextToPlainText(document)) },
  }, 'one\ntwo', active);
  assert.equal(richTextToPlainText(result.document), 'one\ntwo');
  for (const line of result.document.lines) {
    const run = line.runs[0];
    for (const [key, value] of Object.entries(active)) assert.equal(run[key], value);
  }
  assert.equal(result.document.lines[0].id, document.lines[0].id);
  assert.deepEqual(document, fixture(), 'replacement must not mutate the source document');
});

test('multiline baselines follow the explicit coordinate direction', () => {
  const pdfText = richTextFromPlainText('one\ntwo', { ...normal, baselineAdvance: 12 }, {
    x: 0, y: 0, width: 100, height: 40, baseline: 30,
  });
  assert.equal(pdfText.region.baselineDirection, 'decreasing-y');
  assert.deepEqual(pdfText.lines.map((line) => line.baseline), [30, 18]);

  const annotationText = richTextFromPlainText('one\ntwo', { ...normal, baselineAdvance: 12 }, {
    x: 0, y: 0, width: 100, height: 40, baseline: 10,
    baselineDirection: 'increasing-y',
  });
  assert.deepEqual(annotationText.lines.map((line) => line.baseline), [10, 22]);
  const inserted = replaceTextRange(annotationText, {
    anchor: { line: 0, offset: 3 },
    focus: { line: 0, offset: 3 },
  }, '\nnew');
  assert.deepEqual(inserted.document.lines.map((line) => line.baseline), [10, 22, 34]);
});

test('legacy migration preserves measured baseline advance and fails closed on unknown versions', () => {
  const migrated = migrateLegacyTextEditRecord({
    id: 'legacy-1', page: 2, originalText: '', newText: 'Hello',
    pdfX: 12, pdfY: 44, pdfWidth: 80, fontSize: 10, lineSpacing: 18,
    fontFamily: 'Courier-BoldOblique', color: '#334455',
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.richText.lines[0].baselineAdvance, 18);
  assert.equal(migrated.richText.lines[0].runs[0].faceId, 'liberation-mono-bold-italic');
  assert.throws(() => assertRichTextDocumentV2({ ...migrated.richText, version: 3 }), /Unsupported rich text schema version/u);
  assert.throws(() => migrateLegacyTextEditRecord({ schema: 'open-pdf-studio.text-edit-record', version: 99 }), /Unsupported text edit record version/u);
});
