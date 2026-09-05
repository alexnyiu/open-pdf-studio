import test from 'node:test';
import assert from 'node:assert/strict';
import { trimDocumentHistory } from './undo-history-budget.js';
const command = () => ({ type: 'pageStructure', oldBytes: new Uint8Array(1024), newBytes: new Uint8Array(1024) });
test('byte trimming retains newest commands and cannot mark unsaved revisions clean', () => {
  const commands = Array.from({ length: 6 }, command);
  const doc = { undoStack: [...commands], redoStack: [], savedUndoStackLength: 2,
    modified: true, revisionState: { contentRevision: 6, persistedRevision: 2 } };
  const budget = trimDocumentHistory(doc, { maxBytes: 5000 });
  assert.deepEqual(doc.undoStack, commands.slice(-2));
  assert.ok(budget.estimatedBytes <= 5000);
  assert.equal(doc.savedUndoStackLength, -1); assert.equal(doc.modified, true);
  assert.deepEqual(doc.revisionState, { contentRevision: 6, persistedRevision: 2 });
});
test('an oversized single command releases history but preserves current document content', () => {
  const doc = { undoStack: [command()], redoStack: [], savedUndoStackLength: 0,
    annotations: [{ text: 'unsaved content' }], modified: true };
  assert.equal(trimDocumentHistory(doc, { maxBytes: 100 }).latestChangeNotUndoable, true);
  assert.equal(doc.annotations[0].text, 'unsaved content'); assert.equal(doc.modified, true);
});
test('redo transfers preserve budget and count trimming preserves the saved position', () => {
  const commands = Array.from({ length: 4 }, command);
  const doc = { undoStack: commands.slice(0, 2), redoStack: commands.slice(2), savedUndoStackLength: 2 };
  const before = trimDocumentHistory(doc).estimatedBytes;
  doc.undoStack.push(doc.redoStack.pop());
  assert.equal(trimDocumentHistory(doc).estimatedBytes, before);
  trimDocumentHistory(doc, { maxCommands: 3 });
  assert.equal(doc.undoStack.length + doc.redoStack.length, 3);
  assert.equal(doc.savedUndoStackLength, 1);
});
