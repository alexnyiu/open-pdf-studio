import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';

import {
  createTextEditRecordV2,
  richTextFromPlainText,
} from './rich-text.js';
import {
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
