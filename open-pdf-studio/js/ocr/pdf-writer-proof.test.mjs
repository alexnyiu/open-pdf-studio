import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import mupdf from 'mupdf';
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import {
  OcrPdfWriterProofError,
  inspectPdfModificationPolicy,
  inspectOwnedInvisibleOcrLayer,
  reconcileOwnedInvisibleOcrLayer,
  removeOwnedInvisibleOcrLayer,
  writeOwnedInvisibleOcrLayer,
} from './pdf-writer-proof.js';
import { createOcrWriterProofFixture } from '../../scripts/ocr-pdf-writer-proof-fixture.mjs';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function extractedPages(bytes) {
  const document = await pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const content = await (await document.getPage(pageNumber)).getTextContent();
      pages.push(content.items.map((item) => item.str).filter(Boolean));
    }
    return pages;
  } finally {
    await document.destroy();
  }
}

function writerInput(fixture, pdfBytes, pages = fixture.pages) {
  return {
    pdfBytes,
    fontBytes: fixture.fontBytes,
    fontSha256: fixture.fontSha256,
    pages,
    modifiedAt: fixture.modifiedAt,
  };
}

async function expectProofError(code, action) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof OcrPdfWriterProofError);
    assert.equal(error.code, code);
    return true;
  });
}

function addWordGeometry(line) {
  const words = line.text.split(/\s+/u);
  const minX = Math.min(...line.polygon.points.map((point) => point.x));
  const maxX = Math.max(...line.polygon.points.map((point) => point.x));
  const minY = Math.min(...line.polygon.points.map((point) => point.y));
  const maxY = Math.max(...line.polygon.points.map((point) => point.y));
  const totalUnits = words.reduce((sum, word) => sum + word.length, 0) + words.length - 1;
  let cursor = 0;
  return {
    ...line,
    words: words.map((word, index) => {
      const start = cursor / totalUnits;
      cursor += word.length;
      const end = cursor / totalUnits;
      cursor += index < words.length - 1 ? 1 : 0;
      const left = minX + (maxX - minX) * start;
      const right = minX + (maxX - minX) * end;
      return {
        id: `${line.id}-word-${index + 1}`,
        text: word,
        direction: 'ltr',
        polygon: {
          coordinateSpace: line.polygon.coordinateSpace,
          points: [
            { x: left, y: minY },
            { x: right, y: minY },
            { x: right, y: maxY },
            { x: left, y: maxY },
          ],
        },
      };
    }),
  };
}

test('writes, replaces, and removes only one owned invisible Unicode stream per OCR page', async () => {
  const fixture = await createOcrWriterProofFixture();
  const sourceDigest = digest(fixture.baselineBytes);
  const baselineInspection = await inspectOwnedInvisibleOcrLayer(fixture.baselineBytes);
  const baselineText = await extractedPages(fixture.baselineBytes);

  const written = await writeOwnedInvisibleOcrLayer(writerInput(fixture, fixture.baselineBytes));
  assert.equal(digest(fixture.baselineBytes), sourceDigest, 'source input must not be mutated');
  const firstInspection = await inspectOwnedInvisibleOcrLayer(written);
  assert.equal(new Set(firstInspection.map((page) => page.fontRef)).size, 1, 'pages must share one owned Type 0 font');
  for (const [pageIndex, page] of firstInspection.entries()) {
    assert.equal(page.owned, true);
    assert.equal(page.renderingMode3Count, 1);
    assert.equal(page.textMatrixCount, fixture.pages[pageIndex].lines.length);
    assert.equal(page.showTextCount, fixture.pages[pageIndex].lines.length);
    assert.equal(page.fontSubtype, 'Type0');
    assert.equal(page.descendantSubtype, 'CIDFontType2');
    assert.ok(page.toUnicodeBlockSizes.every((size) => size <= 100));
    assert.deepEqual(page.contentRefs.slice(0, -1), baselineInspection[pageIndex].contentRefs);
    assert.equal(page.contentRefs.length, baselineInspection[pageIndex].contentRefs.length + 1);
  }

  const writtenText = await extractedPages(written);
  for (const [pageIndex, pageText] of writtenText.entries()) {
    assert.deepEqual(pageText, [fixture.thirdPartyText[pageIndex], ...fixture.pages[pageIndex].lines.map((line) => line.text)]);
  }

  const repeated = await writeOwnedInvisibleOcrLayer(writerInput(fixture, written));
  const repeatedInspection = await inspectOwnedInvisibleOcrLayer(repeated);
  for (const [pageIndex, page] of repeatedInspection.entries()) {
    assert.equal(page.contentRefs.length, baselineInspection[pageIndex].contentRefs.length + 1);
    assert.deepEqual(page.contentRefs.slice(0, -1), baselineInspection[pageIndex].contentRefs);
  }
  assert.deepEqual(await extractedPages(repeated), writtenText, 'repeat write must not duplicate extracted text');

  const removed = await removeOwnedInvisibleOcrLayer({ pdfBytes: repeated });
  assert.deepEqual(await extractedPages(removed), baselineText, 'removal must restore pre-write searchable text');
  const removedInspection = await inspectOwnedInvisibleOcrLayer(removed);
  for (const [pageIndex, page] of removedInspection.entries()) {
    assert.equal(page.owned, false);
    assert.deepEqual(page.contentRefs, baselineInspection[pageIndex].contentRefs);
  }
});

