import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  groupNativeTextFragments,
  nativeTextLinePieces,
} from './native-text-blocks.js';

function fragment(text, x, y, width, options = {}) {
  return {
    text,
    pdfX: x,
    pdfY: y,
    pdfWidth: width,
    fontSize: options.fontSize || 6.8,
    sourceText: options.sourceText ?? text,
    style: options.style || 'regular',
    fontName: options.fontName || 'BodyRegular',
  };
}

test('joins mixed-size body lines by the runs touching each boundary', () => {
  const fragments = [
    fragment('IMPORTANT', 64, 700, 48, { fontSize: 7.2, fontName: 'BodyBold' }),
    fragment('The screen result is a starting point that', 64, 684, 180, { fontSize: 8.7 }),
    fragment('combines price strength with ', 64, 673, 105, { fontSize: 8.7 }),
    fragment('smaller inline detail', 169, 673, 70, { fontSize: 6.8 }),
    fragment('smaller continuation ', 64, 662, 70, { fontSize: 6.8 }),
    fragment('returns to body ', 134, 662, 70, { fontSize: 8.7 }),
    fragment('and smaller detail ', 204, 662, 65, { fontSize: 6.8 }),
    fragment('before body.', 269, 662, 54, { fontSize: 8.7 }),
    fragment('The final body line completes the paragraph.', 64, 651, 190, { fontSize: 8.7 }),
  ];

  const blocks = groupNativeTextFragments(fragments);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lines.length, 1);
  assert.equal(blocks[0].lines[0][0].text, 'IMPORTANT');
  assert.equal(blocks[1].lines.length, 4);
});

test('keeps each multiline table-cell paragraph in one independent block', () => {
  const fragments = [
    fragment('High, execution-sensitive', 184, 664, 67),
    fragment('   ', 252, 664, 88),
    fragment('ARCALYST penetration', 344, 664, 61),
    fragment(' (the share of the potential market already using', 406, 664, 145),
    fragment('the product) + pipeline', 344, 656, 68),
    fragment('Very high', 184, 641, 28),
    fragment('AI interconnect + aerospace/defense', 344, 641, 105),
  ];

  const blocks = groupNativeTextFragments(fragments);
  const text = blocks.map((block) => block.lines.map((line) => (
    nativeTextLinePieces(line).map((piece) => piece.text).join('')
  )).join('\n'));

  assert.equal(blocks.length, 4);
  assert.ok(text.includes('ARCALYST penetration (the share of the potential market already using\nthe product) + pipeline'));
  assert.ok(text.includes('High, execution-sensitive'));
  assert.ok(text.includes('Very high'));
  assert.ok(text.includes('AI interconnect + aerospace/defense'));
});

test('preserves lexical spaces while retaining independently styled inline runs', () => {
  const line = [
    fragment('AI optics and 1.6T', 344, 664, 54, { sourceText: 'AI optics and 1.6T ' }),
    fragment('(terabit)', 399, 664, 24, { style: 'italic' }),
  ];
  const pieces = nativeTextLinePieces(line);
  assert.deepEqual(pieces.map((piece) => piece.text), ['AI optics and 1.6T', ' ', '(terabit)']);
  assert.equal(pieces[2].item.style, 'italic');
});

test('drops whitespace and control spans before grouping', () => {
  const blocks = groupNativeTextFragments([
    fragment('Left cell', 100, 500, 30),
    fragment('\u200b   ', 131, 500, 150),
    fragment('Right cell', 300, 500, 35),
  ]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.flatMap((block) => block.lines.flat()).map((item) => item.text), [
    'Left cell', 'Right cell',
  ]);
});

test('groups the ReportLab table fixture without whitespace bridging cells', async () => {
  const bytes = new Uint8Array(await readFile(new URL(
    '../../tests/fixtures/text/native-paragraph-table.pdf', import.meta.url,
  )));
  const document = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const whitespaceCount = content.items.filter((item) => !item.str.trim()).length;
    assert.ok(whitespaceCount >= 4, 'fixture must retain ReportLab/PDF.js layout whitespace spans');
    const blocks = groupNativeTextFragments(content.items.map((item) => ({
      text: item.str,
      sourceText: item.str,
      pdfX: item.transform[4],
      pdfY: item.transform[5],
      pdfWidth: item.width,
      fontSize: Math.hypot(item.transform[2], item.transform[3]),
      fontName: item.fontName,
    })));
    const texts = blocks.map((block) => block.lines.map((line) => (
      nativeTextLinePieces(line).map((piece) => piece.text).join('')
    )).join('\n'));
    const paragraphIndex = texts.indexOf(
      'ARCALYST penetration (the share of the potential market already\nusing the product) + pipeline',
    );
    assert.notEqual(paragraphIndex, -1);
    assert.equal(blocks.length, 6);
    assert.ok(new Set(blocks[paragraphIndex].lines[0].map((item) => item.fontName)).size > 1,
      'inline font changes must remain separate visible fragments');
  } finally {
    await document.destroy();
  }
});
