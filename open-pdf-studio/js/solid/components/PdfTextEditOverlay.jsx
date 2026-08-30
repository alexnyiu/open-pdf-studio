import { For, Show, createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { active, editorMountGeneration, editorStyle, editorPlacement, text, setText, keyDownHandler, blurHandler, selectOnFocus,
  setSelectOnFocus, editorOptions, editorStatus, editorStatusKind, setEditorStatus, richTextDocument,
  richTextDraftRevision,
  editorLayoutState, setEditorLayoutState,
  richTextSelection, typingStyle, updateRichTextDraft, updateRichTextSelection,
  undoRichTextDraft, redoRichTextDraft, updateEditorGeometry,
  updateEditorValidatedLayoutGeometry,
  recordEditorGeometryHistory,
  setEditorDraftFlushHandler } from '../stores/pdfTextEditStore.js';
import {
  canonicalRichTextHash,
  createRichTextDocument,
  createTextLine,
  createTextRun,
  graphemes,
  graphemeLength,
  replaceTextRange,
  richTextInsertionContext,
  shouldInsertRichHardBreak,
} from '../../text/rich-text.js';
import { shapeRichTextDocument } from '../../text/font-catalog.js';
import { reflowRichTextToWidth } from '../../text/text-edit-selection.js';
import { createEditorLayoutRevision } from '../../text/editor-layout-revision.js';
import { cancelLatestNativeLayout, requestLatestNativeLayout } from '../../text/native-layout-scheduler.js';
import {
  disposeFinalTextLayoutSession,
  recordValidatedFinalTextLayout,
} from '../../text/final-text-layout.js';
import { textApplyResultSchedulesPersistence } from '../../text/text-apply-result.js';
import { throwIfSaveFaultInjected } from '../../pdf/save-fault-injection.js';
import {
  applyActiveTextEditing,
  cancelActiveTextEditing,
  getActiveTextEditSession,
} from '../../text/text-edit-session.js';
import { documentNeedsContrastAid, editableRunPresentation } from '../../text/text-edit-contrast.js';
import {
  applyPageTextEditProjection,
  canonicalEditorBoundsForRichText,
  canonicalDeltaFromDisplayDelta,
  clampPageTextEditBounds,
  projectCommitBounds,
  projectPageTextEditPlacement,
  shallowEqualPageTextEditProjection,
  scrollFreePreviewSize,
} from '../../text/page-text-edit-placement.js';
import {
  ensurePageTextEditHost,
  findPageTextEditHost,
  measurePageTextEditFrame,
  removeEmptyPageTextEditHosts,
} from '../../text/page-text-edit-host.js';
import {
  createPageTextEditPlacementController,
  shouldCancelPageTextEditPlacement,
} from '../../text/page-text-edit-placement-controller.js';
import { resolveEditorStatus } from '../../text/editor-status-priority.js';
import { useTranslation } from '../../i18n/useTranslation.js';
import { recordPageTextEditPlacementWrite } from '../../text/page-text-edit-metrics.js';
import {
  PATHOLOGICAL_PASTE_GRAPHEME_LIMIT,
  PATHOLOGICAL_PASTE_LINE_LIMIT,
  displayArrowDelta,
  exactExpansionCandidate,
  orderedRichTextSelectionStart,
  pathologicalPasteDetails,
  semanticRichTextSignature,
} from '../../text/pdf-text-edit-interactions.js';
import {
  consumeOutsidePointerDownForTextEdit,
  shouldApplyTextEditForOutsideFocus,
  shouldRestoreTextEditorFocusAfterHostTransition,
  textEditTargetIsWithinFocusBoundary,
  textEditTargetStartsLifecycleTransition,
} from '../../text/text-edit-focus-boundary.js';
import {
  captureTextEditClickAwayIntent,
  executeTextEditSemanticCommand,
  guardTextEditClickAwayGesture,
  replayTextEditClickAwayIntent,
} from '../../text/text-edit-click-away-intent.js';
import { acquirePageLease, releasePageLease } from '../../pdf/page-lease-registry.js';
import { showMessage } from '../../bridge.js';

async function observeCommittedTextPersistence(documentId, documentGeneration) {
  const [{ scheduleCommittedTextEditSave }, stateModule] = await Promise.all([
    import('../../pdf/saver.js'),
    import('../../core/state.js'),
  ]);
  const result = await scheduleCommittedTextEditSave(documentId, documentGeneration);
  const owner = stateModule.getDocumentById(documentId);
  if (owner) owner.lastTextSaveResult = result;
  if (result?.status === 'failed') {
    showMessage(`Your text edit is still in the document, but saving failed: ${result.errorMessage}`);
  } else if (result?.status === 'save-as-required') {
    showMessage('Your text edit is ready. Use Save As to choose where to keep the PDF.');
  }
  return result;
}

export default function PdfTextEditOverlay() {
  const { t: tHardening, language: hardeningLanguage } = useTranslation('hardening');
  let textareaRef;
  let richEditorRef;
  let portalRef;
  let portalMountTimerId = 0;
  let shapingGeneration = 0;
  let shapedSignature = '';
  let richLayoutOverflow = null;
  let richDisplayHeight = 0;
  let exactRequiredHeight = 0;
  let lastExpandableFingerprint = '';
  let liveContentWidth = 0;
  let contentResizeFrameId = 0;
  let currentPlacementFrame = null;
  let geometryGesture = null;
  let initialManipulation = null;
  let initialManipulationIdentity = '';
  let pendingInputContext = null;
  let selectionFrameId = 0;
  let outsideApplyPromise = null;
  let outsideClickAwayIntent = null;
  let outsideGestureGuard = null;
  const activeOutsidePageLeases = new Set();
  let restoreFocusAfterHostTransition = false;
  let cachedLineRevision = -1;
  const lineGraphemeOffsetCache = new Map();
  const attachmentProjections = new WeakMap();
  const [contentInsetsPx, setContentInsetsPx] = createSignal(null);
  const [projectedStyle, setProjectedStyle] = createSignal(null);
  const [placementAttached, setPlacementAttached] = createSignal(false);
  const [initialExactLayoutReady, setInitialExactLayoutReady] = createSignal(false);
  const [commitBoundsStyle, setCommitBoundsStyle] = createSignal(null);
  const [pageDisplayScale, setPageDisplayScale] = createSignal(0);
  const [previewOverflow, setPreviewOverflow] = createSignal(false);
  const [editorBox, setEditorBox] = createSignal(null);
  const [pathologicalPaste, setPathologicalPaste] = createSignal(null);
  const [pathologicalPreviewFrame, setPathologicalPreviewFrame] = createSignal(null);
  const [layoutRecovery, setLayoutRecovery] = createSignal(null);
  const [layoutRecoveryApplying, setLayoutRecoveryApplying] = createSignal(false);

  const publishContentInsetsPx = (next) => setContentInsetsPx((previous) => (
    shallowEqualPageTextEditProjection(previous, next) ? previous : next
  ));

  const publishEditorBox = (next) => setEditorBox((previous) => (
    previous?.width === next.width && previous?.height === next.height ? previous : next
  ));

  const displayScale = () => pageDisplayScale()
    || editorOptions().expandableRegion?.displayScale
    || editorOptions().displayScale
    || 1;

  const liveEditorStyle = () => projectedStyle() || editorStyle() || {};

  const boundedPathologicalPreview = (preview, editorNode) => {
    if (!pathologicalPaste() || !editorNode) {
      if (pathologicalPreviewFrame()) setPathologicalPreviewFrame(null);
      return preview;
    }
    const editorRect = editorNode.getBoundingClientRect?.();
    const hostRect = portalRef?.parentElement?.getBoundingClientRect?.();
    const viewportWidth = Math.max(240, Number(window.innerWidth) || 1024);
    const viewportHeight = Math.max(180, Number(window.innerHeight) || 768);
    const left = Number.isFinite(editorRect?.left) ? editorRect.left : 12;
    const top = Number.isFinite(editorRect?.top) ? editorRect.top : 12;
    const rightLimit = Math.min(
      Number.isFinite(hostRect?.right) && hostRect.right > left ? hostRect.right : viewportWidth - 12,
      viewportWidth - 12,
    );
    const bottomLimit = Math.min(
      Number.isFinite(hostRect?.bottom) && hostRect.bottom > top ? hostRect.bottom : viewportHeight - 12,
      viewportHeight - 12,
    );
    const maximumWidth = Math.max(96, rightLimit - left);
    // Reserve enough room for the exact-count notice and recovery controls.
    // The full canonical text remains in the scrollable
    // editor; this only bounds what Chromium paints at once.
    const maximumHeight = Math.max(64, bottomLimit - top - 92);
    const width = Math.min(preview.width, maximumWidth);
    const height = Math.min(preview.height, maximumHeight);
    const actionWidth = Math.min(Math.max(280, width), viewportWidth - 24);
    setPathologicalPreviewFrame({
      width: actionWidth,
      left: Math.max(12, Math.min(left, viewportWidth - actionWidth - 12)),
      top: Math.max(12, Math.min(top + height + 8, viewportHeight - 112)),
    });
    return { ...preview, width, height };
  };

  const placementIdentity = () => {
    const placement = editorPlacement();
    return placement
      ? `${placement.documentId}:${placement.pageNum}:${placement.generation}`
      : 'unplaced';
  };

  const editorReadyForDisplay = () => (
    (!editorPlacement() || placementAttached())
      && (!editorOptions().expandableRegion || initialExactLayoutReady())
  );

  const syncPagePlacement = () => {
    const placement = editorPlacement();
    if (!active() || !placement) {
      currentPlacementFrame = null;
      if (placementAttached()) setPlacementAttached(false);
      if (projectedStyle()) setProjectedStyle(null);
      if (commitBoundsStyle()) setCommitBoundsStyle(null);
      if (pageDisplayScale()) setPageDisplayScale(0);
      publishPlacementDebug('inactive');
      return true;
    }
    let host = findPageTextEditHost(placement);
    if (!host) {
      if (placementAttached()) setPlacementAttached(false);
      // Host creation is a DOM write. Defer all layout reads until a later
      // frame so the placement pass remains measure-then-write.
      host = ensurePageTextEditHost(placement);
      publishPlacementDebug(host ? 'host-created' : 'host-unavailable');
      return false;
    }
    const mountGeneration = String(editorMountGeneration());
    if (portalRef?.dataset?.editorMountGeneration !== mountGeneration) {
      portalRef = [...document.querySelectorAll('.pdf-text-edit-portal')]
        .find((candidate) => candidate.dataset.editorMountGeneration === mountGeneration);
    }
    // Solid assigns refs after mounting the conditional subtree. A session
    // handoff can land between that mount and this frame; retry a bounded
    // number of active frames instead of leaving the portal at its root
    // fallback position for the lifetime of the editor.
    if (!portalRef) {
      if (placementAttached()) setPlacementAttached(false);
      publishPlacementDebug('portal-missing');
      return false;
    }
    const frame = measurePageTextEditFrame(placement, host);
    if (!frame) {
      if (placementAttached()) setPlacementAttached(false);
      publishPlacementDebug('frame-unavailable');
      return false;
    }
    currentPlacementFrame = frame;
    let wrotePlacement = false;
    const previousHosts = new Set();
    for (const stalePortal of document.querySelectorAll('.pdf-text-edit-portal')) {
      if (stalePortal === portalRef) continue;
      if (stalePortal.parentElement?.classList?.contains('pdf-text-edit-layer')) {
        previousHosts.add(stalePortal.parentElement);
      }
      stalePortal.remove();
      wrotePlacement = true;
    }
    if (portalRef && portalRef.parentElement !== host) {
      const preserveFocus = restoreFocusAfterHostTransition
        || portalRef.contains(document.activeElement);
      if (portalRef.parentElement?.classList?.contains('pdf-text-edit-layer')) {
        previousHosts.add(portalRef.parentElement);
      }
      host.appendChild(portalRef);
      if (preserveFocus) {
        queueMicrotask(() => {
          if (shouldRestoreTextEditorFocusAfterHostTransition({
            portal: portalRef,
            activeElement: document.activeElement,
            body: document.body,
            documentElement: document.documentElement,
          })) (richEditorRef || textareaRef)?.focus({ preventScroll: true });
        });
      }
    }
    for (const attachment of editorOptions().attachedPageElements || []) {
      const element = attachment?.element;
      const attachmentPlacement = attachment?.placement;
      if (!element || !attachmentPlacement) continue;
      if (element.parentElement !== host) {
        if (element.parentElement?.classList?.contains('pdf-text-edit-layer')) {
          previousHosts.add(element.parentElement);
        }
        host.appendChild(element);
      }
      const attachmentStyle = projectPageTextEditPlacement(attachmentPlacement, frame);
      const previousAttachmentStyle = attachmentProjections.get(element) || null;
      if (applyPageTextEditProjection(element, attachmentStyle, previousAttachmentStyle)) {
        attachmentProjections.set(element, attachmentStyle);
        wrotePlacement = true;
      }
    }
    for (const previousHost of previousHosts) {
      if (previousHost !== host && previousHost.childElementCount === 0) previousHost.remove();
    }
    if (portalRef?.parentElement === host) restoreFocusAfterHostTransition = false;
    const nextProjectedStyle = projectPageTextEditPlacement(placement, frame);
    const nextCommitBoundsStyle = projectCommitBounds(placement, frame);
    if (!shallowEqualPageTextEditProjection(projectedStyle(), nextProjectedStyle)) {
      setProjectedStyle(nextProjectedStyle);
      wrotePlacement = true;
    }
    if (!shallowEqualPageTextEditProjection(commitBoundsStyle(), nextCommitBoundsStyle)) {
      setCommitBoundsStyle(nextCommitBoundsStyle);
      wrotePlacement = true;
    }
    const scaleChanged = pageDisplayScale() !== frame.scale;
    if (scaleChanged) setPageDisplayScale(frame.scale);
    if (wrotePlacement) recordPageTextEditPlacementWrite();
    const exactInsets = editorLayoutState()?.result?.contentInsets;
    if (exactInsets) {
      publishContentInsetsPx({
        left: exactInsets.left * frame.scale,
        right: exactInsets.right * frame.scale,
        top: exactInsets.top * frame.scale,
        bottom: exactInsets.bottom * frame.scale,
      });
    }
    if (wrotePlacement || scaleChanged) {
      queueMicrotask(() => {
        resizeToContent();
        resizeRichToContent();
      });
    }
    const attached = portalRef.parentElement === host;
    if (placementAttached() !== attached) setPlacementAttached(attached);
    publishPlacementDebug(attached ? 'attached' : 'attachment-rejected', {
      hostDocumentId: host.dataset.documentId ?? null,
      hostGeneration: host.dataset.generation ?? null,
      hostPage: host.dataset.page ?? null,
    });
    return attached;
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
      const bounded = boundedPathologicalPreview(preview, textareaRef);
      textareaRef.style.maxWidth = pathologicalPaste() ? `${bounded.width}px` : `${minWidth}px`;
      textareaRef.style.maxHeight = pathologicalPaste() ? `${bounded.height}px` : 'none';
      textareaRef.style.overflow = pathologicalPaste() ? 'auto' : 'hidden';
      textareaRef.style.width = `${bounded.width}px`;
      textareaRef.style.height = `${bounded.height}px`;
      publishEditorBox({ width: bounded.width, height: bounded.height });
      const overflowing = preview.overflowing;
      if (overflowing !== previewOverflow()) {
        setPreviewOverflow(overflowing);
      }
      return;
    }

    // wrap="off" keeps the live layout identical to the saved PDF: only an
    // explicit Enter creates a new line. Grow instead of introducing a visual
    // wrap that would disappear after saving.
    textareaRef.style.width = `${minWidth}px`;
    textareaRef.style.height = '0px';
    textareaRef.style.maxWidth = 'none';
    textareaRef.style.maxHeight = 'none';
    textareaRef.style.overflow = 'hidden';
    const preview = boundedPathologicalPreview({
      width: Math.max(minWidth, textareaRef.scrollWidth + 2),
      height: Math.max(minHeight, textareaRef.scrollHeight),
    }, textareaRef);
    textareaRef.style.height = `${preview.height}px`;
    textareaRef.style.width = `${preview.width}px`;
    if (pathologicalPaste()) {
      textareaRef.style.maxWidth = `${preview.width}px`;
      textareaRef.style.maxHeight = `${preview.height}px`;
      textareaRef.style.overflow = 'auto';
    }
    publishEditorBox({
      width: preview.width,
      height: preview.height,
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
    const bounded = boundedPathologicalPreview(preview, richEditorRef);
    richEditorRef.style.maxWidth = pathologicalPaste()
      ? `${bounded.width}px` : (manualLineBreaks ? 'none' : `${minWidth}px`);
    richEditorRef.style.maxHeight = pathologicalPaste() ? `${bounded.height}px` : 'none';
    richEditorRef.style.overflow = pathologicalPaste() ? 'auto' : 'visible';
    richEditorRef.style.width = `${bounded.width}px`;
    const nextHeight = bounded.height;
    richEditorRef.style.height = `${nextHeight}px`;
    publishEditorBox({ width: bounded.width, height: nextHeight });
    richDisplayHeight = nextHeight;
    // Rich DOM line boxes include one complete baseline advance for the final
    // line, so scrollHeight can exceed the approved region even when every
    // shaped glyph ink bound fits. Fixed-region validity comes from the exact
    // font shaper; DOM overflow remains only a preview-sizing input.
    const overflowing = Boolean(editorOptions().fixedRegion && richLayoutOverflow === true);
    if (overflowing !== previewOverflow()) {
      setPreviewOverflow(overflowing);
    }
    editorOptions().onHeightChange?.(nextHeight);
  };

  const scheduleContentResize = () => {
    const mountGeneration = editorMountGeneration();
    queueMicrotask(() => {
      if (!active() || editorMountGeneration() !== mountGeneration) return;
      resizeToContent();
      resizeRichToContent();
      if (contentResizeFrameId) cancelAnimationFrame(contentResizeFrameId);
      contentResizeFrameId = requestAnimationFrame(() => {
        contentResizeFrameId = 0;
        if (!active() || editorMountGeneration() !== mountGeneration) return;
        resizeToContent();
        resizeRichToContent();
      });
    });
  };

  const focusEditorOnOpen = () => {
    const editor = richTextDocument() ? richEditorRef : textareaRef;
    if (!active() || !editor || !selectOnFocus()) return false;
    if (!editorReadyForDisplay()) return false;
    if (editorPlacement()
        && !portalRef?.parentElement?.classList?.contains('pdf-text-edit-layer')) return false;
    editor.focus({ preventScroll: true });
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
    return true;
  };

  const placementController = createPageTextEditPlacementController({
    isActive: () => active() && Boolean(editorPlacement()),
    update: syncPagePlacement,
    afterUpdate: focusEditorOnOpen,
    // Background/occluded WKWebViews may suspend requestAnimationFrame. A
    // single dirty-cycle fallback keeps packaged automation and real tab
    // handoffs recoverable without reintroducing an idle placement loop.
    fallbackDelayMs: 100,
  });

  const markPlacementDirty = () => placementController.markDirty();
  const publishPlacementDebug = (phase, extra = {}) => {
    if (typeof window === 'undefined') return;
    const placement = editorPlacement();
    window.__pdfTextEditPlacementDebug = {
      phase,
      editorMountGeneration: editorMountGeneration(),
      placementSessionGeneration: placement?.sessionGeneration ?? null,
      documentId: placement?.documentId ?? null,
      documentGeneration: placement?.generation ?? null,
      pageNum: placement?.pageNum ?? null,
      portalMountGeneration: portalRef?.dataset?.editorMountGeneration ?? null,
      portalParentClass: portalRef?.parentElement?.className ?? null,
      portalConnected: portalRef?.isConnected === true,
      at: performance.now(),
      ...extra,
    };
  };
  const capturePortalElement = (element) => {
    portalRef = element;
    // Solid does not invoke ref callbacks with null when this keyed subtree is
    // replaced. Drop both mutually exclusive editor refs before the new child
    // mounts so queued sizing work from the previous session cannot mutate the
    // replacement session's overflow state.
    textareaRef = undefined;
    richEditorRef = undefined;
    currentPlacementFrame = null;
    richDisplayHeight = 0;
    exactRequiredHeight = 0;
    liveContentWidth = 0;
    shapedSignature = '';
    richLayoutOverflow = null;
    setEditorBox(null);
    publishContentInsetsPx(null);
    setProjectedStyle(null);
    setPlacementAttached(false);
    setInitialExactLayoutReady(!editorOptions().expandableRegion);
    setCommitBoundsStyle(null);
    setPageDisplayScale(0);
    setPreviewOverflow(false);
    setPathologicalPaste(null);
    setPathologicalPreviewFrame(null);
    const mountGeneration = editorMountGeneration();
    // The ref callback runs while Solid is still constructing the keyed
    // subtree, before the portal is connected and before cleanup from the
    // previous session is guaranteed to have completed. Try immediately for
    // ordinary mounts, then make one task-boundary attempt for fast handoffs.
    const placementScheduled = markPlacementDirty();
    publishPlacementDebug('portal-mounted', {
      placementScheduled,
      placementPending: placementController.pending,
    });
    if (portalMountTimerId) clearTimeout(portalMountTimerId);
    portalMountTimerId = setTimeout(() => {
      portalMountTimerId = 0;
      if (active() && editorMountGeneration() === mountGeneration
          && portalRef === element) {
        const scheduled = markPlacementDirty();
        publishPlacementDebug('portal-mount-task', {
          placementScheduled: scheduled,
          placementPending: placementController.pending,
        });
      }
    }, 0);
  };
  const handleViewportRevision = () => {
    // View-mode rendering can detach the current page host before the next
    // placement frame. Preserve focus only when the editor owned it before
    // that transition; property-panel and formatting focus is never stolen.
    if (portalRef?.contains(document.activeElement)) restoreFocusAfterHostTransition = true;
    if (editorPlacement()) setPlacementAttached(false);
    markPlacementDirty();
  };

  createEffect(() => {
    const editor = richTextDocument() ? richEditorRef : textareaRef;
    if (active() && editor && selectOnFocus()) {
      if (editorPlacement()) markPlacementDirty();
      else focusEditorOnOpen();
    }
  });

  const scheduleExpandableLayout = (source) => {
    const config = editorOptions().expandableRegion;
    if (!config || !source) return;
    const placement = editorPlacement();
    const session = getActiveTextEditSession();
    const draftRevision = richTextDraftRevision();
    const mountGeneration = editorMountGeneration();
    const revision = createEditorLayoutRevision(source, config, {
      sessionId: session?.sessionId,
      ownerDocumentId: session?.ownerDocumentId || placement?.documentId,
      ownerDocumentGeneration: session?.ownerDocumentGeneration,
      editorMountGeneration: mountGeneration,
      draftRevision,
      placementGeneration: placement?.sessionGeneration,
    });
    const fingerprint = revision.fingerprint;
    if (fingerprint === lastExpandableFingerprint) return;
    lastExpandableFingerprint = fingerprint;
    const sourcePlacementIdentity = placementIdentity();
    setEditorLayoutState({
      pending: true,
      valid: false,
      requestedFingerprint: fingerprint,
      validatedFingerprint: null,
      message: tHardening('textEditor.status.shaping'),
      statuses: { shaping: 'pending' },
    });
    setEditorStatus(tHardening('textEditor.status.shaping'), 'shaping');
    const workerOptions = {
      width: config.width,
      contentWidth: config.contentWidth,
      sourceWidth: config.sourceWidth,
      substitutionWidthAllowance: config.substitutionWidthAllowance,
      effectiveContentWidth: config.effectiveContentWidth,
      contentInset: config.contentInset,
      inkPadding: config.inkPadding,
      minimumHeight: config.minimumHeight,
      anchorTop: config.anchorTop,
      pageBounds: config.pageBounds,
      columnBounds: config.columnBounds,
      existingBounds: config.existingBounds,
      editId: config.editId,
      manualLineBreaks: config.manualLineBreaks === true,
    };
    void requestLatestNativeLayout(structuredClone(source), workerOptions, fingerprint).then((response) => {
      const live = richTextDocument();
      const currentSession = getActiveTextEditSession();
      if (!live || placementIdentity() !== sourcePlacementIdentity) return;
      const currentRevision = createEditorLayoutRevision(live, editorOptions().expandableRegion, {
        sessionId: currentSession?.sessionId,
        ownerDocumentId: currentSession?.ownerDocumentId || editorPlacement()?.documentId,
        ownerDocumentGeneration: currentSession?.ownerDocumentGeneration,
        editorMountGeneration: editorMountGeneration(),
        draftRevision: richTextDraftRevision(),
        placementGeneration: editorPlacement()?.sessionGeneration,
      });
      if (response.fingerprint !== fingerprint || currentRevision.fingerprint !== fingerprint) return;
      const result = response.result;
      throwIfSaveFaultInjected('before-final-text-layout-ack');
      updateEditorValidatedLayoutGeometry({
        canonicalBounds: canonicalEditorBoundsForRichText(
          result.document.region,
          editorPlacement()?.pageHeight,
        ),
        effectiveContentWidth: result.effectiveContentWidth,
      });
      const validatedRevision = createEditorLayoutRevision(
        result.document,
        editorOptions().expandableRegion,
        {
          sessionId: currentSession?.sessionId,
          ownerDocumentId: currentSession?.ownerDocumentId || editorPlacement()?.documentId,
          ownerDocumentGeneration: currentSession?.ownerDocumentGeneration,
          editorMountGeneration: editorMountGeneration(),
          draftRevision: richTextDraftRevision(),
          placementGeneration: editorPlacement()?.sessionGeneration,
        },
      );
      shapedSignature = canonicalRichTextHash(result.document);
      updateRichTextDraft(result.document, {
        recordHistory: false,
        preserveDom: true,
        advanceDraftRevision: false,
      });
      exactRequiredHeight = result.requiredHeight;
      liveContentWidth = result.contentWidth;
      publishContentInsetsPx({
        left: result.contentInsets.left * displayScale(),
        right: result.contentInsets.right * displayScale(),
        top: result.contentInsets.top * displayScale(),
        bottom: result.contentInsets.bottom * displayScale(),
      });
      const notices = [];
      const overlapNotice = tHardening('textEditor.status.overlap');
      const contrastNotice = tHardening('textEditor.status.lowContrast');
      if (result.overlapWarnings.length) {
        notices.push(overlapNotice);
      }
      if (documentNeedsContrastAid(result.document, config.editorBackground)) {
        notices.push(contrastNotice);
      }
      const message = result.valid
        ? notices.join(' ')
        : [tHardening('textEditor.status.layoutRejected', {
          reasons: result.rejectionReasons.join('; '),
        }), ...notices].join(' ');
      setEditorLayoutState({
        pending: false,
        valid: result.valid,
        sourceFingerprint: fingerprint,
        requestedFingerprint: validatedRevision.fingerprint,
        validatedFingerprint: validatedRevision.fingerprint,
        validatedRevision: validatedRevision.payload,
        message,
        result,
        statuses: {
          shaping: null,
          pageOrColumn: result.pageEdgeValid && result.columnValid
            ? null : result.rejectionReasons.join('; '),
          overflow: result.valid ? null : result.rejectionReasons.join('; '),
          overlap: result.overlapWarnings.length ? overlapNotice : null,
          contrast: documentNeedsContrastAid(result.document, config.editorBackground)
            ? contrastNotice : null,
        },
      });
      recordValidatedFinalTextLayout({
        sessionId: currentSession?.sessionId,
        draftRevision,
        fingerprint: validatedRevision.fingerprint,
        result,
      });
      setEditorStatus(message, result.valid ? 'info' : 'invalid');
      config.onDraftLayout?.(result);
      if (!initialExactLayoutReady()) {
        setInitialExactLayoutReady(true);
        markPlacementDirty();
      }
      queueMicrotask(resizeRichToContent);
    }).catch((error) => {
      if (error?.code === 'TEXT_LAYOUT_CANCELLED' || lastExpandableFingerprint !== fingerprint) return;
      const message = tHardening('textEditor.status.shapingRejected', {
        reason: error instanceof Error ? error.message : String(error),
      });
      setEditorLayoutState({
        pending: false,
        valid: false,
        requestedFingerprint: fingerprint,
        validatedFingerprint: null,
        message,
        statuses: { shaping: message },
      });
      setEditorStatus(message, 'invalid');
      if (!initialExactLayoutReady()) {
        setInitialExactLayoutReady(true);
        markPlacementDirty();
      }
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
      cancelLatestNativeLayout();
      lastExpandableFingerprint = '';
      shapedSignature = '';
      richLayoutOverflow = null;
      liveContentWidth = 0;
      exactRequiredHeight = 0;
      if (contentInsetsPx()) publishContentInsetsPx(null);
      return;
    }
    if (editorOptions().expandableRegion) {
      scheduleExpandableLayout(current);
      return;
    }
    const signature = canonicalRichTextHash(current);
    const fullyShaped = current.lines.every((line) => line.runs.every((run) => run.shaped));
    if (fullyShaped && signature === shapedSignature) return;
    richLayoutOverflow = null;
    if (editorOptions().fixedRegion && previewOverflow()) setPreviewOverflow(false);
    const sourcePlacementIdentity = placementIdentity();
    const generation = ++shapingGeneration;
    void shapeRichTextDocument(current).then((layout) => {
      const live = richTextDocument();
      if (generation !== shapingGeneration
          || placementIdentity() !== sourcePlacementIdentity || !live
          || canonicalRichTextHash(live) !== signature) return;
      shapedSignature = signature;
      richLayoutOverflow = layout.overflow;
      layout.lines.forEach((line, lineIndex) => {
        line.runs.forEach((run, runIndex) => {
          const liveRun = live.lines[lineIndex]?.runs[runIndex];
          if (!liveRun) return;
          liveRun.shaped = run.shaped;
          liveRun.geometry = run.geometry;
        });
      });
      if (layout.overflow) {
        setEditorStatus(tHardening('textEditor.status.layoutRejected', {
          reasons: layout.rejectionReasons.join('; '),
        }), 'invalid');
      } else if (editorStatus().startsWith(tHardening('textEditor.status.layoutRejectedPrefix'))) {
        setEditorStatus('');
      }
      queueMicrotask(resizeRichToContent);
    }).catch((error) => {
      if (generation === shapingGeneration) {
        richLayoutOverflow = null;
        setEditorStatus(tHardening('textEditor.status.shapingRejected', {
          reason: error instanceof Error ? error.message : String(error),
        }), 'invalid');
      }
    });
  });

  createEffect(() => {
    const isActive = active();
    const mountGeneration = editorMountGeneration();
    text();
    richTextDocument();
    editorStyle();
    editorPlacement();
    // Placement projection and display-scale updates are applied after the
    // editor subtree mounts. Re-measure once those reactive styles reach the
    // DOM so an early fallback-size measurement cannot leave a fixed-region
    // editor permanently marked as overflowing.
    projectedStyle();
    contentInsetsPx();
    pageDisplayScale();
    if (isActive && (textareaRef || richEditorRef)) scheduleContentResize();
    // Reactive listener cleanups can cancel a frame scheduled earlier in the
    // same Solid batch. Queue the authoritative dirty mark after all effects
    // for this session handoff have settled.
    if (isActive) queueMicrotask(() => {
      if (active() && editorMountGeneration() === mountGeneration) markPlacementDirty();
    });
    else {
      // The editor portal is deliberately reparented into the active page host.
      // Once moved, Solid's original <Show> anchor can no longer remove it, so
      // tear it down synchronously before the store changes document/view state.
      portalRef?.remove?.();
      portalRef = undefined;
      textareaRef = undefined;
      richEditorRef = undefined;
      queueMicrotask(() => removeEmptyPageTextEditHosts());
    }
  });

  const handleKeyDown = (e) => {
    const handler = keyDownHandler();
    if (handler) handler(e);
  };

  const handleBlur = (event) => {
    const handler = blurHandler();
    if (handler) handler(event);
    const sessionId = getActiveTextEditSession()?.sessionId;
    if (!sessionId) return;
    // WebKit reliably emits blur when focus leaves contentEditable, but some
    // programmatic and accessibility focus transfers do not also bubble a
    // focusin event through document. Re-check the settled active element so
    // both paths share the same complete portal/properties boundary policy.
    queueMicrotask(() => {
      if (!active() || getActiveTextEditSession()?.sessionId !== sessionId) return;
      const focused = document.activeElement || event?.relatedTarget;
      if (!shouldApplyTextEditForOutsideFocus({
        target: focused,
        portal: portalRef,
        documentHasFocus: document.hasFocus(),
        body: document.body,
        documentElement: document.documentElement,
      })) return;
      void applyTextEditFromOutside();
    });
  };

  const directManipulationEnabled = () => Boolean(
    editorPlacement() && editorOptions().expandableRegion?.directManipulation,
  );

  const manipulationStyle = () => {
    const style = liveEditorStyle();
    const box = editorBox();
    const placement = editorPlacement();
    const rotation = ((Number(currentPlacementFrame?.rotation) || 0)
      + (Number(placement?.elementRotation) || 0)) % 180;
    return {
      position: 'absolute',
      left: style.left,
      top: style.top,
      width: `${box?.width ?? (parseFloat(style.width) || 80)}px`,
      height: `${box?.height ?? (parseFloat(style.height) || 24)}px`,
      transform: style.transform || 'none',
      'transform-origin': style['transform-origin'] || '0 0',
      'z-index': String((Number(style['z-index']) || 1000) + 1),
      '--text-edit-resize-cursor': Math.abs(rotation) === 90 ? 'nesw-resize' : 'nwse-resize',
    };
  };

  const recoveryStyle = () => {
    const pathologicalFrame = pathologicalPreviewFrame();
    if (!pathologicalFrame) return {};
    return {
      position: 'fixed',
      left: `${pathologicalFrame.left}px`,
      top: `${pathologicalFrame.top}px`,
      width: `${pathologicalFrame.width}px`,
      'max-width': 'calc(100vw - 24px)',
      'z-index': '2147483000',
    };
  };

  const applyTextEdit = () => {
    void applyActiveTextEditing().catch((error) => {
      setEditorStatus(tHardening('textEditor.status.applyRejected', {
        reason: error instanceof Error ? error.message : String(error),
      }));
    });
  };

  const acquireOutsidePageLeases = (session, intent) => {
    const identities = [
      { pageNum: session?.pageNum, reason: 'text-edit-owner' },
      { pageNum: intent?.pageNum, reason: 'text-edit-click-away-target' },
    ];
    const leases = [];
    try {
      for (const identity of identities) {
        if (!Number.isInteger(Number(identity.pageNum)) || Number(identity.pageNum) < 1) continue;
        const lease = acquirePageLease({
          documentId: session.ownerDocumentId,
          lifecycleGeneration: session.ownerDocumentGeneration,
          pageNum: Number(identity.pageNum),
          reason: identity.reason,
        });
        leases.push(lease);
        activeOutsidePageLeases.add(lease);
      }
      return leases;
    } catch (error) {
      for (const lease of leases) {
        releasePageLease(lease);
        activeOutsidePageLeases.delete(lease);
      }
      console.warn('[text-edit] Could not retain click-away pages:', error);
      return [];
    }
  };

  const releaseOutsidePageLeases = (leases = []) => {
    for (const lease of leases) {
      releasePageLease(lease);
      activeOutsidePageLeases.delete(lease);
    }
  };

  const dispatchCapturedTextEditCommand = async (command) => {
    if (command.type === 'set-tool') {
      const [{ setTool }, stateModule] = await Promise.all([
        import('../../tools/manager.js'),
        import('../../core/state.js'),
      ]);
      setTool(command.tool);
      return stateModule.state.currentTool === command.tool;
    }
    if (command.type === 'open-panel' && command.panel === 'properties') {
      const properties = await import('../stores/propertiesStore.js');
      properties.setPanelVisible(true);
      properties.setPanelCollapsed(false);
      return true;
    }
    return false;
  };

  const applyTextEditFromOutside = (
    capturedIntent = outsideClickAwayIntent,
    capturedGuard = outsideGestureGuard,
    capturedLeases = [],
  ) => {
    if (outsideApplyPromise || !active()) {
      releaseOutsidePageLeases(capturedLeases);
      return outsideApplyPromise;
    }
    // Flush the visible control synchronously at the commit boundary. WebKit
    // can finish composition/autocorrection as focus is moving, after the last
    // ordinary input callback but before the outside pointer is handled.
    if (richEditorRef && richTextDocument()) syncRichDocument();
    else if (textareaRef) setText(textareaRef.value);
    const session = getActiveTextEditSession();
    const sessionId = session?.sessionId;
    if (!sessionId) {
      releaseOutsidePageLeases(capturedLeases);
      return null;
    }
    const ownerDocumentId = session.ownerDocumentId;
    const ownerDocumentGeneration = session.ownerDocumentGeneration;
    const refocusCurrentSession = () => queueMicrotask(() => {
      if (active() && getActiveTextEditSession()?.sessionId === sessionId) {
        (richEditorRef || textareaRef)?.focus?.({ preventScroll: true });
      }
    });
    const settleCapturedGesture = () => capturedGuard?.settled || Promise.resolve(true);
    outsideApplyPromise = applyActiveTextEditing('click-away')
      .then(async (result) => {
        // Keep ownership of the initiating pointer through its compatibility
        // click even when the successful Apply already unmounted this portal.
        await settleCapturedGesture();
        const interactionCompleted = result?.status === 'applied' || result?.status === 'noop';
        if (interactionCompleted && capturedIntent) {
          try {
            const stateModule = await import('../../core/state.js');
            const replayResult = await replayTextEditClickAwayIntent(capturedIntent, {
              applyResult: result,
              ownerIsCurrent: (intent) => {
                const owner = stateModule.getDocumentById(intent.documentId);
                return Boolean(owner
                  && stateModule.getActiveDocument() === owner
                  && (Number(owner.lifecycleGeneration) || 0) === intent.documentGeneration);
              },
              beginTextEdit: async (intent) => {
                const { startTextLayerEditAtClientPointWhenReady } = await import(
                  '../../tools/text-edit-tool.js'
                );
                return startTextLayerEditAtClientPointWhenReady({
                  pageNum: intent.pageNum,
                  clientX: intent.clientX,
                  clientY: intent.clientY,
                  preferredEditId: intent.preferredEditId,
                  preferredMarkerIds: intent.preferredMarkerIds,
                  preferredOcrLineId: intent.preferredOcrLineId,
                  preferredOcrRegionId: intent.preferredOcrRegionId,
                  preferredOcrRecognitionGeneration:
                    intent.preferredOcrRecognitionGeneration,
                });
              },
              executeSemanticCommand: (command, intent) => executeTextEditSemanticCommand(
                command,
                {
                  fallbackTarget: intent.actionTarget,
                  dispatchCommand: dispatchCapturedTextEditCommand,
                },
              ),
              indicateUnsafe: () => showMessage(
                'Your text edit was applied. Click the destructive action again to confirm it.',
              ),
            });
            const owner = stateModule.getDocumentById(ownerDocumentId);
            if (owner) owner.textEditReplayResult = replayResult;
          } catch (error) {
            console.warn('[text-edit] Click-away target replay failed:', error);
          }
        }
        // A successful commit is the authoritative persistence boundary. Do
        // not depend on an earlier dirty-state snapshot: composition and
        // editor-family adapters may finalize their draft during commit. Queue
        // persistence after replay so a second text region can establish its
        // live session before the coordinator considers heavy serialization.
        if (textApplyResultSchedulesPersistence(result)) {
          void observeCommittedTextPersistence(ownerDocumentId, ownerDocumentGeneration)
            .catch((error) => {
              console.warn('[text-edit] Click-away auto-save failed:', error);
            });
        }
        if (result?.status === 'rejected'
            && active()
            && getActiveTextEditSession()?.sessionId === sessionId) {
          const finalDecision = editorLayoutState()?.finalDecision || null;
          if (finalDecision?.status === 'blocked') {
            setLayoutRecovery(Object.freeze({ result, finalDecision }));
            setEditorStatus((finalDecision.rejectionReasons || []).join(' '), 'invalid');
          }
          refocusCurrentSession();
        } else if (result?.status === 'applied' || result?.status === 'noop') {
          setLayoutRecovery(null);
        }
        return result;
      })
      .catch(async (error) => {
        await settleCapturedGesture();
        setEditorStatus(tHardening('textEditor.status.applyRejected', {
          reason: error instanceof Error ? error.message : String(error),
        }), 'invalid');
        refocusCurrentSession();
        return false;
      })
      .finally(() => {
        capturedGuard?.dispose?.();
        releaseOutsidePageLeases(capturedLeases);
        if (outsideClickAwayIntent === capturedIntent) outsideClickAwayIntent = null;
        if (outsideGestureGuard === capturedGuard) outsideGestureGuard = null;
        outsideApplyPromise = null;
      });
    return outsideApplyPromise;
  };

  const handleOutsidePointerDown = (event) => {
    if (!active()) return;
    const target = event.target;
    const session = getActiveTextEditSession();
    if (!session?.sessionId) return;
    if (textEditTargetIsWithinFocusBoundary(target, portalRef)
        || textEditTargetStartsLifecycleTransition(target)) return;
    // The intended target and client coordinates must be immutable before the
    // pointerdown is consumed and before Apply can replace its DOM subtree.
    const intent = captureTextEditClickAwayIntent({ event, session });
    if (consumeOutsidePointerDownForTextEdit(event, portalRef)) {
      // Consume the first outside gesture so its target cannot deactivate or
      // supersede the owner session while exact validation is still finishing.
      outsideClickAwayIntent = intent;
      outsideGestureGuard = guardTextEditClickAwayGesture(intent, document);
      const pageLeases = acquireOutsidePageLeases(session, intent);
      void applyTextEditFromOutside(intent, outsideGestureGuard, pageLeases);
    }
  };

  const handleOutsideFocusIn = (event) => {
    if (!active()) return;
    const target = event.target;
    // A deliberate focus move within the broader editing boundary (zoom,
    // properties, or modal UI) supersedes any pending reparent restoration.
    if (portalRef && !portalRef.contains(target)) restoreFocusAfterHostTransition = false;
    const sessionId = getActiveTextEditSession()?.sessionId;
    if (!sessionId || !shouldApplyTextEditForOutsideFocus({
      target,
      portal: portalRef,
      documentHasFocus: document.hasFocus(),
      body: document.body,
      documentElement: document.documentElement,
    })) return;
    // A focus hand-off can pass through an outside node for one microtask.
    // Commit only if it settled outside the complete portal/properties boundary.
    queueMicrotask(() => {
      if (!active() || getActiveTextEditSession()?.sessionId !== sessionId) return;
      const focused = document.activeElement;
      if (!shouldApplyTextEditForOutsideFocus({
        target: focused,
        portal: portalRef,
        documentHasFocus: document.hasFocus(),
        body: document.body,
        documentElement: document.documentElement,
      })) return;
      void applyTextEditFromOutside();
    });
  };

  const editorGeometrySnapshot = (document = richTextDocument(), placement = editorPlacement()) => (
    document && placement ? {
      canonicalBounds: structuredClone(placement.canonicalBounds),
      width: Number(editorOptions().expandableRegion?.width) || document.region.width,
      minimumHeight: Number(editorOptions().expandableRegion?.minimumHeight) || document.region.height,
      anchorTop: Number.isFinite(editorOptions().expandableRegion?.anchorTop)
        ? editorOptions().expandableRegion.anchorTop : document.region.y + document.region.height,
    } : null
  );

  const createGeometryGesture = (kind, { paintedBounds = false } = {}) => {
    const placement = editorPlacement();
    const richText = richTextDocument();
    if (!directManipulationEnabled() || !placement || !richText || !currentPlacementFrame) return null;
    let bounds = structuredClone(placement.canonicalBounds);
    if (paintedBounds && kind === 'resize') {
      const visibleBox = editorBox();
      const editorNode = richEditorRef || textareaRef;
      const paintedRect = editorNode?.getBoundingClientRect?.();
      const quarterTurn = Math.abs(((Number(currentPlacementFrame.rotation) || 0)
        + (Number(placement.elementRotation) || 0)) % 180) === 90;
      const paintedWidth = Number(quarterTurn ? paintedRect?.height : paintedRect?.width)
        || Number(editorNode?.offsetWidth) || Number(visibleBox?.width) || 0;
      const paintedHeight = Number(quarterTurn ? paintedRect?.width : paintedRect?.height)
        || Number(editorNode?.offsetHeight) || Number(visibleBox?.height) || 0;
      bounds = {
        ...bounds,
        width: Math.max(bounds.width, paintedWidth / currentPlacementFrame.scale),
        height: Math.max(bounds.height, paintedHeight / currentPlacementFrame.scale),
      };
    }
    return {
      kind,
      bounds,
      placement: structuredClone(placement),
      richText: structuredClone(richText),
      beforeDocument: structuredClone(richText),
      beforeGeometry: editorGeometrySnapshot(richText, placement),
      minimum: kind === 'move' ? {
        width: bounds.width,
        height: bounds.height,
      } : {
        width: Math.max(24 / currentPlacementFrame.scale, 12),
        height: Math.max(18 / currentPlacementFrame.scale, 8),
      },
    };
  };

  const applyGeometryDelta = (gesture, delta) => {
    if (!gesture) return false;
    const start = gesture.bounds;
    const requested = gesture.kind === 'move' ? {
      ...start,
      x: start.x + delta.x,
      y: start.y + delta.y,
    } : {
      ...start,
      width: start.width + delta.x,
      height: start.height + delta.y,
    };
    let bounds = clampPageTextEditBounds(requested, {
      width: gesture.placement.pageWidth,
      height: gesture.placement.pageHeight,
    }, gesture.minimum);
    const column = editorOptions().expandableRegion?.columnBounds;
    if (Number.isFinite(column?.left) && Number.isFinite(column?.right)
        && column.right > column.left) {
      if (gesture.kind === 'resize') {
        const maximumWidth = Math.max(
          gesture.minimum.width,
          column.right - gesture.richText.region.x,
        );
        bounds = { ...bounds, width: Math.min(bounds.width, maximumWidth) };
      } else {
        const minimumDx = column.left - gesture.richText.region.x;
        const maximumDx = column.right
          - (gesture.richText.region.x + gesture.richText.region.width);
        const dx = Math.max(minimumDx, Math.min(maximumDx, bounds.x - start.x));
        bounds = { ...bounds, x: start.x + dx };
      }
    }
    const next = structuredClone(gesture.richText);
    if (gesture.kind === 'move') {
      const dx = bounds.x - start.x;
      const dyPdf = -(bounds.y - start.y);
      next.region.x += dx;
      next.region.y += dyPdf;
      for (const line of next.lines) line.baseline += dyPdf;
    } else {
      const anchorTop = gesture.richText.region.y + gesture.richText.region.height;
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
    lastExpandableFingerprint = '';
    updateRichTextDraft(next, { recordHistory: false });
    queueMicrotask(resizeRichToContent);
    return true;
  };

  const recordFinishedGeometryGesture = (gesture) => {
    const afterDocument = richTextDocument();
    const afterGeometry = editorGeometrySnapshot(afterDocument, editorPlacement());
    if (!gesture?.beforeDocument || !gesture.beforeGeometry || !afterDocument || !afterGeometry) return;
    if (JSON.stringify(gesture.beforeGeometry) === JSON.stringify(afterGeometry)
        && JSON.stringify(gesture.beforeDocument) === JSON.stringify(afterDocument)) return;
    recordEditorGeometryHistory({
      beforeDocument: gesture.beforeDocument,
      afterDocument,
      beforeGeometry: gesture.beforeGeometry,
      afterGeometry,
    });
  };

  const applyGeometryGesture = (event) => {
    if (!geometryGesture || !currentPlacementFrame
        || geometryGesture.pointerId !== event.pointerId) return;
    const delta = canonicalDeltaFromDisplayDelta({
      x: event.clientX - geometryGesture.clientX,
      y: event.clientY - geometryGesture.clientY,
    }, currentPlacementFrame);
    applyGeometryDelta(geometryGesture, delta);
  };

  const finishGeometryGesture = (event) => {
    if (!geometryGesture || geometryGesture.pointerId !== event.pointerId) return;
    const completed = geometryGesture;
    geometryGesture = null;
    try { event.currentTarget?.releasePointerCapture?.(event.pointerId); } catch { /* no-op */ }
    recordFinishedGeometryGesture(completed);
  };

  const cancelGeometryGesture = (event) => {
    if (!geometryGesture || geometryGesture.pointerId !== event.pointerId) return;
    const cancelled = geometryGesture;
    geometryGesture = null;
    try { event.currentTarget?.releasePointerCapture?.(event.pointerId); } catch { /* no-op */ }
    updateEditorGeometry(cancelled.beforeGeometry);
    updateRichTextDraft(cancelled.beforeDocument, { recordHistory: false });
    lastExpandableFingerprint = '';
    queueMicrotask(resizeRichToContent);
  };

  const startGeometryGesture = (kind, event) => {
    const gesture = createGeometryGesture(kind, { paintedBounds: true });
    if (!gesture) return;
    event.preventDefault();
    event.stopPropagation();
    setPathologicalPaste(null);
    geometryGesture = {
      ...gesture,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleGeometryKeyDown = (kind, event) => {
    const displayDelta = displayArrowDelta(event.key, (event.shiftKey ? 10 : 1)
      * (currentPlacementFrame?.scale || 1));
    if (!displayDelta || !currentPlacementFrame) return;
    const gesture = createGeometryGesture(kind);
    if (!gesture) return;
    event.preventDefault();
    event.stopPropagation();
    setPathologicalPaste(null);
    const canonicalDelta = canonicalDeltaFromDisplayDelta(displayDelta, currentPlacementFrame);
    if (applyGeometryDelta(gesture, canonicalDelta)) recordFinishedGeometryGesture(gesture);
  };

  createEffect(() => {
    const placement = editorPlacement();
    const document = richTextDocument();
    const identity = placement
      ? `${placement.documentId}:${placement.pageNum}:${placement.sessionGeneration}` : '';
    if (!directManipulationEnabled() || !placement || !document) {
      initialManipulation = null;
      initialManipulationIdentity = '';
      return;
    }
    if (identity === initialManipulationIdentity) return;
    initialManipulationIdentity = identity;
    initialManipulation = {
      document: structuredClone(document),
      geometry: editorGeometrySnapshot(document, placement),
    };
  });

  const resetGeometryFromHandle = (kind, event) => {
    const gesture = createGeometryGesture(kind);
    if (!gesture || !initialManipulation?.geometry) return;
    event.preventDefault();
    event.stopPropagation();
    setPathologicalPaste(null);
    const target = initialManipulation.geometry.canonicalBounds;
    const delta = kind === 'move' ? {
      x: target.x - gesture.bounds.x,
      y: target.y - gesture.bounds.y,
    } : {
      x: target.width - gesture.bounds.width,
      y: target.height - gesture.bounds.height,
    };
    if (applyGeometryDelta(gesture, delta)) recordFinishedGeometryGesture(gesture);
  };

  const graphemeOffsetsForLine = (line) => {
    const revision = richTextDraftRevision();
    if (cachedLineRevision !== revision) {
      cachedLineRevision = revision;
      lineGraphemeOffsetCache.clear();
    }
    const lineIndex = Number(line.dataset.richLineIndex);
    const value = line.textContent.replaceAll('\u200b', '');
    const cached = lineGraphemeOffsetCache.get(lineIndex);
    if (cached?.value === value) return cached.offsets;
    const offsets = [0];
    let codeUnits = 0;
    for (const unit of graphemes(value)) {
      codeUnits += unit.length;
      offsets.push(codeUnits);
    }
    lineGraphemeOffsetCache.set(lineIndex, { value, offsets });
    return offsets;
  };

  const rawOffsetForCanonicalCodeUnits = (value, canonicalTarget) => {
    let canonicalOffset = 0;
    let rawOffset = 0;
    while (rawOffset < value.length && canonicalOffset < canonicalTarget) {
      if (value[rawOffset] !== '\u200b') canonicalOffset += 1;
      rawOffset += 1;
    }
    return rawOffset;
  };

  const pointFromDom = (node, offset) => {
    if (!richEditorRef || !node) return null;
    // WebKit represents Select All on a contenteditable as a range whose
    // endpoints are the editor root (offset 0 through childElementCount), not
    // as endpoints inside the first and last text nodes. Translate those root
    // boundaries explicitly so a following paste replaces the whole canonical
    // document instead of reusing a stale caret selection.
    if (node === richEditorRef) {
      const lineElements = [...richEditorRef.querySelectorAll(':scope > [data-rich-line-index]')];
      if (lineElements.length === 0) return null;
      if (offset <= 0) {
        return { line: Number(lineElements[0].dataset.richLineIndex), offset: 0 };
      }
      const line = lineElements[Math.min(lineElements.length - 1, offset - 1)];
      const graphemeOffsets = graphemeOffsetsForLine(line);
      return {
        line: Number(line.dataset.richLineIndex),
        offset: Math.max(0, graphemeOffsets.length - 1),
      };
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const line = element?.closest?.('[data-rich-line-index]');
    if (!line || !richEditorRef.contains(line)) return null;
    const range = document.createRange();
    range.setStart(line, 0);
    try { range.setEnd(node, offset); } catch { return null; }
    const prefixCodeUnits = range.toString().replaceAll('\u200b', '').length;
    const offsets = graphemeOffsetsForLine(line);
    let low = 0;
    let high = offsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsets[middle] <= prefixCodeUnits) low = middle + 1;
      else high = middle;
    }
    return {
      line: Number(line.dataset.richLineIndex),
      offset: Math.max(0, low - 1),
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
    const offsets = graphemeOffsetsForLine(target);
    let remainingCodeUnits = offsets[Math.max(0, Math.min(point.offset, offsets.length - 1))];
    while (node) {
      const length = node.textContent.replaceAll('\u200b', '').length;
      if (remainingCodeUnits <= length) break;
      remainingCodeUnits -= length;
      node = walker.nextNode();
    }
    node ||= target.querySelector('[data-rich-run]')?.firstChild;
    if (!node) return;
    const rawOffset = rawOffsetForCanonicalCodeUnits(node.textContent, remainingCodeUnits);
    range.setStart(node, Math.min(rawOffset, node.textContent.length));
    range.collapse(true);
    const domSelection = window.getSelection();
    domSelection.removeAllRanges();
    domSelection.addRange(range);
    richEditorRef.focus({ preventScroll: true });
    syncRichSelection();
  });

  const insertCanonicalRichText = (insertedText, { historyKind = 'typing' } = {}) => {
    // Capture the live DOM selection before synchronizing content. A Solid
    // draft update can reconcile the editable DOM and collapse a root-level
    // Select All range, which would otherwise turn paste into insertion at an
    // older caret.
    syncRichSelection();
    syncRichDocument();
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
    updateRichTextDraft(next, { historyKind });
    updateRichTextSelection({ anchor: caret, focus: caret });
    pendingInputContext = null;
    restoreRichCaret(caret);
    return true;
  };

  const captureRichHardBreak = (event) => {
    if (!richEditorRef || !richEditorRef.contains(event.target)
        || !shouldInsertRichHardBreak(event, {
          singleLine: editorOptions().singleLine === true,
        })) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setPathologicalPaste(null);
    insertCanonicalRichText('\n');
  };

  const scheduleSelectionSync = () => {
    if (selectionFrameId) return;
    selectionFrameId = requestAnimationFrame(() => {
      selectionFrameId = 0;
      syncRichSelection();
    });
  };

  // Global listeners and geometry observers exist only for an active editor.
  createEffect(() => {
    if (!active()) return;
    // Session identity, not each immutable rich-text draft revision, owns the
    // listener lifecycle. Reinstalling listeners on every keystroke used to
    // cancel the placement frame that was about to attach the portal.
    const observedMountGeneration = editorMountGeneration();
    // Placement geometry is replaced after exact layout, scroll projection,
    // and direct manipulation. Those updates belong to the same editor
    // session and must not tear down/reinstall the document listeners. The
    // mount generation is the reactive session key; read the placement only
    // for cleanup ownership evidence.
    const observedSessionGeneration = untrack(editorPlacement)?.sessionGeneration ?? null;
    const richEditorActive = Boolean(untrack(richTextDocument));
    const observer = typeof ResizeObserver === 'undefined'
      ? null : new ResizeObserver(markPlacementDirty);
    let observedPageContainer = null;
    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null : new MutationObserver(() => {
        // Container replacement may blur a reparented contentEditable before
        // the next placement frame can inspect document.activeElement. Capture
        // focus ownership at the mutation boundary; ordinary geometry/scroll
        // dirtying never sets this flag and therefore never steals focus.
        if (portalRef?.contains(document.activeElement)) {
          restoreFocusAfterHostTransition = true;
        }
        observePlacementContainers();
        markPlacementDirty();
      });
    const observePlacementContainers = () => {
      if (!mutationObserver) return;
      const placement = editorPlacement();
      const singleContainer = document.getElementById('canvas-container');
      const continuousRoot = document.getElementById('continuous-container');
      const pageContainer = placement
        ? document.querySelector(
          `.page-wrapper[data-page="${placement.pageNum}"] .canvas-container-cont`,
        )
        : null;
      if (singleContainer) mutationObserver.observe(singleContainer, { childList: true });
      if (continuousRoot) mutationObserver.observe(continuousRoot, { childList: true });
      if (pageContainer && pageContainer !== observedPageContainer) {
        observedPageContainer = pageContainer;
        mutationObserver.observe(pageContainer, { childList: true });
      }
    };
    queueMicrotask(() => {
      if (!active()) return;
      observePlacementContainers();
      if (portalRef?.parentElement) observer?.observe(portalRef.parentElement);
      if (richEditorRef || textareaRef) observer?.observe(richEditorRef || textareaRef);
      markPlacementDirty();
    });
    if (richEditorActive) {
      document.addEventListener('selectionchange', scheduleSelectionSync);
      document.addEventListener('keydown', captureRichHardBreak, true);
    }
    document.addEventListener('scroll', markPlacementDirty, true);
    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    document.addEventListener('focusin', handleOutsideFocusIn, true);
    window.addEventListener('resize', markPlacementDirty);
    window.addEventListener('opds:viewport-revision', handleViewportRevision);
    window.addEventListener('opds:page-rendered', markPlacementDirty);
    window.addEventListener('opds:page-edit-ready', markPlacementDirty);
    window.addEventListener('opds:dpr-change', markPlacementDirty);
    onCleanup(() => {
      if (richEditorActive) {
        document.removeEventListener('selectionchange', scheduleSelectionSync);
        document.removeEventListener('keydown', captureRichHardBreak, true);
      }
      document.removeEventListener('scroll', markPlacementDirty, true);
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
      document.removeEventListener('focusin', handleOutsideFocusIn, true);
      window.removeEventListener('resize', markPlacementDirty);
      window.removeEventListener('opds:viewport-revision', handleViewportRevision);
      window.removeEventListener('opds:page-rendered', markPlacementDirty);
      window.removeEventListener('opds:page-edit-ready', markPlacementDirty);
      window.removeEventListener('opds:dpr-change', markPlacementDirty);
      observer?.disconnect();
      mutationObserver?.disconnect();
      if (selectionFrameId) cancelAnimationFrame(selectionFrameId);
      selectionFrameId = 0;
      restoreFocusAfterHostTransition = false;
      if (shouldCancelPageTextEditPlacement({
        active: active(),
        observedMountGeneration,
        currentMountGeneration: editorMountGeneration(),
        observedSessionGeneration,
        currentSessionGeneration: editorPlacement()?.sessionGeneration ?? null,
      })) placementController.cancel();
    });
  });

  onCleanup(() => {
    if (portalMountTimerId) clearTimeout(portalMountTimerId);
    portalMountTimerId = 0;
    if (contentResizeFrameId) cancelAnimationFrame(contentResizeFrameId);
    contentResizeFrameId = 0;
    placementController.dispose();
    cancelLatestNativeLayout();
    const sessionId = getActiveTextEditSession()?.sessionId;
    if (sessionId) disposeFinalTextLayoutSession(sessionId);
    setEditorDraftFlushHandler(null);
    outsideGestureGuard?.dispose?.();
    releaseOutsidePageLeases([...activeOutsidePageLeases]);
    setLayoutRecovery(null);
    for (const attachment of editorOptions().attachedPageElements || []) {
      attachment?.element?.remove?.();
    }
    queueMicrotask(() => removeEmptyPageTextEditHosts());
  });

  const syncRichDocument = () => {
    const current = richTextDocument();
    if (!current || !richEditorRef) return;
    const pendingSelection = pendingInputContext?.selection || richTextSelection();
    const insertion = pendingInputContext?.context || richTextInsertionContext(
      current,
      pendingSelection ? orderedRichTextSelectionStart(pendingSelection) : { line: 0, offset: 0 },
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
    let authoredChanged = true;
    try {
      authoredChanged = canonicalRichTextHash(draft) !== canonicalRichTextHash(current);
    } catch {
      authoredChanged = true;
    }
    updateRichTextDraft(draft, {
      preserveDom: true,
      advanceDraftRevision: authoredChanged,
    });
    if (expandable) {
      exactRequiredHeight = draft.region.height;
      lastExpandableFingerprint = '';
      scheduleExpandableLayout(draft);
    }
    // Manual-line native drafts do not reflow, so their live outline must be
    // resized from the just-edited DOM before the asynchronous exact-layout
    // result returns. Exact validation still owns whether Apply is allowed.
    if (editorOptions().reflowWidth || expandable) queueMicrotask(resizeRichToContent);
    queueMicrotask(syncRichSelection);
    pendingInputContext = null;
  };

  createEffect(() => {
    if (!active()) {
      setEditorDraftFlushHandler(null);
      return;
    }
    const mountGeneration = editorMountGeneration();
    setEditorDraftFlushHandler(() => {
      if (!active() || editorMountGeneration() !== mountGeneration) return false;
      if (richEditorRef && richTextDocument()) syncRichDocument();
      else if (textareaRef) setText(textareaRef.value);
      return true;
    });
    onCleanup(() => setEditorDraftFlushHandler(null));
  });

  const captureRichBeforeInput = (event) => {
    const current = richTextDocument();
    if (!current || !richEditorRef?.contains(event.target)) return;
    syncRichSelection();
    const selection = richTextSelection();
    if (!selection) return;
    setPathologicalPaste(null);
    pendingInputContext = {
      selection: structuredClone(selection),
      context: richTextInsertionContext(
        current,
        orderedRichTextSelectionStart(selection),
        typingStyle(),
      ),
    };
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault();
      insertCanonicalRichText('\n');
    }
  };

  const placeRichDropCaret = (clientX, clientY) => {
    if (!richEditorRef || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
    let node = null;
    let offset = 0;
    const position = document.caretPositionFromPoint?.(clientX, clientY);
    if (position) {
      node = position.offsetNode;
      offset = position.offset;
    } else {
      const caretRange = document.caretRangeFromPoint?.(clientX, clientY);
      node = caretRange?.startContainer || null;
      offset = caretRange?.startOffset || 0;
    }
    if (!node || !richEditorRef.contains(node)) return false;
    const range = document.createRange();
    try {
      if (node === richEditorRef) {
        const lineElements = [...richEditorRef.children];
        if (lineElements.length === 0) return false;
        const atStart = offset <= 0;
        const line = atStart
          ? lineElements[0] : lineElements[Math.min(lineElements.length - 1, offset - 1)];
        range.selectNodeContents(line);
        range.collapse(atStart);
      } else {
        range.setStart(node, offset);
        range.collapse(true);
      }
    } catch { return false; }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    syncRichSelection();
    return true;
  };

  const rememberPathologicalPaste = (details, recovery) => {
    if (!details.pathological) return;
    setPathologicalPaste({
      ...details,
      ...recovery,
      semanticSignature: recovery.kind === 'rich'
        ? semanticRichTextSignature(richTextDocument()) : null,
    });
    queueMicrotask(() => {
      resizeToContent();
      resizeRichToContent();
    });
  };

  const insertTransferText = (event, value, { atDropPoint = false } = {}) => {
    if (!richEditorRef?.contains(event.target) || typeof value !== 'string' || value.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    // A drop is coordinate-owned. If WebKit cannot resolve that coordinate to
    // this editor, fail closed instead of inserting at an unrelated stale
    // selection.
    if (atDropPoint && !placeRichDropCaret(event.clientX, event.clientY)) return;
    const details = pathologicalPasteDetails(value);
    if (insertCanonicalRichText(details.text, { historyKind: 'paste' })) {
      rememberPathologicalPaste(details, { kind: 'rich' });
    }
  };

  const handlePlainPaste = (event) => {
    const details = pathologicalPasteDetails(event.clipboardData?.getData('text/plain'));
    if (!details.pathological || !textareaRef) return;
    event.preventDefault();
    event.stopPropagation();
    const beforeText = text();
    const start = Math.max(0, Number(textareaRef.selectionStart) || 0);
    const end = Math.max(start, Number(textareaRef.selectionEnd) || start);
    const nextText = `${beforeText.slice(0, start)}${details.text}${beforeText.slice(end)}`;
    const caret = start + details.text.length;
    setText(nextText);
    rememberPathologicalPaste(details, {
      kind: 'plain',
      beforeText,
      beforeSelection: { start, end },
      afterText: nextText,
    });
    queueMicrotask(() => {
      textareaRef?.setSelectionRange?.(caret, caret);
      resizeToContent();
    });
  };

  const undoPathologicalPaste = () => {
    const recovery = pathologicalPaste();
    if (!recovery) return;
    if (recovery.kind === 'rich') {
      undoRichTextDraft();
    } else if (recovery.kind === 'plain') {
      setText(recovery.beforeText);
      queueMicrotask(() => {
        textareaRef?.setSelectionRange?.(
          recovery.beforeSelection.start,
          recovery.beforeSelection.end,
        );
        textareaRef?.focus?.({ preventScroll: true });
      });
    }
    setPathologicalPaste(null);
    queueMicrotask(() => {
      resizeToContent();
      resizeRichToContent();
    });
  };

  const approvedExpansion = () => exactExpansionCandidate({
    placement: editorPlacement(),
    layoutState: editorLayoutState(),
    columnBounds: editorOptions().expandableRegion?.columnBounds,
  });

  const layoutRecoveryExpansion = () => (
    layoutRecovery()?.result?.recoveryActions?.includes('expand-to-fit')
      ? approvedExpansion() : null
  );

  const keepEditingAfterLayoutBlock = () => {
    setLayoutRecovery(null);
    setEditorStatus('');
    queueMicrotask(() => (richEditorRef || textareaRef)?.focus?.({ preventScroll: true }));
  };

  const insertLineBreakAfterLayoutBlock = () => {
    if (richEditorRef && richTextDocument()) {
      insertCanonicalRichText('\n');
    } else if (textareaRef) {
      const start = Math.max(0, Number(textareaRef.selectionStart) || 0);
      const end = Math.max(start, Number(textareaRef.selectionEnd) || start);
      const value = text();
      setText(`${value.slice(0, start)}\n${value.slice(end)}`);
      queueMicrotask(() => textareaRef?.setSelectionRange?.(start + 1, start + 1));
    }
    keepEditingAfterLayoutBlock();
  };

  const expandAfterLayoutBlock = async () => {
    if (layoutRecoveryApplying()) return;
    const candidate = layoutRecoveryExpansion();
    const gesture = createGeometryGesture('resize');
    if (!candidate || !gesture) return;
    setLayoutRecoveryApplying(true);
    try {
      if (outsideApplyPromise) await outsideApplyPromise;
      const delta = {
        x: candidate.width - gesture.bounds.width,
        y: candidate.height - gesture.bounds.height,
      };
      setLayoutRecovery(null);
      if (!applyGeometryDelta(gesture, delta)) return;
      recordFinishedGeometryGesture(gesture);
      const session = getActiveTextEditSession();
      const result = await applyActiveTextEditing('layout-recovery-expand');
      if (textApplyResultSchedulesPersistence(result) && session) {
        void observeCommittedTextPersistence(
          session.ownerDocumentId,
          session.ownerDocumentGeneration,
        )
          .catch((error) => console.warn('[text-edit] Layout recovery save failed:', error));
      } else if (result?.status === 'rejected') {
        const finalDecision = editorLayoutState()?.finalDecision || null;
        if (finalDecision?.status === 'blocked') {
          setLayoutRecovery(Object.freeze({ result, finalDecision }));
        }
      }
    } finally {
      setLayoutRecoveryApplying(false);
    }
  };

  const layoutRecoveryMessage = () => {
    const decision = layoutRecovery()?.finalDecision;
    return (decision?.rejectionReasons || []).join(' ')
      || 'This text cannot fit within its current page constraints. Keep editing or insert a line break.';
  };

  const expandPathologicalPasteBox = () => {
    const candidate = approvedExpansion();
    const gesture = createGeometryGesture('resize');
    if (!candidate || !gesture) return;
    const delta = {
      x: candidate.width - gesture.bounds.width,
      y: candidate.height - gesture.bounds.height,
    };
    setPathologicalPaste(null);
    if (applyGeometryDelta(gesture, delta)) recordFinishedGeometryGesture(gesture);
  };

  const pathologicalPasteMessage = () => {
    const recovery = pathologicalPaste();
    if (!recovery) return '';
    const locale = hardeningLanguage();
    const thresholds = [
      recovery.overGraphemeLimit && tHardening('textEditor.pathologicalPaste.graphemeThreshold', {
        limit: PATHOLOGICAL_PASTE_GRAPHEME_LIMIT.toLocaleString(locale),
      }),
      recovery.overLineLimit && tHardening('textEditor.pathologicalPaste.lineThreshold', {
        limit: PATHOLOGICAL_PASTE_LINE_LIMIT.toLocaleString(locale),
      }),
    ].filter(Boolean);
    const formattedThresholds = new Intl.ListFormat(locale, {
      style: 'long',
      type: 'conjunction',
    }).format(thresholds);
    return tHardening(approvedExpansion()
      ? 'textEditor.pathologicalPaste.messageWithExpansion'
      : 'textEditor.pathologicalPaste.message', {
      graphemeCount: recovery.graphemeCount.toLocaleString(locale),
      lineCount: recovery.lineCount.toLocaleString(locale),
      thresholds: formattedThresholds,
    });
  };

  const visibleEditorStatus = () => resolveEditorStatus({
    editorStatus: editorStatus(),
    statusKind: editorStatusKind(),
    layoutState: editorLayoutState(),
    pathologicalStatus: pathologicalPaste() ? pathologicalPasteMessage() : '',
    previewOverflow: previewOverflow(),
    overflowStatus: tHardening('textEditor.status.ocrOverflow'),
    defaultStatus: editorOptions().status || (editorOptions().expandableRegion
      ? editorOptions().expandableRegion?.manualLineBreaks
        ? documentNeedsContrastAid(richTextDocument(), editorBackground())
          ? tHardening('textEditor.status.nativeManualContrast')
          : tHardening('textEditor.status.nativeManual')
        : documentNeedsContrastAid(richTextDocument(), editorBackground())
          ? tHardening('textEditor.status.nativeGrowingContrast')
          : tHardening('textEditor.status.nativeGrowing')
      : tHardening('textEditor.status.scannedEstimate')),
  });

  createEffect(() => {
    const recovery = pathologicalPaste();
    const document = richTextDocument();
    if (recovery?.kind === 'rich' && document
        && recovery.semanticSignature !== semanticRichTextSignature(document)) {
      setPathologicalPaste(null);
    }
  });

  const editorBackground = () => editorOptions().expandableRegion?.editorBackground
    || editorOptions().editorBackground
    || '#ffffff';
  const runPresentation = (run) => editableRunPresentation(run.color, editorBackground());
  const richEditorStyle = () => {
    const base = liveEditorStyle();
    const box = editorBox();
    const manualLineBreaks = editorOptions().expandableRegion?.manualLineBreaks === true;
    return {
      ...base,
      background: editorBackground(),
      'padding-left': `${contentInsetsPx()?.left
        ?? editorOptions().expandableRegion?.contentInsetPx ?? 0}px`,
      'padding-right': `${contentInsetsPx()?.right
        ?? editorOptions().expandableRegion?.contentInsetPx ?? 0}px`,
      'padding-top': `${contentInsetsPx()?.top
        ?? editorOptions().expandableRegion?.contentInsetPx ?? 0}px`,
      'padding-bottom': `${contentInsetsPx()?.bottom
        ?? editorOptions().expandableRegion?.contentInsetPx ?? 0}px`,
      'font-synthesis': 'none',
      'max-width': pathologicalPaste() && box
        ? `${box.width}px` : (manualLineBreaks ? 'none' : base['max-width']),
      'max-height': pathologicalPaste() && box ? `${box.height}px` : 'none',
      ...(box ? {
        width: `${box.width}px`,
        height: `${box.height}px`,
      } : {}),
    };
  };
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
    <Show when={active() ? editorMountGeneration() : 0} keyed>
      {() => <>
        <div ref={capturePortalElement} class="pdf-text-edit-portal" data-page={editorPlacement()?.pageNum}
          data-placement-ready={editorReadyForDisplay() ? 'true' : 'false'}
          style={{ visibility: editorReadyForDisplay() ? 'visible' : 'hidden' }}
          data-editor-mount-generation={editorMountGeneration()}
          data-text-edit-focus-boundary="true">
          <Show when={editorOptions().fixedRegion && commitBoundsStyle()}>
            <div class="pdf-text-edit-commit-bounds" style={commitBoundsStyle()} aria-hidden="true" />
          </Show>
          <Show when={richTextDocument()} fallback={
            <textarea
              ref={textareaRef}
              class={`pdf-text-editor${previewOverflow() ? ' pdf-text-editor-overflow' : ''}${pathologicalPaste() ? ' pdf-text-editor-pathological-paste' : ''}`}
              dir={editorOptions().direction || 'auto'}
              wrap={editorOptions().fixedRegion ? 'soft' : 'off'}
              spellcheck={false}
              aria-label={editorOptions().ariaLabel || tHardening('textEditor.aria.editPlain')}
              aria-multiline={editorOptions().singleLine ? 'false' : 'true'}
              aria-describedby={[
                (editorOptions().singleLine || editorOptions().fixedRegion)
                  && 'scanned-text-edit-status',
                pathologicalPaste() && 'pdf-text-pathological-paste-status',
                layoutRecovery() && 'pdf-text-layout-recovery-status',
              ].filter(Boolean).join(' ') || undefined}
              style={liveEditorStyle()}
              value={text()}
              onInput={(e) => {
                if (pathologicalPaste()?.kind === 'plain'
                    && e.target.value !== pathologicalPaste().afterText) setPathologicalPaste(null);
                setText(e.target.value);
                queueMicrotask(resizeToContent);
              }}
              onPaste={handlePlainPaste}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
            />
          }>
            <div
              ref={richEditorRef}
              class={`pdf-text-editor rich-text-editor${editorOptions().reflowWidth ? ' rich-text-editor-reflow' : ''}${editorOptions().expandableRegion?.manualLineBreaks ? ' rich-text-editor-manual-lines' : ''}${previewOverflow() ? ' pdf-text-editor-overflow' : ''}${pathologicalPaste() ? ' pdf-text-editor-pathological-paste' : ''}${editorOptions().expandableRegion && editorLayoutState()?.valid === false ? ' pdf-text-editor-rejected' : ''}`}
              contentEditable={true}
              dir={editorOptions().direction || 'auto'}
              role="textbox"
              aria-label={editorOptions().ariaLabel || tHardening('textEditor.aria.editFormatted')}
              aria-multiline={editorOptions().singleLine ? 'false' : 'true'}
              aria-describedby={[
                editorOptions().expandableRegion && 'native-text-edit-status',
                pathologicalPaste() && 'pdf-text-pathological-paste-status',
                layoutRecovery() && 'pdf-text-layout-recovery-status',
              ].filter(Boolean).join(' ') || undefined}
              spellcheck={false}
              style={richEditorStyle()}
              onBeforeInput={captureRichBeforeInput}
              onPaste={(event) => insertTransferText(event, event.clipboardData?.getData('text/plain'))}
              onDrop={(event) => insertTransferText(
                event,
                event.dataTransfer?.getData('text/plain'),
                { atDropPoint: true },
              )}
              onInput={syncRichDocument}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelActiveTextEditing('escape');
                  return;
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.stopPropagation();
                  applyTextEdit();
                  return;
                }
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
                aria-label={tHardening('textEditor.handles.move')}
                title={tHardening('textEditor.handles.moveHint')}
                onPointerDown={(event) => startGeometryGesture('move', event)}
                onPointerMove={applyGeometryGesture}
                onPointerUp={finishGeometryGesture}
                onPointerCancel={cancelGeometryGesture}
                onLostPointerCapture={finishGeometryGesture}
                onKeyDown={(event) => handleGeometryKeyDown('move', event)}
                onDblClick={(event) => resetGeometryFromHandle('move', event)}
              />
              <button
                type="button"
                class="pdf-text-editor-resize-handle"
                aria-label={tHardening('textEditor.handles.resize')}
                title={tHardening('textEditor.handles.resizeHint')}
                onPointerDown={(event) => startGeometryGesture('resize', event)}
                onPointerMove={applyGeometryGesture}
                onPointerUp={finishGeometryGesture}
                onPointerCancel={cancelGeometryGesture}
                onLostPointerCapture={finishGeometryGesture}
                onKeyDown={(event) => handleGeometryKeyDown('resize', event)}
                onDblClick={(event) => resetGeometryFromHandle('resize', event)}
              />
            </div>
          </Show>
          <Show when={pathologicalPaste()}>
            <div
              id="pdf-text-pathological-paste-status"
              class="pdf-text-editor-paste-recovery"
              style={recoveryStyle()}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-grapheme-count={pathologicalPaste().graphemeCount}
              data-line-count={pathologicalPaste().lineCount}
            >
              <span>{pathologicalPasteMessage()}</span>
              <div class="pdf-text-editor-paste-actions">
                <button type="button" onClick={undoPathologicalPaste}>
                  {tHardening('textEditor.pathologicalPaste.undo')}
                </button>
                <Show when={approvedExpansion()}>
                  <button type="button" onClick={expandPathologicalPasteBox}>
                    {tHardening('textEditor.pathologicalPaste.expand')}
                  </button>
                </Show>
              </div>
            </div>
          </Show>
          <Show when={layoutRecovery()}>
            <div
              id="pdf-text-layout-recovery-status"
              class="pdf-text-editor-paste-recovery pdf-text-editor-layout-recovery"
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              data-rejection-code={layoutRecovery().finalDecision?.rejectionCode || ''}
            >
              <span>{layoutRecoveryMessage()}</span>
              <div class="pdf-text-editor-paste-actions">
                <button type="button" onClick={keepEditingAfterLayoutBlock}>
                  Keep editing
                </button>
                <Show when={layoutRecovery().result?.recoveryActions?.includes('insert-line-break')}>
                  <button type="button" onClick={insertLineBreakAfterLayoutBlock}>
                    Insert line break
                  </button>
                </Show>
                <Show when={layoutRecoveryExpansion()}>
                  <button
                    type="button"
                    disabled={layoutRecoveryApplying()}
                    onClick={() => void expandAfterLayoutBlock()}
                  >
                    Expand to fit
                  </button>
                </Show>
              </div>
            </div>
          </Show>
        </div>
        <Show when={editorOptions().singleLine || editorOptions().fixedRegion || editorOptions().expandableRegion}>
          <div id={editorOptions().expandableRegion ? 'native-text-edit-status' : 'scanned-text-edit-status'} class="ocr-review-live-region" role="status" aria-live="polite" aria-atomic="true">
            {visibleEditorStatus()}
          </div>
        </Show>
      </>}
    </Show>
  );
}