test('rejects missing baselines, malformed geometry, malformed fonts, and missing glyphs before returning output', async () => {
  const fixture = await createOcrWriterProofFixture();

  const missingBaseline = structuredClone(fixture.pages);
  missingBaseline[0].lines[0].baseline.status = 'unavailable';
  await expectProofError('MISSING_CANONICAL_BASELINE', () => writeOwnedInvisibleOcrLayer(
    writerInput(fixture, fixture.baselineBytes, missingBaseline),
  ));

  const malformedGeometry = structuredClone(fixture.pages);
  malformedGeometry[0].lines[0].polygon.points[0].x = Number.NaN;
  await expectProofError('INVALID_GEOMETRY', () => writeOwnedInvisibleOcrLayer(
    writerInput(fixture, fixture.baselineBytes, malformedGeometry),
  ));

  const malformedFont = Uint8Array.of(0, 1, 2, 3, 4, 5);
  await expectProofError('MALFORMED_FONT', () => writeOwnedInvisibleOcrLayer({
    ...writerInput(fixture, fixture.baselineBytes),
    fontBytes: malformedFont,
    fontSha256: digest(malformedFont),
  }));

  const missingGlyph = structuredClone(fixture.pages);
  missingGlyph[0].lines[0].text = 'Unsupported glyph: 😀';
  await expectProofError('MISSING_GLYPH', () => writeOwnedInvisibleOcrLayer(
    writerInput(fixture, fixture.baselineBytes, missingGlyph),
  ));
});

test('fails closed when private ownership metadata is spoofed', async () => {
  const fixture = await createOcrWriterProofFixture();
  const written = await writeOwnedInvisibleOcrLayer(writerInput(fixture, fixture.baselineBytes));
  const tamperedDoc = await PDFDocument.load(written, { updateMetadata: false });
  const page = tamperedDoc.getPage(0);
  const pieceInfo = page.node.lookup(PDFName.of('PieceInfo'), PDFDict);
  const vendor = pieceInfo.lookup(PDFName.of('OpenPDFStudioOCR'), PDFDict);
  const privateDict = vendor.lookup(PDFName.of('Private'), PDFDict);
  privateDict.set(PDFName.of('ContentDigest'), PDFString.of('0'.repeat(64)));
  const tampered = await tamperedDoc.save({ useObjectStreams: true, updateFieldAppearances: false });

  await expectProofError('MALFORMED_OWNERSHIP', () => removeOwnedInvisibleOcrLayer({ pdfBytes: tampered }));
  await expectProofError('MALFORMED_OWNERSHIP', () => writeOwnedInvisibleOcrLayer(writerInput(fixture, tampered)));
});

