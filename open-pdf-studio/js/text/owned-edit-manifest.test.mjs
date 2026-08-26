import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';

import {
  createRichTextDocument,
  createTextLine,
  createTextEditRecordV2,
  createTextRun,
  richTextFromPlainText,
} from './rich-text.js';
import {
  hydrateOwnedTextEditManifest,
  readOwnedTextEditManifest,
  writeOwnedTextEditManifest,
} from './owned-edit-manifest.js';

function insertedRecord(id = 'inserted-edit') {
  const richText = richTextFromPlainText('Mixed', {
    faceId: 'liberation-serif-bold-italic',
    size: 14,
    color: '#123456',
    bold: true,
    italic: true,
    underline: true,
  }, {
    x: 24,
    y: 40,
    width: 120,
    height: 28,
    baseline: 56,
  });
  return createTextEditRecordV2({ id, page: 1, richText });
}

function manifestPrivateRef(document) {
  const pieceInfo = document.catalog.lookup(PDFName.of('PieceInfo'), PDFDict);
  const owner = pieceInfo.lookup(PDFName.of('OpenPDFStudioTextEdit'), PDFDict);
  const ref = owner.get(PDFName.of('Private'));
  assert.ok(ref instanceof PDFRef);
  return ref.toString();
}

test('owned V3 manifest survives reopen and replaces its private stream by identity', async () => {
  const document = await PDFDocument.create();
  document.addPage([300, 300]);
  const record = insertedRecord();

  const first = await writeOwnedTextEditManifest(document, 'document-1', [record]);
  assert.equal(first.version, 3);
  const firstRef = manifestPrivateRef(document);
  const firstBytes = await document.save({ useObjectStreams: false });

  const reopened = await PDFDocument.load(firstBytes);
  const loaded = await readOwnedTextEditManifest(reopened);
  assert.deepEqual(loaded, first);
  assert.equal(manifestPrivateRef(reopened), firstRef);

  const second = await writeOwnedTextEditManifest(
    reopened,
    loaded.documentId,
    loaded.pages.flatMap((page) => page.edits),
    loaded,
  );
  assert.equal(manifestPrivateRef(reopened), firstRef);
  assert.equal(second.pages.length, 1);
  assert.equal(second.pages[0].edits.length, 1);
  assert.equal(second.pages[0].edits[0].id, record.id);
  assert.equal(second.revision, first.revision);

  const repeated = await PDFDocument.load(await reopened.save({ useObjectStreams: false }));
  assert.equal(manifestPrivateRef(repeated), firstRef);
  assert.deepEqual(await readOwnedTextEditManifest(repeated), second);
});

test('owned manifest rejects native edits without exact operator provenance', async () => {
  const document = await PDFDocument.create();
  document.addPage([300, 300]);
  const record = insertedRecord('native-edit');
  record.original = structuredClone(record.richText);

  await assert.rejects(
    writeOwnedTextEditManifest(document, 'document-1', [record]),
    /trustworthy source provenance/u,
  );
});

test('native paragraph re-edit keeps one stable record and owned layer across reopen', async () => {
  const document = await PDFDocument.create();
  document.addPage([300, 300]);
  const record = insertedRecord('stable-native-paragraph');
  record.original = structuredClone(record.richText);
  record.sourceProvenance = [{
    schema: 'open-pdf-studio.native-text-source',
    version: 1,
    markerId: 'source-1',
    streamObjectId: '10 0 R',
    operatorIndex: 2,
    eligibility: { eligible: true },
  }];
  const originalProvenance = structuredClone(record.sourceProvenance);
  const originalLayerId = record.ownedLayerId;
  const first = await writeOwnedTextEditManifest(document, 'document-1', [record]);

  const reopened = await PDFDocument.load(await document.save({ useObjectStreams: false }));
  const hydrated = await readOwnedTextEditManifest(reopened);
  const hydratedRecord = hydrated.pages[0].edits[0];
  hydratedRecord.richText.lines[0].runs[0].text = 'Re-edited paragraph';
  hydratedRecord.revision += 1;
  const second = await writeOwnedTextEditManifest(reopened, hydrated.documentId, [hydratedRecord], hydrated);

  assert.equal(second.pages[0].edits.length, 1);
  assert.equal(second.pages[0].edits[0].id, record.id);
  assert.equal(second.pages[0].edits[0].ownedLayerId, originalLayerId);
  assert.deepEqual(second.pages[0].edits[0].sourceProvenance, originalProvenance);
  assert.equal(second.pages[0].edits[0].revision, 2);

  const repeated = await PDFDocument.load(await reopened.save({ useObjectStreams: false }));
  const finalManifest = await readOwnedTextEditManifest(repeated);
  assert.equal(finalManifest.pages[0].edits.length, 1);
  assert.equal(finalManifest.pages[0].edits[0].richText.lines[0].runs[0].text, 'Re-edited paragraph');
});

