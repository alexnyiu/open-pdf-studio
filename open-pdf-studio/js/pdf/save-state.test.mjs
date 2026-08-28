import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canAutoSaveCommittedTextEdit,
  canSkipUnmodifiedSamePathSave,
  documentHasPendingPersistence,
  documentLifecycleOwnerMatches,
  textEditCommitAllowsSave,
} from './save-state.js';

const cleanDocument = () => ({
  modified: false,
  isUntitled: false,
  saveTargetPath: null,
  ocr: { dirty: false },
  scannedTextEdits: { stateRevision: 3 },
  scannedTextEditPersistedRevision: 3,
  scannedTextEditRemovalPending: false,
});

test('unchanged same-path Save is a byte-preserving no-op', () => {
  assert.equal(canSkipUnmodifiedSamePathSave({
    documentState: cleanDocument(),
    currentPath: '/tmp/document.pdf',
    outputPath: '/tmp/document.pdf',
  }), true);
});

test('a coordinator-owned post-editor check may resolve a coherent Save as a no-op', () => {
  const documentState = {
    ...cleanDocument(),
    revisionState: {
      contentRevision: 3,
      serializedRevision: 3,
      persistedRevision: 3,
      livePdfRevision: 3,
      visibleRenderRevision: 3,
      visibleSemanticRevision: 3,
      visibleRequiredPages: [1],
      pageContentRevisions: { 1: 3 },
      pageRenderReadyRevisions: { 1: 3 },
      pageSemanticReadyRevisions: { 1: 3 },
      saveState: 'saving',
      activeSaveRequestId: 'save-1',
      lastPersistedPath: '/tmp/document.pdf',
      lastSaveError: null,
      lastSynchronizationError: null,
    },
  };
  const args = {
    documentState,
    currentPath: '/tmp/document.pdf',
    outputPath: '/tmp/document.pdf',
  };
  assert.equal(canSkipUnmodifiedSamePathSave(args), false,
    'an arbitrary caller cannot bypass an active save transaction');
  assert.equal(canSkipUnmodifiedSamePathSave({ ...args, coordinatorOwnsCheck: true }), true,
    'the owning coordinator may preserve bytes after its editor barrier');
  documentState.revisionState.contentRevision = 4;
  assert.equal(canSkipUnmodifiedSamePathSave({ ...args, coordinatorOwnsCheck: true }), false,
    'post-barrier content debt still requires serialization');
});

test('production Save enters the coordinator before evaluating the same-path no-op', async () => {
  const source = await readFile(new URL('./saver.js', import.meta.url), 'utf8');
  const publicSave = source.slice(
    source.indexOf('export async function savePDF'),
    source.indexOf('\nasync function performSavePDF'),
  );
  assert.match(publicSave, /saveCoordinator\.request/u);
  assert.doesNotMatch(publicSave, /canSkipUnmodifiedSamePathSave/u,
    'the editor barrier must run before the document can be declared unchanged');
});

test('F-01 disk-clean same-path Save cannot skip a stale live PDF revision', () => {
  const documentState = {
    ...cleanDocument(),
    revisionState: {
      contentRevision: 1,
      serializedRevision: 1,
      persistedRevision: 1,
      livePdfRevision: 0,
      visibleRenderRevision: 0,
      visibleSemanticRevision: 0,
      pageContentRevisions: { 1: 1 },
      pageRenderReadyRevisions: { 1: 0 },
      pageSemanticReadyRevisions: { 1: 0 },
      saveState: 'persisted',
      activeSaveRequestId: null,
      lastPersistedPath: '/tmp/document.pdf',
      lastSaveError: null,
      lastSynchronizationError: null,
    },
  };

  assert.equal(documentHasPendingPersistence(documentState), false,
    'the disk-dirty projection is intentionally clean after persistence');
  assert.equal(canSkipUnmodifiedSamePathSave({
    documentState,
    currentPath: '/tmp/document.pdf',
    outputPath: '/tmp/document.pdf',
  }), false, 'Save must service synchronization debt instead of returning a false no-op');
});

