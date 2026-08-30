import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canAutoSaveCommittedTextEdit,
  canSkipUnmodifiedSamePathSave,
  committedTextSaveFailureMayNotify,
  documentHasPendingPersistence,
  documentLifecycleOwnerMatches,
  textEditCommitAllowsSave,
} from './save-state.js';
import { createTextApplyResult } from '../text/text-apply-result.js';

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
    return createTextApplyResult({
      status: 'rejected', documentId: 'doc-a', pageNum: 1,
      rejectionCode: 'TEXT_LAYOUT_WIDTH_CAPACITY', recoveryActions: ['keep-editing'],
    });
  }), false);
  assert.deepEqual(calls, [['doc-a', 'save']]);
  assert.equal(await textEditCommitAllowsSave(documentState, 'save-as', async (...args) => {
    calls.push(args);
    return createTextApplyResult({ status: 'noop', documentId: 'doc-a', pageNum: 1 });
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

test('background text-save failure notifies only its current document lifecycle owner', () => {
  const owner = { id: 'doc-a', lifecycleGeneration: 7 };
  const failure = { status: 'failed', errorMessage: 'disk full' };
  assert.equal(committedTextSaveFailureMayNotify(owner, { ...owner }, failure), true);
  assert.equal(committedTextSaveFailureMayNotify(
    owner,
    { id: 'doc-b', lifecycleGeneration: 7 },
    failure,
  ), false, 'a stale document must not block the current editor with its save failure');
  assert.equal(committedTextSaveFailureMayNotify(
    owner,
    { id: 'doc-a', lifecycleGeneration: 8 },
    failure,
  ), false, 'a stale lifecycle must not block its replacement');
  assert.equal(committedTextSaveFailureMayNotify(owner, { ...owner }, { status: 'saved' }), false);
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

test('untitled click-away persistence restores nonblocking Save As status', async () => {
  const [saverSource, overlaySource] = await Promise.all([
    readFile(new URL('./saver.js', import.meta.url), 'utf8'),
    readFile(new URL('../solid/components/PdfTextEditOverlay.jsx', import.meta.url), 'utf8'),
  ]);
  const scheduleSource = saverSource.slice(
    saverSource.indexOf('export function scheduleCommittedTextEditSave'),
    saverSource.indexOf('\n// Save PDF with annotations'),
  );
  const observerSource = overlaySource.slice(
    overlaySource.indexOf('async function observeCommittedTextPersistence'),
    overlaySource.indexOf('\nexport default function PdfTextEditOverlay'),
  );

  assert.match(scheduleSource, /markDocumentSaveAsRequired\(owner\)/u);
  assert.match(scheduleSource, /ownerSaveResult\(owner, 'save-as-required'/u);
  assert.match(observerSource, /committedTextSaveFailureMayNotify/u);
  assert.doesNotMatch(observerSource, /result\?\.status === 'save-as-required'/u,
    'Save As guidance belongs in the document status UI, not a canvas-blocking modal');
});

test('asynchronous save failures cannot publish blocking UI for a stale document owner', async () => {
  const source = await readFile(new URL('./saver.js', import.meta.url), 'utf8');
  const refreshMessage = 'The PDF was saved, but the in-app document refresh failed:';
  const refreshMessageIndex = source.indexOf(refreshMessage);
  assert.notEqual(refreshMessageIndex, -1);
  const guardedRefreshMessage = source.slice(refreshMessageIndex - 180, refreshMessageIndex + 180);
  assert.match(guardedRefreshMessage,
    /documentLifecycleOwnerMatches\(activeDoc, getActiveDocument\(\)\)/u);

  const coordinatedFailureIndex = source.indexOf("console.warn('[saver] Coordinated save failed:'");
  assert.notEqual(coordinatedFailureIndex, -1);
  const guardedCoordinatorFailure = source.slice(coordinatedFailureIndex, coordinatedFailureIndex + 420);
  assert.match(guardedCoordinatorFailure,
    /documentLifecycleOwnerMatches\(owner, getActiveDocument\(\)\)/u);
});

test('automatic save admission defers while a page edit intent is awaiting readiness', async () => {
  const source = await readFile(new URL('./saver.js', import.meta.url), 'utf8');
  assert.match(source, /pageEditIntentPendingForDocument\(documentId\)/u);
  assert.match(source, /reason: 'pending-page-edit-intent'/u);
});
