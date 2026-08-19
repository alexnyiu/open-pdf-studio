import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import {
  inspectOwnedInvisibleOcrLayer,
  removeOwnedInvisibleOcrLayer,
  writeOwnedInvisibleOcrLayer,
} from '../js/ocr/pdf-writer-proof.js';
import { createOcrWriterProofFixture } from './ocr-pdf-writer-proof-fixture.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDir = join(appRoot, 'output', 'pdf');
const proofDir = process.env.OPEN_PDF_STUDIO_OCR_WRITER_PROOF_DIR
  || join(tmpdir(), 'open-pdf-studio-ocr-writer-proof');
const finalPath = join(outputDir, 'open-pdf-studio-ocr-writer-proof.pdf');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function count(text, needle) {
  let result = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    result += 1;
    offset += needle.length;
  }
  return result;
}

async function extractWithPdfJs(bytes) {
  const document = await pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const content = await (await document.getPage(pageNumber)).getTextContent();
      const items = content.items.map((item) => item.str).filter(Boolean);
      pages.push({ items, copyText: items.join('\n') });
    }
    return pages;
  } finally {
    await document.destroy();
  }
}

async function thirdPartyState(bytes) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return document.getPages().map((page) => {
    const pieceInfo = page.node.lookup(PDFName.of('PieceInfo'), PDFDict);
    const vendor = pieceInfo.lookup(PDFName.of('ThirdPartyProof'), PDFDict);
    const privateDict = vendor.lookup(PDFName.of('Private'), PDFDict);
    const stream = privateDict.get(PDFName.of('Stream'));
    assert.ok(stream instanceof PDFRef, 'third-party stream metadata must remain indirect');
    return {
      owner: privateDict.get(PDFName.of('Owner')).decodeText(),
      streamRef: stream.toString(),
    };
  });
}

const fixture = await createOcrWriterProofFixture();
const writerArgs = {
  fontBytes: fixture.fontBytes,
  fontSha256: fixture.fontSha256,
  pages: fixture.pages,
  modifiedAt: fixture.modifiedAt,
};
const baseline = fixture.baselineBytes;
const written = await writeOwnedInvisibleOcrLayer({ pdfBytes: baseline, ...writerArgs });
const repeated = await writeOwnedInvisibleOcrLayer({ pdfBytes: written, ...writerArgs });
const removed = await removeOwnedInvisibleOcrLayer({ pdfBytes: repeated });

const baselineStructure = await inspectOwnedInvisibleOcrLayer(baseline);
const writtenStructure = await inspectOwnedInvisibleOcrLayer(written);
const repeatedStructure = await inspectOwnedInvisibleOcrLayer(repeated);
const removedStructure = await inspectOwnedInvisibleOcrLayer(removed);
const baselineText = await extractWithPdfJs(baseline);
const writtenText = await extractWithPdfJs(written);
const repeatedText = await extractWithPdfJs(repeated);
const removedText = await extractWithPdfJs(removed);
const baselineThirdParty = await thirdPartyState(baseline);

assert.deepEqual(await thirdPartyState(written), baselineThirdParty);
assert.deepEqual(await thirdPartyState(repeated), baselineThirdParty);
assert.deepEqual(await thirdPartyState(removed), baselineThirdParty);
for (const [pageIndex, page] of writtenStructure.entries()) {
  assert.equal(page.owned, true);
  assert.equal(page.renderingMode3Count, 1);
  assert.equal(page.textMatrixCount, fixture.pages[pageIndex].lines.length);
  assert.equal(page.showTextCount, fixture.pages[pageIndex].lines.length);
  assert.deepEqual(page.contentRefs.slice(0, -1), baselineStructure[pageIndex].contentRefs);
  assert.ok(page.toUnicodeBlockSizes.every((size) => size <= 100));
  assert.equal(page.fontSubtype, 'Type0');
  assert.ok(page.descendantSubtype.startsWith('CIDFontType'));

  const expectedItems = [fixture.thirdPartyText[pageIndex], ...fixture.pages[pageIndex].lines.map((line) => line.text)];
  assert.deepEqual(writtenText[pageIndex].items, expectedItems);
  assert.deepEqual(repeatedText[pageIndex].items, expectedItems);
  for (const line of fixture.pages[pageIndex].lines) {
    assert.equal(count(repeatedText[pageIndex].copyText, line.text), 1, `repeat write duplicated ${line.id}`);
  }
}
assert.deepEqual(repeatedStructure.map((page) => page.contentRefs.length), writtenStructure.map((page) => page.contentRefs.length));
assert.deepEqual(removedText, baselineText);
for (const [pageIndex, page] of removedStructure.entries()) {
  assert.equal(page.owned, false);
  assert.deepEqual(page.contentRefs, baselineStructure[pageIndex].contentRefs);
}

await mkdir(proofDir, { recursive: true });
await mkdir(outputDir, { recursive: true });
const files = {
  baseline: join(proofDir, 'baseline.pdf'),
  written: join(proofDir, 'written.pdf'),
  repeated: join(proofDir, 'repeated.pdf'),
  removed: join(proofDir, 'removed.pdf'),
  final: finalPath,
};
await Promise.all([
  writeFile(files.baseline, baseline),
  writeFile(files.written, written),
  writeFile(files.repeated, repeated),
  writeFile(files.removed, removed),
  writeFile(files.final, written),
]);

const result = {
  status: 'pass',
  proofDir,
  finalPath,
  fontSha256: fixture.fontSha256,
  fileBytes: {
    baseline: baseline.length,
    written: written.length,
    repeated: repeated.length,
    removed: removed.length,
  },
  fileSha256: {
    baseline: sha256(baseline),
    written: sha256(written),
    repeated: sha256(repeated),
    removed: sha256(removed),
  },
  pdfJs: {
    extractionAfterReopen: 'pass',
    readingOrder: 'pass',
    repeatedWriteNoDuplicate: 'pass',
    removalRestoresSearchableState: 'pass',
    pages: writtenText,
  },
  structure: writtenStructure.map((page) => ({
    pageIndex: page.pageIndex,
    contentRefs: page.contentRefs,
    ownedStreamRef: page.ownedStreamRef,
    renderingMode3Count: page.renderingMode3Count,
    textMatrixCount: page.textMatrixCount,
    fontRef: page.fontRef,
    fontSubtype: page.fontSubtype,
    descendantSubtype: page.descendantSubtype,
    toUnicodeBlockSizes: page.toUnicodeBlockSizes,
  })),
  preservation: {
    nativeAndThirdPartyContentRefs: 'pass',
    thirdPartyPieceInfo: 'pass',
  },
};
await writeFile(join(proofDir, 'js-proof-results.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