test('uses optional word geometry without changing line order and rejects unsupported directions', async () => {
  const fixture = await createOcrWriterProofFixture();
  const pages = structuredClone(fixture.pages);
  pages[0].lines[0] = addWordGeometry(pages[0].lines[0]);
  const written = await writeOwnedInvisibleOcrLayer(writerInput(fixture, fixture.baselineBytes, pages));
  const inspection = await inspectOwnedInvisibleOcrLayer(written);
  const expectedPlacements = pages[0].lines.reduce(
    (sum, line) => sum + (line.words?.length || 1),
    0,
  );
  assert.equal(inspection[0].textMatrixCount, expectedPlacements);
  assert.equal(inspection[0].showTextCount, expectedPlacements);
  const extracted = await extractedPages(written);
  const copyText = extracted[0].join('\n');
  let wordOffset = 0;
  for (const word of pages[0].lines[0].words) {
    const nextOffset = copyText.indexOf(word.text, wordOffset);
    assert.ok(nextOffset >= wordOffset, `word ${word.id} must remain in declared reading order`);
    wordOffset = nextOffset + word.text.length;
  }

  const unsupported = structuredClone(pages);
  unsupported[0].lines[0].words[0].direction = 'rtl';
  await expectProofError('UNSUPPORTED_TEXT_DIRECTION', () => writeOwnedInvisibleOcrLayer(
    writerInput(fixture, fixture.baselineBytes, unsupported),
  ));

  const inferredRtl = structuredClone(fixture.pages);
  inferredRtl[0].lines[0].text = 'שלום';
  await expectProofError('UNSUPPORTED_TEXT_DIRECTION', () => writeOwnedInvisibleOcrLayer(
    writerInput(fixture, fixture.baselineBytes, inferredRtl),
  ));
});

test('reconciliation preserves unrelated owned pages and removes only explicit targets', async () => {
  const fixture = await createOcrWriterProofFixture();
  const initial = await writeOwnedInvisibleOcrLayer(writerInput(fixture, fixture.baselineBytes));
  const pageZeroOnly = structuredClone(fixture.pages.slice(0, 1));
  pageZeroOnly[0].lines[0].text = 'Updated searchable line';
  const updated = await reconcileOwnedInvisibleOcrLayer({
    ...writerInput(fixture, initial, pageZeroOnly),
    removePageIndexes: [],
  });
  assert.deepEqual((await inspectOwnedInvisibleOcrLayer(updated)).map((page) => page.owned),
    fixture.pages.map(() => true));

  const removedSecond = await reconcileOwnedInvisibleOcrLayer({
    ...writerInput(fixture, updated, pageZeroOnly),
    removePageIndexes: [1],
  });
  assert.deepEqual((await inspectOwnedInvisibleOcrLayer(removedSecond)).map((page) => page.owned),
    fixture.pages.map((_, pageIndex) => pageIndex !== 1));
  const text = await extractedPages(removedSecond);
  assert.equal(text[0].includes('Updated searchable line'), true);
  assert.deepEqual(text[1], [fixture.thirdPartyText[1]]);
});

test('detects signed PDFs and rejects malformed documents before mutation', async () => {
  const fixture = await createOcrWriterProofFixture();
  const signedDocument = await PDFDocument.load(fixture.baselineBytes, { updateMetadata: false });
  const context = signedDocument.context;
  const signature = context.obj({
    Type: 'Sig',
    ByteRange: [0, 10, 20, 30],
    Contents: PDFString.of('proof-signature-bytes'),
  });
  const signatureField = context.obj({ FT: 'Sig', T: PDFString.of('ApprovedSignature'), V: context.register(signature) });
  signedDocument.catalog.set(PDFName.of('AcroForm'), context.obj({ Fields: [context.register(signatureField)] }));
  const signedBytes = await signedDocument.save({ useObjectStreams: true, updateFieldAppearances: false });
  assert.deepEqual(await inspectPdfModificationPolicy(signedBytes), { signed: true, signatureCount: 1 });
  assert.deepEqual(await inspectPdfModificationPolicy(fixture.baselineBytes), { signed: false, signatureCount: 0 });

  await expectProofError('MALFORMED_PDF', () => inspectPdfModificationPolicy(Uint8Array.of(1, 2, 3, 4)));
});

test('rejects a genuinely encrypted PDF with an explicit policy error', async () => {
  const fixture = await createOcrWriterProofFixture();
  const source = mupdf.Document.openDocument(fixture.baselineBytes, 'application/pdf');
  const encrypted = source.saveToBuffer(
    'encrypt=aes-256,user-password=reader,owner-password=owner',
  ).asUint8Array();
  await expectProofError('ENCRYPTED_PDF_UNSUPPORTED', () => inspectPdfModificationPolicy(encrypted));
  await expectProofError('ENCRYPTED_PDF_UNSUPPORTED', () => writeOwnedInvisibleOcrLayer(
    writerInput(fixture, encrypted),
  ));
});
