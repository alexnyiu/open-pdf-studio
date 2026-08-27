import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeTextAnnotationDraft,
  applyExistingTextAnnotationDraft,
  applyTextAnnotationDraft,
  cleanTextAnnotationApplyIsNoop,
  discardTextAnnotationDraft,
  isolateTextAnnotationDraft,
  isActiveTextAnnotationDraft,
  recordAnnotationMutationOutsideTextDraft,
} from './annotation-text-draft.js';

function owner() {
  return {
    id: 'owner-a',
    annotations: [],
    selectedAnnotations: [],
    selectedAnnotation: null,
  };
}

test('existing annotation edits are isolated while new detached drafts retain identity', () => {
  const annotation = { id: 'draft-source', type: 'textbox', fillColor: '#ffffff' };
  const existingDraft = isolateTextAnnotationDraft(annotation);
  const newDraft = isolateTextAnnotationDraft(annotation, { isNew: true });

  assert.notEqual(existingDraft, annotation);
  existingDraft.fillColor = '#ff0000';
  assert.equal(annotation.fillColor, '#ffffff');
  assert.equal(newDraft, annotation);
});

test('reply changes on an active isolated draft stay inside one Apply or Cancel transaction', () => {
  const source = {
    id: 'reply-source',
    type: 'textbox',
    text: 'Body',
    replies: [{ id: 'reply-1', text: 'Before' }],
  };
  const editingState = { isEditingText: true };
  const cancelledDraft = isolateTextAnnotationDraft(source);
  editingState.editingAnnotation = cancelledDraft;
  let immediateUndoCount = 0;

  cancelledDraft.replies.push({ id: 'reply-2', text: 'Discard me' });
  recordAnnotationMutationOutsideTextDraft({
    annotation: cancelledDraft,
    before: source,
    editingState,
    record: () => { immediateUndoCount += 1; },
  });
  assert.equal(immediateUndoCount, 0);
  assert.equal(source.replies.length, 1, 'Cancel leaves the immutable source unchanged');

  const appliedDraft = isolateTextAnnotationDraft(source);
  editingState.editingAnnotation = appliedDraft;
  appliedDraft.replies.splice(0, 1);
  recordAnnotationMutationOutsideTextDraft({
    annotation: appliedDraft,
    before: source,
    editingState,
    record: () => { immediateUndoCount += 1; },
  });
  assert.equal(immediateUndoCount, 0);

  assert.equal(applyExistingTextAnnotationDraft({
    annotation: source,
    draft: appliedDraft,
    record: () => {
      immediateUndoCount += 1;
      return true;
    },
  }), true);
  assert.equal(immediateUndoCount, 1, 'dirty Apply emits exactly one owner command');
  assert.deepEqual(source.replies, []);
});

test('reply changes outside an active textbox/callout draft remain immediate', () => {
  const annotation = { id: 'reply-normal', type: 'comment' };
  assert.equal(isActiveTextAnnotationDraft(annotation, {
    isEditingText: false,
    editingAnnotation: annotation,
  }), false);
  assert.equal(isActiveTextAnnotationDraft(annotation, {
    isEditingText: true,
    editingAnnotation: annotation,
  }), false);
  let immediateUndoCount = 0;
  assert.equal(recordAnnotationMutationOutsideTextDraft({
    annotation,
    before: { ...annotation },
    editingState: { isEditingText: false, editingAnnotation: null },
    record: () => { immediateUndoCount += 1; },
  }), true);
  assert.equal(immediateUndoCount, 1);
});

test('active text draft remains authoritative after the panel republishes its source', () => {
  const source = { id: 'source-panel-refresh', type: 'textbox', textAlign: 'left' };
  const draft = isolateTextAnnotationDraft(source);
  const editingState = {
    isEditingText: true,
    editingAnnotation: draft,
  };
  const stalePanelAnnotation = source;

  assert.equal(activeTextAnnotationDraft(editingState), draft);
  assert.notEqual(activeTextAnnotationDraft(editingState), stalePanelAnnotation);
  assert.equal(activeTextAnnotationDraft({
    isEditingText: false,
    editingAnnotation: draft,
  }), null);
});

