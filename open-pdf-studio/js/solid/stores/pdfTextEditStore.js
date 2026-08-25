import { createSignal } from 'solid-js';
import {
  applyTextFormat,
  graphemeLength,
  richTextToPlainText,
  textFormatState,
} from '../../text/rich-text.js';

const [active, setActive] = createSignal(false);
const [editorStyle, setEditorStyle] = createSignal({});
const [text, setText] = createSignal('');
const [commitHandler, setCommitHandler] = createSignal(null);
const [cancelHandler, setCancelHandler] = createSignal(null);
const [keyDownHandler, setKeyDownHandler] = createSignal(null);
const [blurHandler, setBlurHandler] = createSignal(null);
const [selectOnFocus, setSelectOnFocus] = createSignal(false);
const [editorOptions, setEditorOptions] = createSignal({});
const [editorStatus, setEditorStatus] = createSignal('');
const [richTextDocument, setRichTextDocument] = createSignal(null);
const [richTextSelection, setRichTextSelection] = createSignal(null);
const [typingStyle, setTypingStyle] = createSignal(null);
const [mixedFormatState, setMixedFormatState] = createSignal({});
let richTextHistory = [];
let richTextHistoryIndex = -1;

export function showPdfTextEditor(style, initialText, handlers) {
  setEditorStyle(style);
  setText(initialText);
  setCommitHandler(() => handlers.onCommit || null);
  setCancelHandler(() => handlers.onCancel || null);
  setKeyDownHandler(() => handlers.onKeyDown || null);
  setBlurHandler(() => handlers.onBlur || null);
  setEditorOptions(handlers.options || {});
  setEditorStatus('');
  const richText = handlers.options?.richTextDocument || null;
  setRichTextDocument(richText);
  richTextHistory = richText ? [structuredClone(richText)] : [];
  richTextHistoryIndex = richText ? 0 : -1;
  setRichTextSelection(richText ? {
    anchor: { line: 0, offset: 0 },
    focus: {
      line: richText.lines.length - 1,
      offset: richText.lines.at(-1).runs.reduce((sum, run) => sum + graphemeLength(run.text), 0),
    },
  } : null);
  setTypingStyle(null);
  setMixedFormatState(richText ? textFormatState(richText, richTextSelection()) : {});
  setSelectOnFocus(true);
  setActive(true);
}

export function hidePdfTextEditor() {
  setActive(false);
  setSelectOnFocus(false);
  setEditorOptions({});
  setEditorStatus('');
  setRichTextDocument(null);
  setRichTextSelection(null);
  setTypingStyle(null);
  setMixedFormatState({});
  richTextHistory = [];
  richTextHistoryIndex = -1;
}

export function getEditorText() {
  return richTextDocument() ? richTextToPlainText(richTextDocument()) : text();
}

export function getEditorRichText() {
  return richTextDocument();
}

export function getEditorFormatState() {
  return mixedFormatState();
}

export function updateRichTextDraft(document, { recordHistory = true, preserveDom = false } = {}) {
  if (recordHistory) {
    const previous = richTextHistory[richTextHistoryIndex];
    if (!previous || JSON.stringify(previous) !== JSON.stringify(document)) {
      richTextHistory = richTextHistory.slice(0, richTextHistoryIndex + 1);
      richTextHistory.push(structuredClone(document));
      richTextHistoryIndex = richTextHistory.length - 1;
    }
  }
  if (preserveDom) {
    // contentEditable owns the live DOM while the user is typing. Replacing
    // the signal value on every input makes Solid reconcile the keyed line/run
    // nodes, which destroys the native caret and can turn a select-all
    // replacement into an empty document.
    const current = richTextDocument();
    if (current) {
      const snapshot = structuredClone(document);
      for (const key of Object.keys(current)) {
        if (!Object.hasOwn(snapshot, key)) delete current[key];
      }
      Object.assign(current, snapshot);
    } else {
      setRichTextDocument(document);
    }
  } else {
    setRichTextDocument(document);
  }
  setText(richTextToPlainText(document));
  if (richTextSelection()) setMixedFormatState(textFormatState(document, richTextSelection()));
}

export function undoRichTextDraft() {
  if (richTextHistoryIndex <= 0) return false;
  richTextHistoryIndex -= 1;
  updateRichTextDraft(structuredClone(richTextHistory[richTextHistoryIndex]), { recordHistory: false });
  return true;
}

export function redoRichTextDraft() {
  if (richTextHistoryIndex < 0 || richTextHistoryIndex >= richTextHistory.length - 1) return false;
  richTextHistoryIndex += 1;
  updateRichTextDraft(structuredClone(richTextHistory[richTextHistoryIndex]), { recordHistory: false });
  return true;
}

export function updateRichTextSelection(selection) {
  setRichTextSelection(selection);
  const document = richTextDocument();
  if (document) setMixedFormatState(textFormatState(document, selection));
}

export function applyRichTextDraftFormat(patch) {
  const document = richTextDocument();
  const selection = richTextSelection();
  if (!document || !selection) return false;
  const result = applyTextFormat(document, selection, patch);
  if (result.collapsed) setTypingStyle((previous) => ({ ...(previous || {}), ...patch }));
  else {
    setTypingStyle(null);
    updateRichTextDraft(result.document);
  }
  setMixedFormatState(textFormatState(result.document, selection));
  return true;
}

export function applyRichTextDraftParagraphFormat(key, value) {
  const document = richTextDocument();
  const selection = richTextSelection();
  if (!document || !selection) return false;
  const next = structuredClone(document);
  const start = Math.min(selection.anchor.line, selection.focus.line);
  const end = Math.max(selection.anchor.line, selection.focus.line);
  for (let index = start; index <= end; index += 1) {
    if (key === 'alignment' && ['left', 'center', 'right'].includes(value)) {
      next.lines[index].alignment = value;
    } else if (key === 'baselineAdvance' && Number(value) > 0) {
      // Preserve measured baselines independently from font-size changes.
      const previous = next.lines[index].baselineAdvance;
      const replacement = Number(value);
      next.lines[index].baselineAdvance = replacement;
      const baselineSign = next.region.baselineDirection === 'increasing-y' ? 1 : -1;
      for (let later = index + 1; later < next.lines.length; later += 1) {
        next.lines[later].baseline += baselineSign * (replacement - previous);
      }
    }
  }
  updateRichTextDraft(next);
  return true;
}

// Merge a partial style object into the live editor style (used when the
// properties panel changes font/colour/weight while a text edit is open).
export function updateEditorStyle(partial) {
  setEditorStyle(prev => ({ ...(prev || {}), ...partial }));
}

// Shift the live editor's fixed position by a pixel delta (used for keyboard
// nudge / move of the active text edit). left/top are 'Npx' strings.
export function shiftEditorPosition(dxPx, dyPx) {
  setEditorStyle(prev => {
    const s = { ...(prev || {}) };
    const l = parseFloat(s.left) || 0;
    const t = parseFloat(s.top) || 0;
    s.left = `${l + dxPx}px`;
    s.top = `${t + dyPx}px`;
    return s;
  });
}

export { active, editorStyle, text, setText, commitHandler, cancelHandler, keyDownHandler, blurHandler,
  selectOnFocus, setSelectOnFocus, editorOptions, editorStatus, setEditorStatus,
  richTextDocument, richTextSelection, typingStyle, mixedFormatState };
