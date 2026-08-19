import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName } from 'pdf-lib';

// The production bundle supplies the browser DOMMatrix implementation. Text
// extraction in these Node tests does not use matrix methods, but the modern
// PDF.js module initializes one eagerly.
globalThis.DOMMatrix ||= class DOMMatrix {};

const {
  OcrPdfCandidateValidationError,
  buildAndValidateOcrPdfCandidate,
  destroyPreparedPdfJsDocument,
  validateOcrPdfiumCandidateResult,
} = await import('./pdf-persistence.js');
const {
  inspectOwnedInvisibleOcrLayer,
  writeOwnedInvisibleOcrLayer,
} = await import('./pdf-writer-proof.js');
const { createOcrWriterProofFixture } = await import('../../scripts/ocr-pdf-writer-proof-fixture.mjs');
const {
  applyOcrPageResult,
  beginOcrPageAttempt,
  createDocumentOcrState,
} = await import('./document-state.js');
const { fakePdfDocument, makeOcrFixture } = await import('./searchable-layer.test-fixtures.mjs');
const { stripPdfAMetadata } = await import('../pdf/saver/utils.js');
const { evaluatePdfModificationSavePolicy } = await import('../pdf/modification-save-policy.js');

function occurrences(text, token) {
  return text.split(token).length - 1;
}

function passingPdfiumResult(fixture, plan) {
  return {
    status: 'pass',
    baselinePageCount: fixture.pages.length,
    candidatePageCount: fixture.pages.length,
    renderScale: 2,
    maxChangedPixelsPerPage: 0,
    maxChannelDeltaTolerance: 0,
    pages: plan.selectedPageIndexes.map((pageIndex) => ({
      pageIndex,
      width: 200,
      height: 200,
      changedPixels: 0,
      maxChannelDelta: 0,
      baselineText: fixture.thirdPartyText[pageIndex],
      candidateText: [
        fixture.thirdPartyText[pageIndex],
        ...fixture.pages[pageIndex].lines.map((line) => line.text),
      ].join('\n'),
    })),
  };
}

test('production candidate validates PDF.js extraction, ownership, repeat write, removal, and PDFium result', async () => {
  const fixture = await createOcrWriterProofFixture();
  const result = await buildAndValidateOcrPdfCandidate({
    baseBytes: fixture.baselineBytes,
    fontBytes: fixture.fontBytes,
    writerPages: fixture.pages,
    expectedPageCount: fixture.pages.length,
    modifiedAt: fixture.modifiedAt,
  });
  try {
    assert.deepEqual(result.inspection.map((page) => page.owned), [true, true]);
    assert.deepEqual(result.pdfiumPlan.selectedPageIndexes, [0, 1]);
    assert.equal(validateOcrPdfiumCandidateResult(
      result.pdfiumPlan,
      passingPdfiumResult(fixture, result.pdfiumPlan),
    ), true);

    const duplicate = passingPdfiumResult(fixture, result.pdfiumPlan);
    const token = result.pdfiumPlan.tokensByPage[0][0].token;
    assert.equal(occurrences(duplicate.pages[0].candidateText, token), 1);
    duplicate.pages[0].candidateText += `\n${token}`;
    assert.throws(
      () => validateOcrPdfiumCandidateResult(result.pdfiumPlan, duplicate),
      (error) => error instanceof OcrPdfCandidateValidationError
        && error.code === 'PDFIUM_TOKEN_COUNT_MISMATCH',
    );

    const changedPixels = passingPdfiumResult(fixture, result.pdfiumPlan);
    changedPixels.pages[0].changedPixels = 1;
    assert.throws(
      () => validateOcrPdfiumCandidateResult(result.pdfiumPlan, changedPixels),
      (error) => error instanceof OcrPdfCandidateValidationError
        && error.code === 'VISIBLE_PIXEL_REGRESSION',
    );
  } finally {
    await destroyPreparedPdfJsDocument(result.candidatePdfJsDocument);
  }
});

test('candidate update preserves an owned page absent from current typed state and supports explicit removal', async () => {
  const fixture = await createOcrWriterProofFixture();
  const initial = await writeOwnedInvisibleOcrLayer({
    pdfBytes: fixture.baselineBytes,
    fontBytes: fixture.fontBytes,
    fontSha256: fixture.fontSha256,
    pages: fixture.pages,
    modifiedAt: fixture.modifiedAt,
  });
  const onePageState = structuredClone(fixture.pages.slice(0, 1));
  onePageState[0].lines[0].text = 'Updated after document reopen';

  const preserved = await buildAndValidateOcrPdfCandidate({
    baseBytes: initial,
    fontBytes: fixture.fontBytes,
    writerPages: onePageState,
    removePageIndexes: [],
    expectedPageCount: fixture.pages.length,
    modifiedAt: fixture.modifiedAt,
  });
  try {
    assert.deepEqual((await inspectOwnedInvisibleOcrLayer(preserved.candidateBytes))
      .map((page) => page.owned), [true, true]);
  } finally {
    await destroyPreparedPdfJsDocument(preserved.candidatePdfJsDocument);
  }

  const removed = await buildAndValidateOcrPdfCandidate({
    baseBytes: initial,
    fontBytes: fixture.fontBytes,
    writerPages: onePageState,
    removePageIndexes: [1],
    expectedPageCount: fixture.pages.length,
    modifiedAt: fixture.modifiedAt,
  });
  try {
    assert.deepEqual((await inspectOwnedInvisibleOcrLayer(removed.candidateBytes))
      .map((page) => page.owned), [true, false]);
  } finally {
    await destroyPreparedPdfJsDocument(removed.candidatePdfJsDocument);
  }
});

