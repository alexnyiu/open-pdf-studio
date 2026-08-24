import { Show, createEffect } from 'solid-js';
import { active, editorStyle, text, setText, keyDownHandler, blurHandler, selectOnFocus,
  setSelectOnFocus, editorOptions, editorStatus, setEditorStatus } from '../stores/pdfTextEditStore.js';

export default function PdfTextEditOverlay() {
  let textareaRef;

  const resizeToContent = () => {
    if (!textareaRef) return;
    const base = editorStyle() || {};
    const minWidth = parseFloat(base.width) || 80;
    const minHeight = parseFloat(base.height) || 24;

    if (editorOptions().fixedRegion) {
      textareaRef.style.width = `${minWidth}px`;
      textareaRef.style.height = `${minHeight}px`;
      textareaRef.style.maxWidth = `${minWidth}px`;
      textareaRef.style.maxHeight = `${minHeight}px`;
      textareaRef.style.overflow = 'auto';
      textareaRef.style.whiteSpace = 'pre-wrap';
      textareaRef.style.overflowWrap = 'normal';
      return;
    }

    // wrap="off" keeps the live layout identical to the saved PDF: only an
    // explicit Enter creates a new line. Grow instead of introducing a visual
    // wrap that would disappear after saving.
    textareaRef.style.width = `${minWidth}px`;
    textareaRef.style.height = '0px';
    textareaRef.style.height = `${Math.max(minHeight, textareaRef.scrollHeight)}px`;
    textareaRef.style.width = `${Math.max(minWidth, textareaRef.scrollWidth + 2)}px`;
  };

  createEffect(() => {
    if (active() && textareaRef) {
      textareaRef.focus();
      if (selectOnFocus()) {
        textareaRef.select();
        setSelectOnFocus(false);
      }
    }
  });

  createEffect(() => {
    const isActive = active();
    text();
    editorStyle();
    if (isActive && textareaRef) queueMicrotask(resizeToContent);
  });

  const handleKeyDown = (e) => {
    const handler = keyDownHandler();
    if (handler) handler(e);
  };

  const handleBlur = () => {
    const handler = blurHandler();
    if (handler) handler();
  };

  return (
    <Show when={active()}>
      <>
        <textarea
          ref={textareaRef}
          class="pdf-text-editor"
          dir={editorOptions().direction || 'auto'}
          wrap={editorOptions().fixedRegion ? 'soft' : 'off'}
          spellcheck={false}
          aria-label={editorOptions().ariaLabel || 'Edit PDF text'}
          aria-multiline={editorOptions().singleLine ? 'false' : 'true'}
          aria-describedby={(editorOptions().singleLine || editorOptions().fixedRegion)
            ? 'scanned-text-edit-status' : undefined}
          style={editorStyle()}
          value={text()}
          onBeforeInput={(e) => {
            if (editorOptions().singleLine && ['insertParagraph', 'insertLineBreak'].includes(e.inputType)) {
              e.preventDefault();
              setEditorStatus('Scanned text editing supports one line only.');
            }
          }}
          onPaste={(e) => {
            if (!editorOptions().singleLine) return;
            const pasted = e.clipboardData?.getData('text') || '';
            if (/[\r\n\u2028\u2029]/u.test(pasted)) {
              e.preventDefault();
              setEditorStatus('Pasted text was rejected because multiline editing is not supported.');
            }
          }}
          onInput={(e) => {
            let value = e.target.value;
            if (editorOptions().singleLine && /[\r\n\u2028\u2029]/u.test(value)) {
              value = value.replace(/[\r\n\u2028\u2029]+/gu, '');
              e.target.value = value;
              setEditorStatus('Line breaks are not supported for scanned text.');
            }
            setText(value);
            queueMicrotask(resizeToContent);
            if (editorOptions().fixedRegion) {
              queueMicrotask(() => {
                const overflow = textareaRef.scrollHeight > textareaRef.clientHeight + 1
                  || textareaRef.scrollWidth > textareaRef.clientWidth + 1;
                setEditorStatus(overflow
                  ? 'Content exceeds the fixed preview. Apply will wrap only if it fits; otherwise the edit is rejected.'
                  : editorOptions().status || 'Editing inside one fixed original region.');
              });
            }
          }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
        />
        <Show when={editorOptions().singleLine || editorOptions().fixedRegion}>
          <div id="scanned-text-edit-status" class="ocr-review-live-region" role="status" aria-live="polite" aria-atomic="true">
            {editorStatus() || editorOptions().status || 'Editing scanned text. Font properties are estimates.'}
          </div>
        </Show>
      </>
    </Show>
  );
}
