import { createSignal } from 'solid-js';

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

export function showPdfTextEditor(style, initialText, handlers) {
  setEditorStyle(style);
  setText(initialText);
  setCommitHandler(() => handlers.onCommit || null);
  setCancelHandler(() => handlers.onCancel || null);
  setKeyDownHandler(() => handlers.onKeyDown || null);
  setBlurHandler(() => handlers.onBlur || null);
  setEditorOptions(handlers.options || {});
  setEditorStatus('');
  setSelectOnFocus(true);
  setActive(true);
}

export function hidePdfTextEditor() {
  setActive(false);
  setSelectOnFocus(false);
  setEditorOptions({});
  setEditorStatus('');
}

export function getEditorText() {
  return text();
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
  selectOnFocus, setSelectOnFocus, editorOptions, editorStatus, setEditorStatus };
