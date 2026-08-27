import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSkipUnmodifiedSamePathSave,
  documentHasPendingPersistence,
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
