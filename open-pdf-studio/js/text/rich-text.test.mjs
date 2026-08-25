import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTextFormat,
  assertRichTextDocumentV2,
  createRichTextDocument,
  createTextLine,
  createTextRun,
  graphemeLength,
  migrateLegacyTextEditRecord,
  replaceTextRange,
  richTextFromPlainText,
  richTextToPlainText,
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
