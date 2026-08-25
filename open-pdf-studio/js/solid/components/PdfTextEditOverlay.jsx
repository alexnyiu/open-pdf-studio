import { For, Show, createEffect, onCleanup, onMount } from 'solid-js';
import { active, editorStyle, text, setText, keyDownHandler, blurHandler, selectOnFocus,
  setSelectOnFocus, editorOptions, editorStatus, setEditorStatus, richTextDocument,
  typingStyle, updateRichTextDraft, updateRichTextSelection,
  undoRichTextDraft, redoRichTextDraft } from '../stores/pdfTextEditStore.js';
import {
  canonicalRichTextHash,
  createRichTextDocument,
  createTextLine,
  createTextRun,
  graphemeLength,
} from '../../text/rich-text.js';
import { shapeRichTextDocument } from '../../text/font-catalog.js';

export default function PdfTextEditOverlay() {
  let textareaRef;
  let richEditorRef;
  let shapingGeneration = 0;
  let shapedSignature = '';

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
    const editor = richTextDocument() ? richEditorRef : textareaRef;
    if (active() && editor) {
      editor.focus();
      if (selectOnFocus()) {
        if (richTextDocument()) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          selection.removeAllRanges();
          selection.addRange(range);
          syncRichSelection();
        } else {
          textareaRef.select();
        }
        setSelectOnFocus(false);
      }
    }
  });

  // Keep the draft's cached glyph plan synchronized with its canonical text
  // and styles. Preview, overflow validation, decorations, and save can then
  // consume the same advances instead of independently measuring a flat font.
  createEffect(() => {
    const current = richTextDocument();
    if (!active() || !current) {
      shapingGeneration += 1;
      shapedSignature = '';
      return;
    }
    const signature = canonicalRichTextHash(current);
    const fullyShaped = current.lines.every((line) => line.runs.every((run) => run.shaped));
    if (fullyShaped && signature === shapedSignature) return;
    const generation = ++shapingGeneration;
    void shapeRichTextDocument(current).then((layout) => {
      const live = richTextDocument();
      if (generation !== shapingGeneration || !live
          || canonicalRichTextHash(live) !== signature) return;
      shapedSignature = signature;
      layout.lines.forEach((line, lineIndex) => {
        line.runs.forEach((run, runIndex) => {
          const liveRun = live.lines[lineIndex]?.runs[runIndex];
          if (!liveRun) return;
          liveRun.shaped = run.shaped;
          liveRun.geometry = run.geometry;
        });
      });
      if (layout.overflow) setEditorStatus(`Text layout rejected: ${layout.rejectionReasons.join('; ')}`);
      else if (editorStatus().startsWith('Text layout rejected:')) setEditorStatus('');
    }).catch((error) => {
      if (generation === shapingGeneration) {
        setEditorStatus(`Text shaping rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
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

  const pointFromDom = (node, offset) => {
    if (!richEditorRef || !node) return null;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const line = element?.closest?.('[data-rich-line-index]');
    if (!line || !richEditorRef.contains(line)) return null;
    const range = document.createRange();
    range.setStart(line, 0);
    try { range.setEnd(node, offset); } catch { return null; }
    return {
      line: Number(line.dataset.richLineIndex),
      offset: graphemeLength(range.toString().replaceAll('\u200b', '')),
    };
  };

  const syncRichSelection = () => {
    if (!active() || !richTextDocument() || !richEditorRef) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !richEditorRef.contains(selection.anchorNode)) return;
    const anchor = pointFromDom(selection.anchorNode, selection.anchorOffset);
    const focus = pointFromDom(selection.focusNode, selection.focusOffset);
    if (anchor && focus) updateRichTextSelection({ anchor, focus });
  };

  onMount(() => document.addEventListener('selectionchange', syncRichSelection));
  onCleanup(() => document.removeEventListener('selectionchange', syncRichSelection));

  const syncRichDocument = () => {
    const current = richTextDocument();
    if (!current || !richEditorRef) return;
    const fallback = typingStyle() || current.lines[0]?.runs[0] || {};
    const rootHasTextNode = [...richEditorRef.childNodes].some((node) =>
      node.nodeType === Node.TEXT_NODE && node.textContent.replaceAll('\u200b', '') !== '');
    const lineElements = [...richEditorRef.children];
    // Selecting the whole editor and typing is the normal first-edit path.
    // Browsers may replace all structural line/run elements with one root text
    // node. Parse that text explicitly instead of silently producing no lines.
    const plainLines = rootHasTextNode || lineElements.length === 0
      ? (richEditorRef.innerText || richEditorRef.textContent || '')
        .replaceAll('\u200b', '').replaceAll('\r', '').split('\n')
      : null;
    const editableLines = plainLines || lineElements;
    const lines = editableLines.map((lineSource, lineIndex) => {
      const oldLine = current.lines[Math.min(lineIndex, current.lines.length - 1)] || current.lines[0];
      const baselineSign = current.region.baselineDirection === 'increasing-y' ? 1 : -1;
      const addedLineCount = Math.max(0, lineIndex - current.lines.length + 1);
      const lineElement = typeof lineSource === 'string' ? null : lineSource;
      const runElements = lineElement ? [...lineElement.querySelectorAll('[data-rich-run]')] : [];
      const runs = typeof lineSource === 'string'
        ? [createTextRun(lineSource, fallback)]
        : runElements.length > 0
        ? runElements.map((runElement) => createTextRun(
            runElement.textContent.replaceAll('\u200b', ''),
            {
              faceId: runElement.dataset.faceId,
              size: Number(runElement.dataset.size),
              color: runElement.dataset.color,
              bold: runElement.dataset.bold === 'true',
              italic: runElement.dataset.italic === 'true',
              underline: runElement.dataset.underline === 'true',
              strikeout: runElement.dataset.strikeout === 'true',
              direction: 'ltr',
            },
            { id: runElement.dataset.runId },
          ))
        : [createTextRun(lineElement.textContent.replaceAll('\u200b', ''), fallback)];
      return createTextLine(runs, {
        id: oldLine?.id,
        baseline: oldLine?.baseline + baselineSign * addedLineCount * oldLine.baselineAdvance,
        baselineAdvance: oldLine?.baselineAdvance,
        alignment: oldLine?.alignment,
        breakAfter: plainLines ? 'hard' : (lineElement?.dataset.breakAfter || oldLine?.breakAfter),
      });
    });
    const next = createRichTextDocument(lines, current.region);
    updateRichTextDraft(next, { preserveDom: true });
    if (editorOptions().reflowWidth) {
      queueMicrotask(() => {
        if (richEditorRef) richEditorRef.style.height = `${Math.max(24, richEditorRef.scrollHeight)}px`;
      });
    }
    queueMicrotask(syncRichSelection);
  };

  const runStyle = (run) => ({
    'font-family': run.faceId.includes('mono') ? '"Liberation Mono", monospace'
      : run.faceId.includes('serif') ? '"Liberation Serif", serif' : '"Liberation Sans", sans-serif',
    'font-size': `${run.size}px`,
    'font-weight': run.bold ? '700' : '400',
    'font-style': run.italic ? 'italic' : 'normal',
    color: run.color,
    'text-decoration-line': [run.underline && 'underline', run.strikeout && 'line-through'].filter(Boolean).join(' ') || 'none',
  });

  // A collapsed formatting command changes only the style of subsequently
  // typed graphemes. Insert a zero-width styled DOM run at the native caret;
  // the next input event promotes it into the canonical rich-run document.
  createEffect(() => {
    const patch = typingStyle();
    if (!patch || !active() || !richEditorRef) return;
    const selection = window.getSelection();
    if (!selection?.isCollapsed || selection.rangeCount === 0
        || !richEditorRef.contains(selection.anchorNode)) return;
    const sourceElement = (selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode : selection.anchorNode.parentElement)?.closest?.('[data-rich-run]');
    const current = richTextDocument()?.lines?.[0]?.runs?.[0] || {};
    const style = {
      ...current,
      ...(sourceElement ? {
        faceId: sourceElement.dataset.faceId,
        size: Number(sourceElement.dataset.size),
        color: sourceElement.dataset.color,
        bold: sourceElement.dataset.bold === 'true',
        italic: sourceElement.dataset.italic === 'true',
        underline: sourceElement.dataset.underline === 'true',
        strikeout: sourceElement.dataset.strikeout === 'true',
      } : {}),
      ...patch,
    };
    const span = document.createElement('span');
    span.dataset.richRun = 'true';
    span.dataset.runId = `typing-${Date.now().toString(36)}`;
    span.dataset.faceId = style.faceId;
    span.dataset.size = String(style.size);
    span.dataset.color = style.color;
    span.dataset.bold = String(style.bold === true);
    span.dataset.italic = String(style.italic === true);
    span.dataset.underline = String(style.underline === true);
    span.dataset.strikeout = String(style.strikeout === true);
    Object.assign(span.style, runStyle(style));
    span.textContent = '\u200b';
    const range = selection.getRangeAt(0);
    range.insertNode(span);
    range.setStart(span.firstChild, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  });

  return (
    <Show when={active()}>
      <>
        <Show when={richTextDocument()} fallback={
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
            onInput={(e) => { setText(e.target.value); queueMicrotask(resizeToContent); }}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
          />
        }>
          <div
            ref={richEditorRef}
            class={`pdf-text-editor rich-text-editor${editorOptions().reflowWidth ? ' rich-text-editor-reflow' : ''}`}
            contentEditable={true}
            role="textbox"
            aria-label={editorOptions().ariaLabel || 'Edit formatted PDF text'}
            aria-multiline={editorOptions().singleLine ? 'false' : 'true'}
            spellcheck={false}
            style={editorStyle()}
            onInput={syncRichDocument}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                if (event.shiftKey) redoRichTextDraft();
                else undoRichTextDraft();
                return;
              }
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
                event.preventDefault();
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(richEditorRef);
                selection.removeAllRanges();
                selection.addRange(range);
                syncRichSelection();
                return;
              }
              handleKeyDown(event);
            }}
            onBlur={handleBlur}
          >
            <For each={richTextDocument().lines}>{(line, lineIndex) =>
              <div data-rich-line-index={lineIndex()} data-break-after={line.breakAfter || 'hard'} style={{ 'text-align': line.alignment }}>
                <For each={line.runs}>{(run) =>
                  <span
                    data-rich-run="true"
                    data-run-id={run.id}
                    data-face-id={run.faceId}
                    data-size={run.size}
                    data-color={run.color}
                    data-bold={String(run.bold)}
                    data-italic={String(run.italic)}
                    data-underline={String(run.underline)}
                    data-strikeout={String(run.strikeout)}
                    style={runStyle(run)}
                  >{run.text || '\u200b'}</span>
                }</For>
              </div>
            }</For>
          </div>
        </Show>
        <Show when={editorOptions().singleLine || editorOptions().fixedRegion}>
          <div id="scanned-text-edit-status" class="ocr-review-live-region" role="status" aria-live="polite" aria-atomic="true">
            {editorStatus() || editorOptions().status || 'Editing scanned text. Font properties are estimates.'}
          </div>
        </Show>
      </>
    </Show>
  );
}
