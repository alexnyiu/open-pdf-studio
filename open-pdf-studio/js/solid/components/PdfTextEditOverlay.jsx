import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { active, editorStyle, editorPlacement, text, setText, keyDownHandler, blurHandler, selectOnFocus,
  setSelectOnFocus, editorOptions, editorStatus, setEditorStatus, richTextDocument,
  editorLayoutState, setEditorLayoutState,
  richTextSelection, typingStyle, updateRichTextDraft, updateRichTextSelection,
  undoRichTextDraft, redoRichTextDraft, updateEditorGeometry } from '../stores/pdfTextEditStore.js';
import {
  canonicalRichTextHash,
  createRichTextDocument,
  createTextLine,
  createTextRun,
  graphemes,
  graphemeLength,
  replaceTextRange,
  richTextInsertionContext,
} from '../../text/rich-text.js';
import { shapeRichTextDocument } from '../../text/font-catalog.js';
import { reflowRichTextToWidth } from '../../text/text-edit-selection.js';
import { layoutExpandableNativeText } from '../../text/native-expandable-layout.js';
import { documentNeedsContrastAid, editableRunPresentation } from '../../text/text-edit-contrast.js';
import {
  canonicalDeltaFromDisplayDelta,
  clampPageTextEditBounds,
  projectCommitBounds,
  projectPageTextEditPlacement,
  scrollFreePreviewSize,
} from '../../text/page-text-edit-placement.js';
import {
  ensurePageTextEditHost,
  measurePageTextEditFrame,
} from '../../text/page-text-edit-host.js';

