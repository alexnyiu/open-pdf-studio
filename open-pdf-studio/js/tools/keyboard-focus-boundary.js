import { textEditTargetIsWithinFocusBoundary } from '../text/text-edit-focus-boundary.js';

export function isEditableKeyboardTarget(target) {
  return target?.tagName === 'INPUT'
    || target?.tagName === 'TEXTAREA'
    || target?.tagName === 'SELECT'
    || target?.isContentEditable === true
    || target?.closest?.('[contenteditable="true"], [contenteditable="plaintext-only"]') != null;
}

/**
 * Escape is the one editable-control keystroke owned by an active text-edit
 * session across its complete focus boundary. Property inputs otherwise keep
 * their native keyboard behavior.
 */
export function shouldCancelTextEditForEscape(event, editingText) {
  const target = event?.target;
  return Boolean(
    editingText
      && event?.key === 'Escape'
      && textEditTargetIsWithinFocusBoundary(target)
      // The modal stack owns Escape whenever a dialog is above the editor.
      // Treating dialogs as part of the focus boundary keeps the draft open,
      // but must not let the global editor shortcut bypass the top modal.
      && !target?.closest?.('.modal-overlay, [role="dialog"][aria-modal="true"]'),
  );
}

export function consumeTextEditEscape(event, editingText, cancel) {
  if (!shouldCancelTextEditForEscape(event, editingText)
      || typeof cancel !== 'function') return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  cancel('escape');
  return true;
}

export function shouldRedirectTextEditorSelectAll(event, editingText) {
  const ctrl = event?.ctrlKey || event?.metaKey;
  return Boolean(ctrl
    && !event?.shiftKey
    && !event?.altKey
    && String(event?.key || '').toLowerCase() === 'a'
    && editingText
    && !isEditableKeyboardTarget(event?.target));
}

/** Select a plain textarea/input or the complete canonical rich editor. */
export function selectAllTextEditorContent(editor, {
  getSelection = () => globalThis.getSelection?.(),
  createRange = () => globalThis.document?.createRange?.(),
} = {}) {
  if (!editor) return false;
  editor.focus?.({ preventScroll: true });
  if (typeof editor.select === 'function') {
    editor.select();
    return true;
  }
  if (editor.isContentEditable !== true
      && editor.getAttribute?.('contenteditable') == null) return false;
  const selection = getSelection();
  const range = createRange();
  if (!selection || !range) return false;
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
