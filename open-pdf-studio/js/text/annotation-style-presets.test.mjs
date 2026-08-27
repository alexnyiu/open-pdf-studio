import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyAnnotationStyle,
  captureAnnotationStyle,
  resolveAnnotationStyleActionTarget,
} from './annotation-style-presets.js';

function fixture() {
  const source = {
    id: 'textbox-1',
    type: 'textbox',
    page: 1,
    fillColor: '#ffffff',
    strokeColor: '#000000',
    opacity: 1,
    lineWidth: 1,
    borderStyle: 'solid',
  };
  const draft = structuredClone(source);
  const activeDocument = {
    id: 'document-1',
    lifecycleGeneration: 4,
    selectedAnnotations: [source],
    selectedAnnotation: source,
  };
  const editorState = { isEditingText: true, editingAnnotation: draft };
  const activeSession = {
    ownerDocumentId: activeDocument.id,
    ownerDocumentGeneration: activeDocument.lifecycleGeneration,
    pageNum: 1,
    kind: 'textbox',
  };
  return { source, draft, activeDocument, editorState, activeSession };
}

test('style actions prefer the owner-validated text draft over the persisted selection', () => {
  const context = fixture();
  const target = resolveAnnotationStyleActionTarget({
    ...context,
    sessionOwnerIsCurrent: true,
  });
  assert.equal(target.mode, 'text-draft');
  assert.equal(target.annotation, context.draft);
  assert.notEqual(target.annotation, context.source);
});

test('stale or foreign editor sessions fail closed instead of reaching persisted selection', () => {
  const context = fixture();
  for (const activeSession of [
    { ...context.activeSession, ownerDocumentId: 'document-2' },
    { ...context.activeSession, ownerDocumentGeneration: 3 },
    { ...context.activeSession, pageNum: 2 },
  ]) {
    const target = resolveAnnotationStyleActionTarget({
      ...context,
      activeSession,
      sessionOwnerIsCurrent: true,
    });
    assert.equal(target.mode, 'stale-text-draft');
    assert.equal(target.annotation, null);
  }

  const staleTarget = resolveAnnotationStyleActionTarget({
    ...context,
    sessionOwnerIsCurrent: false,
  });
  assert.equal(staleTarget.mode, 'stale-text-draft');
  assert.equal(staleTarget.annotation, null);
});

test('preset application and capture stay on the isolated live draft', () => {
  const { source, draft } = fixture();
  assert.equal(applyAnnotationStyle(draft, {
    fillColor: '#ffeeaa',
    strokeColor: '#2255cc',
    opacity: 65,
    lineWidth: 3,
    borderStyle: 'dashed',
  }), true);

  assert.deepEqual(source, {
    id: 'textbox-1',
    type: 'textbox',
    page: 1,
    fillColor: '#ffffff',
    strokeColor: '#000000',
    opacity: 1,
    lineWidth: 1,
    borderStyle: 'solid',
  });
  assert.deepEqual(captureAnnotationStyle(draft), {
    fillColor: '#ffeeaa',
    strokeColor: '#2255cc',
    opacity: 65,
    lineWidth: 3,
    borderStyle: 'dashed',
  });
  assert.equal(applyAnnotationStyle(draft, captureAnnotationStyle(draft)), false,
    'reapplying an identical preset is a clean draft no-op');
});

test('non-editor action resolution preserves selection and empty-panel behavior', () => {
  const context = fixture();
  const selected = resolveAnnotationStyleActionTarget({
    activeDocument: context.activeDocument,
    editorState: { isEditingText: false, editingAnnotation: null },
    activeSession: null,
    sessionOwnerIsCurrent: false,
  });
  assert.equal(selected.mode, 'selection');
  assert.equal(selected.annotation, context.source);

  const empty = resolveAnnotationStyleActionTarget({
    activeDocument: {
      id: 'document-1', lifecycleGeneration: 4,
      selectedAnnotations: [], selectedAnnotation: null,
    },
    editorState: { isEditingText: false, editingAnnotation: null },
  });
  assert.deepEqual(empty, { mode: 'none', annotation: null });
});
