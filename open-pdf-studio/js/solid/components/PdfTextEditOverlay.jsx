import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { active, editorStyle, text, setText, keyDownHandler, blurHandler, selectOnFocus,
  setSelectOnFocus, editorOptions, editorStatus, setEditorStatus, richTextDocument,
  setEditorLayoutState,
  richTextSelection, typingStyle, updateRichTextDraft, updateRichTextSelection,
  undoRichTextDraft, redoRichTextDraft } from '../stores/pdfTextEditStore.js';
import {
  canonicalRichTextHash,
  createRichTextDocument,
  createTextLine,
  createTextRun,
  graphemeLength,
  replaceTextRange,
} from '../../text/rich-text.js';
import { shapeRichTextDocument } from '../../text/font-catalog.js';
import { reflowRichTextToWidth } from '../../text/text-edit-selection.js';
import { layoutExpandableNativeText } from '../../text/native-expandable-layout.js';
import { documentNeedsContrastAid, editableRunPresentation } from '../../text/text-edit-contrast.js';

export default function PdfTextEditOverlay() {
  let textareaRef;
  let richEditorRef;
  let shapingGeneration = 0;
  let shapedSignature = '';
  let richDisplayHeight = 0;
  let exactDisplayHeight = 0;
  let lastExpandableInputKey = '';
  let liveContentWidth = 0;
  const [inkInsetsPx, setInkInsetsPx] = createSignal(null);

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

  const resizeRichToContent = () => {
    if (!richEditorRef) return;
    const base = editorStyle() || {};
    const minWidth = parseFloat(base.width) || 80;
    const minHeight = parseFloat(base.height) || 24;
    richEditorRef.style.width = `${minWidth}px`;
    richEditorRef.style.maxWidth = `${minWidth}px`;
    richEditorRef.style.whiteSpace = 'pre-wrap';
    richEditorRef.style.overflowWrap = 'break-word';
    richEditorRef.style.overflow = 'hidden';
    richEditorRef.style.height = 'auto';
    const nextHeight = Math.max(minHeight, exactDisplayHeight, richEditorRef.scrollHeight);
    richEditorRef.style.height = `${nextHeight}px`;
    richDisplayHeight = nextHeight;
    editorOptions().onHeightChange?.(nextHeight);
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

  const expandableInputKey = (document) => {
    const logical = [];
    let current = [];
    const styleKeys = ['faceId','size','color','bold','italic','underline','strikeout','direction'];
    const append = (run) => {
      const style = Object.fromEntries(styleKeys.map((key) => [key, run[key]]));
      const previous = current.at(-1);
      if (previous && styleKeys.every((key) => previous[key] === style[key])) previous.text += run.text;
      else current.push({ text: run.text, ...style });
    };
    document.lines.forEach((line) => {
      line.runs.forEach(append);
      if (line.breakAfter !== 'soft') {
        logical.push(current);
        current = [];
      }
    });
    if (current.length) logical.push(current);
    return JSON.stringify(logical);
  };

  const scheduleExpandableLayout = (source) => {
    const config = editorOptions().expandableRegion;
    if (!config || !source) return;
    const inputKey = expandableInputKey(source);
    if (inputKey === lastExpandableInputKey) return;
    lastExpandableInputKey = inputKey;
    const generation = ++shapingGeneration;
    setEditorLayoutState({ pending: true, valid: false, message: 'Finishing exact text layout…' });
    setEditorStatus('Finishing exact text layout…');
    void layoutExpandableNativeText(source, {
      width: config.width,
      inkPadding: config.inkPadding,
      minimumHeight: config.minimumHeight,
      anchorTop: config.anchorTop,
      pageBounds: config.pageBounds,
      columnBounds: config.columnBounds,
      existingBounds: config.existingBounds,
      editId: config.editId,
    }).then((result) => {
      if (generation !== shapingGeneration || expandableInputKey(richTextDocument()) !== inputKey) return;
      shapedSignature = canonicalRichTextHash(result.document);
      updateRichTextDraft(result.document, { recordHistory: false, preserveDom: true });
      exactDisplayHeight = result.requiredHeight * (config.displayScale || 1);
      liveContentWidth = result.contentWidth;
      setInkInsetsPx({
        left: result.inkInsets.left * (config.displayScale || 1),
        right: result.inkInsets.right * (config.displayScale || 1),
      });
      const notices = [];
      if (result.overlapWarnings.length) {
        notices.push('Text overlaps existing page content. Commit is allowed; neighboring source objects will not move.');
      }
      if (documentNeedsContrastAid(result.document, config.editorBackground)) {
        notices.push('Low-contrast source colors have an editing-only backing. Saved colors remain unchanged.');
      }
      const message = result.valid
        ? notices.join(' ')
        : `Text layout rejected: ${result.rejectionReasons.join('; ')}`;
      setEditorLayoutState({ pending: false, valid: result.valid, message, result });
      setEditorStatus(message);
      config.onDraftLayout?.(result);
      queueMicrotask(resizeRichToContent);
    }).catch((error) => {
      if (generation !== shapingGeneration) return;
      const message = `Text shaping rejected: ${error instanceof Error ? error.message : String(error)}`;
      setEditorLayoutState({ pending: false, valid: false, message });
      setEditorStatus(message);
      queueMicrotask(resizeRichToContent);
    });
  };

  // Keep the draft's cached glyph plan synchronized with its canonical text
  // and styles. Preview, overflow validation, decorations, and save can then
  // consume the same advances instead of independently measuring a flat font.
  createEffect(() => {
    const current = richTextDocument();
    if (!active() || !current) {
      shapingGeneration += 1;
      shapedSignature = '';
      liveContentWidth = 0;
      if (inkInsetsPx()) setInkInsetsPx(null);
      return;
    }
    if (editorOptions().expandableRegion) {
      scheduleExpandableLayout(current);
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
    richTextDocument();
    editorStyle();
    if (isActive && textareaRef) queueMicrotask(resizeToContent);
    if (isActive && richEditorRef) queueMicrotask(resizeRichToContent);
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

  const captureRichHardBreak = (event) => {
    if (!richEditorRef || !richEditorRef.contains(event.target)
        || event.key !== 'Enter' || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    syncRichDocument();
    syncRichSelection();
    const current = richTextDocument();
    const selection = richTextSelection();
    if (!current || !selection) return;
    const inserted = replaceTextRange(current, selection, '\n', typingStyle());
    const logicalIndex = inserted.document.lines.slice(0, inserted.selection.anchor.line)
      .filter((line) => line.breakAfter !== 'soft').length;
    const expandable = editorOptions().expandableRegion;
    const next = expandable
      ? reflowRichTextToWidth(inserted.document,
          liveContentWidth || expandable.contentWidth || expandable.width, undefined, {
          minimumHeight: expandable.minimumHeight,
          anchorTop: expandable.anchorTop,
        })
      : inserted.document;
    let targetLine = 0;
    let paragraphs = 0;
    for (let index = 0; index < next.lines.length; index += 1) {
      if (paragraphs === logicalIndex) { targetLine = index; break; }
      if (next.lines[index].breakAfter !== 'soft') paragraphs += 1;
    }
    updateRichTextDraft(next);
    updateRichTextSelection({
      anchor: { line: targetLine, offset: 0 },
      focus: { line: targetLine, offset: 0 },
    });
    queueMicrotask(() => {
      [...(richEditorRef?.children || [])].forEach((element, index) => {
        element.dataset.richLineIndex = String(index);
        element.dataset.breakAfter = next.lines[index]?.breakAfter || 'hard';
      });
      const target = richEditorRef?.querySelector(`[data-rich-line-index="${targetLine}"]`);
      const textNode = target?.querySelector('[data-rich-run]')?.firstChild;
      if (!textNode) return;
      const domSelection = window.getSelection();
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.collapse(true);
      domSelection.removeAllRanges();
      domSelection.addRange(range);
      richEditorRef.focus();
    });
  };

  onMount(() => {
    document.addEventListener('selectionchange', syncRichSelection);
    document.addEventListener('keydown', captureRichHardBreak, true);
  });
  onCleanup(() => {
    document.removeEventListener('selectionchange', syncRichSelection);
    document.removeEventListener('keydown', captureRichHardBreak, true);
  });

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
      ? (richEditorRef.textContent || '')
        .replaceAll('\u200b', '').replaceAll('\r', '').split('\n')
      : null;
    const editableLines = plainLines || lineElements;
    if (!plainLines) {
      // A select-all replacement containing newlines can make Chromium clone
      // the original line element (including its soft marker). Repeated source
      // indexes are browser-created structural lines, never CSS-only wraps.
      for (let index = 1; index < lineElements.length; index += 1) {
        if (lineElements[index - 1].dataset.richLineIndex
            === lineElements[index].dataset.richLineIndex) {
          lineElements[index - 1].dataset.breakAfter = 'hard';
          if (index === lineElements.length - 1) lineElements[index].dataset.breakAfter = 'hard';
        }
      }
    }
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
        // Existing source visual lines carry an explicit soft/hard marker.
        // A browser-created div has no marker and therefore represents an
        // authored Enter, which must persist as a hard break.
        breakAfter: plainLines ? 'hard' : (lineElement?.dataset.breakAfter || 'hard'),
      });
    });
    const next = createRichTextDocument(lines, current.region);
    const expandable = editorOptions().expandableRegion;
    const draft = expandable
      ? reflowRichTextToWidth(next,
          liveContentWidth || expandable.contentWidth || expandable.width, undefined, {
          minimumHeight: expandable.minimumHeight,
          anchorTop: expandable.anchorTop,
        })
      : next;
    updateRichTextDraft(draft, { preserveDom: true });
    if (expandable) {
      exactDisplayHeight = draft.region.height * (expandable.displayScale || 1);
      lastExpandableInputKey = '';
      scheduleExpandableLayout(draft);
    }
    if (editorOptions().reflowWidth) queueMicrotask(resizeRichToContent);
    queueMicrotask(syncRichSelection);
  };

  const editorBackground = () => editorOptions().expandableRegion?.editorBackground || '#ffffff';
  const runPresentation = (run) => editableRunPresentation(run.color, editorBackground());
  const richEditorStyle = () => ({
    ...(editorStyle() || {}),
    background: editorBackground(),
    'padding-left': `${inkInsetsPx()?.left ?? editorOptions().expandableRegion?.inkPaddingPx ?? 0}px`,
    'padding-right': `${inkInsetsPx()?.right ?? editorOptions().expandableRegion?.inkPaddingPx ?? 0}px`,
    'font-synthesis': 'none',
  });
  const runStyle = (run) => ({
    'font-family': run.faceId.includes('mono') ? '"Liberation Mono", monospace'
      : run.faceId.includes('serif') ? '"Liberation Serif", serif' : '"Liberation Sans", sans-serif',
    'font-size': `${run.size * (editorOptions().displayScale || 1)}px`,
    'font-weight': run.bold ? '700' : '400',
    'font-style': run.italic ? 'italic' : 'normal',
    color: runPresentation(run).color,
    'background-color': runPresentation(run).backingColor || 'transparent',
    'box-decoration-break': 'clone',
    '-webkit-box-decoration-break': 'clone',
    'font-synthesis': 'none',
    'text-shadow': 'none',
    'vertical-align': 'baseline',
    'text-decoration-line': [run.underline && 'underline', run.strikeout && 'line-through'].filter(Boolean).join(' ') || 'none',
  });

  const lineDisplayHeight = (line) => {
    const shapedHeight = Math.max(0, ...line.runs.map((run) => (
      (run.shaped?.metrics?.ascent || 0) + (run.shaped?.metrics?.descent || 0)
    )));
    return Math.max(line.baselineAdvance, shapedHeight) * (editorOptions().displayScale || 1);
  };

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
            aria-describedby={editorOptions().expandableRegion ? 'native-text-edit-status' : undefined}
            spellcheck={false}
            style={richEditorStyle()}
            onInput={syncRichDocument}
            on:keydown={(event) => {
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
              <div
                data-rich-line-index={lineIndex()}
                data-break-after={line.breakAfter || 'hard'}
                style={{
                  'text-align': line.alignment,
                  'min-height': `${lineDisplayHeight(line)}px`,
                  'line-height': `${lineDisplayHeight(line)}px`,
                }}
              >
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
                    data-contrast-aid={String(runPresentation(run).contrastAid)}
                    style={runStyle(run)}
                  >{run.text || '\u200b'}</span>
                }</For>
              </div>
            }</For>
          </div>
        </Show>
        <Show when={editorOptions().singleLine || editorOptions().fixedRegion || editorOptions().expandableRegion}>
          <div id={editorOptions().expandableRegion ? 'native-text-edit-status' : 'scanned-text-edit-status'} class="ocr-review-live-region" role="status" aria-live="polite" aria-atomic="true">
            {editorStatus() || editorOptions().status || (editorOptions().expandableRegion
              ? documentNeedsContrastAid(richTextDocument(), editorBackground())
                ? 'Editing native text. The width is fixed and the region grows downward. Low-contrast source colors have an editing-only backing; saved colors remain unchanged.'
                : 'Editing native text. The width is fixed and the region grows downward.'
              : 'Editing scanned text. Font properties are estimates.')}
          </div>
        </Show>
      </>
    </Show>
  );
}