export default function PdfTextEditOverlay() {
  let textareaRef;
  let richEditorRef;
  let portalRef;
  let placementFrameId = 0;
  let placementSignature = '';
  let shapingGeneration = 0;
  let shapedSignature = '';
  let richDisplayHeight = 0;
  let exactRequiredHeight = 0;
  let lastExpandableInputKey = '';
  let liveContentWidth = 0;
  let currentPlacementFrame = null;
  let geometryGesture = null;
  let pendingInputContext = null;
  const [inkInsetsPx, setInkInsetsPx] = createSignal(null);
  const [projectedStyle, setProjectedStyle] = createSignal(null);
  const [commitBoundsStyle, setCommitBoundsStyle] = createSignal(null);
  const [pageDisplayScale, setPageDisplayScale] = createSignal(0);
  const [previewOverflow, setPreviewOverflow] = createSignal(false);
  const [editorBox, setEditorBox] = createSignal(null);

  const displayScale = () => pageDisplayScale()
    || editorOptions().expandableRegion?.displayScale
    || editorOptions().displayScale
    || 1;

  const liveEditorStyle = () => projectedStyle() || editorStyle() || {};

  const placementIdentity = () => {
    const placement = editorPlacement();
    return placement
      ? `${placement.documentId}:${placement.pageNum}:${placement.generation}`
      : 'unplaced';
  };

  const syncPagePlacement = () => {
    const placement = editorPlacement();
    if (!active() || !placement) {
      currentPlacementFrame = null;
      placementSignature = '';
      if (projectedStyle()) setProjectedStyle(null);
      if (commitBoundsStyle()) setCommitBoundsStyle(null);
      if (pageDisplayScale()) setPageDisplayScale(0);
      return;
    }
    const host = ensurePageTextEditHost(placement);
    const frame = host && measurePageTextEditFrame(placement, host);
    if (!host || !frame) return;
    currentPlacementFrame = frame;
    const style = editorStyle() || {};
    const signature = JSON.stringify([
      placement.documentId, placement.pageNum, placement.generation,
      frame.pageWidth, frame.pageHeight, frame.rotation, frame.scale,
      frame.offsetX, frame.offsetY, style.left, style.top, style.width,
      style.height, style['font-size'], style['line-height'],
      placement.canonicalBounds.x, placement.canonicalBounds.y,
      placement.canonicalBounds.width, placement.canonicalBounds.height,
    ]);
    if (portalRef && portalRef.parentElement !== host) {
      const focused = portalRef.contains(document.activeElement);
      host.appendChild(portalRef);
      if (focused) queueMicrotask(() => (richEditorRef || textareaRef)?.focus({ preventScroll: true }));
    }
    for (const attachment of editorOptions().attachedPageElements || []) {
      const element = attachment?.element;
      const attachmentPlacement = attachment?.placement;
      if (!element || !attachmentPlacement) continue;
      if (element.parentElement !== host) host.appendChild(element);
      const attachmentStyle = projectPageTextEditPlacement(
        attachmentPlacement,
        frame,
        attachmentPlacement.sourceStyle,
      );
      if (attachmentStyle) Object.assign(element.style, attachmentStyle);
    }
    if (signature === placementSignature) return;
    placementSignature = signature;
    setProjectedStyle(projectPageTextEditPlacement(placement, frame, style));
    setCommitBoundsStyle(projectCommitBounds(placement, frame));
    setPageDisplayScale(frame.scale);
    const exactInsets = editorLayoutState()?.result?.inkInsets;
    if (exactInsets) {
      setInkInsetsPx({
        left: exactInsets.left * frame.scale,
        right: exactInsets.right * frame.scale,
      });
    }
    queueMicrotask(() => {
      resizeToContent();
      resizeRichToContent();
    });
  };

  const resizeToContent = () => {
    if (!textareaRef) return;
    const base = liveEditorStyle();
    const minWidth = parseFloat(base.width) || 80;
    const minHeight = parseFloat(base.height) || 24;

    if (editorOptions().fixedRegion) {
      textareaRef.style.width = `${minWidth}px`;
      textareaRef.style.maxWidth = `${minWidth}px`;
      textareaRef.style.maxHeight = 'none';
      textareaRef.style.height = '0px';
      textareaRef.style.overflow = 'hidden';
      textareaRef.style.whiteSpace = 'pre-wrap';
      textareaRef.style.overflowWrap = 'anywhere';
      const preview = scrollFreePreviewSize({
        minimumWidth: minWidth,
        minimumHeight: minHeight,
        scrollWidth: textareaRef.scrollWidth,
        scrollHeight: textareaRef.scrollHeight,
      });
      textareaRef.style.height = `${preview.height}px`;
      setEditorBox({ width: preview.width, height: preview.height });
      const overflowing = preview.overflowing;
      if (overflowing !== previewOverflow()) {
        setPreviewOverflow(overflowing);
        setEditorStatus(overflowing
          ? 'The complete OCR draft is visible beyond its approved region. Saving remains blocked unless exact fixed-region validation fits the text.'
          : (editorOptions().status || 'Editing scanned text inside its approved region.'));
      }
      return;
    }

    // wrap="off" keeps the live layout identical to the saved PDF: only an
    // explicit Enter creates a new line. Grow instead of introducing a visual
    // wrap that would disappear after saving.
    textareaRef.style.width = `${minWidth}px`;
    textareaRef.style.height = '0px';
    textareaRef.style.height = `${Math.max(minHeight, textareaRef.scrollHeight)}px`;
    textareaRef.style.width = `${Math.max(minWidth, textareaRef.scrollWidth + 2)}px`;
    setEditorBox({
      width: Math.max(minWidth, textareaRef.scrollWidth + 2),
      height: Math.max(minHeight, textareaRef.scrollHeight),
    });
  };

  const resizeRichToContent = () => {
    if (!richEditorRef) return;
    const base = liveEditorStyle();
    const minWidth = parseFloat(base.width) || 80;
    const minHeight = parseFloat(base.height) || 24;
    const manualLineBreaks = editorOptions().expandableRegion?.manualLineBreaks === true;
    richEditorRef.style.width = `${minWidth}px`;
    richEditorRef.style.maxWidth = manualLineBreaks ? 'none' : `${minWidth}px`;
    richEditorRef.style.whiteSpace = manualLineBreaks ? 'pre' : 'pre-wrap';
    richEditorRef.style.overflowWrap = manualLineBreaks ? 'normal' : 'break-word';
    richEditorRef.style.overflow = 'visible';
    richEditorRef.style.height = 'auto';
    const preview = scrollFreePreviewSize({
      minimumWidth: minWidth,
      minimumHeight: Math.max(minHeight, exactRequiredHeight * displayScale()),
      scrollWidth: richEditorRef.scrollWidth,
      scrollHeight: richEditorRef.scrollHeight,
      fixedWidth: !manualLineBreaks,
    });
    richEditorRef.style.width = `${preview.width}px`;
    const nextHeight = preview.height;
    richEditorRef.style.height = `${nextHeight}px`;
    setEditorBox({ width: preview.width, height: nextHeight });
    richDisplayHeight = nextHeight;
    const overflowing = Boolean(editorOptions().fixedRegion && preview.overflowing);
    if (overflowing !== previewOverflow()) {
      setPreviewOverflow(overflowing);
      setEditorStatus(overflowing
        ? 'The complete OCR draft is visible beyond its approved region. Saving remains blocked unless exact fixed-region validation fits the text.'
        : (editorOptions().status || 'Editing scanned text inside its approved region.'));
    }
    editorOptions().onHeightChange?.(nextHeight);
  };

  createEffect(() => {
    const editor = richTextDocument() ? richEditorRef : textareaRef;
    if (active() && editor) {
      if (editorPlacement()) {
        syncPagePlacement();
        if (!portalRef?.parentElement?.classList?.contains('pdf-text-edit-layer')) return;
      }
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
    const sourcePlacementIdentity = placementIdentity();
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
      manualLineBreaks: config.manualLineBreaks === true,
    }).then((result) => {
      if (generation !== shapingGeneration
          || placementIdentity() !== sourcePlacementIdentity
          || expandableInputKey(richTextDocument()) !== inputKey) return;
      shapedSignature = canonicalRichTextHash(result.document);
      updateRichTextDraft(result.document, { recordHistory: false, preserveDom: true });
      exactRequiredHeight = result.requiredHeight;
      liveContentWidth = result.contentWidth;
      setInkInsetsPx({
        left: result.inkInsets.left * displayScale(),
        right: result.inkInsets.right * displayScale(),
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
        : [`Text layout rejected: ${result.rejectionReasons.join('; ')}`, ...notices].join(' ');
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
      exactRequiredHeight = 0;
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
    const sourcePlacementIdentity = placementIdentity();
    const generation = ++shapingGeneration;
    void shapeRichTextDocument(current).then((layout) => {
      const live = richTextDocument();
      if (generation !== shapingGeneration
          || placementIdentity() !== sourcePlacementIdentity || !live
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
    editorPlacement();
    if (isActive && textareaRef) queueMicrotask(resizeToContent);
    if (isActive && richEditorRef) queueMicrotask(resizeRichToContent);
    if (isActive) queueMicrotask(syncPagePlacement);
  });

  const handleKeyDown = (e) => {
    const handler = keyDownHandler();
    if (handler) handler(e);
  };

  const handleBlur = () => {
    const handler = blurHandler();
    if (handler) handler();
  };

  const directManipulationEnabled = () => Boolean(
    editorPlacement() && editorOptions().expandableRegion?.directManipulation,
  );

  const manipulationStyle = () => {
    const style = liveEditorStyle();
    const box = editorBox();
    return {
      position: 'absolute',
      left: style.left,
      top: style.top,
      width: `${box?.width ?? (parseFloat(style.width) || 80)}px`,
      height: `${box?.height ?? (parseFloat(style.height) || 24)}px`,
      transform: style.transform || 'none',
      'transform-origin': style['transform-origin'] || '0 0',
      'z-index': String((Number(style['z-index']) || 1000) + 1),
    };
  };

  const applyGeometryGesture = (clientX, clientY) => {
    if (!geometryGesture || !currentPlacementFrame) return;
    const delta = canonicalDeltaFromDisplayDelta({
      x: clientX - geometryGesture.clientX,
      y: clientY - geometryGesture.clientY,
    }, currentPlacementFrame);
    const start = geometryGesture.bounds;
    const requested = geometryGesture.kind === 'move' ? {
      ...start,
      x: start.x + delta.x,
      y: start.y + delta.y,
    } : {
      ...start,
      width: start.width + delta.x,
      height: start.height + delta.y,
    };
    let bounds = clampPageTextEditBounds(requested, {
      width: editorPlacement().pageWidth,
      height: editorPlacement().pageHeight,
    }, geometryGesture.minimum);
    const column = editorOptions().expandableRegion?.columnBounds;
    if (Number.isFinite(column?.left) && Number.isFinite(column?.right)
        && column.right > column.left) {
      if (geometryGesture.kind === 'resize') {
        const maximumWidth = Math.max(
          geometryGesture.minimum.width,
          column.right - geometryGesture.richText.region.x,
        );
        bounds = { ...bounds, width: Math.min(bounds.width, maximumWidth) };
      } else {
        const minimumDx = column.left - geometryGesture.richText.region.x;
        const maximumDx = column.right
          - (geometryGesture.richText.region.x + geometryGesture.richText.region.width);
        const dx = Math.max(minimumDx, Math.min(maximumDx, bounds.x - start.x));
        bounds = { ...bounds, x: start.x + dx };
      }
    }
    const next = structuredClone(geometryGesture.richText);
    if (geometryGesture.kind === 'move') {
      const dx = bounds.x - start.x;
      const dyPdf = -(bounds.y - start.y);
      next.region.x += dx;
      next.region.y += dyPdf;
      for (const line of next.lines) line.baseline += dyPdf;
    } else {
      const anchorTop = geometryGesture.richText.region.y + geometryGesture.richText.region.height;
      next.region.width = bounds.width;
      next.region.height = bounds.height;
      next.region.y = anchorTop - bounds.height;
    }
    const anchorTop = next.region.y + next.region.height;
    updateEditorGeometry({
      canonicalBounds: bounds,
      width: next.region.width,
      minimumHeight: next.region.height,
      anchorTop,
    });
    lastExpandableInputKey = '';
    updateRichTextDraft(next, { recordHistory: false });
    queueMicrotask(resizeRichToContent);
  };

  const finishGeometryGesture = (event) => {
    if (!geometryGesture) return;
    try { event.currentTarget?.releasePointerCapture?.(event.pointerId); } catch { /* no-op */ }
    geometryGesture = null;
    queueMicrotask(() => richEditorRef?.focus({ preventScroll: true }));
  };

  const startGeometryGesture = (kind, event) => {
    const placement = editorPlacement();
    const richText = richTextDocument();
    if (!directManipulationEnabled() || !placement || !richText || !currentPlacementFrame) return;
    event.preventDefault();
    event.stopPropagation();
    const visibleBox = editorBox();
    const editorNode = richEditorRef || textareaRef;
    const paintedRect = editorNode?.getBoundingClientRect?.();
    const quarterTurn = Math.abs((
      (Number(currentPlacementFrame.rotation) || 0)
      + (Number(placement.elementRotation) || 0)
    ) % 180) === 90;
    const paintedWidth = Number(quarterTurn ? paintedRect?.height : paintedRect?.width)
      || Number(editorNode?.offsetWidth) || Number(visibleBox?.width) || 0;
    const paintedHeight = Number(quarterTurn ? paintedRect?.width : paintedRect?.height)
      || Number(editorNode?.offsetHeight) || Number(visibleBox?.height) || 0;
    const visibleBounds = {
      ...placement.canonicalBounds,
      width: Math.max(
        placement.canonicalBounds.width,
        paintedWidth / currentPlacementFrame.scale,
      ),
      height: Math.max(
        placement.canonicalBounds.height,
        paintedHeight / currentPlacementFrame.scale,
      ),
    };
    geometryGesture = {
      kind,
      clientX: event.clientX,
      clientY: event.clientY,
      // Begin from the painted box, not merely the stored minimum. Exact
      // shaping can make the live editor taller, and the corner must follow
      // the pointer from the first pixel instead of consuming that difference.
      bounds: visibleBounds,
      richText: structuredClone(richText),
      minimum: {
        width: Math.max(24 / currentPlacementFrame.scale, 12),
        height: Math.max(18 / currentPlacementFrame.scale, 8),
      },
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
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

  const caretAfterReflow = (sourceDocument, reflowedDocument, sourcePoint) => {
    let paragraph = 0;
    let paragraphOffset = 0;
    for (let index = 0; index <= sourcePoint.line; index += 1) {
      if (index === sourcePoint.line) {
        paragraphOffset += sourcePoint.offset;
        break;
      }
      paragraphOffset += sourceDocument.lines[index].runs
        .reduce((sum, run) => sum + graphemeLength(run.text), 0);
      if (sourceDocument.lines[index].breakAfter !== 'soft') {
        paragraph += 1;
        paragraphOffset = 0;
      }
    }
    let currentParagraph = 0;
    let remaining = paragraphOffset;
    for (let index = 0; index < reflowedDocument.lines.length; index += 1) {
      if (currentParagraph !== paragraph) {
        if (reflowedDocument.lines[index].breakAfter !== 'soft') currentParagraph += 1;
        continue;
      }
      const length = reflowedDocument.lines[index].runs
        .reduce((sum, run) => sum + graphemeLength(run.text), 0);
      if (remaining <= length || reflowedDocument.lines[index].breakAfter !== 'soft') {
        return { line: index, offset: Math.min(remaining, length) };
      }
      remaining -= length;
    }
    const last = reflowedDocument.lines.length - 1;
    return {
      line: last,
      offset: reflowedDocument.lines[last].runs
        .reduce((sum, run) => sum + graphemeLength(run.text), 0),
    };
  };

  const restoreRichCaret = (point) => queueMicrotask(() => {
    const target = richEditorRef?.querySelector(`[data-rich-line-index="${point.line}"]`);
    if (!target) return;
    const range = document.createRange();
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let remaining = point.offset;
    while (node) {
      const length = graphemeLength(node.textContent.replaceAll('\u200b', ''));
      if (remaining <= length) break;
      remaining -= length;
      node = walker.nextNode();
    }
    node ||= target.querySelector('[data-rich-run]')?.firstChild;
    if (!node) return;
    const codeUnits = graphemes(node.textContent.replaceAll('\u200b', ''))
      .slice(0, remaining).reduce((sum, unit) => sum + unit.length, 0);
    range.setStart(node, Math.min(codeUnits, node.textContent.length));
    range.collapse(true);
    const domSelection = window.getSelection();
    domSelection.removeAllRanges();
    domSelection.addRange(range);
    richEditorRef.focus({ preventScroll: true });
    syncRichSelection();
  });

  const insertCanonicalRichText = (insertedText) => {
    syncRichDocument();
    syncRichSelection();
    const current = richTextDocument();
    const selection = richTextSelection();
    if (!current || !selection) return false;
    const inserted = replaceTextRange(current, selection, insertedText, typingStyle());
    const expandable = editorOptions().expandableRegion;
    const next = expandable && !expandable.manualLineBreaks
      ? reflowRichTextToWidth(inserted.document,
          liveContentWidth || expandable.contentWidth || expandable.width, undefined, {
          minimumHeight: expandable.minimumHeight,
          anchorTop: expandable.anchorTop,
        })
      : inserted.document;
    const caret = next === inserted.document
      ? inserted.selection.anchor
      : caretAfterReflow(inserted.document, next, inserted.selection.anchor);
    updateRichTextDraft(next);
    updateRichTextSelection({ anchor: caret, focus: caret });
    pendingInputContext = null;
    restoreRichCaret(caret);
    return true;
  };

  const captureRichHardBreak = (event) => {
    if (!richEditorRef || !richEditorRef.contains(event.target)
        || event.key !== 'Enter' || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    insertCanonicalRichText('\n');
  };

  onMount(() => {
    document.addEventListener('selectionchange', syncRichSelection);
    document.addEventListener('keydown', captureRichHardBreak, true);
    const placementLoop = () => {
      syncPagePlacement();
      placementFrameId = requestAnimationFrame(placementLoop);
    };
    placementFrameId = requestAnimationFrame(placementLoop);
  });
  onCleanup(() => {
    document.removeEventListener('selectionchange', syncRichSelection);
    document.removeEventListener('keydown', captureRichHardBreak, true);
    if (placementFrameId) cancelAnimationFrame(placementFrameId);
    for (const attachment of editorOptions().attachedPageElements || []) {
      attachment?.element?.remove?.();
    }
  });

  const syncRichDocument = () => {
    const current = richTextDocument();
    if (!current || !richEditorRef) return;
    const pendingSelection = pendingInputContext?.selection || richTextSelection();
    const insertion = pendingInputContext?.context || richTextInsertionContext(
      current,
      pendingSelection?.anchor || { line: 0, offset: 0 },
      typingStyle(),
    );
    const fallback = insertion.runStyle;
    const fallbackLine = insertion.lineStyle;
    const currentLinesById = new Map(current.lines.map((line) => [line.id, line]));
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
    const expandable = editorOptions().expandableRegion;
    const hasStructuralChange = Boolean(plainLines)
      || lineElements.length !== current.lines.length
      || lineElements.some((line) => !currentLinesById.has(line.dataset.richLineId));
    const lines = editableLines.map((lineSource, lineIndex) => {
      const lineElement = typeof lineSource === 'string' ? null : lineSource;
      const oldLine = lineElement
        ? currentLinesById.get(lineElement.dataset.richLineId) || null
        : null;
      const baselineSign = current.region.baselineDirection === 'increasing-y' ? 1 : -1;
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
        baseline: hasStructuralChange
          ? (lineIndex === 0 ? current.lines[0].baseline
            : undefined)
          : oldLine?.baseline,
        baselineAdvance: oldLine?.baselineAdvance || fallbackLine.baselineAdvance,
        alignment: oldLine?.alignment || fallbackLine.alignment,
        // Existing source visual lines carry an explicit soft/hard marker.
        // A browser-created div has no marker and therefore represents an
        // authored Enter, which must persist as a hard break.
        breakAfter: expandable?.manualLineBreaks || plainLines
          ? 'hard' : (lineElement?.dataset.breakAfter || 'hard'),
      });
    });
    if (hasStructuralChange) {
      const baselineSign = current.region.baselineDirection === 'increasing-y' ? 1 : -1;
      for (let index = 1; index < lines.length; index += 1) {
        lines[index].baseline = lines[index - 1].baseline
          + baselineSign * lines[index - 1].baselineAdvance;
      }
    }
    const next = createRichTextDocument(lines, current.region);
    const draft = expandable && !expandable.manualLineBreaks
      ? reflowRichTextToWidth(next,
          liveContentWidth || expandable.contentWidth || expandable.width, undefined, {
          minimumHeight: expandable.minimumHeight,
          anchorTop: expandable.anchorTop,
        })
      : next;
    updateRichTextDraft(draft, { preserveDom: true });
    if (expandable) {
      exactRequiredHeight = draft.region.height;
      lastExpandableInputKey = '';
      scheduleExpandableLayout(draft);
    }
    if (editorOptions().reflowWidth) queueMicrotask(resizeRichToContent);
    queueMicrotask(syncRichSelection);
    pendingInputContext = null;
  };

  const captureRichBeforeInput = (event) => {
    const current = richTextDocument();
    if (!current || !richEditorRef?.contains(event.target)) return;
    syncRichSelection();
    const selection = richTextSelection();
    if (!selection) return;
    pendingInputContext = {
      selection: structuredClone(selection),
      context: richTextInsertionContext(current, selection.anchor, typingStyle()),
    };
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault();
      insertCanonicalRichText('\n');
    }
  };

  const insertTransferText = (event, value) => {
    if (!richEditorRef?.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    insertCanonicalRichText(String(value || '').replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
  };

  const editorBackground = () => editorOptions().expandableRegion?.editorBackground
    || editorOptions().editorBackground
    || '#ffffff';
  const runPresentation = (run) => editableRunPresentation(run.color, editorBackground());
  const richEditorStyle = () => ({
    ...liveEditorStyle(),
    background: editorBackground(),
    'padding-left': `${inkInsetsPx()?.left ?? editorOptions().expandableRegion?.inkPaddingPx ?? 0}px`,
    'padding-right': `${inkInsetsPx()?.right ?? editorOptions().expandableRegion?.inkPaddingPx ?? 0}px`,
    'font-synthesis': 'none',
  });
  const runStyle = (run) => ({
    'font-family': run.faceId.includes('mono') ? '"Liberation Mono", monospace'
      : run.faceId.includes('serif') ? '"Liberation Serif", serif' : '"Liberation Sans", sans-serif',
    'font-size': `${run.size * displayScale()}px`,
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
    return Math.max(line.baselineAdvance, shapedHeight) * displayScale();
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
        <div ref={portalRef} class="pdf-text-edit-portal" data-page={editorPlacement()?.pageNum}>
          <Show when={editorOptions().fixedRegion && commitBoundsStyle()}>
            <div class="pdf-text-edit-commit-bounds" style={commitBoundsStyle()} aria-hidden="true" />
          </Show>
          <Show when={richTextDocument()} fallback={
            <textarea
              ref={textareaRef}
              class={`pdf-text-editor${previewOverflow() ? ' pdf-text-editor-overflow' : ''}`}
              dir={editorOptions().direction || 'auto'}
              wrap={editorOptions().fixedRegion ? 'soft' : 'off'}
              spellcheck={false}
              aria-label={editorOptions().ariaLabel || 'Edit PDF text'}
              aria-multiline={editorOptions().singleLine ? 'false' : 'true'}
              aria-describedby={(editorOptions().singleLine || editorOptions().fixedRegion)
                ? 'scanned-text-edit-status' : undefined}
              style={liveEditorStyle()}
              value={text()}
              onInput={(e) => { setText(e.target.value); queueMicrotask(resizeToContent); }}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
            />
          }>
            <div
              ref={richEditorRef}
              class={`pdf-text-editor rich-text-editor${editorOptions().reflowWidth ? ' rich-text-editor-reflow' : ''}${editorOptions().expandableRegion?.manualLineBreaks ? ' rich-text-editor-manual-lines' : ''}${previewOverflow() ? ' pdf-text-editor-overflow' : ''}${editorOptions().expandableRegion && editorLayoutState()?.valid === false ? ' pdf-text-editor-rejected' : ''}`}
              contentEditable={true}
              role="textbox"
              aria-label={editorOptions().ariaLabel || 'Edit formatted PDF text'}
              aria-multiline={editorOptions().singleLine ? 'false' : 'true'}
              aria-describedby={editorOptions().expandableRegion ? 'native-text-edit-status' : undefined}
              spellcheck={false}
              style={richEditorStyle()}
              onBeforeInput={captureRichBeforeInput}
              onPaste={(event) => insertTransferText(event, event.clipboardData?.getData('text/plain'))}
              onDrop={(event) => insertTransferText(event, event.dataTransfer?.getData('text/plain'))}
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
                  data-rich-line-id={line.id}
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
          <Show when={directManipulationEnabled()}>
            <div class="pdf-text-editor-manipulation" style={manipulationStyle()} aria-hidden="false">
              <button
                type="button"
                class="pdf-text-editor-move-handle"
                aria-label="Move text box"
                title="Drag to move text box"
                onPointerDown={(event) => startGeometryGesture('move', event)}
                onPointerMove={(event) => applyGeometryGesture(event.clientX, event.clientY)}
                onPointerUp={finishGeometryGesture}
                onPointerCancel={finishGeometryGesture}
              />
              <button
                type="button"
                class="pdf-text-editor-resize-handle"
                aria-label="Resize text box"
                title="Drag to resize text box"
                onPointerDown={(event) => startGeometryGesture('resize', event)}
                onPointerMove={(event) => applyGeometryGesture(event.clientX, event.clientY)}
                onPointerUp={finishGeometryGesture}
                onPointerCancel={finishGeometryGesture}
              />
            </div>
          </Show>
        </div>
        <Show when={editorOptions().singleLine || editorOptions().fixedRegion || editorOptions().expandableRegion}>
          <div id={editorOptions().expandableRegion ? 'native-text-edit-status' : 'scanned-text-edit-status'} class="ocr-review-live-region" role="status" aria-live="polite" aria-atomic="true">
            {editorStatus() || editorOptions().status || (editorOptions().expandableRegion
              ? editorOptions().expandableRegion?.manualLineBreaks
                ? documentNeedsContrastAid(richTextDocument(), editorBackground())
                  ? 'Editing native text in a manual-line text box. Press Enter for a new line. Low-contrast source colors have an editing-only backing; saved colors remain unchanged.'
                  : 'Editing native text in a manual-line text box. Press Enter for a new line.'
                : documentNeedsContrastAid(richTextDocument(), editorBackground())
                  ? 'Editing native text. The width is fixed and the region grows downward. Low-contrast source colors have an editing-only backing; saved colors remain unchanged.'
                  : 'Editing native text. The width is fixed and the region grows downward.'
              : 'Editing scanned text. Font properties are estimates.')}
          </div>
        </Show>
      </>
    </Show>
  );
}