test('owned manifest preserves mixed run colors through reopen and repeated save', async () => {
  const document = await PDFDocument.create();
  document.addPage([300, 300]);
  const richText = createRichTextDocument([
    createTextLine([
      createTextRun('Black ', { faceId: 'liberation-sans-regular', size: 10, color: '#111111' }),
      createTextRun('Blue ', { faceId: 'liberation-sans-regular', size: 10, color: '#0057a8' }),
      createTextRun('Gray ', { faceId: 'liberation-sans-regular', size: 10, color: '#666666' }),
      createTextRun('Pale', { faceId: 'liberation-sans-regular', size: 10, color: '#f4f4f4' }),
    ], { baseline: 80, baselineAdvance: 12 }),
  ], { x: 20, y: 65, width: 180, height: 20 });
  const record = createTextEditRecordV2({ id: 'mixed-color-record', page: 1, richText });
  const expectedColors = ['#111111', '#0057a8', '#666666', '#f4f4f4'];

  await writeOwnedTextEditManifest(document, 'mixed-color-document', [record]);
  const reopened = await PDFDocument.load(await document.save({ useObjectStreams: false }));
  const first = await readOwnedTextEditManifest(reopened);
  assert.deepEqual(first.pages[0].edits[0].richText.lines[0].runs.map((run) => run.color), expectedColors);
  await writeOwnedTextEditManifest(reopened, first.documentId, first.pages[0].edits, first);
  const repeated = await PDFDocument.load(await reopened.save({ useObjectStreams: false }));
  const second = await readOwnedTextEditManifest(repeated);
  assert.deepEqual(second.pages[0].edits[0].richText.lines[0].runs.map((run) => run.color), expectedColors);
});

test('manifest hydration rejects an externally modified owned layer marker', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 300]);
  page.drawLine({ start: { x: 10, y: 10 }, end: { x: 20, y: 20 } });
  page.getContentStream().dict.set(
    PDFName.of('OPDSOwnedTextLayer'),
    PDFString.of('OpenPDFStudioTextEditPage-1'),
  );
  await writeOwnedTextEditManifest(document, 'document-1', [insertedRecord()]);
  const validBytes = await document.save({ useObjectStreams: false });
  const hydratedState = { textEdits: [] };
  await hydrateOwnedTextEditManifest(hydratedState, validBytes);
  assert.equal(hydratedState.textEdits.length, 1);

  const tampered = await PDFDocument.load(validBytes);
  const contents = tampered.getPage(0).node.lookup(PDFName.of('Contents'));
  const streams = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, index) => tampered.context.lookup(contents.get(index)))
    : [contents];
  for (const stream of streams) {
    if (stream instanceof PDFRawStream) {
      stream.dict.set(PDFName.of('OPDSOwnedTextLayer'), PDFString.of('ExternallyModifiedLayer'));
    }
  }
  await assert.rejects(
    hydrateOwnedTextEditManifest({}, await tampered.save({ useObjectStreams: false })),
    /layer marker is missing or externally modified/u,
  );
});
