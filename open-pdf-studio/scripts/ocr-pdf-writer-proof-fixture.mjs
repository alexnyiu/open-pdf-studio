import { readFile } from 'node:fs/promises';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
} from 'pdf-lib';

const FIXTURE_ROOT = new URL('../tests/fixtures/ocr/quality-v1/', import.meta.url);
const FIXTURE_IDS = ['punctuation-unicode', 'multiple-columns', 'dense-70-lines'];
export const APPROVED_FONT_URL = new URL('../public/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf', import.meta.url);
export const APPROVED_FONT_SHA256 = 'f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f';
export const THIRD_PARTY_TEXT = [
  'THIRD PARTY PAGE ONE',
  'THIRD PARTY PAGE TWO',
  'THIRD PARTY PAGE THREE',
];
const FIXED_MODIFIED_AT = 'D:20260817090000Z';
const FIXED_DOCUMENT_DATE = new Date('2026-08-17T09:00:00.000Z');

function pointFromRaster([x, y], input, origin = { x: 0, y: 0 }) {
  const scale = 72 / input.dpi;
  return {
    x: origin.x + x * scale,
    y: origin.y + (input.heightPx - y) * scale,
  };
}

function proofLines(fixture, origin) {
  const orderById = new Map(fixture.expected.readingOrder.map((id, index) => [id, index]));
  return fixture.expected.lines.map((line) => {
    const rasterPoints = line.polygon.points;
    const left = Math.min(...rasterPoints.map(([x]) => x));
    const right = Math.max(...rasterPoints.map(([x]) => x));
    const top = Math.min(...rasterPoints.map(([, y]) => y));
    const bottom = Math.max(...rasterPoints.map(([, y]) => y));
    // This is declared fixture geometry, not an OCR-engine fallback. The writer
    // receives it as canonical and refuses absent/non-provided baselines.
    const sourceBaselineY = top + (bottom - top) * 0.78;
    return {
      id: line.id,
      text: line.text,
      direction: 'ltr',
      readingOrder: orderById.get(line.id),
      polygon: {
        coordinateSpace: 'pdf-default-user-space',
        points: rasterPoints.map((point) => pointFromRaster(point, fixture.input, origin)),
      },
      baseline: {
        status: 'provided',
        provenance: 'approved-fixture-declared',
        coordinateSpace: 'pdf-default-user-space',
        start: pointFromRaster([left, sourceBaselineY], fixture.input, origin),
        end: pointFromRaster([right, sourceBaselineY], fixture.input, origin),
      },
    };
  });
}

function addThirdPartyPieceInfo(page, context, streamRef) {
  const privateDict = PDFDict.withContext(context);
  privateDict.set(PDFName.of('Owner'), PDFString.of('third-party-proof'));
  privateDict.set(PDFName.of('Stream'), streamRef);
  const vendor = PDFDict.withContext(context);
  vendor.set(PDFName.of('LastModified'), PDFString.of(FIXED_MODIFIED_AT));
  vendor.set(PDFName.of('Private'), privateDict);
  const pieceInfo = PDFDict.withContext(context);
  pieceInfo.set(PDFName.of('ThirdPartyProof'), vendor);
  page.node.set(PDFName.of('PieceInfo'), pieceInfo);
}

export async function createOcrWriterProofFixture() {
  const corpus = JSON.parse(await readFile(new URL('corpus.v1.json', FIXTURE_ROOT), 'utf8'));
  const fixtures = FIXTURE_IDS.map((id) => corpus.fixtures.find((fixture) => fixture.id === id));
  if (fixtures.some((fixture) => !fixture || fixture.classification !== 'supported')) {
    throw new Error('Approved OCR writer fixtures are missing or no longer classified supported');
  }

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setCreationDate(FIXED_DOCUMENT_DATE);
  pdfDoc.setModificationDate(FIXED_DOCUMENT_DATE);
  const thirdPartyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const thirdPartyStreamRefs = [];
  const pageOrigins = [];
  for (const [pageIndex, fixture] of fixtures.entries()) {
    const pageWidth = fixture.input.widthPx * 72 / fixture.input.dpi;
    const pageHeight = fixture.input.heightPx * 72 / fixture.input.dpi;
    const origin = fixture.id === 'dense-70-lines' ? { x: 24, y: 24 } : { x: 0, y: 0 };
    const page = pdfDoc.addPage([pageWidth + origin.x * 2, pageHeight + origin.y * 2]);
    page.setCropBox(origin.x, origin.y, pageWidth, pageHeight);
    pageOrigins.push(origin);
    const image = await pdfDoc.embedPng(await readFile(new URL(fixture.input.file, FIXTURE_ROOT)));
    page.drawImage(image, { x: origin.x, y: origin.y, width: pageWidth, height: pageHeight });

    const resourceName = page.node.newFontDictionary('ThirdPartyProof', thirdPartyFont.ref);
    const stream = pdfDoc.context.contentStream([
      pushGraphicsState(),
      beginText(),
      setFontAndSize(resourceName, 6),
      setTextRenderingMode(TextRenderingMode.Invisible),
      setTextMatrix(1, 0, 0, 1, origin.x + 8, origin.y + 8),
      showText(thirdPartyFont.encodeText(THIRD_PARTY_TEXT[pageIndex])),
      endText(),
      popGraphicsState(),
    ], {
      ThirdPartyOwner: PDFString.of('third-party-proof'),
    });
    const streamRef = pdfDoc.context.register(stream);
    page.node.addContentStream(streamRef);
    thirdPartyStreamRefs.push(streamRef.toString());
    addThirdPartyPieceInfo(page, pdfDoc.context, streamRef);
  }

  const baselineBytes = await pdfDoc.save({ useObjectStreams: true, updateFieldAppearances: false });
  return {
    baselineBytes,
    fontBytes: await readFile(APPROVED_FONT_URL),
    fontSha256: APPROVED_FONT_SHA256,
    modifiedAt: FIXED_MODIFIED_AT,
    pages: fixtures.map((fixture, pageIndex) => ({
      pageIndex,
      fixtureId: fixture.id,
      expectedText: fixture.expected.text,
      lines: proofLines(fixture, pageOrigins[pageIndex]),
    })),
    thirdPartyText: THIRD_PARTY_TEXT,
    thirdPartyStreamRefs,
  };
}