test('only an untouched existing annotation may close through clean Apply', () => {
  assert.equal(cleanTextAnnotationApplyIsNoop({ isNew: false, isDirty: false }), true);
  assert.equal(cleanTextAnnotationApplyIsNoop({ isNew: true, isDirty: false }), false);
  assert.equal(cleanTextAnnotationApplyIsNoop({ isNew: false, isDirty: true }), false);
});

test('existing draft Apply publishes immediately with one reversible record', () => {
  const annotation = { id: 'existing-1', type: 'textbox', text: 'Before', fillColor: '#ffffff' };
  const draft = isolateTextAnnotationDraft(annotation);
  draft.text = 'After';
  draft.fillColor = '#ffeeaa';
  const records = [];

  assert.equal(applyExistingTextAnnotationDraft({
    annotation,
    draft,
    record(command) { records.push(command); return true; },
  }), true);
  assert.equal(annotation.text, 'After');
  assert.equal(annotation.fillColor, '#ffeeaa');
  assert.equal(records.length, 1);
  assert.equal(records[0].oldState.text, 'Before');
  assert.equal(records[0].newState.text, 'After');

  Object.assign(annotation, structuredClone(records[0].oldState));
  assert.equal(annotation.text, 'Before');
  Object.assign(annotation, structuredClone(records[0].newState));
  assert.equal(annotation.text, 'After');
});

test('failed existing-draft recording restores the source atomically', () => {
  const annotation = { id: 'existing-2', type: 'callout', text: 'Before' };
  const draft = isolateTextAnnotationDraft(annotation);
  draft.text = 'Untracked';
  assert.equal(applyExistingTextAnnotationDraft({
    annotation,
    draft,
    record: () => false,
  }), false);
  assert.deepEqual(annotation, { id: 'existing-2', type: 'callout', text: 'Before' });

  assert.equal(applyExistingTextAnnotationDraft({
    annotation,
    draft,
    record: () => { throw new Error('undo recorder unavailable'); },
  }), false);
  assert.deepEqual(annotation, { id: 'existing-2', type: 'callout', text: 'Before' });
});

test('new annotation remains detached until Apply and is recorded exactly once', () => {
  const documentState = owner();
  const annotation = { id: 'draft-1', type: 'callout' };
  let recordCount = 0;
  let flushedWhileDetached = false;

  assert.equal(documentState.annotations.length, 0);
  const applied = applyTextAnnotationDraft({
    ownerDocument: documentState,
    annotation,
    beforeAttach() {
      flushedWhileDetached = documentState.annotations.length === 0;
    },
    record(value) {
      recordCount += 1;
      assert.equal(documentState.annotations[0], value);
      return true;
    },
  });

  assert.equal(applied, true);
  assert.equal(flushedWhileDetached, true);
  assert.deepEqual(documentState.annotations, [annotation]);
  assert.equal(recordCount, 1);

  assert.equal(applyTextAnnotationDraft({
    ownerDocument: documentState,
    annotation,
    record() { recordCount += 1; return true; },
  }), false);
  assert.equal(recordCount, 1);
  assert.deepEqual(documentState.annotations, [annotation]);
});

test('Cancel discards selection without adding content or undo work', () => {
  const documentState = owner();
  const annotation = { id: 'draft-2', type: 'textbox' };
  documentState.selectedAnnotations = [annotation];
  documentState.selectedAnnotation = annotation;

  assert.equal(discardTextAnnotationDraft(documentState, annotation), false);
  assert.deepEqual(documentState.annotations, []);
  assert.deepEqual(documentState.selectedAnnotations, []);
  assert.equal(documentState.selectedAnnotation, null);
});

test('failed add recording rolls attachment back and never deletes same-id content', () => {
  const documentState = owner();
  const annotation = { id: 'draft-3', type: 'callout' };

  assert.equal(applyTextAnnotationDraft({
    ownerDocument: documentState,
    annotation,
    record: () => false,
  }), false);
  assert.deepEqual(documentState.annotations, []);

  assert.equal(applyTextAnnotationDraft({
    ownerDocument: documentState,
    annotation,
    record: () => { throw new Error('undo recorder unavailable'); },
  }), false);
  assert.deepEqual(documentState.annotations, []);

  const persisted = { ...annotation };
  documentState.annotations.push(persisted);
  assert.equal(discardTextAnnotationDraft(documentState, annotation), false);
  assert.deepEqual(documentState.annotations, [persisted]);
});
