import { estimateRetainedBytes } from './retained-value-size.js';
export const MAX_UNDO_COMMANDS = 100;
export const MAX_UNDO_RETAINED_BYTES = 128 * 1024 * 1024;
const commandBytes = new WeakMap();
function size(command) {
  if (!command || typeof command !== 'object') return 0;
  if (!commandBytes.has(command)) commandBytes.set(command, estimateRetainedBytes(command));
  return commandBytes.get(command);
}
/** Commands are immutable after recording. Trimming never changes save revisions. */
export function trimDocumentHistory(doc, { maxBytes = MAX_UNDO_RETAINED_BYTES, maxCommands = MAX_UNDO_COMMANDS } = {}) {
  const undo = doc.undoStack || [];
  const redo = doc.redoStack || [];
  let bytes = undo.reduce((sum, command) => sum + size(command), 0)
    + redo.reduce((sum, command) => sum + size(command), 0);
  let removed = 0;
  while (undo.length && (undo.length + redo.length > maxCommands || bytes > maxBytes)) {
    bytes -= size(undo.shift()); removed++;
    if (doc.savedUndoStackLength >= 0) doc.savedUndoStackLength = Math.max(-1, doc.savedUndoStackLength - 1);
  }
  // Redo is ordered farthest-to-nearest: remove only the farthest future.
  while (redo.length && (undo.length + redo.length > maxCommands || bytes > maxBytes)) {
    bytes -= size(redo.shift()); removed++;
    doc.savedUndoStackLength = -1;
  }
  doc.undoHistoryBudget = { estimatedBytes: bytes, maxBytes, removedCommands: removed,
    latestChangeNotUndoable: removed > 0 && undo.length === 0 && redo.length === 0 };
  return doc.undoHistoryBudget;
}
