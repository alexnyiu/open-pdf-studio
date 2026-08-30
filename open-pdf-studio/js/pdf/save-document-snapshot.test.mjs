import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';

import { createInitialDocumentRevisionState } from '../core/document-revision-state.runtime.js';
import {
  createSaveDocumentSnapshot,
  saveDocumentSnapshotOwns,
} from './save-document-snapshot.js';
import { saveBookmarksToOutline } from './saver/bookmarks.js';
import { saveStylePresetsToCatalog } from './saver/style-presets.js';
import {
  captureFormPersistenceState,
  formFieldNameMapForDocument,
  resetFormPersistenceState,
} from './form-persistence-state.js';

const OWNER_SCOPED_SERIALIZERS = [
  './saver/text-edits.js',
  './saver/watermarks.js',
  './saver/bookmarks.js',
  './saver/style-presets.js',
];

test('owner-scoped serializers cannot escape to active-tab or shared DOM state', async () => {
  const forbidden = [
    /\bgetActiveDocument\b/u,
    /state\.activeDocumentIndex/u,
    /\bgetPageRotation\s*\(/u,
    /document\.querySelector/u,
    /window\.__pdfViewport/u,
  ];
  for (const relativePath of OWNER_SCOPED_SERIALIZERS) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${relativePath} violates owner-pure serialization`);
    }
  }
});

function owner(id = 'doc-a') {
  const revisionState = createInitialDocumentRevisionState();
  revisionState.contentRevision = 4;
  revisionState.pendingChangedPages = [3, 1, 3];
  return {
    id,
    lifecycleGeneration: 7,
    filePath: `/tmp/${id}.pdf`,
    fileName: `${id}.pdf`,
    pdfDoc: { numPages: 8, getPage() { throw new Error('proxy escaped'); } },
    revisionState,
    pageRotations: { 1: 90 },
    annotations: [{ id: `${id}-annotation`, page: 1, type: 'rectangle' }],
    textEdits: [],
    textEditManifest: null,
    metadata: { title: id },
    watermarks: [],
    bookmarks: [{ id: `${id}-bookmark`, page: 1 }],
    stylePresets: [],
    ocr: { dirty: false, pages: {} },
    scannedTextEdits: null,
    scannedTextEditPersistedRevision: 0,
    scannedTextEditRemovalPending: false,
    pdfaCompliance: null,
  };
}

test('snapshot is immutable, owner-bound, and detached from later tab mutations', () => {
  const documentState = owner();
  const snapshot = createSaveDocumentSnapshot({
    documentState,
    outputPath: '/tmp/doc-a-output.pdf',
    requestedRevision: 4,
    expectedDocumentGeneration: 7,
    capturedAt: '2026-08-29T12:00:00.000Z',
    formState: {
      fields: [{ annotationId: 'field-a', fieldName: 'OwnerA', storedValue: { value: 'A' } }],
    },
  });
  documentState.annotations[0].id = 'doc-b-annotation';
  documentState.pageRotations[1] = 180;
  assert.equal(snapshot.annotations[0].id, 'doc-a-annotation');
  assert.equal(snapshot.pageRotations[1], 90);
  assert.deepEqual(snapshot.changedPages, [1, 3]);
  assert.equal(snapshot.formState.fields[0].storedValue.value, 'A');
  assert.equal(snapshot.pdfDoc, undefined);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.annotations[0]), true);
  assert.equal(saveDocumentSnapshotOwns(snapshot, documentState), true);
});

test('snapshot capture rejects a stale lifecycle or requested revision', () => {
  const documentState = owner();
  assert.throws(() => createSaveDocumentSnapshot({
    documentState,
    outputPath: '/tmp/output.pdf',
    requestedRevision: 4,
    expectedDocumentGeneration: 6,
  }), { code: 'SAVE_SNAPSHOT_STALE_OWNER' });
  assert.throws(() => createSaveDocumentSnapshot({
    documentState,
    outputPath: '/tmp/output.pdf',
    requestedRevision: 3,
    expectedDocumentGeneration: 7,
  }), { code: 'SAVE_SNAPSHOT_STALE_REVISION' });
});

test('the same owner snapshot produces identical catalog bytes regardless of later state', async () => {
  const documentState = owner();
  documentState.stylePresets = [{ id: 'owner-a-style', name: 'A', props: { width: 2 } }];
  const snapshot = createSaveDocumentSnapshot({
    documentState,
    outputPath: '/tmp/doc-a-output.pdf',
    requestedRevision: 4,
    capturedAt: '2026-08-29T12:00:00.000Z',
  });
  const source = await PDFDocument.create();
  source.addPage([612, 792]);
  source.setCreationDate(new Date('2026-08-29T12:00:00.000Z'));
  source.setModificationDate(new Date('2026-08-29T12:00:00.000Z'));
  const baseBytes = await source.save({ useObjectStreams: false });
  const serialize = async () => {
    const candidate = await PDFDocument.load(baseBytes, { updateMetadata: false });
    saveBookmarksToOutline(candidate, snapshot);
    saveStylePresetsToCatalog(candidate, snapshot);
    return candidate.save({ useObjectStreams: false });
  };
  const first = await serialize();
  documentState.bookmarks = [{ id: 'doc-b-bookmark', page: 1 }];
  documentState.stylePresets = [{ id: 'doc-b-style', name: 'B', props: { width: 99 } }];
  const second = await serialize();
  assert.deepEqual(second, first);
});

test('performSavePDF captures once before owner-pure serialization begins', async () => {
  const source = await readFile(new URL('./saver.js', import.meta.url), 'utf8');
  const start = source.indexOf('const saveSnapshot = createSaveDocumentSnapshot');
  const end = source.indexOf('const persistedOwner =', start);
  assert.ok(start > 0 && end > start, 'save snapshot serialization boundary is missing');
  const serialization = source.slice(start, end);
  assert.doesNotMatch(serialization, /\bgetActiveDocument\s*\(/u);
  assert.doesNotMatch(serialization, /\bgetPageRotation\s*\(/u);
  assert.match(serialization, /saveTextEditsToPages\([\s\S]*?saveSnapshot/u);
  assert.match(serialization, /saveWatermarksToPages\(pdfDocLib, pages, saveSnapshot\)/u);
  assert.match(serialization, /saveBookmarksToOutline\(pdfDocLib, saveSnapshot\)/u);
});

test('form persistence maps and values stay isolated by document owner', () => {
  const storage = (value) => ({
    size: 1,
    getRawValue: () => ({ value }),
  });
  const documentA = { id: 'doc-a', pdfDoc: { annotationStorage: storage('A') } };
  const documentB = { id: 'doc-b', pdfDoc: { annotationStorage: storage('B') } };
  formFieldNameMapForDocument(documentA, { create: true }).set('shared-id', 'OwnerA');
  formFieldNameMapForDocument(documentB, { create: true }).set('shared-id', 'OwnerB');
  assert.deepEqual(captureFormPersistenceState(documentA).fields, [{
    annotationId: 'shared-id',
    fieldName: 'OwnerA',
    storedValue: { value: 'A' },
  }]);
  assert.deepEqual(captureFormPersistenceState(documentB).fields, [{
    annotationId: 'shared-id',
    fieldName: 'OwnerB',
    storedValue: { value: 'B' },
  }]);
  resetFormPersistenceState(documentA);
  resetFormPersistenceState(documentB);
});