test('explicit Save As and pending targets always serialize', () => {
  assert.equal(canSkipUnmodifiedSamePathSave({
    documentState: cleanDocument(),
    currentPath: '/tmp/document.pdf',
    outputPath: '/tmp/copy.pdf',
    saveAsPath: '/tmp/copy.pdf',
  }), false);
  assert.equal(canSkipUnmodifiedSamePathSave({
    documentState: { ...cleanDocument(), saveTargetPath: '/tmp/copy.pdf' },
    currentPath: '/tmp/document.pdf',
    outputPath: '/tmp/copy.pdf',
  }), false);
});

test('ordinary, OCR, and scanned-text mutations block the no-op', () => {
  const cases = [
    { ...cleanDocument(), modified: true },
    { ...cleanDocument(), ocr: { dirty: true } },
    { ...cleanDocument(), scannedTextEditRemovalPending: true },
    { ...cleanDocument(), scannedTextEdits: { stateRevision: 4 } },
  ];
  for (const documentState of cases) {
    assert.equal(documentHasPendingPersistence(documentState), true);
    assert.equal(canSkipUnmodifiedSamePathSave({
      documentState,
      currentPath: '/tmp/document.pdf',
      outputPath: '/tmp/document.pdf',
    }), false);
  }
});

test('document-scoped text-edit commit is a mandatory save barrier', async () => {
  const calls = [];
  const documentState = { id: 'doc-a' };
  assert.equal(await textEditCommitAllowsSave(documentState, 'save', async (...args) => {
    calls.push(args);
    return false;
  }), false);
  assert.deepEqual(calls, [['doc-a', 'save']]);
  assert.equal(await textEditCommitAllowsSave(documentState, 'save-as', async (...args) => {
    calls.push(args);
    return true;
  }), true);
  assert.deepEqual(calls.at(-1), ['doc-a', 'save-as']);
  await assert.rejects(
    textEditCommitAllowsSave(documentState, 'save', null),
    /document-scoped text-edit commit barrier/u,
  );
});

test('save ownership survives a reactive proxy change but rejects stale lifecycles', () => {
  const owner = { id: 'doc-a', lifecycleGeneration: 7 };
  assert.equal(documentLifecycleOwnerMatches(owner, { ...owner }), true);
  assert.equal(documentLifecycleOwnerMatches(owner, { id: 'doc-b', lifecycleGeneration: 7 }), false);
  assert.equal(documentLifecycleOwnerMatches(owner, { id: 'doc-a', lifecycleGeneration: 8 }), false);
  assert.equal(documentLifecycleOwnerMatches(owner, null), false);
});

test('click-away auto-save is limited to normal file-backed PDF owners', () => {
  const fileBacked = {
    id: 'doc-a',
    filePath: '/Users/example/Documents/report.pdf',
    lifecycleGeneration: 4,
    isUntitled: false,
    _renderTemp: false,
    pdfaCompliance: null,
  };
  assert.equal(canAutoSaveCommittedTextEdit(fileBacked), true);
  assert.equal(canAutoSaveCommittedTextEdit({ ...fileBacked, filePath: '' }), false);
  assert.equal(canAutoSaveCommittedTextEdit({ ...fileBacked, isUntitled: true }), false);
  assert.equal(canAutoSaveCommittedTextEdit({ ...fileBacked, _renderTemp: true }), false);
  assert.equal(canAutoSaveCommittedTextEdit({
    ...fileBacked,
    filePath: '/private/tmp/open-pdf-studio-render.pdf',
    saveTargetPath: '/Users/example/Documents/report.pdf',
    _renderTemp: true,
  }), true, 'an owned render temp can auto-save to its normal original target');
  assert.equal(canAutoSaveCommittedTextEdit({ ...fileBacked, pdfaCompliance: 'PDF/A-2b' }), false);
  assert.equal(canAutoSaveCommittedTextEdit({
    ...fileBacked,
    filePath: 'C:\\Users\\Example\\INetCache\\Content.Outlook\\ABC\\report.pdf',
  }), false);
});