test('production candidate consumes canonical estimated baselines from typed OCR state', async () => {
  const sourceDocument = await PDFDocument.create();
  sourceDocument.addPage([612, 792]);
  const sourceBytes = await sourceDocument.save({ useObjectStreams: true });
  const pdfDoc = fakePdfDocument([]);
  const document = {
    id: 'production-writer-state',
    pdfDoc,
    modified: false,
    ocr: createDocumentOcrState('production-writer-state'),
  };
  const attempt = await beginOcrPageAttempt(document, 1);
  const fixture = makeOcrFixture({
    documentId: document.id,
    documentGeneration: attempt.token.documentGeneration,
    pageId: attempt.token.pageId,
    pageRevision: attempt.token.pageRevision,
  });
  assert.deepEqual(applyOcrPageResult(document, { ...fixture, token: attempt.token }), {
    applied: true,
    reason: null,
  });
  assert.equal(document.ocr.pages[1].recognition.result.lines[0].baseline.status, 'unavailable');
  assert.equal(document.ocr.pages[1].review.estimatedBaselines['line-1'].provenance, 'estimated');

  const approved = await createOcrWriterProofFixture();
  const result = await buildAndValidateOcrPdfCandidate({
    document,
    baseBytes: sourceBytes,
    fontBytes: approved.fontBytes,
    expectedPageCount: 1,
    modifiedAt: approved.modifiedAt,
  });
  try {
    assert.deepEqual(result.inspection.map((page) => page.owned), [true]);
    assert.equal(result.inspection[0].renderingMode3Count, 1);
    assert.equal(result.inspection[0].textMatrixCount, 2);
  } finally {
    await destroyPreparedPdfJsDocument(result.candidatePdfJsDocument);
  }
});

test('PDF/A conversion removes element and attribute conformance claims or fails closed', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([100, 100]);
  const xmp = `<?xpacket begin="﻿"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2">
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
  const metadata = pdf.context.flateStream(new TextEncoder().encode(xmp), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(metadata));

  assert.equal(stripPdfAMetadata(pdf), true);
  const replacement = pdf.context.lookup(pdf.catalog.get(PDFName.of('Metadata')));
  const converted = new TextDecoder().decode(replacement.getContents());
  assert.doesNotMatch(converted, /pdfaid:(?:part|conformance)\b/iu);
  assert.match(converted, /x:xmpmeta/u);

  const unsupported = await PDFDocument.create();
  unsupported.addPage([100, 100]);
  const ordinaryXmp = unsupported.context.stream(new TextEncoder().encode('<x:xmpmeta/>'), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  unsupported.catalog.set(PDFName.of('Metadata'), unsupported.context.register(ordinaryXmp));
  assert.throws(
    () => stripPdfAMetadata(unsupported),
    /no conformance markers were found/iu,
  );

  const missing = await PDFDocument.create();
  missing.addPage([100, 100]);
  assert.throws(
    () => stripPdfAMetadata(missing),
    /XMP metadata stream is missing/iu,
  );
});

test('signed and PDF/A modification policy forces a different Save As path with clear warnings', () => {
  const signed = evaluatePdfModificationSavePolicy({
    signed: true,
    pdfa: false,
    currentPath: '/tmp/original.pdf',
    outputPath: '/tmp/original.pdf',
    saveAsPath: null,
  });
  assert.equal(signed.forceSaveAs, true);
  assert.equal(signed.rejectOriginalPath, false);
  assert.match(signed.warning, /invalidates those signatures/iu);
  assert.match(signed.warning, /Save As/iu);

  const samePdfAPath = evaluatePdfModificationSavePolicy({
    signed: false,
    pdfa: true,
    currentPath: '/tmp/Café.pdf',
    outputPath: '/tmp/Cafe\u0301.pdf',
    saveAsPath: '/tmp/Cafe\u0301.pdf',
  });
  assert.equal(samePdfAPath.forceSaveAs, false);
  assert.equal(samePdfAPath.rejectOriginalPath, true);
  assert.match(samePdfAPath.warning, /converted to a standard PDF/iu);

  const safeCopy = evaluatePdfModificationSavePolicy({
    signed: true,
    pdfa: true,
    currentPath: '/tmp/original.pdf',
    outputPath: '/tmp/copy.pdf',
    saveAsPath: '/tmp/copy.pdf',
  });
  assert.equal(safeCopy.forceSaveAs, false);
  assert.equal(safeCopy.rejectOriginalPath, false);
  assert.match(safeCopy.warning, /signatures/iu);
  assert.match(safeCopy.warning, /PDF\/A/iu);
});
