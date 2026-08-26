import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  detectNativeColumnTracks,
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

function sideBySideCalloutFragments() {
  const left = [
    ['Mounjaro and Zepbound are still expanding rapidly as obesity', 282.86, 236.94],
    ['and diabetes treatment adoption (customers or patients beginning to', 271.66, 233.4],
    ['use a product) grows globally. Lilly is also adding manufacturing', 260.46, 233.97],
    ['capacity and developing next-generation medicines such as', 249.26, 230.18],
    ['retatrutide, which gives the company a potential second wave', 238.06, 236.94],
    ['after the current tirzepatide franchise.', 226.86, 144.1],
  ];
  const right = [
    ['The growth runway is unusually long because the obesity and', 282.86, 237.43],
    ['metabolic market is large and still underpenetrated (only a', 271.66, 217.69],
    ['relatively small share of potential customers or patients currently use the', 260.46, 217.68],
    ['product), but growth rates should normalize as the revenue', 249.26, 220.3],
    ['base becomes enormous. Sustained growth depends on', 238.06, 217.61],
    ['manufacturing capacity, broader reimbursement (whether', 226.86, 213.57],
    ['insurers or government health programs will pay for the treatment),', 215.66, 201.58],
    ['successful pipeline launches, and retaining strong efficacy', 204.46, 223.89],
    ['and safety advantages versus competitors.', 193.26, 165.38],
  ];
  return [
    fragment('WHY IT IS GROWING', 52.6, 294.86, 72.01, { fontSize: 7.2, fontName: 'BodyBold' }),
    fragment('CAN THE GROWTH CONTINUE?', 311.08, 294.86, 110.79, { fontSize: 7.2, fontName: 'BodyBold' }),
    ...left.map(([text, y, width]) => fragment(text, 52.6, y, width, { fontSize: 8.7 })),
    ...right.map(([text, y, width]) => fragment(text, 311.08, y, width, { fontSize: 8.7 })),
  ];
}

test('isolates synchronized side-by-side callouts across a narrow persistent gutter', () => {
  const fragments = sideBySideCalloutFragments();
  const tracks = detectNativeColumnTracks(fragments);
  const calloutTrack = tracks.find((track) => track.center > 295 && track.center < 305);
  assert.ok(calloutTrack);
  assert.ok(calloutTrack.right - calloutTrack.left >= 8.7 * 1.25);
  assert.ok(calloutTrack.supportLineCount >= 2);

  const summarize = (input) => groupNativeTextFragments(input).map((block) => ({
    columnId: block.columnId,
    columnBounds: block.columnBounds,
    lines: block.lines.map((line) => nativeTextLinePieces(line).map((piece) => piece.text).join('')),
  }));
  const blocks = summarize(fragments);
  assert.deepEqual(blocks.map((block) => block.lines.length), [1, 1, 6, 9]);
  assert.equal(blocks[0].lines[0], 'WHY IT IS GROWING');
  assert.equal(blocks[1].lines[0], 'CAN THE GROWTH CONTINUE?');
  assert.match(blocks[2].lines.join(' '), /tirzepatide franchise/u);
  assert.match(blocks[3].lines.join(' '), /safety advantages versus competitors/u);
  assert.notEqual(blocks[2].columnId, blocks[3].columnId);
  assert.ok(blocks[2].columnBounds.right <= blocks[3].columnBounds.left);
  assert.deepEqual(summarize([...fragments].reverse()), blocks,
    'column IDs and paragraph membership must not depend on PDF.js input order');
});

test('ends a local two-column lane before a full-width crossing paragraph', () => {
  const fragments = [
    fragment('Left first line continues', 20, 500, 115),
    fragment('Right first line continues', 160, 500, 120),
    fragment('Left second line.', 20, 488, 100),
    fragment('Right second line.', 160, 488, 105),
    fragment('A full-width paragraph crosses the former gutter.', 20, 450, 260),
  ];
  const blocks = groupNativeTextFragments(fragments);
  const texts = blocks.map((block) => block.lines.map((line) => segmentTextForTest(line)).join('\n'));
  assert.equal(texts.some((text) => text.includes('Left') && text.includes('Right')), false);
  assert.ok(texts.includes('A full-width paragraph crosses the former gutter.'));
});

function segmentTextForTest(line) {
  return nativeTextLinePieces(line).map((piece) => piece.text).join('');
}

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

test('restores merged PDF.js spans to exact source-colored operator runs', () => {
  const item = fragment('including blue emphasis and pale detail', 52, 650, 170, {
    fontSize: 8.7,
  });
  item.sourceRuns = [
    { decodedText: 'including ', fillColor: '#111111', fontSize: 8.7, markerId: 'black' },
    { decodedText: 'blue emphasis', fillColor: '#0057a8', fontSize: 8.7, markerId: 'blue' },
    { decodedText: ' and ', fillColor: '#111111', fontSize: 8.7, markerId: 'black-2' },
    { decodedText: 'pale detail', fillColor: '#f4f4f4', fontSize: 6.8, markerId: 'pale' },
  ];
  item.sourceText = item.sourceRuns.map((source) => source.decodedText).join('');
  const pieces = nativeTextLinePieces([item]);
  assert.deepEqual(pieces.map((piece) => piece.text), [
    'including ', 'blue emphasis', ' and ', 'pale detail',
  ]);
  assert.deepEqual(pieces.map((piece) => piece.source.fillColor), [
    '#111111', '#0057a8', '#111111', '#f4f4f4',
  ]);
  assert.equal(pieces.at(-1).source.fontSize, 6.8);
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

test('groups the generated side-by-side mixed-color fixture into independent paragraphs', async () => {
  const bytes = new Uint8Array(await readFile(new URL(
    '../../tests/fixtures/text/native-side-by-side-color.pdf', import.meta.url,
  )));
  const document = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const blocks = groupNativeTextFragments(content.items.map((item) => ({
      text: item.str,
      sourceText: item.str,
      pdfX: item.transform[4],
      pdfY: item.transform[5],
      pdfWidth: item.width,
      fontSize: Math.hypot(item.transform[2], item.transform[3]),
      fontName: item.fontName,
      fontFamily: content.styles?.[item.fontName]?.fontFamily || '',
    })));
    assert.deepEqual(blocks.map((block) => block.lines.length), [1, 1, 6, 9]);
    assert.equal(blocks[0].columnId, blocks[2].columnId);
    assert.equal(blocks[1].columnId, blocks[3].columnId);
    assert.notEqual(blocks[2].columnId, blocks[3].columnId);
    assert.ok(blocks[2].columnBounds.right <= blocks[3].columnBounds.left);
  } finally {
    await document.destroy();
  }
});
