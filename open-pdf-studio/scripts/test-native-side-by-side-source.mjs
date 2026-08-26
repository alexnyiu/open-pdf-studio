import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  groupNativeTextFragments,
  nativeTextLinePieces,
} from '../js/text/native-text-blocks.js';

const sourcePath = process.env.OPDS_NATIVE_SIDE_BY_SIDE_PDF
  || '/Users/alexander/Downloads/Market_Screen_50_Stock_CANSLIM_Analysis_Competitive_Deep_Dive.pdf';

try {
  await access(sourcePath);
} catch {
  console.log(`Optional native side-by-side source regression skipped: ${sourcePath}`);
  process.exit(0);
}

const document = await pdfjsLib.getDocument({
  data: new Uint8Array(await readFile(sourcePath)), isEvalSupported: false, verbosity: 0,
}).promise;
try {
  assert.ok(document.numPages >= 9, 'side-by-side regression PDF must contain page 9');
  const content = await (await document.getPage(9)).getTextContent();
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
  const summaries = blocks.map((block) => ({
    columnId: block.columnId,
    lines: block.lines.map((line) => nativeTextLinePieces(line).map((piece) => piece.text).join('')),
  }));
  const leftHeading = summaries.find((block) => block.lines[0] === 'WHY IT IS GROWING');
  const rightHeading = summaries.find((block) => block.lines[0] === 'CAN THE GROWTH CONTINUE?');
  const leftBody = summaries.find((block) => block.lines[0]?.startsWith('Mounjaro and Zepbound'));
  const rightBody = summaries.find((block) => block.lines[0]?.startsWith('The growth runway'));
  assert.ok(leftHeading && rightHeading && leftBody && rightBody);
  assert.equal(leftHeading.lines.length, 1);
  assert.equal(rightHeading.lines.length, 1);
  assert.equal(leftBody.lines.length, 6);
  assert.equal(rightBody.lines.length, 9);
  assert.equal(leftHeading.columnId, leftBody.columnId);
  assert.equal(rightHeading.columnId, rightBody.columnId);
  assert.notEqual(leftBody.columnId, rightBody.columnId);
  assert.match(leftBody.lines.at(-1), /tirzepatide franchise/u);
  assert.match(rightBody.lines.at(-1), /safety advantages versus competitors/u);
  console.log(`Native side-by-side source regression passed: ${sourcePath}`);
} finally {
  await document.destroy();
}
