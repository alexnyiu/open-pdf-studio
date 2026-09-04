import { state, getActiveDocument, getDocumentById, getPageRotation } from '../core/state.js';
import i18next from '../i18n/config.js';
import { execute, executeForDocument } from '../core/undo-manager.js';
import { redrawAnnotations, redrawContinuous } from '../annotations/rendering.js';
import { showTextEditProperties, hideProperties } from '../ui/panels/properties-panel.js';
import { canvasContainer, continuousContainer } from '../ui/dom-elements.js';
import { showPdfTextEditor, hidePdfTextEditor, getPdfEditorText as getEditorText,
  updatePdfEditorStyle, shiftPdfEditorPosition, setPdfEditorStatus,
  getPdfEditorRichText, flushPdfEditorDraftForCommit, adoptPdfEditorFinalTextLayout,
  applyPdfEditorRichTextFormat,
  applyPdfEditorRichTextParagraphFormat } from '../bridge.js';
import {
  DEFAULT_TEXT_FORMAT_CAPABILITIES,
  canonicalRichTextHash,
  cloneTextEditRecord,
  createRichTextDocument,
  createTextEditRecordV2,
  createTextLine,
  createTextRun,
  projectTextEditRecord,
  removeTextEditRecordFromDocument,
  richTextFromPlainText,
  richTextToPlainText,
} from '../text/rich-text.js';
import {
  buildMergedTextEditSelection,
  marqueeContainsSelectionItem,
  reflowRichTextToWidth,
  unionSelectionGeometry,
} from '../text/text-edit-selection.js';
import { resolvePackagedFace } from '../text/font-catalog.js';
import { resolveAutomaticFontSubstitution } from '../text/font-substitution-policy.js';
import { openDialog, showMessage } from '../solid/stores/dialogStore.js';
import { showOcrParagraphMenu } from '../solid/stores/contextMenuStore.js';
import { injectSyntheticTextSpans, refreshPendingOcrTextLayer, resolveTextLayerFonts } from '../text/text-layer.js';
import { provenanceForSpans } from '../text/native-text-provenance.js';
import { sameNativeTextOwnership } from '../text/native-text-matching.js';
import {
  groupNativeTextFragments,
  nativeTextLinePieces,
} from '../text/native-text-blocks.js';
import { ownedTextEditLineTargets } from '../text/owned-text-edit-targets.js';
import { evaluateScannedTextEdit } from '../ocr/editing/edit-state.js';
import { fixedRegionTargetFromLineIds } from '../ocr/editing/fixed-region.js';
import {
  OCR_PARAGRAPH_LINE_LIMIT_REASON,
  buildOcrParagraphRegions,
  paragraphRegionForLine,
  partitionSelectionByParagraph,
} from '../ocr/editing/paragraph-regions.js';
import {
  resetOcrParagraphGroupingForDocument,
  setOcrParagraphBoundaryOverrideForDocument,
} from '../ocr/editing/paragraph-grouping-state.js';
import {
  SCANNED_TEXT_REFLOW_LAYOUT_MODE,
  SCANNED_TEXT_REFLOW_SCOPE,
} from '../ocr/editing/reflow.js';
import {
  applyScannedTextEditForDocument,
  removeScannedTextEditForDocument,
  reviseScannedTextEditForDocument,
} from '../ocr/editing/undo-commands.js';
import { rasterizePdfPageForOcr } from '../ocr/spike.js';
import { withScannedRichText } from '../ocr/editing/rich-text-adapter.js';
import {
  applyPageRotation,
  getPageRotationMatrix,
  invertPageRotation,
  restoreTextEditSnapshot,
  resolveTextEditPageGeometry,
  sampleDominantBackgroundColor,
  sampleTextColor,
  sourceTextLineExtent,
} from '../text/text-edit-appearance.js';
import {
  canonicalDeltaFromDisplayDelta,
  canonicalBoundsFromDisplayRect,
  canonicalEditorBoundsForRichText,
  createPageTextEditPlacement,
  createPageTextEditStyle,
} from '../text/page-text-edit-placement.js';
import { createInsertedTextDraft } from '../text/inserted-text.js';
import {
  createTextEditDirtyBaseline,
  textEditDraftIsDirty,
} from '../text/text-edit-dirty-state.js';
import {
  prepareTextEditRecordCommit,
  runOwnerScopedTextCommit,
  textEditValidationReason,
} from '../text/text-edit-commit.js';
import { createNativeTextSourceProjection } from '../text/native-text-source-projection.js';
import {
  scannedFontClassFromFamily,
  scannedStyleSnapshot,
  syncScannedStyleTouchedKey,
} from '../text/scanned-style-draft.js';
import {
  applyActiveTextEditing,
  cancelActiveTextEditing,
  completeTextEditSession,
  getActiveTextEditSession,
  registerTextEditSession,
} from '../text/text-edit-session.js';
import { createTextEditTargetIdentity } from '../text/text-edit-target-identity.js';
import { textEditDeactivationOwnsSession } from '../text/text-edit-deactivation.js';
import { waitForSavedDocumentSynchronization } from '../pdf/saved-document-transition.js';
import {
  awaitPageEditReady,
  PAGE_EDIT_READINESS_TIMEOUT_MS,
} from '../pdf/page-edit-readiness.js';
import {
  runPageEditIntent,
  synchronizeTextEditActivation,
} from '../text/page-edit-intent.js';
import { acquirePageLease, releasePageLease } from '../pdf/page-lease-registry.js';
import {
  authoredFinalTextLayoutInput,
  awaitFinalTextLayout,
  disposeFinalTextLayoutSession,
} from '../text/final-text-layout.js';
import { createTextApplyResult } from '../text/text-apply-result.js';
import { createEditorLayoutRevision } from '../text/editor-layout-revision.js';
import { publishCommittedTextEdit } from '../text/text-edit-publication.js';
import {
  mountedPageSurfaces,
  resolvePageSurface,
  resolvePageSurfaceForElement,
} from '../pdf/page-surface-registry.js';

let activeEditor = null;
let hoverListeners = [];
let layerOwnedEditListeners = [];
let ownedEditCaptureHandler = null;
let textLayerObserver = null;
let blockGroupsCache = new Map();
let ocrParagraphCache = new Map();
let paragraphOutline = null;
let selectionOutlines = [];
let selectedTextItems = new Map();
let selectionKeyHandler = null;
let marqueePointerHandlers = null;
let marqueeState = null;
const stagedScannedLineSelections = new WeakMap();
const selectedOcrParagraphs = new Map();

function reportQueuedEditFailure(error) {
  if (error?.name !== 'AbortError') console.warn('[text-edit] Queued page edit failed:', error);
}

function textEditActivationResult({
  activated = false,
  reason = null,
  errorCode = null,
  message = null,
  action = null,
} = {}) {
  return Object.freeze({
    activated: activated === true,
    reason: reason == null ? null : String(reason),
    errorCode: errorCode == null ? null : String(errorCode),
    message: message == null ? null : String(message),
    action: action == null ? null : String(action),
  });
}

async function waitForTextEditDocumentSynchronization(documentId) {
  const saver = await import('../pdf/saver.js');
  return synchronizeTextEditActivation({
    documentId,
    waitForSynchronization: waitForSavedDocumentSynchronization,
    resolveDocument: getDocumentById,
    getSaveCoordinatorSnapshot: saver.getDocumentSaveCoordinatorSnapshot,
    requestSynchronization: ({ documentId: id, documentGeneration }) => (
      saver.requestTextEditDocumentSynchronization(id, documentGeneration)
    ),
  });
}

function queueCurrentPageEditIntent({ documentState, pageNum, point = null, activate }) {
  return runPageEditIntent({
    documentState,
    pageNum,
    point,
    waitForSynchronization: waitForTextEditDocumentSynchronization,
    resolveDocument: getDocumentById,
    awaitReadiness: awaitPageEditReady,
    acquireLease: acquirePageLease,
    releaseLease: releasePageLease,
    readinessTimeoutMs: PAGE_EDIT_READINESS_TIMEOUT_MS,
    activate,
  }).then((result) => {
    if (result?.activated === false && result?.action === 'retry-page-edit') {
      showMessage(hardeningText('textEditor.status.pageNotReady'));
    }
    return result;
  });
}

function livePageSurface(pageNum, documentState = getActiveDocument()) {
  return resolvePageSurface(documentState, pageNum, {
    targetRevision: Number(documentState?.revisionState?.pageContentRevisions?.[pageNum]
      ?? documentState?.revisionState?.contentRevision) || 0,
  });
}

function livePageTextLayer(pageNum, documentState = getActiveDocument()) {
  return livePageSurface(pageNum, documentState)?.textLayer || null;
}

function livePageCanvas(pageNum, _layer = null, documentState = getActiveDocument()) {
  const surface = livePageSurface(pageNum, documentState);
  if (!surface) return null;
  if (surface.geometryCanvas) return surface.geometryCanvas;
  return surface.baseSurface?.getContext ? surface.baseSurface : null;
}

function spanAtClientPoint(layer, point, selector = 'span') {
  if (!layer || !point) return null;
  const target = document.elementFromPoint?.(point?.x, point?.y);
  const span = target?.closest?.(selector);
  if (span && layer?.contains(span)) return span;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [...layer.querySelectorAll(selector)].reverse().find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      && x >= rect.left && x <= rect.right
      && y >= rect.top && y <= rect.bottom;
  }) || null;
}

function hardeningText(key, options = {}) {
  return i18next.t(key, { ns: 'hardening', ...options });
}

function editorOwnerIsCurrent(editor) {
  if (!editor?.ownerDocument) return false;
  return getDocumentById(editor.ownerDocument.id) === editor.ownerDocument
    && editor.ownerDocument.lifecycleGeneration === editor.ownerDocumentGeneration;
}

function editorApplyOperationIsCurrent(editor, operation) {
  return Boolean(editor
    && operation
    && activeEditor === editor
    && editor.sessionId === operation.sessionId
    && editor.ownerDocument?.id === operation.ownerDocumentId
    && editor.ownerDocumentGeneration === operation.ownerDocumentGeneration
    && typeof operation.isCurrent === 'function'
    && operation.isCurrent()
    && editorOwnerIsCurrent(editor));
}

function completeEditorSession(editor) {
  disposeFinalTextLayoutSession(editor?.sessionId);
  completeTextEditSession(editor?.sessionId);
}

function textApplyResultFor(editor, status, overrides = {}) {
  const owner = editor?.ownerDocument || null;
  const pageNum = Number(overrides.pageNum ?? editor?.pageNum) || 1;
  return createTextApplyResult({
    status,
    documentId: String(owner?.id || ''),
    documentGeneration: Number(editor?.ownerDocumentGeneration
      ?? owner?.lifecycleGeneration) || 0,
    pageNum,
    contentRevision: Number(owner?.revisionState?.contentRevision) || 0,
    pageRevision: Number(owner?.revisionState?.pageContentRevisions?.[pageNum]) || 0,
    editId: overrides.editId ?? editor?._sourceRecordRef?.id ?? editor?._recordRef?.id ?? null,
    editRevision: overrides.editRevision
      ?? editor?._sourceRecordRef?.revision
      ?? editor?._recordRef?.revision
      ?? null,
    ...overrides,
  });
}

async function publishEditorCommit(editor, {
  ownerDocument = editor?.ownerDocument,
  pageNum = editor?.pageNum,
  editId = null,
  editRevision = null,
  nativeAuthoritative = false,
} = {}) {
  const expectedVisible = getActiveDocument() === ownerDocument;
  let publication;
  try {
    publication = await publishCommittedTextEdit({
      documentState: ownerDocument,
      pageNum,
      editId,
      editRevision,
      expectedVisible,
      nativeAuthoritative,
    });
  } catch (error) {
    publication = Object.freeze({
      status: 'failed',
      visiblePublished: false,
      semanticPublished: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'TEXT_PUBLICATION_FAILED',
      pageRevision: Number(ownerDocument?.revisionState?.pageContentRevisions?.[pageNum]) || 0,
    });
  }
  if (typeof window !== 'undefined') window.__lastTextPublicationResult = publication;
  const pendingOrFailed = publication.status === 'failed'
    || publication.status === 'deferred-unmounted';
  if (pendingOrFailed && ownerDocument) {
    ownerDocument.textEditPublicationState = Object.freeze({
      ...publication,
      editId: editId == null ? null : String(editId),
      editRevision: editRevision == null ? null : Number(editRevision) || 0,
      recoveryActions: Object.freeze(['retry-page-publication', 'save']),
    });
    if (publication.status === 'deferred-unmounted') {
      showMessage(hardeningText('textEditor.status.previewPending'));
    } else {
      showMessage(hardeningText('textEditor.status.previewFailed', {
        error: publication.error ? `\n\n${publication.error}` : '',
      }));
    }
  } else if (publication.status === 'published'
      && ownerDocument?.textEditPublicationState?.pageNum === Number(pageNum)) {
    ownerDocument.textEditPublicationState = null;
  }
  return Object.freeze({
    publication,
    visiblePublished: publication.status === 'published'
      && publication.visiblePublished === true,
    semanticPublished: publication.status === 'published'
      && publication.semanticPublished === true,
    publicationError: publication.status === 'failed'
      ? publication.error || publication.errorCode || 'Page publication failed'
      : publication.status === 'superseded'
        ? publication.error || publication.errorCode
          || 'Page publication was superseded by a newer document revision'
        : null,
  });
}

function finalEditorDraft(editor) {
  const snapshot = flushPdfEditorDraftForCommit({
    sessionId: editor?.sessionId,
    ownerDocumentId: editor?.ownerDocument?.id,
    ownerDocumentGeneration: editor?.ownerDocumentGeneration,
  });
  if (snapshot) return snapshot;
  const document = getPdfEditorRichText() || editor?.richTextDocument || null;
  return Object.freeze({
    sessionId: editor?.sessionId || '',
    ownerDocumentId: editor?.ownerDocument?.id || '',
    ownerDocumentGeneration: editor?.ownerDocumentGeneration || 0,
    draftRevision: 0,
    document,
    plainText: document ? richTextToPlainText(document) : getEditorText(),
    options: Object.freeze({}),
    identity: Object.freeze({
      sessionId: editor?.sessionId || '',
      ownerDocumentId: editor?.ownerDocument?.id || '',
      ownerDocumentGeneration: editor?.ownerDocumentGeneration || 0,
    }),
    layoutRevision: null,
  });
}

function layoutAdjustmentForDecision(value) {
  if (value?.status !== 'auto-fitted' || !value.autoFit?.priorBounds || !value.autoFit?.nextBounds) {
    return null;
  }
  return {
    kind: 'auto-grow-width',
    deltaWidthPt: value.autoFit.nextBounds.width - value.autoFit.priorBounds.width,
    deltaHeightPt: value.autoFit.nextBounds.height - value.autoFit.priorBounds.height,
  };
}

function layoutRecoveryActions(value) {
  if (Array.isArray(value?.recoveryActions) && value.recoveryActions.length) {
    return value.recoveryActions;
  }
  return value?.rejectionCode?.startsWith('TEXT_LAYOUT_')
    ? ['insert-line-break', 'keep-editing']
    : ['keep-editing'];
}

function registerActiveEditorSession(editor, ownerDocument, kind = editor?.kind) {
  if (!editor || !ownerDocument) return null;
  editor.ownerDocument = ownerDocument;
  editor.ownerDocumentGeneration = ownerDocument.lifecycleGeneration;
  const initialRichText = editor.richTextDocument || editor._recordRef?.richText || null;
  const dirtyBaseline = createTextEditDirtyBaseline({
    text: editor.originalText,
    richText: initialRichText,
    record: editor._recordRef,
  });
  editor.dirtyBaseline = dirtyBaseline;
  const ownedRecordId = editor._sourceRecordRef?.id ?? editor._recordRef?.id ?? '';
  const nativeMarkerIds = editor.sourceProvenance
    ?.map((source) => source?.markerId)
    .filter(Boolean) || [];
  const targetIdentity = createTextEditTargetIdentity({
    documentId: ownerDocument.id,
    pageNum: editor.pageNum,
    recordId: ownedRecordId,
    markerIds: nativeMarkerIds,
    recognitionGeneration: editor.ocrTargetIdentity?.recognitionGeneration,
    regionId: editor.ocrTargetIdentity?.regionId,
    lineIds: editor.ocrTargetIdentity?.lineIds,
  });
  const session = registerTextEditSession({
    ownerDocumentId: ownerDocument.id,
    ownerDocumentGeneration: ownerDocument.lifecycleGeneration,
    pageNum: editor.pageNum,
    kind,
    targetIdentity,
    isDirty: () => activeEditor === editor && textEditDraftIsDirty(dirtyBaseline, {
      text: getEditorText(),
      // Registration precedes mounting by one synchronous call stack. During
      // that interval, use the isolated source draft instead of stale store
      // state from a previously closed editor.
      richText: getPdfEditorRichText() || initialRichText,
      record: editor._recordRef,
      transientStyleChanged: (editor.styleTouchedKeys?.size || 0) > 0,
    }),
    commit: (operation) => finishPdfTextEditing(operation),
    cancel: (reason) => cancelPdfTextEditing(reason),
  });
  editor.sessionId = session?.sessionId || null;
  return session;
}
// WeakMap: span -> block group, for fast lookup on hover/click
let spanToBlock = new WeakMap();

globalThis.window?.addEventListener?.('open-pdf-studio:request-text-edit-hover-refresh', () => {
  if (state.isEditingPdfText && state.currentTool === 'editText') enableTextLayerHover();
});

function showTextEditPropertiesSafely(properties) {
  try {
    showTextEditProperties(properties);
  } catch (error) {
    // The paragraph editor remains usable if the optional properties panel is
    // not mounted yet or rejects a transient reactive value.
    console.warn('[text-edit] Properties panel unavailable:', error);
  }
}

function publishPdfTextEditState(editor) {
  // Global editing state is only a keyboard-routing sentinel. Keep DOM nodes,
  // callbacks, and reactive record proxies in the module-local activeEditor.
  state.pdfTextEditState = editor ? { kind: editor.kind, pageNum: editor.pageNum } : null;
}

/** Rebind a native-source editor to the replacement text layer after a view render. */
export function rebindActiveTextEditorSourceProjection({
  documentState,
  pageNum,
  textLayer,
} = {}) {
  if (!activeEditor?.block?.spans || activeEditor.kind !== 'existingText'
      || activeEditor.ownerDocument !== documentState
      || Number(activeEditor.pageNum) !== Number(pageNum)
      || !textLayer?.querySelectorAll) return false;
  const markerIds = new Set((activeEditor.sourceProvenance || [])
    .map((source) => String(source?.markerId || ''))
    .filter(Boolean));
  if (!markerIds.size) return false;
  const spans = [...textLayer.querySelectorAll(
    'span[data-native-text-marker-ids], span[data-native-text-provenance]',
  )].filter((span) => String(span.dataset?.nativeTextMarkerIds || '')
    .split(/[\s,]+/u)
    .some((markerId) => markerIds.has(markerId)));
  if (!spans.length) return false;
  for (const span of spans) span.style.visibility = 'hidden';
  activeEditor.block = { ...activeEditor.block, spans };
  return true;
}

function cleanupEditorRuntime(editor, {
  restoreNativeSpans = false,
  reason = 'runtime-cleanup',
} = {}) {
  let closeResult = { status: 'inactive' };
  const cleanupSteps = [
    () => { closeResult = hidePdfTextEditor(editor?.mountOwner, reason); },
    () => {
      if (!restoreNativeSpans) return;
      for (const span of editor?.block?.spans || []) span.style.visibility = '';
    },
    () => completeEditorSession(editor),
    () => editor?.preview?.remove?.(),
  ];
  for (const step of cleanupSteps) {
    try { step(); } catch (error) {
      console.warn('[text-edit] Editor cleanup step failed:', error);
    }
  }
  if (closeResult.status === 'superseded') return false;
  if (activeEditor === editor) activeEditor = null;
  if (!activeEditor) {
    state.pdfTextEditState = null;
    try { hideProperties(); } catch (error) {
      console.warn('[text-edit] Properties cleanup failed:', error);
    }
  }
  return true;
}

function rejectInvalidOwnedTextState() {
  const reason = getActiveDocument()?.textEditReadOnlyReason;
  if (!reason) return false;
  console.warn('[text-edit] Owned text is read-only:', reason);
  showMessage(hardeningText('textEditor.status.readOnly'));
  return true;
}

function hideParagraphOutline() {
  paragraphOutline?.remove();
  paragraphOutline = null;
}

function clearTextBoxSelection() {
  selectedTextItems.clear();
  selectedOcrParagraphs.clear();
  selectionOutlines.forEach((element) => element.remove());
  selectionOutlines = [];
}

function ocrParagraphContext(doc, pageNum) {
  const pageState = doc?.ocr?.pages?.[pageNum];
  const result = pageState?.recognition?.result;
  const pageGeometry = pageState?.recognition?.geometry;
  if (!result || !pageGeometry || pageState.recognition.ownership?.owner !== 'open-pdf-studio') return null;
  const grouping = doc.scannedTextEdits?.pages?.find((page) => page.index === pageNum - 1)?.paragraphGrouping;
  const revision = grouping?.ownership?.revision ?? 0;
  const key = [doc.id, result.document.generation, result.page.id, result.page.revision,
    result.sourceRaster.id, pageGeometry.geometryId, revision].join('|');
  let regions = ocrParagraphCache.get(key);
  if (!regions) {
    regions = buildOcrParagraphRegions({ result, pageGeometry, overrides: grouping });
    ocrParagraphCache.set(key, regions);
    if (ocrParagraphCache.size > 64) ocrParagraphCache = new Map([[key, regions]]);
  }
  return { result, pageGeometry, grouping, regions };
}

function ocrRegionRect(layer, region) {
  const lineIds = new Set(region.lineIds);
  const spans = [...layer.querySelectorAll('span[data-ocr-owner][data-ocr-line-id]')]
    .filter((candidate) => (candidate.dataset.ocrSourceLineIds || candidate.dataset.ocrLineId || '')
      .split(/\s+/u).some((id) => lineIds.has(id)));
  if (spans.length === 0) return null;
  const layerRect = layer.getBoundingClientRect();
  const rects = spans.map((candidate) => candidate.getBoundingClientRect());
  const left = Math.min(...rects.map((rect) => rect.left)) - layerRect.left;
  const top = Math.min(...rects.map((rect) => rect.top)) - layerRect.top;
  const right = Math.max(...rects.map((rect) => rect.right)) - layerRect.left;
  const bottom = Math.max(...rects.map((rect) => rect.bottom)) - layerRect.top;
  return { spans, rect: { left, top, width: right - left, height: bottom - top } };
}

function showOcrParagraphOutline(layer, region) {
  const block = ocrRegionRect(layer, region);
  if (block) showParagraphOutline(layer, block);
}

function showOcrParagraphSelection(layer, regions) {
  selectionOutlines.forEach((element) => element.remove());
  selectionOutlines = [];
  const parent = layer.parentElement;
  if (!parent) return;
  const layerRect = layer.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  for (const region of regions) {
    const block = ocrRegionRect(layer, region);
    if (!block) continue;
    const outline = document.createElement('div');
    outline.className = 'edit-text-paragraph-outline edit-text-selection-outline';
    outline.setAttribute('aria-label', hardeningText('textEditor.aria.selectedOcrParagraph', {
      count: region.lineIds.length,
    }));
    outline.style.left = `${layerRect.left - parentRect.left + block.rect.left}px`;
    outline.style.top = `${layerRect.top - parentRect.top + block.rect.top}px`;
    outline.style.width = `${Math.max(block.rect.width, 1)}px`;
    outline.style.height = `${Math.max(block.rect.height, 1)}px`;
    parent.appendChild(outline);
    selectionOutlines.push(outline);
  }
}

function toggleOcrParagraphSelection(pageNum, layer, region) {
  const key = `${pageNum}:${region.id}`;
  if (selectedOcrParagraphs.has(key)) selectedOcrParagraphs.delete(key);
  else selectedOcrParagraphs.set(key, region);
  showOcrParagraphSelection(layer, [...selectedOcrParagraphs.entries()]
    .filter(([entryKey]) => entryKey.startsWith(`${pageNum}:`)).map(([, entry]) => entry));
}

function boundaryBetween(context, beforeLineId, afterLineId) {
  return context.regions.boundaries?.find((entry) => entry.beforeLineId === beforeLineId
    && entry.afterLineId === afterLineId) ?? null;
}

function groupingTouchesRegion(grouping, region) {
  const ids = new Set(region.lineIds);
  return grouping?.boundaries?.some((entry) => ids.has(entry.beforeLineId) || ids.has(entry.afterLineId)) === true;
}

function ocrParagraphActionsForSpan({ doc, pageNum, span, context, region, existingRaster = null, onApplied }) {
  const regionIndex = context.regions.findIndex((entry) => entry.id === region.id);
  const previous = context.regions[regionIndex - 1] ?? null;
  const next = context.regions[regionIndex + 1] ?? null;
  const firstLineId = region.lineIds[0];
  const lastLineId = region.lineIds.at(-1);
  const clickedLineId = span.dataset.ocrLineId;
  const clickedIndex = region.lineIds.indexOf(clickedLineId);
  const previousBoundary = previous && boundaryBetween(context, previous.lineIds.at(-1), firstLineId);
  const nextBoundary = next && boundaryBetween(context, lastLineId, next.lineIds[0]);
  const canMergePrevious = previous?.columnId === region.columnId
    && previousBoundary?.decision === 'ambiguous'
    && previous.lineIds.length + region.lineIds.length <= 32;
  const canMergeNext = next?.columnId === region.columnId
    && nextBoundary?.decision === 'ambiguous'
    && next.lineIds.length + region.lineIds.length <= 32;
  const canSplitBefore = clickedIndex > 0;
  const canSplitAfter = clickedIndex >= 0 && clickedIndex < region.lineIds.length - 1;
  const ownedSelection = appliedScannedSelection(
    doc, pageNum, clickedLineId, span.dataset.scannedTextEditSelectionId || null,
  );
  const ownedLineIndex = ownedSelection?.target?.lineIds?.indexOf(clickedLineId) ?? -1;
  const ownedFixedRegion = ownedSelection?.target?.kind === 'region'
    && ownedSelection.content?.scope === 'fixed-region-multiline';
  const selectedRegions = [...selectedOcrParagraphs.entries()]
    .filter(([key]) => key.startsWith(`${pageNum}:`))
    .map(([, entry]) => entry)
    .sort((left, right) => left.readingOrder - right.readingOrder);
  const selectedBoundary = selectedRegions.length === 2
    ? boundaryBetween(context, selectedRegions[0].lineIds.at(-1), selectedRegions[1].lineIds[0]) : null;
  const canMergeSelected = selectedRegions.length === 2
    && selectedRegions[0].columnId === selectedRegions[1].columnId
    && selectedBoundary?.decision === 'ambiguous'
    && selectedRegions[0].lineIds.length + selectedRegions[1].lineIds.length <= 32;
  const ensureRaster = async () => existingRaster || sourceRasterForScannedLine(doc, context.result);
  const complete = async () => {
    ocrParagraphCache.clear();
    onApplied?.();
    refreshPendingOcrTextLayer(pageNum);
    enableTextLayerHover();
  };
  const persist = async (beforeLineId, afterLineId, decision, validateMergedIds = null) => {
    try {
      const raster = await ensureRaster();
      if (validateMergedIds) {
        const target = fixedRegionTargetFromLineIds(context.result, validateMergedIds);
        const lines = target.lineIds.map((id) => context.result.lines.find((line) => line.id === id));
        const preflight = await evaluateScannedTextEdit({
          result: context.result, pageGeometry: context.pageGeometry, raster, target,
          replacementText: lines.map((line) => line.text).join('\n'), contextPaddingPx: 24,
        });
        if (!preflight.selection.analysis.eligibility.eligible || !preflight.selection.content) {
          throw new Error('The merged paragraph does not pass fixed-region validation');
        }
      }
      await setOcrParagraphBoundaryOverrideForDocument(doc, {
        result: context.result, pageGeometry: context.pageGeometry, raster,
        beforeLineId, afterLineId, decision,
      });
      await complete();
    } catch (error) {
      console.warn('[ocr-paragraph-grouping] Change failed:', error);
      showMessage(hardeningText('textEditor.status.operationFailed'));
    }
  };
  const splitOwned = (boundaryIndex) => {
    onApplied?.();
    openDialog('split-ocr-region', {
      pageNum, selectionId: ownedSelection.id, boundaryIndex,
    });
  };
  return {
    canMergePrevious,
    canMergeNext,
    canMergeSelected,
    canSplitBefore: ownedFixedRegion ? ownedLineIndex > 0 : canSplitBefore,
    canSplitAfter: ownedFixedRegion
      ? ownedLineIndex >= 0 && ownedLineIndex < ownedSelection.target.lineIds.length - 1
      : canSplitAfter,
    canReset: groupingTouchesRegion(context.grouping, region),
    mergePreviousReason: previous?.columnId !== region.columnId
      ? hardeningText('ocrGrouping.crossColumnDisabled')
      : previousBoundary?.decision !== 'ambiguous'
        ? hardeningText('ocrGrouping.ambiguousBoundariesOnly')
        : null,
    mergeNextReason: next?.columnId !== region.columnId
      ? hardeningText('ocrGrouping.crossColumnDisabled')
      : nextBoundary?.decision !== 'ambiguous'
        ? hardeningText('ocrGrouping.ambiguousBoundariesOnly')
        : null,
    status: region.rejectionReason === OCR_PARAGRAPH_LINE_LIMIT_REASON
      ? hardeningText('ocrGrouping.tooManyLines') : null,
    mergePrevious: () => canMergePrevious && persist(previous.lineIds.at(-1), firstLineId, 'merge',
      [...previous.lineIds, ...region.lineIds]),
    mergeNext: () => canMergeNext && persist(lastLineId, next.lineIds[0], 'merge',
      [...region.lineIds, ...next.lineIds]),
    mergeSelected: () => {
      if (!canMergeSelected) return;
      const owned = selectedRegions.map((selectedRegion) => appliedScannedSelection(
        doc, pageNum, selectedRegion.lineIds[0], null,
      ));
      if (owned.every(Boolean) && owned[0].id !== owned[1].id) {
        onApplied?.();
        openDialog('merge-ocr-regions', { pageNum, selectionIds: owned.map((selection) => selection.id) });
        return;
      }
      return persist(
        selectedRegions[0].lineIds.at(-1), selectedRegions[1].lineIds[0], 'merge',
        [...selectedRegions[0].lineIds, ...selectedRegions[1].lineIds],
      );
    },
    splitBefore: () => ownedFixedRegion
      ? ownedLineIndex > 0 && splitOwned(ownedLineIndex)
      : canSplitBefore && persist(region.lineIds[clickedIndex - 1], clickedLineId, 'split'),
    splitAfter: () => ownedFixedRegion
      ? ownedLineIndex >= 0 && ownedLineIndex < ownedSelection.target.lineIds.length - 1
        && splitOwned(ownedLineIndex + 1)
      : canSplitAfter && persist(clickedLineId, region.lineIds[clickedIndex + 1], 'split'),
    reset: async () => {
      if (!groupingTouchesRegion(context.grouping, region)) return;
      await resetOcrParagraphGroupingForDocument(doc, { pageIndex: pageNum - 1, lineIds: region.lineIds });
      await complete();
    },
  };
}

export function clearSelectedTextBoxes() {
  if (selectedTextItems.size === 0) return false;
  clearTextBoxSelection();
  return true;
}

function drawTextBoxSelection() {
  selectionOutlines.forEach((element) => element.remove());
  selectionOutlines = [];
  const items = [...selectedTextItems.values()];
  if (!items.length) return;
  const layer = items[0].layer;
  const parent = layer?.parentElement;
  if (!parent) return;
  const layerRect = layer.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const append = (rect, className) => {
    const element = document.createElement('div');
    element.className = className;
    element.setAttribute('aria-hidden', 'true');
    Object.assign(element.style, {
      left: `${layerRect.left - parentRect.left + rect.left}px`,
      top: `${layerRect.top - parentRect.top + rect.top}px`,
      width: `${Math.max(1, rect.width)}px`,
      height: `${Math.max(1, rect.height)}px`,
    });
    parent.appendChild(element);
    selectionOutlines.push(element);
  };
  items.forEach((item) => append(item.viewRect, 'edit-text-selection-box'));
  if (items.length > 1) append(unionSelectionGeometry(items, 'viewRect'), 'edit-text-selection-union');
}

function toggleTextBoxSelection(item) {
  if (!item) return;
  const existingPage = selectedTextItems.values().next().value?.page;
  if (existingPage && existingPage !== item.page) clearTextBoxSelection();
  if (selectedTextItems.has(item.key)) selectedTextItems.delete(item.key);
  else selectedTextItems.set(item.key, item);
  hideParagraphOutline();
  drawTextBoxSelection();
}

function richTextForNativeBlock(block, pageNum) {
  const { lineData, lineSpacing } = block;
  const fontSize = lineData[0].fontSize;
  const pdfY = lineData[0].pdfY;
  // The native text layer anchors spans by their PDF baseline using the same
  // 0.8em ascent. Keep the canonical paragraph rectangle on that visible top
  // edge instead of treating the whole em square as ascent, which placed the
  // editor roughly 0.2em above the source text.
  const sourceAscent = fontSize * 0.8;
  const sourceDescent = fontSize - sourceAscent;
  return createRichTextDocument(lineData.map((line, index) => {
    const runs = line.runs.map((run) => cloneTextEditRecord(run));
    const nextText = lineData[index + 1]?.text || '';
    if (index < lineData.length - 1 && !/\s$/u.test(line.text) && !/^[\s,.;:!?)]/u.test(nextText)) {
      runs.push(createTextRun(' ', runs.at(-1) || line.runs[0], { seed: `wrap-space-${index}` }));
    }
    return createTextLine(runs, {
      id: `source-line-${pageNum}-${index}`,
      baseline: line.pdfY,
      baselineAdvance: lineSpacing,
      alignment: 'left',
      breakAfter: index === lineData.length - 1 ? 'hard' : 'soft',
    });
  }), {
    x: lineData[0].pdfX,
    y: pdfY - (lineData.length - 1) * lineSpacing - sourceDescent,
    width: Math.max(...lineData.map((line) => line.pdfWidth)),
    height: (lineData.length - 1) * lineSpacing + sourceAscent + sourceDescent,
    rotation: getPageRotation(pageNum),
  });
}

function selectionItemForRecord(record, pageNum, layer, viewRect = null) {
  const projected = projectTextEditRecord(record);
  const target = [...layer.querySelectorAll('span[data-edit-id]')]
    .find((span) => span.dataset.editId === String(record.id));
  const block = viewRect || (target ? ownedEditOutlineBlock(target, layer) : null);
  const rect = block?.rect || viewRect;
  if (!rect) return null;
  const region = projected.richText.region;
  return {
    key: `record:${record.id}`, kind: 'record', page: pageNum,
    rotation: region.rotation || getPageRotation(pageNum), eligible: true,
    geometry: { left: region.x, top: region.y, width: region.width, height: region.height },
    viewRect: rect, visualBaseline: rect.top + Math.min(rect.height, projected.fontSize),
    richText: cloneTextEditRecord(projected.richText),
    original: projected.original ? cloneTextEditRecord(projected.original) : null,
    sourceProvenance: record.sourceProvenance ? cloneTextEditRecord(record.sourceProvenance) : null,
    substitution: record.substitution ? cloneTextEditRecord(record.substitution) : null,
    sourceRecord: record, layer,
  };
}

async function openCombinedTextBoxEditor() {
  if (selectedTextItems.size < 2 || activeEditor) return;
  if (rejectInvalidOwnedTextState()) return;
  let ownerDocument = getActiveDocument();
  if (!ownerDocument) return;
  const selectedDocumentGeneration = Number(ownerDocument.lifecycleGeneration) || 0;
  if (!(await waitForTextEditDocumentSynchronization(ownerDocument.id))) return;
  ownerDocument = getDocumentById(ownerDocument.id);
  if (!ownerDocument) return;
  if ((Number(ownerDocument.lifecycleGeneration) || 0) !== selectedDocumentGeneration) {
    // The selected DOM items belonged to the retired PDF.js proxy. Make the
    // user reselect against the synchronized layer instead of combining stale
    // source identities.
    clearTextBoxSelection();
    return;
  }
  const items = [...selectedTextItems.values()];
  const unsupported = [...new Set(items.flatMap((item) => item.unsupportedFonts || []))];
  if (unsupported.length) {
    const substitution = resolveAutomaticFontSubstitution({
      sourceFonts: unsupported,
      sampleText: items.map((item) => richTextToPlainText(item.richText)).join('\n'),
      scope: 'selection',
    });
    if (!substitution) return;
    items.forEach((item) => { if (item.unsupportedFonts?.length) item.substitution = substitution; });
  }
  let plan;
  try {
    plan = buildMergedTextEditSelection(items, {
      createId: () => Date.now() + Math.random().toString(36).slice(2, 11),
    });
  } catch (error) {
    console.warn('[text-edit] Combining selected text boxes failed:', error);
    showMessage(hardeningText('textEditor.status.operationFailed'));
    return;
  }
  try {
    const controller = new AbortController();
    try {
      await awaitPageEditReady(ownerDocument, plan.page, {
        signal: controller.signal,
        timeoutMs: PAGE_EDIT_READINESS_TIMEOUT_MS,
      });
    } finally {
      controller.abort();
    }
  } catch (error) {
    reportQueuedEditFailure(error);
    showMessage(hardeningText('textEditor.status.pageNotReady'));
    return;
  }
  if (getActiveDocument() !== ownerDocument) return;
  const mergedRichText = reflowRichTextToWidth(plan.richText, Math.max(plan.geometry.width, 1));
  const mergedRecord = createTextEditRecordV2({
    id: plan.primaryId,
    page: plan.page,
    richText: mergedRichText,
    original: plan.original,
    sourceProvenance: plan.sourceProvenance,
    substitution: plan.substitution,
    revision: plan.revision,
  });
  const doc = getActiveDocument();
  const originalRecords = plan.consumedRecords.map((record) => ({
    index: doc.textEdits.findIndex((entry) => String(entry.id) === String(record.id)),
    record: cloneTextEditRecord(record),
  })).filter((item) => item.index >= 0);
  const mergedIndex = originalRecords.length ? Math.min(...originalRecords.map((item) => item.index)) : doc.textEdits.length;
  const layer = plan.orderedItems[0].layer;
  const canvasEl = livePageCanvas(plan.page, layer, doc);
  if (!canvasEl) return;
  clearTextBoxSelection();
  startTextEditEditing(mergedRecord, plan.page, canvasEl, {
    // Combining boxes is itself an edit, including an unchanged native-only
    // merge whose normalized geometry differs from its original snapshot.
    forceCommit: true,
    // A native-only combination creates its first owner record at revision 1.
    // An existing owned record advances once when this transaction commits.
    draftOnly: originalRecords.length === 0,
    commit(finalRecord) {
      const originalTextEdits = [...(doc.textEdits || [])];
      const consumedIds = new Set(originalRecords.map((item) => String(item.record.id)));
      const recorded = runOwnerScopedTextCommit({
        ownerDocument: doc,
        attempt() {
          if (!doc.textEdits) doc.textEdits = [];
          const remaining = doc.textEdits.filter(
            (record) => !consumedIds.has(String(record.id)),
          );
          doc.textEdits.splice(0, doc.textEdits.length, ...remaining);
          doc.textEdits.splice(Math.min(mergedIndex, doc.textEdits.length), 0, finalRecord);
          return executeForDocument(doc, {
            type: 'replaceTextEditSet',
            originalRecords,
            mergedRecord: cloneTextEditRecord(finalRecord),
            mergedIndex,
          });
        },
        rollback() {
          if (!doc.textEdits) doc.textEdits = [];
          doc.textEdits.splice(0, doc.textEdits.length, ...originalTextEdits);
        },
      });
      if (!recorded) return false;
      return true;
    },
  });
}

function installTextBoxSelectionHandlers() {
  if (!selectionKeyHandler) {
    selectionKeyHandler = (event) => {
      if (!state.isEditingPdfText || state.currentTool !== 'editText') return;
      if (event.key === 'Escape' && clearSelectedTextBoxes()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (!activeEditor && event.key === 'Enter' && selectedTextItems.size >= 2) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void openCombinedTextBoxEditor();
      }
    };
    document.addEventListener('keydown', selectionKeyHandler, true);
  }
  if (marqueePointerHandlers) return;
  const down = (event) => {
    if (!event.shiftKey || event.button !== 0 || !state.isEditingPdfText || activeEditor) return;
    const layer = event.target instanceof Element ? event.target.closest('.textLayer') : null;
    if (!layer || event.target.closest('span')) return;
    marqueeState = { layer, startX: event.clientX, startY: event.clientY, active: false, element: null };
  };
  const move = (event) => {
    if (!marqueeState) return;
    const dx = event.clientX - marqueeState.startX;
    const dy = event.clientY - marqueeState.startY;
    if (!marqueeState.active && Math.hypot(dx, dy) <= 4) return;
    event.preventDefault();
    marqueeState.active = true;
    if (!marqueeState.element) {
      marqueeState.element = document.createElement('div');
      marqueeState.element.className = 'edit-text-marquee';
      document.body.appendChild(marqueeState.element);
    }
    Object.assign(marqueeState.element.style, {
      left: `${Math.min(marqueeState.startX, event.clientX)}px`,
      top: `${Math.min(marqueeState.startY, event.clientY)}px`,
      width: `${Math.abs(dx)}px`, height: `${Math.abs(dy)}px`,
    });
  };
  const up = (event) => {
    const current = marqueeState;
    marqueeState = null;
    if (!current?.active) return;
    event.preventDefault();
    event.stopPropagation();
    current.element?.remove();
    const layerRect = current.layer.getBoundingClientRect();
    const marquee = {
      left: Math.min(current.startX, event.clientX) - layerRect.left,
      top: Math.min(current.startY, event.clientY) - layerRect.top,
      width: Math.abs(event.clientX - current.startX),
      height: Math.abs(event.clientY - current.startY),
    };
    const pageNum = parseInt(current.layer.dataset.page, 10) || getActiveDocument()?.currentPage || 1;
    const candidates = getBlockGroups(current.layer).map((block) => selectionItemForBlock(block, pageNum, current.layer));
    for (const record of getActiveDocument()?.textEdits?.filter((entry) => entry.page === pageNum) || []) {
      const item = selectionItemForRecord(record, pageNum, current.layer);
      if (item && !candidates.some((candidate) => candidate.key === item.key)) candidates.push(item);
    }
    candidates.filter((item) => marqueeContainsSelectionItem(marquee, item))
      .forEach((item) => selectedTextItems.set(item.key, item));
    drawTextBoxSelection();
  };
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  marqueePointerHandlers = { down, move, up };
}

function removeTextBoxSelectionHandlers() {
  if (selectionKeyHandler) document.removeEventListener('keydown', selectionKeyHandler, true);
  selectionKeyHandler = null;
  if (marqueePointerHandlers) {
    document.removeEventListener('pointerdown', marqueePointerHandlers.down, true);
    document.removeEventListener('pointermove', marqueePointerHandlers.move, true);
    document.removeEventListener('pointerup', marqueePointerHandlers.up, true);
  }
  marqueePointerHandlers = null;
  marqueeState?.element?.remove();
  marqueeState = null;
  clearTextBoxSelection();
}

function selectionItemForBlock(block, pageNum, layer) {
  const provenance = provenanceForSpans(block.spans);
  const existing = provenance && getActiveDocument()?.textEdits?.find((record) => (
    record.page === pageNum && sameNativeTextOwnership(record.sourceProvenance, provenance)
  ));
  if (existing) return selectionItemForRecord(existing, pageNum, layer, block.rect);
  const richText = richTextForNativeBlock(block, pageNum);
  const unsupportedFonts = [...new Set(block.lineData.flatMap((line) => line.spans.map((span) => (
    span.dataset.pdfActualFontName || span.dataset.pdfFontName || 'Unknown font'
  ))).filter((name) => !/^liberation\s*(sans|serif|mono)/iu.test(name)))];
  const markerKey = provenance?.map((source) => source.markerId).sort().join('|') || `unowned:${block.rect.left}:${block.rect.top}`;
  return {
    key: `native:${markerKey}`, kind: 'native', page: pageNum,
    rotation: getPageRotation(pageNum), eligible: Boolean(provenance) && block.laneValid !== false,
    geometry: { left: richText.region.x, top: richText.region.y, width: richText.region.width, height: richText.region.height },
    viewRect: block.rect, visualBaseline: block.lineData[0].domBottom,
    richText, original: richText, sourceProvenance: provenance,
    unsupportedFonts, substitution: null, block, layer,
  };
}

function showParagraphOutline(layer, block) {
  if (!layer || !block?.rect) return;
  hideParagraphOutline();
  const parent = layer.parentElement;
  if (!parent) return;
  const layerRect = layer.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const outline = document.createElement('div');
  outline.className = 'edit-text-paragraph-outline';
  outline.setAttribute('aria-hidden', 'true');
  outline.style.left = `${layerRect.left - parentRect.left + block.rect.left}px`;
  outline.style.top = `${layerRect.top - parentRect.top + block.rect.top}px`;
  outline.style.width = `${Math.max(block.rect.width, 1)}px`;
  outline.style.height = `${Math.max(block.rect.height, 1)}px`;
  parent.appendChild(outline);
  paragraphOutline = outline;
}

function ownedEditOutlineBlock(span, layer) {
  const editId = span.dataset.editId;
  if (!editId) return null;
  const targets = [...layer.querySelectorAll('span[data-owned-text-edit-hit]')]
    .filter((candidate) => candidate.dataset.editId === editId);
  if (targets.length === 0) return null;
  const layerRect = layer.getBoundingClientRect();
  const rects = targets.map((target) => target.getBoundingClientRect());
  const left = Math.min(...rects.map((rect) => rect.left)) - layerRect.left;
  const top = Math.min(...rects.map((rect) => rect.top)) - layerRect.top;
  const right = Math.max(...rects.map((rect) => rect.right)) - layerRect.left;
  const bottom = Math.max(...rects.map((rect) => rect.bottom)) - layerRect.top;
  return { spans: targets, rect: { left, top, width: right - left, height: bottom - top } };
}

// ── Font mapping shared by the text-edit sessions ──
// Map a display / actual font name + bold/italic flags to a pdf-lib StandardFont
// name (the value stored on the text-edit record and used by the saver).
function toStandardFontName(displayName, isBold, isItalic) {
  const n = (displayName || '').toLowerCase();
  if (n.includes('courier') || n.includes('consolas') || n.includes('mono')) {
    return isBold && isItalic ? 'Courier-BoldOblique'
      : isBold ? 'Courier-Bold'
      : isItalic ? 'Courier-Oblique'
      : 'Courier';
  }
  if (n.includes('times') || n.includes('garamond') || n.includes('georgia')
      || n.includes('palatino') || n.includes('cambria') || n.includes('bookman') || n.includes('serif')) {
    return isBold && isItalic ? 'TimesRoman-BoldItalic'
      : isBold ? 'TimesRoman-Bold'
      : isItalic ? 'TimesRoman-Italic'
      : 'TimesRoman';
  }
  return isBold && isItalic ? 'Helvetica-BoldOblique'
    : isBold ? 'Helvetica-Bold'
    : isItalic ? 'Helvetica-Oblique'
    : 'Helvetica';
}

// CSS font-family for the live editor / synthetic span, from a font name.
function cssFamilyFor(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('liberation')) {
    if (n.includes('mono')) return '"Liberation Mono", monospace';
    if (n.includes('serif') && !n.includes('sans')) return '"Liberation Serif", serif';
    return '"Liberation Sans", sans-serif';
  }
  if (n.includes('courier') || n.includes('consolas') || n.includes('mono')) return '"Courier New", Courier, monospace';
  if (n.includes('times') || n.includes('garamond') || n.includes('georgia')
      || n.includes('palatino') || n.includes('cambria') || n.includes('bookman') || n.includes('serif')) return '"Times New Roman", Times, serif';
  return 'Helvetica, Arial, sans-serif';
}

function isInternalPdfFontName(name) {
  return /^g_d\d+_f\d+$/i.test(name || '');
}

function editableFontName(line, cssFallbackFont) {
  if (line.actualFontName) return line.actualFontName;
  if (line.pdfFontName && !isInternalPdfFontName(line.pdfFontName)) return line.pdfFontName;
  if ((line.fontFamily || '').toLowerCase() === 'monospace') return 'Courier New';
  if ((line.fontFamily || '').toLowerCase() === 'serif') return 'Times New Roman';
  return cssFallbackFont.includes('Courier') ? 'Courier New'
    : cssFallbackFont.includes('Times') ? 'Times New Roman'
    : 'Arial';
}

let fontMetricsContext = null;

// Return the browser baseline offset inside a CSS line box. Canvas and CSS use
// the same font metrics, so anchoring the textarea by its baseline keeps its
// glyphs on top of the PDF canvas glyphs instead of relying on a magic offset.
function cssBaselineOffset(fontFamily, fontSize, lineHeight, isBold = false, isItalic = false) {
  if (!fontMetricsContext) {
    fontMetricsContext = document.createElement('canvas').getContext('2d');
  }
  if (!fontMetricsContext) return fontSize * 0.8 + (lineHeight - fontSize) / 2;

  const fontWeight = isBold ? 'bold ' : '';
  const fontStyle = isItalic ? 'italic ' : '';
  fontMetricsContext.font = `${fontStyle}${fontWeight}${fontSize}px ${fontFamily}`;
  const metrics = fontMetricsContext.measureText('Mg');
  const ascent = Number.isFinite(metrics.fontBoundingBoxAscent)
    ? metrics.fontBoundingBoxAscent
    : (metrics.actualBoundingBoxAscent || fontSize * 0.8);
  const descent = Number.isFinite(metrics.fontBoundingBoxDescent)
    ? metrics.fontBoundingBoxDescent
    : (metrics.actualBoundingBoxDescent || fontSize * 0.2);
  return ascent + (lineHeight - ascent - descent) / 2;
}

// Re-inject the synthetic text-layer spans for added text on a page (after the
// record's content/style/position changed) and repaint the annotation canvas.
function reRenderAddedText(pageNum) {
  const doc = getActiveDocument();
  const surface = livePageSurface(pageNum, doc);
  const textLayer = surface?.textLayer || null;
  const canvasEl = surface?.geometryCanvas
    || (surface?.baseSurface?.getContext ? surface.baseSurface : null);
  if (textLayer && canvasEl) {
    const vp = window.__pdfViewport;
    const useViewport = vp?.active && doc?.filePath && vp.pageW > 0 && vp.pageH > 0;
    const sc = doc?.scale || 1.5;
    const pw = useViewport ? vp.pageW : canvasEl.width / sc;
    const ph = useViewport ? vp.pageH : canvasEl.height / sc;
    injectSyntheticTextSpans(textLayer, pageNum, pw, ph);
  }
  if (getActiveDocument()?.viewMode === 'continuous') redrawContinuous();
  else redrawAnnotations();
}

// Apply the accumulated style state (family/size/colour/bold/italic) onto a
// text-edit record. Returns true when any field actually changed.
function applyStyleStateToRecord(rec, st) {
  if (!rec || !st) return false;
  if (rec.schema === 'open-pdf-studio.text-edit-record' && rec.version === 2) {
    const patch = {
      faceId: resolvePackagedFace(st.family, st.bold, st.italic)?.id,
      size: st.size,
      color: st.color,
      bold: st.bold,
      italic: st.italic,
      underline: st.underline,
      strikeout: st.strikethrough,
    };
    for (const line of rec.richText.lines) {
      for (const run of line.runs) Object.assign(run, Object.fromEntries(Object.entries(patch).filter(([, value]) => value != null)));
    }
    rec.revision += 1;
    return true;
  }
  let changed = false;
  if (st.size != null && rec.fontSize !== st.size) { rec.fontSize = st.size; changed = true; }
  if (st.color != null && rec.color !== st.color) { rec.color = st.color; changed = true; }
  if (st.underline != null && rec.fontUnderline !== st.underline) { rec.fontUnderline = st.underline; changed = true; }
  if (st.strikethrough != null && rec.fontStrikethrough !== st.strikethrough) { rec.fontStrikethrough = st.strikethrough; changed = true; }
  const std = toStandardFontName(st.family, st.bold, st.italic);
  if (rec.fontFamily !== std) { rec.fontFamily = std; changed = true; }
  return changed;
}

// Live-update the open editor's CSS and keep its baseline anchored while font
// metrics or line height change.
function applyStyleStateToEditor(st) {
  if (!st) return;
  const decorations = [];
  if (st.underline) decorations.push('underline');
  if (st.strikethrough) decorations.push('line-through');
  const family = !st.fontFaceChanged && st.cssFamily
    ? st.cssFamily
    : cssFamilyFor(st.family);
  const style = {
    color: st.color || '#000000',
    'font-weight': st.bold ? 'bold' : 'normal',
    'font-style': st.italic ? 'italic' : 'normal',
    'font-family': family,
    'text-decoration-line': decorations.length ? decorations.join(' ') : 'none',
    'text-decoration-thickness': '0.06em',
    'text-underline-offset': '0.08em',
    'text-align': st.alignment || 'left',
  };
  const canonicalPatch = {
    typography: {
      color: st.color || '#000000',
      fontWeight: st.bold ? 'bold' : 'normal',
      fontStyle: st.italic ? 'italic' : 'normal',
      fontFamily: family,
      textAlign: st.alignment || 'left',
    },
    decoration: {
      textDecorationLine: decorations.length ? decorations.join(' ') : 'none',
      textDecorationThicknessEm: 0.06,
      textUnderlineOffsetEm: 0.08,
    },
  };

  if (activeEditor && st.size > 0) {
    const visualScale = activeEditor.visualScale || activeEditor.scale || 1;
    const fontSizePx = st.size * visualScale;
    const lineHeightPx = (activeEditor.lineSpacing || st.size * 1.2) * visualScale;
    style['font-size'] = `${fontSizePx}px`;
    style['line-height'] = `${lineHeightPx}px`;
    style.height = `${Math.max(getEditorText().split('\n').length * lineHeightPx, 24)}px`;
    canonicalPatch.typography.fontSize = st.size;
    canonicalPatch.typography.lineHeight = lineHeightPx / visualScale;
    canonicalPatch.geometry = {
      height: Math.max(getEditorText().split('\n').length * lineHeightPx, 24) / visualScale,
    };
    const baselineOffset = cssBaselineOffset(
      family, fontSizePx, lineHeightPx, st.bold, st.italic
    );
    let displayLeft = activeEditor.placement?.sourceClientAnchor?.left;
    let displayTop = activeEditor.placement?.sourceClientAnchor?.top;
    if (Number.isFinite(activeEditor.editorBaseline)) {
      displayTop = activeEditor.editorBaseline - baselineOffset;
      style.top = `${displayTop}px`;
    } else if (activeEditor.editorBaseline) {
      const baseline = activeEditor.editorBaseline;
      displayLeft = baseline.left - baseline.rotationC * baselineOffset;
      displayTop = baseline.top - baseline.rotationD * baselineOffset;
      style.left = `${displayLeft}px`;
      style.top = `${displayTop}px`;
    }
    const placement = activeEditor.placement;
    const sourceAnchor = placement?.sourceClientAnchor;
    if (sourceAnchor && Number.isFinite(displayLeft) && Number.isFinite(displayTop)) {
      const offset = canonicalDeltaFromDisplayDelta({
        x: displayLeft - sourceAnchor.left,
        y: displayTop - sourceAnchor.top,
      }, {
        scale: placement.sourceScale,
        rotation: placement.sourceRotation,
      });
      canonicalPatch.geometry.offsetX = offset.x;
      canonicalPatch.geometry.offsetY = offset.y;
    }
  }

  updatePdfEditorStyle(style, canonicalPatch);
}

function getTextEditGeometry(pageNum, canvasEl) {
  const doc = getActiveDocument();
  const scale = doc?.scale || 1;
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = canvasEl?.width ? canvasEl.width / (scale * dpr) : 0;
  const displayHeight = canvasEl?.height ? canvasEl.height / (scale * dpr) : 0;
  return resolveTextEditPageGeometry(
    doc?.pageDims?.[pageNum],
    displayWidth,
    displayHeight,
    getPageRotation(pageNum),
  );
}

/**
 * Open a brand-new application-owned text draft at a real page click. The
 * record remains detached from the owner document until the user explicitly
 * applies non-empty text; cancellation therefore has no document mutation to
 * undo or roll back.
 */
export function startInsertedTextEditingAtPoint(
  { x, y, pageNum, canvasEl } = {},
  { readinessGranted = false } = {},
) {
  if (rejectInvalidOwnedTextState()) return false;
  const ownerDocument = getActiveDocument();
  if (!ownerDocument || !canvasEl || !canvasEl.parentElement) return false;
  if (ownerDocument.pdfDoc && !readinessGranted) {
    void queueCurrentPageEditIntent({
      documentState: ownerDocument,
      pageNum,
      point: { x, y },
      activate: ({ documentState, pageNum: readyPage, point }) => {
        if (getActiveDocument() !== documentState) return false;
        const readyCanvas = livePageCanvas(readyPage);
        if (!readyCanvas) return false;
        return startInsertedTextEditingAtPoint({
          x: point.x,
          y: point.y,
          pageNum: readyPage,
          canvasEl: readyCanvas,
        }, { readinessGranted: true });
      },
    }).catch(reportQueuedEditFailure);
    return false;
  }
  const ownerGeneration = ownerDocument.lifecycleGeneration;
  const geometry = getTextEditGeometry(pageNum, canvasEl);
  let draft;
  try {
    draft = createInsertedTextDraft({
      page: pageNum,
      x,
      y,
      pageWidth: geometry.pageWidth,
      pageHeight: geometry.pageHeight,
      pageRotation: geometry.rotation,
    });
  } catch (error) {
    console.warn('[text-edit] Could not create inserted-text draft:', error);
    showMessage(hardeningText('textEditor.status.operationFailed'));
    return false;
  }

  let committed = false;
  startTextEditEditing(draft, pageNum, canvasEl, {
    draftOnly: true,
    commit(finalRecord) {
      if (committed) return false;
      if (getDocumentById(ownerDocument.id) !== ownerDocument
          || ownerDocument.lifecycleGeneration !== ownerGeneration) {
        showMessage(hardeningText('textEditor.status.staleDraft'));
        return false;
      }
      if (ownerDocument.textEdits?.some((record) => String(record.id) === String(finalRecord.id))) {
        console.warn('[text-edit] Inserted-text owner record already exists:', finalRecord.id);
        showMessage(hardeningText('textEditor.status.operationFailed'));
        return false;
      }
      const storedRecord = cloneTextEditRecord(finalRecord);
      const hadTextEdits = Array.isArray(ownerDocument.textEdits);
      const recorded = runOwnerScopedTextCommit({
        ownerDocument,
        attempt() {
          if (!ownerDocument.textEdits) ownerDocument.textEdits = [];
          ownerDocument.textEdits.push(storedRecord);
          return executeForDocument(ownerDocument, {
            type: 'addTextEdit',
            textEdit: cloneTextEditRecord(storedRecord),
          });
        },
        rollback() {
          const index = ownerDocument.textEdits?.indexOf(storedRecord) ?? -1;
          if (index >= 0) ownerDocument.textEdits.splice(index, 1);
          if (!hadTextEdits && ownerDocument.textEdits?.length === 0) {
            delete ownerDocument.textEdits;
          }
        },
      });
      if (!recorded) {
        setPdfEditorStatus(hardeningText('textEditor.status.operationFailed'), 'invalid');
        return false;
      }
      committed = true;
      return true;
    },
  });
  return true;
}

function pagePlacementForViewportStyle({
  doc,
  pageNum,
  geometry,
  sourceRect,
  canonicalStyle,
  containerRect,
  pageOffsetX = 0,
  pageOffsetY = 0,
  sourceScale,
  mode,
  canonicalBounds = null,
  commitBounds = null,
}) {
  const sourceLeft = Number(sourceRect?.left);
  const sourceTop = Number(sourceRect?.top);
  const sourceWidth = Number(sourceRect?.width);
  const sourceHeight = Number(sourceRect?.height);
  const hasSourceRect = [sourceLeft, sourceTop, sourceWidth, sourceHeight].every(Number.isFinite)
    && sourceWidth > 0 && sourceHeight > 0;
  if (!canonicalBounds && !hasSourceRect) {
    throw new TypeError('Page text editor requires canonical or finite display geometry');
  }
  const anchor = canonicalBounds || (() => {
    const displayX = (sourceLeft - containerRect.left - pageOffsetX) / sourceScale;
    const displayY = (sourceTop - containerRect.top - pageOffsetY) / sourceScale;
    const point = invertPageRotation(
      displayX,
      displayY,
      geometry.pageWidth,
      geometry.pageHeight,
      geometry.rotation,
    );
    return {
      x: point.x,
      y: point.y,
      width: sourceWidth / sourceScale,
      height: sourceHeight / sourceScale,
    };
  })();
  return createPageTextEditPlacement({
    documentId: doc.id,
    pageNum,
    pageWidth: geometry.pageWidth,
    pageHeight: geometry.pageHeight,
    canonicalBounds: anchor,
    commitBounds,
    sourceScale,
    sourceRotation: geometry.rotation,
    canonicalStyle,
    sourceClientAnchor: hasSourceRect ? { left: sourceLeft, top: sourceTop } : null,
    mode,
    generation: doc.lifecycleGeneration,
  });
}

function nativePageContentBounds(pageNum, layer, { block = null, provenance = null, editId = null } = {}) {
  const bounds = [];
  if (layer) {
    for (const candidate of getBlockGroups(layer)) {
      if (candidate === block) continue;
      const candidateProvenance = provenanceForSpans(candidate.spans);
      if (provenance && candidateProvenance
          && sameNativeTextOwnership(candidateProvenance, provenance)) continue;
      const region = richTextForNativeBlock(candidate, pageNum).region;
      bounds.push({ id: `source:${bounds.length}`, ...region });
    }
  }
  for (const record of getActiveDocument()?.textEdits?.filter((entry) => entry.page === pageNum) || []) {
    if (String(record.id) === String(editId)) continue;
    const projected = projectTextEditRecord(record);
    const region = projected.richText?.region;
    if (region) bounds.push({ id: `edit:${record.id}`, ...region });
  }
  return bounds;
}

function expandableNativeEditorOptions(document, pageNum, canvasEl, layer, options = {}) {
  const geometry = getTextEditGeometry(pageNum, canvasEl);
  const displayScale = Math.max(0.0001, Number(options.displayScale) || 1);
  const inkPaddingPx = Math.max(0, Number(options.inkPaddingPx ?? 2) || 0);
  const inkPadding = inkPaddingPx / displayScale;
  // Native/owned/inserted text is persisted at region.x with no content inset.
  // The editor's ink padding is presentation-only and must not reduce the
  // authored width or move the canonical PDF origin.
  const contentInset = Math.max(0, Number(options.contentInset) || 0);
  const sourceWidth = Math.max(0.0001, Number(options.sourceWidth) || document.region.width);
  const substitutionWidthAllowance = Math.max(
    0,
    Math.min(1, Number(options.substitutionWidthAllowance) || 0),
  );
  return {
    manualLineBreaks: options.manualLineBreaks ?? true,
    directManipulation: true,
    width: document.region.width,
    contentWidth: Math.max(0.0001, document.region.width - (contentInset * 2)),
    sourceWidth,
    substitutionWidthAllowance,
    effectiveContentWidth: Math.max(0.0001, document.region.width - (contentInset * 2)),
    contentInset,
    contentInsetPx: contentInset * displayScale,
    minimumHeight: options.minimumHeight ?? document.region.height,
    anchorTop: options.anchorTop ?? document.region.y + document.region.height,
    pageBounds: { x: 0, y: 0, width: geometry.pageWidth, height: geometry.pageHeight },
    columnBounds: options.columnBounds || options.block?.columnBounds || null,
    editorBackground: options.editorBackground || options.block?.editorBackground || '#ffffff',
    existingBounds: nativePageContentBounds(pageNum, layer, options),
    editId: options.editId,
    displayScale,
    inkPadding,
    inkPaddingPx,
    onDraftLayout: options.onDraftLayout,
  };
}

async function nativeLayoutReadyForCommit(editor, draft, operation) {
  if (!editor?.expandableNative) {
    return {
      status: 'ready',
      document: draft?.document || null,
      autoFit: { applied: false, priorBounds: null, nextBounds: null },
    };
  }
  const retainEditorFocus = () => queueMicrotask(() => {
    document.querySelector('.pdf-text-editor.rich-text-editor')?.focus();
  });
  if (!draft?.document || !draft?.layoutRevision?.fingerprint) {
    setPdfEditorStatus(hardeningText('textEditor.status.operationFailed'), 'invalid');
    retainEditorFocus();
    return {
      status: 'failed',
      rejectionCode: 'TEXT_LAYOUT_STALE_FINGERPRINT',
      rejectionReasons: ['Final text layout identity is incomplete'],
      document: draft?.document || null,
      autoFit: { applied: false, priorBounds: null, nextBounds: null },
    };
  }
  setPdfEditorStatus(hardeningText('textEditor.status.shaping'), 'shaping');
  // Source reconciliation is allowed only for an unchanged source draft.
  // This function is reached after authored dirty-state succeeds, so a width
  // increase must use the explicit safe auto-fit transaction instead.
  const finalInput = authoredFinalTextLayoutInput({
    document: draft.document,
    options: draft.options,
  });
  const finalRevision = createEditorLayoutRevision(
    finalInput.document,
    finalInput.options,
    draft.identity,
  );
  const decision = await awaitFinalTextLayout({
    sessionId: draft.sessionId,
    draftRevision: draft.draftRevision,
    fingerprint: finalRevision.fingerprint,
    document: finalInput.document,
    options: finalInput.options,
    identity: draft.identity,
    allowSafeAutoFit: true,
    signal: operation?.signal,
    timeoutMs: 5_000,
  });
  if (!editorApplyOperationIsCurrent(editor, operation)) return {
    ...decision,
    status: 'superseded',
  };
  adoptPdfEditorFinalTextLayout(decision);
  if (decision.status === 'ready' || decision.status === 'auto-fitted') {
    return decision;
  }
  const reasons = decision.rejectionReasons?.length
    ? decision.rejectionReasons.join('; ')
    : decision.rejectionCode || hardeningText('textEditor.status.operationFailed');
  const message = decision.rejectionCode === 'TEXT_LAYOUT_TIMEOUT'
    ? hardeningText('textEditor.status.layoutTimeout')
    : hardeningText('textEditor.status.layoutRejected', { reasons });
  setPdfEditorStatus(message, 'invalid');
  retainEditorFocus();
  return decision;
}

function applyActiveTextEditingWithStatus() {
  void applyActiveTextEditing().catch((error) => {
    console.warn('[text-edit] Apply failed:', error);
    setPdfEditorStatus(hardeningText('textEditor.status.operationFailed'), 'invalid');
  });
}

export function activateEditTextTool() {
  state.isEditingPdfText = true;
  void import('../pdf/editable-metadata-preload.js').then(({ scheduleEditableMetadataPreload }) => (
    scheduleEditableMetadataPreload(getActiveDocument()?.currentPage || 1, 1, { editTextActive: true })
  ));
  if (!ownedEditCaptureHandler) {
    ownedEditCaptureHandler = (event) => {
      if (!state.isEditingPdfText || state.currentTool !== 'editText') return;
      const target = event.target instanceof Element ? event.target : null;
      let scannedSpan = target?.closest('span[data-ocr-owner][data-ocr-line-id]') || null;
      let scannedLayer = scannedSpan?.closest('.textLayer') || null;
      if (!scannedSpan && target?.matches('canvas.pdf-canvas, #pdf-canvas')) {
        const point = { x: event.clientX, y: event.clientY };
        const surface = resolvePageSurfaceForElement(target, getActiveDocument());
        scannedLayer = surface?.textLayer || null;
        if (!spanAtClientPoint(
          scannedLayer,
          point,
          'span[data-ocr-owner][data-ocr-line-id]',
        )) scannedLayer = null;
        scannedSpan = spanAtClientPoint(
          scannedLayer,
          point,
          'span[data-ocr-owner][data-ocr-line-id]',
        );
      }
      if (scannedSpan) {
        const layer = scannedLayer || scannedSpan.closest('.textLayer');
        if (!layer) return;
        const pageNum = parseInt(layer?.dataset.page || '', 10)
          || getActiveDocument()?.currentPage || 1;
        const explicitLineIds = stagedScannedLineSelections.get(scannedSpan)
          || explicitScannedLineSelection(scannedSpan);
        stagedScannedLineSelections.delete(scannedSpan);
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) {
          const context = ocrParagraphContext(getActiveDocument(), pageNum);
          const region = context
            && paragraphRegionForLine(context.regions, scannedSpan.dataset.ocrLineId);
          if (region) toggleOcrParagraphSelection(pageNum, layer, region);
          return;
        }
        startTextLayerEditAtClientPointWhenReady({
          pageNum,
          clientX: event.clientX,
          clientY: event.clientY,
          preferredOcrLineId: scannedSpan.dataset.ocrLineId || '',
          stagedLineIds: explicitLineIds,
        });
        return;
      }
      const span = target?.closest('span[data-edit-id]') || null;
      if (!span) return;
      const layer = span.closest('.textLayer');
      const pageNum = parseInt(layer?.dataset.page || '', 10)
        || getActiveDocument()?.currentPage || 1;
      const record = getActiveDocument()?.textEdits?.find(
        (entry) => String(entry.id) === span.dataset.editId,
      );
      const canvasEl = livePageCanvas(pageNum, layer);
      if (!record || !canvasEl) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) {
        toggleTextBoxSelection(selectionItemForRecord(record, pageNum, layer));
        return;
      }
      clearTextBoxSelection();
      startTextEditEditing(record, pageNum, canvasEl);
    };
    document.addEventListener('click', ownedEditCaptureHandler, true);
  }
  // Overlay layers (annotation canvas z-index, form/link pointer-events) are
  // managed centrally by setAnnotationCanvasForTextAccess() in manager.js.
  enableTextLayerHover();
  startObservingTextLayers();
  installTextBoxSelectionHandlers();
}

export function deactivateEditTextTool(expectedSessionId = undefined) {
  const activeSessionId = getActiveTextEditSession()?.sessionId ?? null;
  // manager.setTool() reaches this module through a dynamic import. Retain
  // the session that belonged to the departing tool so a delayed callback
  // cannot cancel an annotation editor opened by the winning tool.
  const ownsActiveSession = textEditDeactivationOwnsSession(
    activeSessionId,
    expectedSessionId,
  );
  if (ownsActiveSession) {
    cancelActiveTextEditing('tool-deactivated');
  }
  if (ownedEditCaptureHandler) {
    document.removeEventListener('click', ownedEditCaptureHandler, true);
    ownedEditCaptureHandler = null;
  }
  disableTextLayerHover();
  stopObservingTextLayers();
  removeTextBoxSelectionHandlers();
  blockGroupsCache.clear();
  hideParagraphOutline();
  spanToBlock = new WeakMap();
  if (!ownsActiveSession) return 'superseded';
  state.isEditingPdfText = false;
  state.pdfTextEditState = null;
  // Overlay layers are restored by setAnnotationCanvasForTextAccess() in manager.js
  return 'closed';
}

// ── MutationObserver: re-attach when text layers are recreated ──

function startObservingTextLayers() {
  stopObservingTextLayers();
  const container = canvasContainer || document.getElementById('canvas-container');
  const continuous = continuousContainer || document.getElementById('continuous-container');
  const targets = [container, continuous].filter(Boolean);
  if (targets.length === 0) return;

  textLayerObserver = new MutationObserver(() => {
    if (state.isEditingPdfText && state.currentTool === 'editText') {
      blockGroupsCache.clear();
      spanToBlock = new WeakMap();
      enableTextLayerHover();
    }
  });
  for (const target of targets) {
    textLayerObserver.observe(target, { childList: true, subtree: true });
  }
}

function stopObservingTextLayers() {
  if (textLayerObserver) {
    textLayerObserver.disconnect();
    textLayerObserver = null;
  }
}

// ── Block grouping: spans → lines → multi-line blocks ──
//
// All grouping decisions use PDF user-space coordinates (from the transform
// matrix stored on each span).  DOM measurements are only used at the end
// to build the bounding rect the editor needs for positioning.

function getBlockGroups(layer) {
  if (blockGroupsCache.has(layer)) return blockGroupsCache.get(layer);

  const spans = Array.from(layer.querySelectorAll('span[data-pdf-transform]'));
  if (spans.length === 0) { blockGroupsCache.set(layer, []); return []; }

  const layerRect = layer.getBoundingClientRect();

  const items = spans.flatMap(span => {
    const r = span.getBoundingClientRect();
    let transform;
    try { transform = JSON.parse(span.dataset.pdfTransform); }
    catch (_) { return []; }
    if (!Array.isArray(transform) || transform.length < 6) return [];
    const fontSize = Math.sqrt(transform[2] ** 2 + transform[3] ** 2);
    let sourceText = '';
    let sourceRuns = [];
    try {
      const sources = JSON.parse(span.dataset.nativeTextProvenance || 'null');
      if (Array.isArray(sources)) {
        sourceRuns = sources;
        sourceText = sources.map((source) => source.decodedText || '').join('');
      }
    } catch (_) {
      sourceText = '';
      sourceRuns = [];
    }
    return [{
      span,
      text: span.textContent || '',
      sourceText,
      sourceRuns,
      // DOM coords – only for editor placement later
      domLeft: r.left - layerRect.left,
      domTop: r.top - layerRect.top,
      domRight: r.right - layerRect.left,
      domBottom: r.bottom - layerRect.top,
      // PDF coords – used for all grouping logic
      pdfX: transform[4],
      pdfY: transform[5],
      pdfWidth: parseFloat(span.dataset.pdfWidth) || 0,
      fontSize,
      fontFamily: span.style.fontFamily || '',
      actualFontName: span.dataset.pdfActualFontName || '',
    }];
  });
  const blocks = groupNativeTextFragments(items);
  if (blocks.length === 0) { blockGroupsCache.set(layer, []); return []; }

  // ── Build group objects ──
  // Find the PDF canvas to sample text colors
  const pageNum = Number(layer.dataset.page) || getActiveDocument()?.currentPage || 1;
  const pdfCanvasEl = livePageCanvas(pageNum, layer);

  const groups = blocks.map(nativeBlock => {
    const block = nativeBlock.lines;
    const allItems = block.flat();
    const allSpans = allItems.map(it => it.span);

    // DOM bounding rect (for editor placement)
    const minLeft = Math.min(...allItems.map(it => it.domLeft));
    const minTop = Math.min(...allItems.map(it => it.domTop));
    const maxRight = Math.max(...allItems.map(it => it.domRight));
    const maxBottom = Math.max(...allItems.map(it => it.domBottom));
    const editorBackground = sampleDominantBackgroundColor(pdfCanvasEl, {
      left: layerRect.left + minLeft,
      top: layerRect.top + minTop,
      right: layerRect.left + maxRight,
      bottom: layerRect.top + maxBottom,
    });

    const lineData = block.map(lineItems => {
      const sourceExtent = sourceTextLineExtent(lineItems);
      const firstSpan = lineItems[0].span;
      // Use actual font name from commonObjs (stored on dataset by text-layer.js)
      const pdfFontFamily = firstSpan.dataset.pdfFontFamily || 'sans-serif';
      const pdfFontName = firstSpan.dataset.pdfFontName || '';
      const actualFontName = firstSpan.dataset.pdfActualFontName || '';
      const loadedFontName = firstSpan.dataset.pdfLoadedFontName || '';
      const isBold = firstSpan.dataset.pdfBold === 'true';
      const isItalic = firstSpan.dataset.pdfItalic === 'true';

      const color = sampleTextColor(pdfCanvasEl, firstSpan.getBoundingClientRect());

      const pieces = nativeTextLinePieces(lineItems);
      const runs = pieces.map((piece, runIndex) => {
        const item = piece.item;
        const source = piece.source;
        const runSpan = item.span;
        const actual = runSpan.dataset.pdfActualFontName || runSpan.dataset.pdfFontFamily || '';
        const bold = runSpan.dataset.pdfBold === 'true';
        const italic = runSpan.dataset.pdfItalic === 'true';
        const face = resolvePackagedFace(actual, bold, italic);
        const sourceGeometry = Array.isArray(source?.geometry) ? source.geometry : null;
        const sourceSize = Number(source?.fontSize);
        const runSize = Number.isFinite(sourceSize) && sourceSize > 0 ? sourceSize : item.fontSize;
        const sourceColor = /^#[0-9a-f]{6}$/iu.test(source?.fillColor || '')
          ? source.fillColor.toLowerCase()
          : null;
        return createTextRun(piece.text, {
          faceId: face?.id,
          size: runSize,
          color: sourceColor || sampleTextColor(pdfCanvasEl, runSpan.getBoundingClientRect()),
          bold,
          italic,
          underline: false,
          strikeout: false,
          direction: 'ltr',
        }, {
          id: source?.markerId || `source-${runSpan.dataset.pdfFontName || 'font'}-${runIndex}`,
          sourceConfidence: sourceColor ? 1 : (actual ? 0.9 : 0.5),
          geometry: {
            x: piece.syntheticSpace ? item.pdfX + item.pdfWidth
              : (Number(sourceGeometry?.[0]) || item.pdfX),
            baseline: Number(sourceGeometry?.[1]) || item.pdfY,
            width: piece.syntheticSpace ? Math.max(item.fontSize * 0.25, 0.5)
              : (Number(sourceGeometry?.[2]) || item.pdfWidth),
            height: Number(sourceGeometry?.[3]) || runSize,
          },
        });
      });

      return {
        text: pieces.map((piece) => piece.text).join(''),
        domTop: Math.min(...lineItems.map(it => it.domTop)),
        domBottom: Math.max(...lineItems.map(it => it.domBottom)),
        pdfX: sourceExtent.x,
        pdfY: lineItems[0].pdfY,
        pdfWidth: sourceExtent.width,
        fontSize: lineItems[0].fontSize,
        spans: lineItems.map(it => it.span),
        fontFamily: pdfFontFamily,
        pdfFontName,
        actualFontName,
        loadedFontName,
        isBold,
        isItalic,
        color: runs[0]?.color || color,
        runs,
      };
    });

    // Baseline-to-baseline spacing in PDF units
    let lineSpacing = lineData[0].fontSize * 1.2;
    if (lineData.length > 1) {
      let total = 0;
      for (let i = 1; i < lineData.length; i++) {
        total += lineData[i - 1].pdfY - lineData[i].pdfY;
      }
      lineSpacing = total / (lineData.length - 1);
    }

    const group = {
      spans: allSpans,
      lineData,
      lineSpacing,
      columnId: nativeBlock.columnId,
      columnBounds: nativeBlock.columnBounds,
      laneValid: allItems.every((item) => (
        item.pdfX >= nativeBlock.columnBounds.left - 1e-6
        && item.pdfX + item.pdfWidth <= nativeBlock.columnBounds.right + 1e-6
      )),
      editorBackground,
      rect: { left: minLeft, top: minTop, width: maxRight - minLeft, height: maxBottom - minTop }
    };

    for (const sp of allSpans) spanToBlock.set(sp, group);
    return group;
  });

  blockGroupsCache.set(layer, groups);
  return groups;
}

// ── Hover & click wiring ──

function ownedTextEditAtClientPoint(clientX, clientY, pageNum, layer) {
  const canvasEl = livePageCanvas(pageNum, layer);
  if (!canvasEl) return null;
  const canvasRect = canvasEl.getBoundingClientRect();
  const documentState = getActiveDocument();
  const viewGeometry = getTextEditViewGeometry(canvasEl, documentState);
  const viewScale = viewGeometry.visualScale;
  if (!(viewScale > 0)) return null;
  const record = findTextEditAtPosition(
    (clientX - canvasRect.left - viewGeometry.offsetX) / viewScale,
    (clientY - canvasRect.top - viewGeometry.offsetY) / viewScale,
    pageNum,
    canvasEl,
  );
  return record ? { record, canvasEl } : null;
}

export async function startTextLayerEditAtClientPointWhenReady({
  pageNum,
  clientX,
  clientY,
  preferredEditId = '',
  preferredMarkerIds = '',
  preferredOcrLineId = '',
  preferredOcrRegionId = '',
  preferredOcrRecognitionGeneration = '',
  stagedLineIds = [],
}) {
  const ownerDocument = getActiveDocument();
  if (!ownerDocument) return textEditActivationResult({ reason: 'no-document' });
  const activate = async ({ documentState, pageNum: readyPage, point }) => {
    if (getActiveDocument() !== documentState) return false;
    const layer = livePageTextLayer(readyPage);
    if (!layer) return false;
    const candidateSelector = 'span:not([data-ocr-owner]), span[data-ocr-owner][data-ocr-line-id]';
    let liveSpan = spanAtClientPoint(layer, point, candidateSelector);
    if (!liveSpan) {
      liveSpan = [...layer.querySelectorAll(candidateSelector)].find((candidate) => (
        (preferredEditId && candidate.dataset.editId === preferredEditId)
        || (preferredMarkerIds && candidate.dataset.nativeTextMarkerIds === preferredMarkerIds)
        || (preferredOcrLineId && candidate.dataset.ocrLineId === preferredOcrLineId)
        || (preferredOcrRegionId && candidate.dataset.ocrRegionId === preferredOcrRegionId)
      ));
    }
    if (liveSpan?.dataset.ocrOwner && preferredOcrRecognitionGeneration
        && liveSpan.dataset.ocrRecognitionGeneration !== preferredOcrRecognitionGeneration) {
      return false;
    }
    if (liveSpan?.dataset.ocrOwner) {
      return startScannedTextEditing(liveSpan, readyPage, stagedLineIds, {
        readinessGranted: true,
        clientPoint: point,
      });
    }
    if (liveSpan) {
      return startPdfTextEditing(liveSpan, readyPage, {
        readinessGranted: true,
        clientPoint: point,
      });
    }
    const ownedHit = ownedTextEditAtClientPoint(point.x, point.y, readyPage, layer);
    if (!ownedHit) return false;
    return startTextEditEditing(
      ownedHit.record,
      readyPage,
      ownedHit.canvasEl,
      null,
      { readinessGranted: true },
    );
  };
  const point = { x: clientX, y: clientY };
  if (!ownerDocument.pdfDoc) {
    const activated = await activate({ documentState: ownerDocument, pageNum, point });
    return textEditActivationResult({
      activated: activated === true,
      reason: activated === true ? null : 'target-unavailable',
    });
  }
  try {
    const queued = await queueCurrentPageEditIntent({
      documentState: ownerDocument,
      pageNum,
      point,
      activate,
    });
    if (queued?.activated !== true) {
      return textEditActivationResult({
        reason: queued?.reason || 'readiness-failed',
        errorCode: queued?.errorCode || null,
        message: queued?.message || null,
        action: queued?.action || null,
      });
    }
    return textEditActivationResult({
      activated: queued.value === true,
      reason: queued.value === true ? null : 'target-unavailable',
    });
  } catch (error) {
    reportQueuedEditFailure(error);
    return textEditActivationResult({
      reason: 'activation-failed',
      errorCode: error?.code || 'TEXT_EDIT_ACTIVATION_FAILED',
      message: error instanceof Error ? error.message : String(error),
      action: 'retry-page-edit',
    });
  }
}

function enableTextLayerHover() {
  const textLayers = mountedPageSurfaces(getActiveDocument())
    .map((surface) => surface.textLayer)
    .filter((layer, index, layers) => layer && layers.indexOf(layer) === index);
  const alreadyAttached = new Set(hoverListeners.map(h => h.span));

  textLayers.forEach(layer => {
    layer.style.pointerEvents = 'auto';
    // Force block computation so spanToBlock is populated
    getBlockGroups(layer);

    const pageNum = parseInt(layer.dataset.page) || (getActiveDocument()?.currentPage || 1);
    if (!layerOwnedEditListeners.some((entry) => entry.layer === layer)) {
      const ownedEditClickHandler = (event) => {
        if (event.target !== layer
            || !state.isEditingPdfText
            || state.currentTool !== 'editText') return;
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          const hit = ownedTextEditAtClientPoint(event.clientX, event.clientY, pageNum, layer);
          if (!hit) return;
          toggleTextBoxSelection(selectionItemForRecord(hit.record, pageNum, layer));
          return;
        }
        clearTextBoxSelection();
        startTextLayerEditAtClientPointWhenReady({
          pageNum,
          clientX: event.clientX,
          clientY: event.clientY,
        });
      };
      layer.addEventListener('click', ownedEditClickHandler);
      layerOwnedEditListeners.push({ layer, click: ownedEditClickHandler });
    }
    // Pending OCR uses immutable engine results plus separate review
    // corrections. It must not enter the legacy PDF-content edit path.
    const spans = layer.querySelectorAll('span:not([data-ocr-owner])');
    spans.forEach(span => {
      if (alreadyAttached.has(span)) return;
      span.style.pointerEvents = 'auto';
      span.style.cursor = 'text';
      span.classList.add('edit-text-hoverable');

      const enterHandler = () => {
        const block = spanToBlock.get(span) || ownedEditOutlineBlock(span, layer);
        if (block) showParagraphOutline(layer, block);
      };
      const leaveHandler = (event) => {
        const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest('span') : null;
        const block = spanToBlock.get(span);
        if ((block && next && spanToBlock.get(next) === block)
            || (span.dataset.editId && next?.dataset.editId === span.dataset.editId)) return;
        hideParagraphOutline();
      };
      const clickHandler = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const editId = span.dataset.editId || '';
        const markerIds = span.dataset.nativeTextMarkerIds || '';
        const doc = getActiveDocument();
        if (!e.shiftKey) {
          clearTextBoxSelection();
          startTextLayerEditAtClientPointWhenReady({
            pageNum,
            clientX: e.clientX,
            clientY: e.clientY,
            preferredEditId: editId,
            preferredMarkerIds: markerIds,
          });
          return;
        }
        if (editId) {
          const ownedRecord = doc?.textEdits?.find((record) => String(record.id) === editId);
          const ownedCanvas = livePageCanvas(pageNum, layer, doc);
          if (ownedRecord && ownedCanvas) {
            if (e.shiftKey) {
              toggleTextBoxSelection(selectionItemForRecord(ownedRecord, pageNum, layer));
              return;
            }
            clearTextBoxSelection();
            startTextEditEditing(ownedRecord, pageNum, ownedCanvas);
            return;
          }
        }
        const ownedHit = ownedTextEditAtClientPoint(e.clientX, e.clientY, pageNum, layer);
        if (ownedHit) {
          if (e.shiftKey) {
            toggleTextBoxSelection(selectionItemForRecord(ownedHit.record, pageNum, layer));
            return;
          }
          clearTextBoxSelection();
          startTextEditEditing(ownedHit.record, pageNum, ownedHit.canvasEl);
          return;
        }
        try {
          const page = await doc?.pdfDoc?.getPage(pageNum);
          if (page) await resolveTextLayerFonts(page, layer);
        } catch (_) {
          // Keep editing available with a standard fallback if a font cannot
          // be resolved (damaged or unsupported embedded font).
        }
        if (!state.isEditingPdfText || state.currentTool !== 'editText') return;
        blockGroupsCache.delete(layer);
        getBlockGroups(layer);
        // Font resolution can recreate PDF.js spans. Retarget the live span by
        // owned edit id (or exact native marker set) after that await instead
        // of trying to edit a detached pre-resolution node.
        let liveSpan = span;
        if (!liveSpan.isConnected || liveSpan.closest('.textLayer') !== layer) {
          liveSpan = [...layer.querySelectorAll('span:not([data-ocr-owner])')].find((candidate) => (
            (editId && candidate.dataset.editId === editId)
            || (markerIds && candidate.dataset.nativeTextMarkerIds === markerIds)
          ));
        }
        if (liveSpan) {
          if (e.shiftKey) {
            const block = spanToBlock.get(liveSpan);
            if (block) toggleTextBoxSelection(selectionItemForBlock(block, pageNum, layer));
          } else {
            clearTextBoxSelection();
            startPdfTextEditing(liveSpan, pageNum);
          }
        }
      };
      span.addEventListener('mouseenter', enterHandler);
      span.addEventListener('mouseleave', leaveHandler);
      span.addEventListener('click', clickHandler);
      hoverListeners.push({ span, enter: enterHandler, leave: leaveHandler, click: clickHandler });
    });

    const scannedSpans = layer.querySelectorAll('span[data-ocr-owner][data-ocr-line-id]');
    scannedSpans.forEach((span) => {
      const documentState = getActiveDocument();
      const identityContext = ocrParagraphContext(documentState, pageNum);
      const identityRegion = identityContext
        && paragraphRegionForLine(identityContext.regions, span.dataset.ocrLineId);
      const regionIdentity = scannedSpanRegionIdentity(
        documentState, pageNum, span, identityRegion,
      );
      const recognitionGeneration = identityContext?.result?.document?.generation;
      if (regionIdentity) {
        span.dataset.ocrRegionId = String(regionIdentity.id);
        span.dataset.ocrRegionLineIds = regionIdentity.lineIds.join(' ');
      } else {
        delete span.dataset.ocrRegionId;
        delete span.dataset.ocrRegionLineIds;
      }
      if (recognitionGeneration) {
        span.dataset.ocrRecognitionGeneration = String(recognitionGeneration);
      } else {
        delete span.dataset.ocrRecognitionGeneration;
      }
      if (alreadyAttached.has(span)) return;
      span.style.pointerEvents = 'auto';
      span.style.cursor = 'text';
      span.classList.add('edit-text-hoverable');
      const enterHandler = () => {
        span.classList.add('edit-text-block-hover');
        const context = ocrParagraphContext(getActiveDocument(), pageNum);
        const region = context && paragraphRegionForLine(context.regions, span.dataset.ocrLineId);
        if (region) showOcrParagraphOutline(layer, region);
      };
      const leaveHandler = (event) => {
        span.classList.remove('edit-text-block-hover');
        const next = event.relatedTarget instanceof Element
          ? event.relatedTarget.closest('span[data-ocr-owner][data-ocr-line-id]') : null;
        const context = ocrParagraphContext(getActiveDocument(), pageNum);
        const currentRegion = context && paragraphRegionForLine(context.regions, span.dataset.ocrLineId);
        const nextRegion = next && context && paragraphRegionForLine(context.regions, next.dataset.ocrLineId);
        if (!currentRegion || currentRegion.id !== nextRegion?.id) hideParagraphOutline();
      };
      const mouseDownHandler = () => {
        if (!state.isEditingPdfText || state.currentTool !== 'editText') return;
        // A native click normally collapses the DOM range before `click` runs.
        // Capture only the user's current explicit OCR line selection here; do
        // not synthesize neighbouring lines or infer a paragraph.
        stagedScannedLineSelections.set(span, explicitScannedLineSelection(span));
      };
      const clickHandler = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!state.isEditingPdfText || state.currentTool !== 'editText') return;
        const explicitLineIds = stagedScannedLineSelections.get(span)
          || explicitScannedLineSelection(span);
        stagedScannedLineSelections.delete(span);
        if (!event.shiftKey) {
          startTextLayerEditAtClientPointWhenReady({
            pageNum,
            clientX: event.clientX,
            clientY: event.clientY,
            preferredOcrLineId: span.dataset.ocrLineId || '',
            stagedLineIds: explicitLineIds,
          });
          return;
        }
        const context = ocrParagraphContext(getActiveDocument(), pageNum);
        const region = context && paragraphRegionForLine(context.regions, span.dataset.ocrLineId);
        if (event.shiftKey && region) {
          toggleOcrParagraphSelection(pageNum, layer, region);
          return;
        }
      };
      const contextMenuHandler = (event) => {
        if (!state.isEditingPdfText || state.currentTool !== 'editText') return;
        const doc = getActiveDocument();
        const context = ocrParagraphContext(doc, pageNum);
        const region = context && paragraphRegionForLine(context.regions, span.dataset.ocrLineId);
        if (!doc || !context || !region) return;
        event.preventDefault();
        event.stopPropagation();
        showOcrParagraphMenu(event.clientX, event.clientY, {
          pageNum,
          lineId: span.dataset.ocrLineId,
          regionId: region.id,
          actions: ocrParagraphActionsForSpan({ doc, pageNum, span, context, region }),
        });
      };
      span.addEventListener('mouseenter', enterHandler);
      span.addEventListener('mouseleave', leaveHandler);
      span.addEventListener('mousedown', mouseDownHandler);
      span.addEventListener('click', clickHandler);
      span.addEventListener('contextmenu', contextMenuHandler);
      hoverListeners.push({
        span,
        enter: enterHandler,
        leave: leaveHandler,
        mouseDown: mouseDownHandler,
        click: clickHandler,
        contextmenu: contextMenuHandler,
      });
    });
  });
}

function disableTextLayerHover() {
  // If switching to the select tool, preserve pointer-events for text selection
  // (this runs asynchronously after setTool() has already applied select-tool state)
  const keepTextAccess = state.currentTool === 'select';

  for (const h of hoverListeners) {
    h.span.removeEventListener('mouseenter', h.enter);
    h.span.removeEventListener('mouseleave', h.leave);
    if (h.mouseDown) h.span.removeEventListener('mousedown', h.mouseDown);
    h.span.removeEventListener('click', h.click);
    if (h.contextmenu) h.span.removeEventListener('contextmenu', h.contextmenu);
    h.span.classList.remove('edit-text-hoverable', 'edit-text-block-hover');
    h.span.style.pointerEvents = keepTextAccess ? 'auto' : '';
    h.span.style.cursor = keepTextAccess ? 'text' : '';
  }
  hoverListeners = [];
  hideParagraphOutline();
  for (const entry of layerOwnedEditListeners) {
    entry.layer.removeEventListener('click', entry.click);
  }
  layerOwnedEditListeners = [];

  mountedPageSurfaces(getActiveDocument())
    .map((surface) => surface.textLayer)
    .filter(Boolean)
    .forEach(layer => {
    layer.style.pointerEvents = keepTextAccess ? 'auto' : '';
  });
}

// ── Inline editor ──

function appliedScannedSelection(doc, pageNum, lineId, selectionId = null) {
  return doc?.scannedTextEdits?.pages
    ?.find((page) => page.index === pageNum - 1)
    ?.selections?.find((selection) => (selectionId
      ? selection.id === selectionId
      : selection.target?.targetId === lineId || selection.target?.lineIds?.includes(lineId))
      && selection.repair?.status === 'applied'
      && ['isolated-horizontal-line', 'fixed-region-multiline', SCANNED_TEXT_REFLOW_SCOPE]
        .includes(selection.content?.scope)) || null;
}

function scannedSpanRegionIdentity(doc, pageNum, span, liveRegion = null) {
  if (liveRegion?.id && Array.isArray(liveRegion.lineIds)) {
    return { id: liveRegion.id, lineIds: liveRegion.lineIds };
  }
  const persistedSelection = appliedScannedSelection(
    doc,
    pageNum,
    span?.dataset?.ocrLineId || '',
    span?.dataset?.scannedTextEditSelectionId || null,
  );
  return persistedSelection?.target?.kind === 'region'
    ? {
        id: persistedSelection.target.targetId,
        lineIds: persistedSelection.target.lineIds,
      }
    : null;
}

function explicitScannedLineSelection(span) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
  const range = selection.getRangeAt(0);
  try {
    if (!range.intersectsNode(span)) return [];
  } catch (_) {
    return [];
  }
  const layer = span.closest('.textLayer');
  if (!layer) return [];
  const ids = [];
  const seen = new Set();
  const candidates = [...layer.querySelectorAll('span[data-ocr-owner][data-ocr-line-id]')]
    .sort((left, right) => Number(left.dataset.ocrReadingOrder) - Number(right.dataset.ocrReadingOrder));
  for (const candidate of candidates) {
    if (candidate.dataset.scannedTextEditHitOnly === 'true') continue;
    let intersects = false;
    try { intersects = range.intersectsNode(candidate); } catch (_) {}
    if (!intersects) continue;
    const sourceIds = (candidate.dataset.ocrSourceLineIds || candidate.dataset.ocrLineId || '')
      .split(/\s+/u).filter(Boolean);
    for (const lineId of sourceIds) {
      if (seen.has(lineId)) continue;
      seen.add(lineId);
      ids.push(lineId);
    }
  }
  return ids;
}

function scannedEditorRect(span, lineIds) {
  const layer = span.closest('.textLayer');
  const selected = lineIds.length > 1 && layer
    ? [...layer.querySelectorAll('span[data-ocr-owner][data-ocr-line-id]')].filter((candidate) => {
        const ids = (candidate.dataset.ocrSourceLineIds || candidate.dataset.ocrLineId || '')
          .split(/\s+/u).filter(Boolean);
        return ids.some((lineId) => lineIds.includes(lineId));
      })
    : [span];
  const rects = selected.map((candidate) => candidate.getBoundingClientRect());
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
    width: Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left)),
    height: Math.max(...rects.map((rect) => rect.bottom)) - Math.min(...rects.map((rect) => rect.top)),
    firstLineHeight: rects[0]?.height || 0,
  };
}

function scannedDisplayFont(fontClass) {
  if (fontClass === 'monospace') return { name: 'Courier New', css: '"Courier New", Courier, monospace' };
  if (fontClass === 'serif') return { name: 'Times New Roman', css: '"Times New Roman", Times, serif' };
  return { name: 'Arial', css: 'Helvetica, Arial, sans-serif' };
}

function scannedStyleOverrides(editor) {
  const touched = editor.styleTouchedKeys || new Set();
  const style = editor.styleState;
  const output = {};
  if (touched.has('fontClass')) {
    output.fontClass = scannedFontClassFromFamily(style.family);
  }
  if (touched.has('fontSize')) output.fontSize = style.size;
  if (touched.has('weight')) output.weight = style.bold ? 'bold' : 'normal';
  if (touched.has('italic')) output.italic = style.italic === true;
  if (touched.has('textColor')) output.textColor = style.color;
  if (touched.has('alignment')) output.alignment = style.alignment;
  return output;
}

function createScannedRepairPreview(span, selection, editorRect = null, pageContext = null) {
  const patch = selection.repair.repairedPatch;
  const sourcePoints = selection.geometry.lineGeometry
    .flatMap((entry) => entry.sourcePolygon.points);
  const minX = Math.min(...sourcePoints.map((point) => point[0]));
  const maxX = Math.max(...sourcePoints.map((point) => point[0]));
  const minY = Math.min(...sourcePoints.map((point) => point[1]));
  const maxY = Math.max(...sourcePoints.map((point) => point[1]));
  const rect = editorRect || span.getBoundingClientRect();
  const scaleX = rect.width / Math.max(1, maxX - minX);
  const scaleY = rect.height / Math.max(1, maxY - minY);
  const canvas = document.createElement('canvas');
  canvas.width = patch.widthPx;
  canvas.height = patch.heightPx;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.scannedTextEditorPreview = selection.id;
  const previewRect = {
    left: rect.left - (minX - patch.originX) * scaleX,
    top: rect.top - (minY - patch.originY) * scaleY,
    width: patch.widthPx * scaleX,
    height: patch.heightPx * scaleY,
  };
  canvas.style.position = 'absolute';
  canvas.style.left = `${previewRect.left}px`;
  canvas.style.top = `${previewRect.top}px`;
  canvas.style.width = `${previewRect.width}px`;
  canvas.style.height = `${previewRect.height}px`;
  canvas.style.zIndex = '999';
  canvas.style.pointerEvents = 'none';
  const context = canvas.getContext('2d');
  if (!context) return null;
  const binary = atob(patch.data);
  const rgba = new Uint8ClampedArray(binary.length);
  for (let index = 0; index < binary.length; index += 1) rgba[index] = binary.charCodeAt(index);
  const image = context.createImageData(patch.widthPx, patch.heightPx);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
  if (pageContext?.doc && pageContext.frame && pageContext.geometry) {
    const { doc, pageNum, frame, geometry } = pageContext;
    const bounds = canonicalBoundsFromDisplayRect(previewRect, frame);
    const origin = applyPageRotation(
      bounds.x,
      bounds.y,
      geometry.pageWidth,
      geometry.pageHeight,
      geometry.rotation,
    );
    const containerLeft = frame.containerLeft;
    const containerTop = frame.containerTop;
    const previewCss = {
      position: 'absolute',
      left: `${containerLeft + frame.offsetX + origin.x * frame.scale}px`,
      top: `${containerTop + frame.offsetY + origin.y * frame.scale}px`,
      width: `${bounds.width * frame.scale}px`,
      height: `${bounds.height * frame.scale}px`,
      'z-index': '1',
      'pointer-events': 'none',
      'image-rendering': 'auto',
    };
    Object.assign(canvas.style, previewCss);
    canvas._pageTextEditPlacement = createPageTextEditPlacement({
      documentId: doc.id,
      pageNum,
      pageWidth: geometry.pageWidth,
      pageHeight: geometry.pageHeight,
      canonicalBounds: bounds,
      sourceScale: frame.scale,
      sourceRotation: geometry.rotation,
      canonicalStyle: createPageTextEditStyle({
        geometry: { width: bounds.width, height: bounds.height, zIndex: 1 },
        layout: { pointerEvents: 'none', imageRendering: 'auto' },
      }),
      sourceClientAnchor: {
        left: containerLeft + frame.offsetX + origin.x * frame.scale,
        top: containerTop + frame.offsetY + origin.y * frame.scale,
      },
      mode: 'ocr-repair-preview',
      generation: doc.lifecycleGeneration,
    });
  }
  document.body.appendChild(canvas);
  return canvas;
}

async function sourceRasterForScannedLine(doc, result) {
  if (!doc?.filePath) throw new Error('Scanned text editing requires a saved local macOS PDF');
  const scale = result.sourceRaster.dpi / 72;
  const rasterized = await rasterizePdfPageForOcr({
    path: doc.filePath,
    pageIndex: result.page.index,
    scale,
  });
  if (rasterized.image.width !== result.sourceRaster.widthPx
      || rasterized.image.height !== result.sourceRaster.heightPx) {
    throw Object.assign(new Error('The current PDF raster no longer matches the OCR source geometry'), {
      code: 'STALE_OCR_RASTER',
    });
  }
  return {
    widthPx: rasterized.image.width,
    heightPx: rasterized.image.height,
    rowBytes: rasterized.image.width * 4,
    data: new Uint8ClampedArray(rasterized.image.rgba),
    sourceRasterId: result.sourceRaster.id,
    sourceRasterFingerprint: result.sourceRaster.fingerprint,
  };
}

async function startScannedTextEditing(
  span,
  pageNum,
  stagedLineIds = [],
  { readinessGranted = false, clientPoint = null } = {},
) {
  let doc = getActiveDocument();
  const preferredLineId = span?.dataset?.ocrLineId || '';
  if (!doc || !preferredLineId) return false;
  if (doc.pdfDoc && !readinessGranted) {
    const fallbackPoint = clientPoint || (() => {
      const rect = span.getBoundingClientRect?.();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })();
    try {
      const queued = await queueCurrentPageEditIntent({
        documentState: doc,
        pageNum,
        point: fallbackPoint,
        activate: ({ documentState, pageNum: readyPage, point }) => {
          if (getActiveDocument() !== documentState) return false;
          const layer = livePageTextLayer(readyPage);
          const liveSpan = spanAtClientPoint(
            layer,
            point,
            'span[data-ocr-owner][data-ocr-line-id]',
          ) || [...(layer?.querySelectorAll('span[data-ocr-owner][data-ocr-line-id]') || [])]
            .find((candidate) => candidate.dataset.ocrLineId === preferredLineId);
          if (!liveSpan) return false;
          return startScannedTextEditing(liveSpan, readyPage, stagedLineIds, {
            readinessGranted: true,
            clientPoint: point,
          });
        },
      });
      return queued?.activated === true && queued.value === true;
    } catch (error) {
      reportQueuedEditFailure(error);
      return false;
    }
  }
  doc = getDocumentById(doc.id);
  if (!doc || getActiveDocument() !== doc) return false;
  const liveLayer = livePageTextLayer(pageNum);
  if (!span?.isConnected || span.closest('.textLayer') !== liveLayer) {
    span = spanAtClientPoint(liveLayer, clientPoint, 'span[data-ocr-owner][data-ocr-line-id]')
      || [...(liveLayer?.querySelectorAll('span[data-ocr-owner][data-ocr-line-id]') || [])]
        .find((candidate) => candidate.dataset.ocrLineId === preferredLineId);
  }
  const lineId = span?.dataset?.ocrLineId;
  if (!span || !lineId) return false;
  cancelActiveTextEditing('superseded');
  const ownerGeneration = Number(doc.lifecycleGeneration) || 0;
  let selection = appliedScannedSelection(
    doc,
    pageNum,
    lineId,
    span.dataset.scannedTextEditSelectionId || null,
  );
  const existingOwnedEdit = Boolean(selection);
  let raster = null;
  let result = null;
  let pageGeometry = null;
  let target = selection?.target?.kind === 'region'
    ? {
        kind: 'region',
        regionId: selection.target.targetId,
        lineIds: [...selection.target.lineIds],
      }
    : { kind: 'line', lineId: selection?.target?.targetId || lineId };
  try {
    if (!selection) {
      const paragraphContext = ocrParagraphContext(doc, pageNum);
      result = paragraphContext?.result;
      pageGeometry = paragraphContext?.pageGeometry;
      if (!result || !pageGeometry) {
        throw Object.assign(new Error('This scanned line does not have a current application-owned OCR result'), {
          code: 'OCR_SOURCE_UNAVAILABLE',
        });
      }
      const explicitlySelectedLineIds = (stagedLineIds.length > 0
        ? stagedLineIds
        : explicitScannedLineSelection(span))
        .filter((candidate) => result.lines.some((line) => line.id === candidate));
      const selectedRegions = explicitlySelectedLineIds.length > 0
        ? partitionSelectionByParagraph(paragraphContext.regions, explicitlySelectedLineIds)
        : [];
      if (selectedRegions.length > 1) {
        const layer = span.closest('.textLayer');
        if (layer) showOcrParagraphSelection(layer, selectedRegions);
        showMessage(hardeningText('textEditor.status.multipleOcrParagraphs'));
        return false;
      }
      const inferredRegion = selectedRegions[0]
        || paragraphRegionForLine(paragraphContext.regions, lineId);
      if (!inferredRegion) throw new Error('The selected OCR line no longer belongs to current paragraph geometry');
      if (!inferredRegion.editable && inferredRegion.rejectionReason === OCR_PARAGRAPH_LINE_LIMIT_REASON) {
        throw Object.assign(new Error('This paragraph contains more than 32 OCR lines. Split it manually before editing.'), {
          code: OCR_PARAGRAPH_LINE_LIMIT_REASON,
        });
      }
      if (!inferredRegion.editable) {
        throw Object.assign(new Error('This paragraph has unsupported or ambiguous source geometry and cannot be edited safely.'), {
          code: inferredRegion.rejectionReason,
        });
      }
      target = inferredRegion.lineIds.length > 1
        ? fixedRegionTargetFromLineIds(result, inferredRegion.lineIds)
        : { kind: 'line', lineId: inferredRegion.lineIds[0] };
      const targetLines = target.kind === 'region'
        ? target.lineIds.map((targetLineId) => result.lines.find((entry) => entry.id === targetLineId))
        : [result.lines.find((entry) => entry.id === lineId)];
      const line = targetLines[0];
      if (!line) throw new Error('The selected OCR line is no longer available');
      if (targetLines.some((entry) => !entry)) throw new Error('One or more selected OCR lines are no longer available');
      raster = await sourceRasterForScannedLine(doc, result);
      const preflight = await evaluateScannedTextEdit({
        result,
        pageGeometry,
        raster,
        target,
        replacementText: targetLines.map((entry) => entry.text).join('\n'),
        contextPaddingPx: 24,
      });
      if (!preflight.selection.analysis.eligibility.eligible || !preflight.selection.content) {
        const reasons = preflight.selection.analysis.eligibility.rejectionReasons
          .map((reason) => reason.message).join('; ');
        throw Object.assign(new Error(reasons || 'This scanned region is not eligible for safe editing'), {
          code: 'INELIGIBLE_EDIT_REGION',
        });
      }
      selection = preflight.selection;
    }
  } catch (error) {
    console.warn('[scanned-text-edit] Eligibility failed:', error);
    showMessage(hardeningText('textEditor.status.operationFailed'));
    return false;
  }

  // Rasterization and eligibility evaluation are asynchronous. Never adopt
  // their result into an editor after the opening gesture's tab or PDF proxy
  // stopped being current; registering with the newer generation would make
  // stale OCR geometry appear current.
  if (getActiveDocument() !== doc
      || getDocumentById(doc.id) !== doc
      || (Number(doc.lifecycleGeneration) || 0) !== ownerGeneration) return false;

  const estimate = selection.content.estimatedStyle;
  const font = scannedDisplayFont(estimate.fontClass.value);
  const lineIds = selection.target.lineIds;
  const fixedRegion = ['fixed-region-multiline', SCANNED_TEXT_REFLOW_SCOPE]
    .includes(selection.content.scope);
  const paragraphReflow = selection.content.scope === SCANNED_TEXT_REFLOW_SCOPE;
  const rect = scannedEditorRect(span, lineIds);
  const fixedRegionLineHeight = rect.height / Math.max(1, lineIds.length);
  const fontSizePx = Math.max(1, fixedRegion
    ? Math.min(rect.firstLineHeight || fixedRegionLineHeight, fixedRegionLineHeight)
    : rect.firstLineHeight || estimate.fontSize.value * (doc.scale || 1));
  const initialText = selection.content.replacementText;
  const scannedRichText = selection.content.richText
    || withScannedRichText(selection.content).richText;
  let preview = null;
  const lineHeightPx = fixedRegion
    ? Math.max(fontSizePx, rect.height / Math.max(1, selection.content.source.canonicalBaselines.length))
    : Math.max(fontSizePx, rect.height);
  const styleObj = {
    position: 'absolute',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${Math.max(rect.width + 4, 80)}px`,
    height: `${Math.max(rect.height, 24)}px`,
    'font-size': `${fontSizePx}px`,
    'line-height': `${lineHeightPx}px`,
    'font-family': font.css,
    'font-weight': estimate.weight.value === 'bold' ? 'bold' : 'normal',
    'font-style': estimate.italic.value ? 'italic' : 'normal',
    'text-align': estimate.alignment.value,
    color: estimate.textColor.value,
    background: 'transparent',
    'z-index': '1000',
  };
  const textLayer = span.closest('.textLayer');
  const pageCanvas = livePageCanvas(pageNum, textLayer, doc);
  const editorContainer = textLayer?.parentElement;
  let placement = null;
  if (pageCanvas && editorContainer) {
    const geometry = getTextEditGeometry(pageNum, pageCanvas);
    const viewGeometry = getTextEditViewGeometry(pageCanvas, doc);
    const containerRect = editorContainer.getBoundingClientRect();
    const canvasRect = pageCanvas.getBoundingClientRect();
    const viewport = window.__pdfViewport;
    const useViewport = editorContainer.id === 'canvas-container'
      && viewport?.active && viewport.pageNum === pageNum;
    const pageOffsetX = useViewport ? viewport.offsetX || 0 : canvasRect.left - containerRect.left;
    const pageOffsetY = useViewport ? viewport.offsetY || 0 : canvasRect.top - containerRect.top;
    const frame = {
      pageWidth: geometry.pageWidth,
      pageHeight: geometry.pageHeight,
      rotation: geometry.rotation,
      scale: viewGeometry.visualScale,
      offsetX: pageOffsetX,
      offsetY: pageOffsetY,
      containerLeft: containerRect.left,
      containerTop: containerRect.top,
    };
    const commitBounds = canonicalBoundsFromDisplayRect(rect, frame);
    const previewBounds = {
      ...commitBounds,
      width: commitBounds.width + (4 / viewGeometry.visualScale),
    };
    const origin = applyPageRotation(
      previewBounds.x,
      previewBounds.y,
      geometry.pageWidth,
      geometry.pageHeight,
      geometry.rotation,
    );
    styleObj.left = `${containerRect.left + pageOffsetX + origin.x * viewGeometry.visualScale}px`;
    styleObj.top = `${containerRect.top + pageOffsetY + origin.y * viewGeometry.visualScale}px`;
    styleObj.width = `${previewBounds.width * viewGeometry.visualScale}px`;
    styleObj.height = `${previewBounds.height * viewGeometry.visualScale}px`;
    styleObj.transform = geometry.rotation ? `rotate(${geometry.rotation}deg)` : 'none';
    styleObj['transform-origin'] = '0 0';
    const sourceRect = {
      left: containerRect.left + pageOffsetX + origin.x * viewGeometry.visualScale,
      top: containerRect.top + pageOffsetY + origin.y * viewGeometry.visualScale,
      width: previewBounds.width * viewGeometry.visualScale,
      height: previewBounds.height * viewGeometry.visualScale,
    };
    placement = pagePlacementForViewportStyle({
      doc,
      pageNum,
      geometry,
      sourceRect,
      canonicalStyle: createPageTextEditStyle({
        geometry: { width: previewBounds.width, height: previewBounds.height, zIndex: 1000 },
        typography: {
          fontFamily: font.css,
          fontSize: fontSizePx / viewGeometry.visualScale,
          lineHeight: lineHeightPx / viewGeometry.visualScale,
          fontWeight: estimate.weight.value === 'bold' ? 'bold' : 'normal',
          fontStyle: estimate.italic.value ? 'italic' : 'normal',
          textAlign: estimate.alignment.value,
          color: estimate.textColor.value,
        },
        decoration: { backgroundColor: 'transparent' },
      }),
      containerRect,
      pageOffsetX,
      pageOffsetY,
      sourceScale: viewGeometry.visualScale,
      mode: 'ocr-fixed',
      canonicalBounds: previewBounds,
      commitBounds,
    });
    preview = createScannedRepairPreview(span, selection, rect, {
      doc,
      pageNum,
      geometry,
      frame,
    });
  } else {
    preview = createScannedRepairPreview(span, selection, rect);
  }
  const styleState = {
    family: font.name,
    cssFamily: font.css,
    fontFaceChanged: false,
    size: estimate.fontSize.value,
    color: estimate.textColor.value,
    bold: estimate.weight.value === 'bold',
    italic: estimate.italic.value,
    underline: false,
    strikethrough: false,
    alignment: estimate.alignment.value,
  };
  const editor = {
    block: { spans: [] },
    pageNum,
    kind: 'scannedText',
    selectionId: selection.id,
    existingOwnedEdit,
    originalText: initialText,
    result,
    pageGeometry,
    raster,
    lineId,
    target,
    fixedRegion,
    paragraphReflow,
    preview,
    placement,
    committing: false,
    scale: doc.scale || 1,
    visualScale: fontSizePx / estimate.fontSize.value,
    editorBaseline: rect.top + fontSizePx * 0.82,
    lineSpacing: fixedRegion ? selection.content.source.lineSpacing.valuePt : estimate.fontSize.value,
    styleTouchedKeys: new Set(),
    scannedStyleBaseline: scannedStyleSnapshot(styleState),
    richTextDocument: paragraphReflow ? null : scannedRichText,
    styleState,
  };
  const identityContext = ocrParagraphContext(doc, pageNum);
  const identityRegion = identityContext
    && paragraphRegionForLine(identityContext.regions, lineId);
  editor.ocrTargetIdentity = Object.freeze({
    recognitionGeneration: String(
      result?.document?.generation
      || identityContext?.result?.document?.generation
      || doc.ocr?.generation
      || '',
    ),
    regionId: String(identityRegion?.id
      || (selection.target.kind === 'region' ? selection.target.targetId : lineId)),
    lineIds: Object.freeze([...(identityRegion?.lineIds || selection.target.lineIds || [lineId])]),
  });

  const cleanup = (reason = 'scanned-runtime-cleanup') => {
    editor.commitOperationId = null;
    return cleanupEditorRuntime(editor, { reason });
  };
  const cancel = () => {
    editor.committing = false;
    return cleanup('cancel');
  };
  const finish = async (operation) => {
    if (editor.committing) {
      return textApplyResultFor(editor, 'rejected', {
        editId: editor.selectionId,
        rejectionCode: 'TEXT_APPLY_IN_PROGRESS',
        recoveryActions: ['keep-editing'],
      });
    }
    if (!editorApplyOperationIsCurrent(editor, operation)) {
      return textApplyResultFor(editor, 'superseded', { editId: editor.selectionId });
    }
    const replacementText = getEditorText();
    if (replacementText === editor.originalText && editor.styleTouchedKeys.size === 0) {
      cleanup('noop');
      return textApplyResultFor(editor, 'noop', { editId: editor.selectionId });
    }
    editor.committing = true;
    editor.commitOperationId = operation.operationId;
    try {
      const richDraft = getPdfEditorRichText();
      if (richDraft && richTextToPlainText(richDraft) !== replacementText) {
        throw new Error('The rich-text draft and OCR replacement text are not synchronized');
      }
      if (richDraft) {
        const styleSignatures = new Set(richDraft.lines.flatMap((line) => line.runs.map((run) => JSON.stringify({
          faceId: run.faceId,
          size: run.size,
          color: run.color,
          bold: run.bold,
          italic: run.italic,
          underline: run.underline,
          strikeout: run.strikeout,
        }))));
        if (styleSignatures.size > 1) {
          throw new Error('Mixed OCR runs require a renderer-qualified fixed region and are not enabled for this selection');
        }
      }
      const styleOverrides = scannedStyleOverrides(editor);
      const layoutMode = editor.fixedRegion
        && (editor.paragraphReflow || !/[\r\n\u2028\u2029]/u.test(replacementText))
        ? SCANNED_TEXT_REFLOW_LAYOUT_MODE
        : null;
      if (!editorApplyOperationIsCurrent(editor, operation)) {
        cleanup('superseded-before-owner-commit');
        return textApplyResultFor(editor, 'superseded', { editId: editor.selectionId });
      }
      if (editor.existingOwnedEdit) {
        await reviseScannedTextEditForDocument(doc, editor.selectionId, {
          replacementText,
          styleOverrides,
          layoutMode,
          operation,
        });
      } else {
        await applyScannedTextEditForDocument(doc, {
          result: editor.result,
          pageGeometry: editor.pageGeometry,
          raster: editor.raster,
          target: editor.target,
          replacementText,
          styleOverrides,
          contextPaddingPx: 24,
          layoutMode,
        }, {
          operation,
        });
      }
      if (!editorApplyOperationIsCurrent(editor, operation)) {
        cleanup('superseded-after-owner-commit');
        return textApplyResultFor(editor, 'superseded', { editId: editor.selectionId });
      }
      const committedSelection = doc.scannedTextEdits?.pages
        ?.flatMap((page) => page.selections || [])
        .find((selection) => selection.id === editor.selectionId);
      const published = await publishEditorCommit(editor, {
        ownerDocument: doc,
        pageNum,
        editId: editor.selectionId,
        editRevision: committedSelection?.revision ?? null,
        nativeAuthoritative: false,
      });
      const closed = cleanup('published');
      if (!closed || published.publication.status === 'superseded') {
        return textApplyResultFor(editor, 'superseded', {
          ownerCommitted: true,
          editId: editor.selectionId,
          editRevision: committedSelection?.revision ?? null,
          publicationError: published.publicationError,
        });
      }
      if (published.semanticPublished) enableTextLayerHover();
      return textApplyResultFor(editor, 'applied', {
        ownerCommitted: true,
        visiblePublished: published.visiblePublished,
        semanticPublished: published.semanticPublished,
        editId: editor.selectionId,
        editRevision: committedSelection?.revision ?? null,
        publicationError: published.publicationError,
      });
    } catch (error) {
      editor.committing = false;
      editor.commitOperationId = null;
      if (error?.code === 'SCANNED_TEXT_EDIT_OPERATION_INVALIDATED'
          || !editorApplyOperationIsCurrent(editor, operation)) {
        cleanup('superseded-after-publication-error');
        return textApplyResultFor(editor, 'superseded', { editId: editor.selectionId });
      }
      console.warn('[scanned-text-edit] Apply failed:', error);
      const validationReason = textEditValidationReason(error);
      const rejection = validationReason
        ? hardeningText('textEditor.status.scannedRejected', { reason: validationReason })
        : hardeningText('textEditor.status.operationFailed');
      setPdfEditorStatus(rejection, 'invalid');
      if (!validationReason) showMessage(rejection);
      return textApplyResultFor(editor, 'rejected', {
        editId: editor.selectionId,
        rejectionCode: typeof error?.code === 'string'
          ? error.code : 'SCANNED_TEXT_EDIT_REJECTED',
        recoveryActions: ['keep-editing'],
      });
    }
  };
  editor._finishEditing = finish;
  editor._cancelEditing = cancel;
  activeEditor = editor;
  registerActiveEditorSession(editor, doc, paragraphReflow
    ? 'ocr-reflow'
    : fixedRegion ? 'ocr-fixed-multiline' : 'ocr-one-line');
  publishPdfTextEditState(editor);

  const liveParagraphContext = ocrParagraphContext(doc, pageNum);
  const liveParagraphRegion = liveParagraphContext
    && paragraphRegionForLine(liveParagraphContext.regions, lineId);
  const paragraphActions = liveParagraphRegion
    ? ocrParagraphActionsForSpan({
        doc, pageNum, span, context: liveParagraphContext, region: liveParagraphRegion,
        existingRaster: raster, onApplied: cleanup,
      })
    : null;

  showTextEditPropertiesSafely({
    text: initialText,
    fontSize: estimate.fontSize.value,
    fontFamily: font.name,
    color: estimate.textColor.value,
    isBold: estimate.weight.value === 'bold',
    isItalic: estimate.italic.value,
    isUnderline: false,
    isStrikethrough: false,
    textAlign: estimate.alignment.value,
    scannedTextEstimate: true,
    ocrParagraphActions: paragraphActions,
    page: pageNum,
  });

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelActiveTextEditing('escape');
      return;
    }
    if (event.key === 'Enter' && !editor.fixedRegion) {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) applyActiveTextEditingWithStatus();
      else setPdfEditorStatus(hardeningText('textEditor.status.lineBreakUnsupported'));
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      applyActiveTextEditingWithStatus();
    } else if (event.key === 'Enter') {
      event.stopPropagation();
    }
  };
  const handleBlur = () => {};
  editor.mountOwner = showPdfTextEditor(styleObj, initialText, {
    onCommit: finish,
    onCancel: cancel,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
    runtimeOwner: {
      sessionId: editor.sessionId,
      documentId: editor.ownerDocument?.id,
      documentGeneration: editor.ownerDocumentGeneration,
    },
    options: {
      // Paragraph reflow keeps soft wrapping in the fixed box; representing
      // those visual wraps as editable hard lines would change the paragraph.
      richTextDocument: paragraphReflow ? null : scannedRichText,
      capabilities: {
        ...DEFAULT_TEXT_FORMAT_CAPABILITIES,
        family: !paragraphReflow,
        bold: !paragraphReflow,
        italic: !paragraphReflow,
        underline: false,
        strikeout: false,
        spacing: false,
      },
      singleLine: !fixedRegion,
      fixedRegion,
      placement,
      attachedPageElements: preview?._pageTextEditPlacement
        ? [{ element: preview, placement: preview._pageTextEditPlacement }]
        : [],
      editorBackground: 'transparent',
      direction: 'ltr',
      ariaLabel: hardeningText(fixedRegion
        ? paragraphReflow
          ? 'textEditor.aria.editScannedReflow'
          : 'textEditor.aria.editScannedFixed'
        : 'textEditor.aria.editScannedLine', { text: initialText }),
      status: fixedRegion
        ? paragraphReflow
          ? hardeningText('textEditor.status.ocrReflow')
          : hardeningText('textEditor.status.ocrFixed')
        : hardeningText('textEditor.status.ocrOneLine'),
    },
  });
  return true;
}

async function startPdfTextEditing(
  span,
  pageNum,
  { readinessGranted = false, clientPoint = null } = {},
) {
  if (rejectInvalidOwnedTextState()) return false;
  let ownerDocument = getActiveDocument();
  if (!ownerDocument) return false;
  const preferredEditId = span?.dataset?.editId || '';
  const preferredMarkerIds = span?.dataset?.nativeTextMarkerIds || '';
  if (ownerDocument.pdfDoc && !readinessGranted) {
    const fallbackPoint = clientPoint || (() => {
      const rect = span?.getBoundingClientRect?.();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })();
    try {
      const queued = await queueCurrentPageEditIntent({
        documentState: ownerDocument,
        pageNum,
        point: fallbackPoint,
        activate: ({ documentState, pageNum: readyPage, point }) => {
          if (getActiveDocument() !== documentState) return false;
          const layer = livePageTextLayer(readyPage);
          const liveSpan = spanAtClientPoint(layer, point, 'span:not([data-ocr-owner])')
            || [...(layer?.querySelectorAll('span:not([data-ocr-owner])') || [])]
              .find((candidate) => (
                (preferredEditId && candidate.dataset.editId === preferredEditId)
                || (preferredMarkerIds
                  && candidate.dataset.nativeTextMarkerIds === preferredMarkerIds)
              ));
          if (!liveSpan) return false;
          return startPdfTextEditing(liveSpan, readyPage, {
            readinessGranted: true,
            clientPoint: point,
          });
        },
      });
      return queued?.activated === true && queued.value === true;
    } catch (error) {
      reportQueuedEditFailure(error);
      return false;
    }
  }
  ownerDocument = getDocumentById(ownerDocument.id);
  if (!ownerDocument || getActiveDocument() !== ownerDocument) return false;
  const ownerGeneration = Number(ownerDocument.lifecycleGeneration) || 0;

  let textLayer = livePageTextLayer(pageNum);
  if (!span?.isConnected || span.closest('.textLayer') !== textLayer) {
    span = spanAtClientPoint(textLayer, clientPoint, 'span:not([data-ocr-owner])')
      || [...(textLayer?.querySelectorAll('span:not([data-ocr-owner])') || [])]
        .find((candidate) => (
          (preferredEditId && candidate.dataset.editId === preferredEditId)
          || (preferredMarkerIds && candidate.dataset.nativeTextMarkerIds === preferredMarkerIds)
        ));
  }
  if (!textLayer) return false;
  try {
    const page = await ownerDocument.pdfDoc?.getPage(pageNum);
    if (page) await resolveTextLayerFonts(page, textLayer);
  } catch (_) {
    // Keep editing available with a standard fallback for damaged or
    // unsupported embedded fonts.
  }
  if (getActiveDocument() !== ownerDocument
      || ownerDocument.lifecycleGeneration !== ownerGeneration) return false;
  textLayer = livePageTextLayer(pageNum);
  if (!span?.isConnected || span.closest('.textLayer') !== textLayer) {
    span = spanAtClientPoint(textLayer, clientPoint, 'span:not([data-ocr-owner])')
      || [...(textLayer?.querySelectorAll('span:not([data-ocr-owner])') || [])]
        .find((candidate) => (
          (preferredEditId && candidate.dataset.editId === preferredEditId)
          || (preferredMarkerIds && candidate.dataset.nativeTextMarkerIds === preferredMarkerIds)
        ));
  }
  if (!span || !textLayer) return false;
  blockGroupsCache.delete(textLayer);
  getBlockGroups(textLayer);
  cancelActiveTextEditing('superseded');

  // Added text (synthetic span) → re-open the SAME textEdit record instead of
  // creating a duplicate edit-of-an-edit. This makes inserted text properly
  // re-editable (content, style, position, delete) via startTextEditEditing.
  const editId = span.dataset.editId;
  if (editId) {
    const rec = ownerDocument.textEdits?.find(e => String(e.id) === editId);
    if (rec) {
      const canvasEl = livePageCanvas(pageNum, textLayer, ownerDocument);
      if (canvasEl) return startTextEditEditing(rec, pageNum, canvasEl);
    }
  }

  const block = spanToBlock.get(span);
  if (!block || block.spans.length === 0) return false;

  if (block.laneValid === false) {
    showMessage(hardeningText('textEditor.status.nativeColumnBoundary'));
    return false;
  }

  hideParagraphOutline();

  const { lineData, lineSpacing } = block;

  const sourceProvenance = provenanceForSpans(block.spans);
  if (!sourceProvenance) {
    showMessage(hardeningText('textEditor.status.nativeSourceUnavailable'));
    return false;
  }

  // An unsaved native edit still sits above the original PDF.js spans. Match
  // those exact operators back to the existing owned record so clicking the
  // line again revises that record instead of creating overlapping ownership.
  const existingNativeEdit = ownerDocument.textEdits?.find((record) => (
    record.page === pageNum
    && sameNativeTextOwnership(record.sourceProvenance, sourceProvenance)
  ));
  if (existingNativeEdit) {
    const canvasEl = livePageCanvas(pageNum, textLayer, ownerDocument);
    return canvasEl ? startTextEditEditing(existingNativeEdit, pageNum, canvasEl) : false;
  }

  // Physical source lines inside one paragraph are soft wraps, not authored
  // paragraph breaks. The canonical rich-text draft below owns that meaning.
  let combinedText = lineData.map(l => l.text).join('\n');
  const unsupportedFonts = [...new Set(lineData.flatMap((line) => line.spans.map((sourceSpan) => (
    sourceSpan.dataset.pdfActualFontName || sourceSpan.dataset.pdfFontName || 'Unknown font'
  ))).filter((name) => !/^liberation\s*(sans|serif|mono)/iu.test(name)))];
  let substitution = null;
  if (unsupportedFonts.length > 0) {
    substitution = resolveAutomaticFontSubstitution({
      sourceFonts: unsupportedFonts,
      bold: lineData[0].isBold,
      italic: lineData[0].isItalic,
      sampleText: combinedText,
      scope: 'paragraph',
    });
    if (!substitution) return false;
  }

  // Never open a draft against a tab or document generation that stopped
  // owning the source gesture.
  if (getActiveDocument() !== ownerDocument
      || getDocumentById(ownerDocument.id) !== ownerDocument
      || (Number(ownerDocument.lifecycleGeneration) || 0) !== ownerGeneration) return false;

  // PDF metadata from first line (top of block in reading order, highest pdfY)
  const pdfX = lineData[0].pdfX;
  const pdfY = lineData[0].pdfY;
  const fontSize = lineData[0].fontSize;
  const pdfWidth = Math.max(...lineData.map(l => l.pdfWidth));

  // DOM font metrics are presentation-only. Placement is derived exclusively
  // from the provenance-backed PDF region below, so clicking any source span
  // in this paragraph opens the exact same canonical editor rectangle.
  const numLines = lineData.length;
  const editorFontSize = Math.max(1, lineData[0].domBottom - lineData[0].domTop);
  const visualLineHeight = numLines > 1
    ? Math.abs(lineData[1].domTop - lineData[0].domTop)
    : editorFontSize * (lineSpacing / fontSize);
  const originalRichText = richTextForNativeBlock(block, pageNum);
  combinedText = richTextToPlainText(originalRichText);

  // Use PDF.js loaded font if available (exact visual match), else map to standard CSS font
  const loadedFont = lineData[0].loadedFontName || '';
  const actualName = (lineData[0].actualFontName || '').toLowerCase();
  const fallback = (lineData[0].fontFamily || 'sans-serif').toLowerCase();
  let cssFallbackFont;
  if (actualName.includes('courier') || actualName.includes('consolas') || actualName.includes('mono') || fallback === 'monospace') {
    cssFallbackFont = '"Courier New", Courier, monospace';
  } else if (actualName.includes('times') || actualName.includes('garamond') || actualName.includes('georgia')
      || actualName.includes('palatino') || actualName.includes('cambria') || actualName.includes('bookman')
      || fallback === 'serif') {
    cssFallbackFont = '"Times New Roman", Times, serif';
  } else {
    cssFallbackFont = 'Helvetica, Arial, sans-serif';
  }
  const substituteFamily = substitution?.faceId?.includes('-mono-') ? 'Liberation Mono'
    : substitution?.faceId?.includes('-serif-') ? 'Liberation Serif'
    : substitution ? 'Liberation Sans' : null;
  const editorFont = substituteFamily
    ? cssFamilyFor(substituteFamily)
    : loadedFont ? `"${loadedFont}", ${cssFallbackFont}` : cssFallbackFont;
  const displayFontName = substituteFamily || editableFontName(lineData[0], cssFallbackFont);
  const editorBold = lineData[0].isBold || false;
  const editorItalic = lineData[0].isItalic || false;
  const pageCanvas = livePageCanvas(pageNum, textLayer, ownerDocument);
  const placementGeometry = pageCanvas ? getTextEditGeometry(pageNum, pageCanvas) : null;
  if (!placementGeometry) {
    showMessage(hardeningText('textEditor.status.operationFailed'));
    return false;
  }
  const placementScale = Math.max(0.0001, editorFontSize / fontSize);
  const canonicalBounds = canonicalEditorBoundsForRichText(
    originalRichText.region,
    placementGeometry.pageHeight,
  );
  const editorWidth = canonicalBounds.width * placementScale;
  const editorHeight = canonicalBounds.height * placementScale;

  // The portal remains hidden until its page-local host has projected this
  // canonical rectangle. These finite seed values are never used as a visible
  // viewport-global fallback.
  const styleObj = {
    position: 'absolute',
    left: '0px',
    top: '0px',
    width: `${editorWidth}px`,
    height: `${editorHeight}px`,
    'font-size': `${editorFontSize}px`,
    'line-height': `${visualLineHeight}px`,
    'font-family': editorFont,
    color: lineData[0].color || '#000000',
    'z-index': '1000'
  };
  if (editorBold) styleObj['font-weight'] = 'bold';
  if (editorItalic) styleObj['font-style'] = 'italic';
  const placement = pagePlacementForViewportStyle({
    doc: ownerDocument,
    pageNum,
    geometry: placementGeometry,
    canonicalBounds,
    canonicalStyle: createPageTextEditStyle({
      geometry: {
        width: canonicalBounds.width,
        height: canonicalBounds.height,
        zIndex: 1000,
      },
      typography: {
        fontFamily: editorFont,
        fontSize,
        lineHeight: visualLineHeight / placementScale,
        fontWeight: editorBold ? 'bold' : 'normal',
        fontStyle: editorItalic ? 'italic' : 'normal',
        color: lineData[0].color || '#000000',
      },
      padding: { all: 0 },
      border: { width: 0, style: 'none', boxSizing: 'border-box' },
    }),
    sourceScale: placementScale,
    mode: 'native-expandable',
  });

  // Hide all spans BEFORE showing editor so text doesn't double-render
  for (const s of block.spans) s.style.visibility = 'hidden';

  activeEditor = {
    block,
    pageNum,
    kind: 'existingText',
    originalText: combinedText,
    pdfX,
    pdfY,
    pdfWidth,
    fontSize,
    lineSpacing,
    numOriginalLines: lineData.length,
    scale: ownerDocument.scale || 1.5,
    visualScale: editorFontSize / fontSize,
    editorBaseline: null,
    placement,
    // Accumulated style state edited via the properties panel; seeded from the
    // block's detected formatting. Persisted onto the edit record on commit.
    styleState: {
      family: displayFontName,
      cssFamily: editorFont,
      fontFaceChanged: false,
      size: fontSize,
      color: lineData[0].color || '#000000',
      bold: lineData[0].isBold || false,
      italic: lineData[0].isItalic || false,
      underline: false,
      strikethrough: false,
    },
    richTextDocument: originalRichText,
    expandableNative: true,
    sourceProvenance,
    substitution,
  };

  registerActiveEditorSession(activeEditor, ownerDocument, 'native-source-text');

  publishPdfTextEditState(activeEditor);

  // Show text properties in the right panel
  showTextEditPropertiesSafely({
    text: combinedText,
    fontSize,
    fontFamily: displayFontName,
    color: lineData[0].color || '#000000',
    isBold: lineData[0].isBold || false,
    isItalic: lineData[0].isItalic || false,
    isUnderline: false,
    isStrikethrough: false,
    page: pageNum
  });

  // Define handlers for the store
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancelActiveTextEditing('escape');
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      applyActiveTextEditingWithStatus();
      return;
    }
    if (e.key === 'Enter') {
      // A normal Enter always creates a real PDF line break. Ctrl/Cmd+Enter
      // commits; clicking or focusing outside the editor/properties boundary
      // requests the same owner-scoped Apply.
      e.stopPropagation();
    }
  };

  const handleBlur = () => {};

  activeEditor.mountOwner = showPdfTextEditor(styleObj, combinedText, {
    onCommit: null,
    onCancel: null,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
    runtimeOwner: {
      sessionId: activeEditor.sessionId,
      documentId: activeEditor.ownerDocument?.id,
      documentGeneration: activeEditor.ownerDocumentGeneration,
    },
    options: {
      richTextDocument: originalRichText,
      capabilities: DEFAULT_TEXT_FORMAT_CAPABILITIES,
      placement,
      expandableRegion: expandableNativeEditorOptions(
        originalRichText,
        pageNum,
        livePageCanvas(pageNum, textLayer, ownerDocument),
        textLayer,
        {
          block,
          provenance: sourceProvenance,
          displayScale: editorFontSize / fontSize,
          sourceWidth: originalRichText.region.width,
          substitutionWidthAllowance: substitution ? 1 : 0,
          onDraftLayout: (layout) => {
            if (activeEditor?.block === block) activeEditor.draftLayout = layout;
          },
        },
      ),
      ariaLabel: hardeningText('textEditor.aria.editRegion', { text: combinedText }),
    },
  });
  return true;
}

async function finishPdfTextEditing(operation) {
  if (!activeEditor) {
    return createTextApplyResult({ status: 'superseded', pageNum: 1 });
  }

  const editor = activeEditor;
  if (!editorApplyOperationIsCurrent(editor, operation)) {
    return textApplyResultFor(editor, 'superseded');
  }

  // If this editor was started via startTextEditEditing, delegate to its own finish handler
  if (activeEditor._finishEditing) {
    return activeEditor._finishEditing(operation);
  }

  const {
    block, pageNum, originalText,
    pdfX, pdfY, pdfWidth, fontSize, lineSpacing, numOriginalLines, styleState
  } = editor;
  const finalDraft = finalEditorDraft(editor);
  const newText = finalDraft.plainText;
  const richTextDraft = finalDraft.document;

  const st = styleState || {};
  // Did the panel change any formatting relative to the detected block style?
  const styleChanged =
    (st.size != null && st.size !== fontSize) ||
    (st.color != null && st.color !== (block.lineData[0].color || '#000000')) ||
    (st.bold != null && st.bold !== (block.lineData[0].isBold || false)) ||
    (st.italic != null && st.italic !== (block.lineData[0].isItalic || false)) ||
    st.fontFaceChanged === true ||
    st.underline === true ||
    st.strikethrough === true;

  // Persist when the text OR the formatting changed (a pure re-style of
  // existing PDF text must be saveable too).
  const nativeChanged = textEditDraftIsDirty(editor.dirtyBaseline, {
    text: newText,
    richText: richTextDraft || editor.richTextDocument,
    transientStyleChanged: styleChanged,
  });
  if (!nativeChanged) {
    cleanupEditorRuntime(editor, { restoreNativeSpans: true, reason: 'noop' });
    return textApplyResultFor(editor, 'noop', { editId: null, editRevision: null });
  }
  if (!editor.sourceProvenance) {
    showMessage(hardeningText('textEditor.status.nativeSourceUnavailable'));
    setPdfEditorStatus(hardeningText('textEditor.status.nativeSourceUnavailable'), 'invalid');
    return textApplyResultFor(editor, 'rejected', {
      editId: null,
      editRevision: null,
      rejectionCode: 'TEXT_SOURCE_PROVENANCE_MISSING',
      recoveryActions: ['keep-editing'],
    });
  }

  const layoutDecision = await nativeLayoutReadyForCommit(editor, finalDraft, operation);
  if (!editorApplyOperationIsCurrent(editor, operation)
      || layoutDecision.status === 'superseded') {
    return textApplyResultFor(editor, 'superseded', { editId: null, editRevision: null });
  }
  if (!['ready', 'auto-fitted'].includes(layoutDecision.status)) {
    return textApplyResultFor(editor, 'rejected', {
      editId: null,
      editRevision: null,
      rejectionCode: layoutDecision.rejectionCode || 'TEXT_LAYOUT_FAILED',
      recoveryActions: layoutRecoveryActions(layoutDecision),
    });
  }

  {
    const { lineData } = block;
    const pdfFontName = lineData[0].pdfFontName || '';

    // Final formatting: panel-edited style state wins over the detected block
    // style (seeded identically, so unchanged edits reproduce the original).
    const finalSize = st.size != null ? st.size : fontSize;
    const finalColor = st.color != null ? st.color : (lineData[0].color || '#000000');
    const finalBold = st.bold != null ? st.bold : (lineData[0].isBold || false);
    const finalItalic = st.italic != null ? st.italic : (lineData[0].isItalic || false);
    const finalUnderline = st.underline === true;
    const finalStrikethrough = st.strikethrough === true;
    const finalLineSpacing = lineSpacing;
    const fontFamily = toStandardFontName(
      st.family != null ? st.family : (lineData[0].actualFontName || lineData[0].fontFamily),
      finalBold, finalItalic
    );
    // Store the PDF.js loaded font name for canvas rendering (exact visual
    // match). Drop it when the family/weight was changed in the panel so the
    // new StandardFont is used instead of the stale embedded font.
    const loadedFontName = st.fontFaceChanged ? '' : (lineData[0].loadedFontName || '');

    const originalRichText = editor.richTextDocument;
    const finalRichText = layoutDecision.document || richTextDraft || richTextFromPlainText(newText, {
      faceId: resolvePackagedFace(fontFamily, finalBold, finalItalic)?.id,
      size: finalSize,
      color: finalColor,
      bold: finalBold,
      italic: finalItalic,
      underline: finalUnderline,
      strikeout: finalStrikethrough,
      baselineAdvance: finalLineSpacing,
    }, originalRichText.region);
    const editRecord = createTextEditRecordV2({
      id: Date.now() + Math.random().toString(36).slice(2, 11),
      page: pageNum,
      richText: finalRichText,
      original: originalRichText,
      sourceProvenance: editor.sourceProvenance,
      substitution: editor.substitution,
    });
    const nativeSourceProjection = createNativeTextSourceProjection({
      pageNum,
      editId: editRecord.id,
      lineData,
      replacementText: newText,
    });

    const doc = editor.ownerDocument;
    if (!doc || !editorOwnerIsCurrent(editor)) {
      return textApplyResultFor(editor, 'superseded', { editId: null, editRevision: null });
    }
    const storedRecord = cloneTextEditRecord(editRecord);
    const hadTextEdits = Array.isArray(doc.textEdits);
    const recorded = runOwnerScopedTextCommit({
      ownerDocument: doc,
      attempt() {
        if (!doc.textEdits) doc.textEdits = [];
        doc.textEdits.push(storedRecord);
        return executeForDocument(doc, {
          type: 'addTextEdit',
          textEdit: cloneTextEditRecord(storedRecord),
          nativeSourceProjection,
        });
      },
      rollback() {
        const index = doc.textEdits?.indexOf(storedRecord) ?? -1;
        if (index >= 0) doc.textEdits.splice(index, 1);
        if (!hadTextEdits && doc.textEdits?.length === 0) delete doc.textEdits;
      },
    });
    if (!recorded) {
      setPdfEditorStatus(hardeningText('textEditor.status.operationFailed'), 'invalid');
      return textApplyResultFor(editor, 'rejected', {
        editId: null,
        editRevision: null,
        rejectionCode: 'TEXT_OWNER_COMMIT_FAILED',
        recoveryActions: ['keep-editing'],
      });
    }

    const published = await publishEditorCommit(editor, {
      ownerDocument: doc,
      pageNum,
      editId: editRecord.id,
      editRevision: editRecord.revision,
      nativeAuthoritative: true,
    });

    const closed = cleanupEditorRuntime(editor, {
      restoreNativeSpans: true,
      reason: 'published',
    });
    if (!closed || published.publication.status === 'superseded') {
      return textApplyResultFor(editor, 'superseded', {
        ownerCommitted: true,
        editId: editRecord.id,
        editRevision: editRecord.revision,
        publicationError: published.publicationError,
      });
    }
    return textApplyResultFor(editor, 'applied', {
      ownerCommitted: true,
      visiblePublished: published.visiblePublished,
      semanticPublished: published.semanticPublished,
      editId: editRecord.id,
      editRevision: editRecord.revision,
      layoutAdjustment: layoutAdjustmentForDecision(layoutDecision),
      publicationError: published.publicationError,
    });
  }
}

function cancelPdfTextEditing() {
  if (!activeEditor) return false;
  const editor = activeEditor;
  try {
    return editor._cancelEditing ? editor._cancelEditing() !== false : true;
  } finally {
    cleanupEditorRuntime(editor, { restoreNativeSpans: true, reason: 'cancel' });
  }
}

/**
 * Native Find & Replace remains fail-closed until the matched span carries
 * exact content-stream/operator provenance. A visual span and bounding box
 * are not sufficient ownership evidence and must never produce a flat edit
 * record or mutate the live text layer.
 *
 * @param {number} pageNum - Page number
 * @param {string} originalText - The original span text
 * @param {string} newText - The replacement span text
 * @param {HTMLElement} matchSpan - The span element containing the text to replace
 * @returns {{ editRecord: Object } | null}
 */
export function createReplaceTextEdit(pageNum, originalText, newText, matchSpan) {
  void pageNum;
  void originalText;
  void newText;
  void matchSpan;
  return null;
}

function getTextEditViewGeometry(canvasEl, doc) {
  const vp = window.__pdfViewport;
  if (vp?.active && doc?.filePath && vp.pageH > 0 && vp.zoom > 0) {
    return {
      pageHeight: vp.pageH,
      visualScale: vp.zoom,
      offsetX: vp.offsetX || 0,
      offsetY: vp.offsetY || 0,
    };
  }

  const dpr = window.devicePixelRatio || 1;
  const visualScale = doc?.scale || 1.5;
  return {
    pageHeight: canvasEl.height / (visualScale * dpr),
    visualScale,
    offsetX: 0,
    offsetY: 0,
  };
}

export function findTextEditAtPosition(x, y, pageNum, canvasEl) {
  const doc = getActiveDocument();
  if (!doc || !doc.textEdits || doc.textEdits.length === 0) return null;

  const pageEdits = doc.textEdits.filter(e => e.page === pageNum);
  if (pageEdits.length === 0) return null;

  const geometry = getTextEditGeometry(pageNum, canvasEl);
  const unrotatedPoint = invertPageRotation(
    x,
    y,
    geometry.pageWidth,
    geometry.pageHeight,
    geometry.rotation,
  );
  const pageHeight = geometry.pageHeight;

  const canonicalHits = [];
  for (const rawEdit of pageEdits) {
    try {
      const record = projectTextEditRecord(rawEdit).record;
      for (const target of ownedTextEditLineTargets(record)) {
        const top = pageHeight - target.baseline - target.fontSize * 0.85;
        if (unrotatedPoint.x >= target.x && unrotatedPoint.x <= target.x + target.width
            && unrotatedPoint.y >= top && unrotatedPoint.y <= top + target.height) {
          canonicalHits.push({ rawEdit, area: target.width * target.height });
        }
      }
    } catch (_) {
      // Invalid records are not eligible for geometry fallback.
    }
  }
  if (canonicalHits.length > 0) {
    canonicalHits.sort((left, right) => left.area - right.area);
    return canonicalHits[0].rawEdit;
  }

  // Backward-compatible fallback for legacy records lacking usable canonical
  // line geometry. V2 records rely on their exact rich-text line regions.
  for (const rawEdit of pageEdits) {
    if (rawEdit?.schema === 'open-pdf-studio.text-edit-record' && rawEdit.version === 2) continue;
    const edit = projectTextEditRecord(rawEdit);
    const fontSize = edit.fontSize;
    const ls = edit.lineSpacing || fontSize * 1.2;
    const newLines = edit.newText.split('\n');
    const numLines = newLines.length;

    const firstBaseY = pageHeight - edit.pdfY;
    const editLeft = edit.pdfX;
    const editTop = firstBaseY - fontSize;
    const editHeight = (numLines - 1) * ls + fontSize * 1.3;
    const maxCharCount = Math.max(...newLines.map(l => l.length), 1);
    const editWidth = Math.max(edit.pdfWidth || 0, fontSize * 0.6 * maxCharCount) + fontSize * 0.5;

    if (unrotatedPoint.x >= editLeft && unrotatedPoint.x <= editLeft + editWidth &&
        unrotatedPoint.y >= editTop && unrotatedPoint.y <= editTop + editHeight) {
      return rawEdit;
    }
  }
  return null;
}

export function startTextEditingAtPointWhenReady({ x, y, pageNum, canvasEl } = {}) {
  const ownerDocument = getActiveDocument();
  if (!ownerDocument || !canvasEl) return false;
  const activate = ({ documentState, pageNum: readyPage, point }) => {
    if (getActiveDocument() !== documentState) return false;
    const readyCanvas = livePageCanvas(readyPage) || canvasEl;
    const hitEdit = findTextEditAtPosition(point.x, point.y, readyPage, readyCanvas);
    if (!hitEdit) return false;
    startTextEditEditing(hitEdit, readyPage, readyCanvas, null, { readinessGranted: true });
    return true;
  };
  if (!ownerDocument.pdfDoc) {
    return activate({ documentState: ownerDocument, pageNum, point: { x, y } });
  }
  void queueCurrentPageEditIntent({
    documentState: ownerDocument,
    pageNum,
    point: { x, y },
    activate,
  }).catch(reportQueuedEditFailure);
  return false;
}

export function startTextEditEditing(
  textEdit,
  pageNum,
  canvasEl,
  transaction = null,
  { readinessGranted = false } = {},
) {
  if (rejectInvalidOwnedTextState()) return false;
  const ownerDocument = getActiveDocument();
  if (!ownerDocument) return false;
  if (ownerDocument?.pdfDoc && !readinessGranted) {
    void queueCurrentPageEditIntent({
      documentState: ownerDocument,
      pageNum,
      activate: ({ documentState, pageNum: readyPage }) => {
        if (getActiveDocument() !== documentState) return false;
        const readyCanvas = livePageCanvas(readyPage);
        if (!readyCanvas) return false;
        const liveRecord = documentState.textEdits?.find(
          (record) => String(record.id) === String(textEdit?.id),
        ) || textEdit;
        return startTextEditEditing(
          liveRecord,
          readyPage,
          readyCanvas,
          transaction,
          { readinessGranted: true },
        );
      },
    }).catch(reportQueuedEditFailure);
    return false;
  }
  cancelActiveTextEditing('superseded');

  // The document-owned record remains immutable for the entire session.
  // Properties, geometry, and content operate on this isolated draft and the
  // owner record is replaced only by the Apply undo command.
  const sourceTextEdit = textEdit;
  const draftTextEdit = cloneTextEditRecord(sourceTextEdit);
  const view = projectTextEditRecord(draftTextEdit);
  const nativeExpandable = draftTextEdit?.schema === 'open-pdf-studio.text-edit-record'
    && draftTextEdit.version === 2
    && Boolean(draftTextEdit.original)
    && Array.isArray(draftTextEdit.sourceProvenance)
    && draftTextEdit.sourceProvenance.length > 0;
  const isAddedText = view.originalText === '';
  const exactExpandable = nativeExpandable || isAddedText;

  const editDoc = getActiveDocument();
  const geometry = getTextEditGeometry(pageNum, canvasEl);
  const pageHeight = geometry.pageHeight;
  const viewGeometry = getTextEditViewGeometry(canvasEl, editDoc);
  const editScale = viewGeometry.visualScale;
  const fontSize = view.fontSize;
  const ls = view.lineSpacing || fontSize * 1.2;
  const newLines = view.newText.split('\n');
  const numLines = newLines.length;

  const firstBaseY = pageHeight - view.pdfY;
  const maxCharCount = Math.max(...newLines.map(l => l.length), 1);
  const editWidth = exactExpandable
    ? Math.max(view.richText.region.width, fontSize)
    : transaction
    ? Math.max(view.pdfWidth || 0, fontSize)
    : Math.max(view.pdfWidth || 0, fontSize * 0.6 * maxCharCount) + fontSize * 0.5;

  // Find the container to place the editor in
  const container = canvasEl.parentElement;
  if (!container) return false;
  const containerRect = container.getBoundingClientRect();
  const canvasRect = canvasEl.getBoundingClientRect();
  const offsetX = canvasRect.left - containerRect.left;
  const offsetY = canvasRect.top - containerRect.top;

  const rotatedBaseline = applyPageRotation(
    view.pdfX,
    firstBaseY,
    geometry.pageWidth,
    geometry.pageHeight,
    geometry.rotation,
  );
  const scaledWidth = editWidth * editScale;
  const editorFontSize = fontSize * editScale;
  const visualLineHeight = ls * editScale;
  const activeViewport = window.__pdfViewport;
  const useViewport = activeViewport?.active && editDoc?.filePath;
  const pageOffsetX = useViewport ? activeViewport.offsetX : offsetX;
  const pageOffsetY = useViewport ? activeViewport.offsetY : offsetY;

  // Map the manifest's packaged face to the matching bundled CSS font. This
  // avoids both a fallback-font preview and an unnecessary substitution flow
  // for application-created text.
  const ff = (view.fontFamily || 'LiberationSans').toLowerCase();
  const cssFontFamily = cssFamilyFor(view.fontFamily || 'Liberation Sans');
  const editorFontFamily = view.loadedFontName
    ? `"${view.loadedFontName}", ${cssFontFamily}`
    : cssFontFamily;

  const editorBold = ff.includes('bold');
  const editorItalic = ff.includes('italic') || ff.includes('oblique');
  const baselineOffset = cssBaselineOffset(
    editorFontFamily, editorFontSize, visualLineHeight, editorBold, editorItalic
  );
  const [, , rotationC, rotationD] = getPageRotationMatrix(
    geometry.pageWidth,
    geometry.pageHeight,
    geometry.rotation,
  );
  const baselineLeft = containerRect.left + pageOffsetX + rotatedBaseline.x * editScale;
  const baselineTop = containerRect.top + pageOffsetY + rotatedBaseline.y * editScale;
  const editorLeft = baselineLeft - rotationC * baselineOffset;
  const editorTop = baselineTop - rotationD * baselineOffset;
  const editorWidth = Math.max(scaledWidth, 80);
  const editorHeight = Math.max(numLines * visualLineHeight, 24);

  // Build style object using fixed positioning
  const styleObj = {
    position: 'absolute',
    left: `${editorLeft}px`,
    top: `${editorTop}px`,
    width: `${editorWidth}px`,
    height: `${editorHeight}px`,
    'font-size': `${editorFontSize}px`,
    'line-height': `${visualLineHeight}px`,
    'font-family': editorFontFamily,
    color: view.color || '#000000',
    transform: `rotate(${geometry.rotation}deg)`,
    'transform-origin': '0 0',
    'z-index': '1000'
  };
  if (editorBold) styleObj['font-weight'] = 'bold';
  if (editorItalic) styleObj['font-style'] = 'italic';
  const decorations = [];
  if (view.fontUnderline) decorations.push('underline');
  if (view.fontStrikethrough) decorations.push('line-through');
  styleObj['text-decoration-line'] = decorations.length ? decorations.join(' ') : 'none';
  styleObj['text-decoration-thickness'] = '0.06em';
  styleObj['text-underline-offset'] = '0.08em';
  const placement = pagePlacementForViewportStyle({
    doc: editDoc,
    pageNum,
    geometry,
    sourceRect: {
      left: editorLeft,
      top: editorTop,
      width: editorWidth,
      height: editorHeight,
    },
    canonicalStyle: createPageTextEditStyle({
      geometry: {
        width: editorWidth / editScale,
        height: editorHeight / editScale,
        zIndex: 1000,
      },
      typography: {
        fontFamily: editorFontFamily,
        fontSize,
        lineHeight: ls,
        fontWeight: editorBold ? 'bold' : 'normal',
        fontStyle: editorItalic ? 'italic' : 'normal',
        color: view.color || '#000000',
      },
      decoration: {
        textDecorationLine: decorations.length ? decorations.join(' ') : 'none',
        textDecorationThicknessEm: 0.06,
        textUnderlineOffsetEm: 0.08,
      },
    }),
    containerRect,
    pageOffsetX,
    pageOffsetY,
    sourceScale: editScale,
    mode: nativeExpandable ? 'native-expandable' : isAddedText ? 'inserted-expandable' : 'owned-text',
  });

  const oldTextEdit = cloneTextEditRecord(sourceTextEdit);

  const finishEditing = async (operation) => {
    const editor = activeEditor;
    if (!editorApplyOperationIsCurrent(editor, operation)) {
      return textApplyResultFor(editor, 'superseded');
    }
    const closeEditor = (reason = 'record-runtime-cleanup') => (
      cleanupEditorRuntime(editor, { reason })
    );
    const finalDraft = finalEditorDraft(editor);
    const newText = finalDraft.plainText;
    const richTextDraft = finalDraft.document;

    // Clearing all the text of an INSERTED edit deletes it entirely — this is
    // how the user removes inserted text (issue #264).
    if (isAddedText && newText === '') {
      if (transaction) {
        closeEditor('noop');
        return textApplyResultFor(editor, 'noop');
      }
      if (!removeTextEditRecord(sourceTextEdit, editDoc)) {
        setPdfEditorStatus(hardeningText('textEditor.status.operationFailed'), 'invalid');
        return textApplyResultFor(editor, 'rejected', {
          rejectionCode: 'TEXT_OWNER_COMMIT_FAILED',
          recoveryActions: ['keep-editing'],
        });
      }
      const published = await publishEditorCommit(editor, {
        ownerDocument: editDoc,
        pageNum,
        editId: null,
        editRevision: null,
        nativeAuthoritative: false,
      });
      const closed = closeEditor('published-delete');
      if (!closed || published.publication.status === 'superseded') {
        return textApplyResultFor(editor, 'superseded', {
          ownerCommitted: true,
          editId: null,
          editRevision: null,
          publicationError: published.publicationError,
        });
      }
      return textApplyResultFor(editor, 'applied', {
        ownerCommitted: true,
        visiblePublished: published.visiblePublished,
        semanticPublished: published.semanticPublished,
        editId: null,
        editRevision: null,
        publicationError: published.publicationError,
      });
    }

    const candidateTextEdit = cloneTextEditRecord(draftTextEdit);
    if (candidateTextEdit.schema === 'open-pdf-studio.text-edit-record'
        && candidateTextEdit.version === 2 && richTextDraft) {
      candidateTextEdit.richText = transaction && !exactExpandable
        ? reflowRichTextToWidth(richTextDraft, Math.max(candidateTextEdit.richText.region.width, 1))
        : richTextDraft;
    } else {
      candidateTextEdit.newText = newText;
    }
    // Persist when content, style, or position changed. The document record is
    // still untouched here; compare and commit the isolated draft atomically.
    const prepared = prepareTextEditRecordCommit(oldTextEdit, candidateTextEdit, {
      force: transaction?.forceCommit === true,
      newRecord: transaction?.draftOnly === true,
    });
    if (!prepared.changed) {
      closeEditor('noop');
      return textApplyResultFor(editor, 'noop', {
        editId: oldTextEdit.id,
        editRevision: oldTextEdit.revision ?? null,
      });
    }

    let layoutDecision = {
      status: 'ready',
      document: candidateTextEdit.richText || richTextDraft,
      autoFit: { applied: false, priorBounds: null, nextBounds: null },
    };
    if (exactExpandable) {
      layoutDecision = await nativeLayoutReadyForCommit(editor, finalDraft, operation);
      if (!editorApplyOperationIsCurrent(editor, operation)
          || layoutDecision.status === 'superseded') {
        return textApplyResultFor(editor, 'superseded');
      }
      if (!['ready', 'auto-fitted'].includes(layoutDecision.status)) {
        return textApplyResultFor(editor, 'rejected', {
          rejectionCode: layoutDecision.rejectionCode || 'TEXT_LAYOUT_FAILED',
          recoveryActions: layoutRecoveryActions(layoutDecision),
        });
      }
      candidateTextEdit.richText = layoutDecision.document;
    }
    const committedCandidate = prepareTextEditRecordCommit(oldTextEdit, candidateTextEdit, {
      force: transaction?.forceCommit === true,
      newRecord: transaction?.draftOnly === true,
    }).candidate;

    if (transaction && (prepared.changed || transaction.forceCommit)) {
      const commitResult = transaction.commit(cloneTextEditRecord(committedCandidate));
      if (commitResult !== true) {
        setPdfEditorStatus(hardeningText('textEditor.status.operationFailed'), 'invalid');
        return textApplyResultFor(editor, 'rejected', {
          rejectionCode: 'TEXT_OWNER_COMMIT_FAILED',
          recoveryActions: ['keep-editing'],
        });
      }
    } else if (prepared.changed) {
      const ownerIndex = editDoc.textEdits?.findIndex((record) => (
        String(record.id) === String(oldTextEdit.id)
      )) ?? -1;
      if (ownerIndex < 0) {
        setPdfEditorStatus(hardeningText('textEditor.status.operationFailed'), 'invalid');
        return textApplyResultFor(editor, 'rejected', {
          rejectionCode: 'TEXT_OWNER_RECORD_MISSING',
          recoveryActions: ['keep-editing'],
        });
      }
      const previousOwnerRecord = editDoc.textEdits[ownerIndex];
      const committedRecord = cloneTextEditRecord(committedCandidate);
      const recorded = runOwnerScopedTextCommit({
        ownerDocument: editDoc,
        attempt() {
          editDoc.textEdits[ownerIndex] = committedRecord;
          return executeForDocument(editDoc, {
            type: 'modifyTextEdit',
            oldTextEdit,
            newTextEdit: cloneTextEditRecord(committedRecord),
          });
        },
        rollback() {
          editDoc.textEdits[ownerIndex] = previousOwnerRecord;
        },
      });
      if (!recorded) {
        setPdfEditorStatus(hardeningText('textEditor.status.operationFailed'), 'invalid');
        return textApplyResultFor(editor, 'rejected', {
          rejectionCode: 'TEXT_OWNER_COMMIT_FAILED',
          recoveryActions: ['keep-editing'],
        });
      }
    }

    const published = await publishEditorCommit(editor, {
      ownerDocument: editDoc,
      pageNum,
      editId: committedCandidate.id ?? null,
      editRevision: committedCandidate.revision ?? null,
      nativeAuthoritative: Boolean(
        committedCandidate.original && committedCandidate.sourceProvenance,
      ),
    });
    const closed = closeEditor('published');
    if (!closed || published.publication.status === 'superseded') {
      return textApplyResultFor(editor, 'superseded', {
        ownerCommitted: true,
        editId: committedCandidate.id ?? null,
        editRevision: committedCandidate.revision ?? null,
        publicationError: published.publicationError,
      });
    }
    return textApplyResultFor(editor, 'applied', {
      ownerCommitted: true,
      visiblePublished: published.visiblePublished,
      semanticPublished: published.semanticPublished,
      editId: committedCandidate.id ?? null,
      editRevision: committedCandidate.revision ?? null,
      layoutAdjustment: layoutAdjustmentForDecision(layoutDecision),
      publicationError: published.publicationError,
    });
  };

  const cancelEditing = () => {
    const editor = activeEditor;
    try {
      reRenderAddedText(pageNum);
    } finally {
      cleanupEditorRuntime(editor, { reason: 'cancel' });
    }
    return true;
  };

  activeEditor = {
    block: { spans: [] },
    pageNum,
    kind: 'record',
    _recordRef: draftTextEdit,
    _sourceRecordRef: sourceTextEdit,
    _transaction: transaction,
    richTextDocument: view.richText,
    expandableNative: exactExpandable,
    originalText: view.newText,
    pdfX: view.pdfX,
    pdfY: view.pdfY,
    pdfWidth: view.pdfWidth || 0,
    fontSize,
    lineSpacing: ls,
    numOriginalLines: numLines,
    scale: editScale,
    visualScale: editScale,
    editorBaseline: {
      left: baselineLeft,
      top: baselineTop,
      rotationC,
      rotationD,
    },
    placement,
    styleState: {
      family: view.fontFamily || 'Liberation Sans',
      cssFamily: editorFontFamily,
      fontFaceChanged: false,
      size: view.fontSize,
      color: view.color || '#000000',
      bold: ff.includes('bold'),
      italic: ff.includes('italic') || ff.includes('oblique'),
      underline: view.fontUnderline === true,
      strikethrough: view.fontStrikethrough === true,
    },
    _finishEditing: finishEditing,
    _cancelEditing: cancelEditing
  };
  registerActiveEditorSession(activeEditor, editDoc, nativeExpandable
    ? 'owned-native-edit'
    : isAddedText ? 'inserted-text' : 'owned-text');
  publishPdfTextEditState(activeEditor);

  // Show text properties in the right panel
  const ffLower = (view.fontFamily || 'LiberationSans').toLowerCase();
  showTextEditPropertiesSafely({
    text: view.newText,
    fontSize: view.fontSize,
    fontFamily: view.fontFamily || 'Liberation Sans',
    color: view.color || '#000000',
    isBold: ffLower.includes('bold'),
    isItalic: ffLower.includes('italic') || ffLower.includes('oblique'),
    isUnderline: view.fontUnderline === true,
    isStrikethrough: view.fontStrikethrough === true,
    page: pageNum
  });

  // Define handlers for the store
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancelActiveTextEditing('escape');
      return;
    }
    // Alt+Arrow nudges the inserted text (Alt keeps normal caret arrows free).
    if (e.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 5 : 1;
      nudgeActiveTextEdit(
        e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
        e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0
      );
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      applyActiveTextEditingWithStatus();
      return;
    }
    if (e.key === 'Enter') {
      e.stopPropagation();
    }
  };

  const handleBlur = () => {};

  activeEditor.mountOwner = showPdfTextEditor(styleObj, view.newText, {
    onCommit: null,
    onCancel: null,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
    runtimeOwner: {
      sessionId: activeEditor.sessionId,
      documentId: activeEditor.ownerDocument?.id,
      documentGeneration: activeEditor.ownerDocumentGeneration,
    },
    options: {
      richTextDocument: view.richText,
      capabilities: DEFAULT_TEXT_FORMAT_CAPABILITIES,
      placement,
      reflowWidth: Boolean(transaction) && !exactExpandable,
      expandableRegion: exactExpandable ? expandableNativeEditorOptions(
        view.richText,
        pageNum,
        canvasEl,
        livePageTextLayer(pageNum, editDoc),
        {
          provenance: draftTextEdit.sourceProvenance,
          editId: draftTextEdit.id,
          displayScale: editScale,
          sourceWidth: draftTextEdit.original?.region?.width || view.richText.region.width,
          substitutionWidthAllowance: draftTextEdit.substitution?.approved === true ? 1 : 0,
          manualLineBreaks: nativeExpandable,
          onDraftLayout: (layout) => {
            if (activeEditor?._recordRef === draftTextEdit) activeEditor.draftLayout = layout;
          },
        },
      ) : undefined,
      ariaLabel: hardeningText('textEditor.aria.editRegion', { text: view.newText }),
    },
  });
  return true;
}

// ── Management of the ACTIVE text edit (called from the properties panel) ──

// Apply a formatting change from the properties panel to the text edit that is
// currently open in the inline editor. Works for both inserted text (a live
// textEdit record) and existing PDF text (persisted on commit).
export function applyActiveTextEditStyle(key, value) {
  if (!activeEditor || !activeEditor.styleState) return false;
  const st = activeEditor.styleState;
  if (activeEditor.kind === 'scannedText' && ['fontUnderline', 'fontStrikethrough'].includes(key)) {
    return false;
  }
  let scannedTouchedKey = null;
  let richPatch = null;
  let paragraphPatch = null;
  let statePatch = null;
  switch (key) {
    case 'fontFamily': {
      if (typeof value !== 'string' || !value.trim()) return false;
      const faceId = resolvePackagedFace(value, st.bold, st.italic)?.id;
      if (!faceId) return false;
      statePatch = {
        family: value,
        fontFaceChanged: st.fontFaceChanged === true || st.family !== value,
      };
      scannedTouchedKey = 'fontClass';
      richPatch = { faceId };
      break;
    }
    case 'textFontSize':
    case 'fontSize': {
      const n = parseInt(value);
      if (!Number.isFinite(n) || n <= 0) return false;
      statePatch = { size: n };
      scannedTouchedKey = 'fontSize';
      richPatch = { size: n };
      break;
    }
    case 'textColor':
    case 'color':
      if (typeof value !== 'string' || !value.trim()) return false;
      statePatch = { color: value };
      scannedTouchedKey = 'textColor';
      richPatch = { color: value };
      break;
    case 'fontBold': {
      if (typeof value !== 'boolean') return false;
      const faceId = resolvePackagedFace(st.family, value, st.italic)?.id;
      if (!faceId) return false;
      statePatch = {
        bold: value,
        fontFaceChanged: st.fontFaceChanged === true || st.bold !== value,
      };
      scannedTouchedKey = 'weight';
      richPatch = {
        bold: value,
        faceId,
      };
      break;
    }
    case 'fontItalic': {
      if (typeof value !== 'boolean') return false;
      const faceId = resolvePackagedFace(st.family, st.bold, value)?.id;
      if (!faceId) return false;
      statePatch = {
        italic: value,
        fontFaceChanged: st.fontFaceChanged === true || st.italic !== value,
      };
      scannedTouchedKey = 'italic';
      richPatch = {
        italic: value,
        faceId,
      };
      break;
    }
    case 'textAlign':
      if (!['left', 'center', 'right'].includes(value)) return false;
      statePatch = { alignment: value };
      scannedTouchedKey = 'alignment';
      // OCR paragraph reflow intentionally uses a plain textarea so visual
      // soft wraps never become authored hard lines. Its canonical alignment
      // is still an owned style override, carried by styleState instead of a
      // rich-text paragraph draft.
      if (!(activeEditor.kind === 'scannedText' && activeEditor.paragraphReflow)) {
        paragraphPatch = ['alignment', value];
      }
      break;
    case 'lineSpacing':
      if (!(Number(value) > 0)) return false;
      paragraphPatch = ['lineSpacingMultiplier', Number(value)];
      break;
    case 'fontUnderline':
      if (typeof value !== 'boolean') return false;
      statePatch = { underline: value };
      richPatch = { underline: value };
      break;
    case 'fontStrikethrough':
      if (typeof value !== 'boolean') return false;
      statePatch = { strikethrough: value };
      richPatch = { strikeout: value };
      break;
    default: return false;
  }
  if (richPatch && applyPdfEditorRichTextFormat(richPatch) !== true) return false;
  if (paragraphPatch && applyPdfEditorRichTextParagraphFormat(...paragraphPatch) !== true) return false;
  if (statePatch) Object.assign(st, statePatch);
  if (activeEditor.kind === 'scannedText' && scannedTouchedKey) {
    syncScannedStyleTouchedKey(
      activeEditor.styleTouchedKeys,
      activeEditor.scannedStyleBaseline,
      st,
      scannedTouchedKey,
    );
  }
  applyStyleStateToEditor(st);
  // Record sessions (inserted text or an existing edit record) update live so
  // the user sees the restyle immediately.
  if (activeEditor._recordRef) {
    if (activeEditor._recordRef.schema !== 'open-pdf-studio.text-edit-record') {
      applyStyleStateToRecord(activeEditor._recordRef, st);
      if (st.fontFaceChanged) activeEditor._recordRef.loadedFontName = '';
    }
    reRenderAddedText(activeEditor._recordRef.page);
  }
  return true;
}

// Delete the text edit that is currently open in the inline editor.
export async function deleteActiveTextEdit() {
  if (!activeEditor) return;
  if (activeEditor.kind === 'scannedText') {
    const editor = activeEditor;
    const doc = editor.ownerDocument;
    if (doc && editor.existingOwnedEdit) {
      try {
        removeScannedTextEditForDocument(doc, editor.selectionId);
        const reverted = doc.scannedTextEdits?.pages
          ?.flatMap((page) => page.selections || [])
          .find((selection) => selection.id === editor.selectionId);
        await publishEditorCommit(editor, {
          ownerDocument: doc,
          pageNum: editor.pageNum,
          editId: editor.selectionId,
          editRevision: reverted?.revision ?? null,
          nativeAuthoritative: false,
        });
      } catch (error) {
        console.warn('[scanned-text-edit] Removal failed:', error);
        showMessage(hardeningText('textEditor.status.operationFailed'));
        return;
      }
    }
    const closed = cleanupEditorRuntime(editor, { reason: 'delete' });
    if (closed) enableTextLayerHover();
    return;
  }
  if (activeEditor._transaction?.draftOnly) {
    activeEditor._cancelEditing?.();
    return;
  }
  const editor = activeEditor;
  if (editor._recordRef) {
    // Inserted text / existing edit record → drop the record.
    const sourceRecord = editor._sourceRecordRef || editor._recordRef;
    if (!removeTextEditRecord(sourceRecord)) return;
    await publishEditorCommit(editor, {
      ownerDocument: editor.ownerDocument,
      pageNum: editor.pageNum,
      editId: null,
      editRevision: null,
      nativeAuthoritative: Boolean(sourceRecord.original && sourceRecord.sourceProvenance),
    });
  } else if (editor.kind === 'existingText' && editor.originalText) {
    // Native source text may be removed only through exact operator ownership;
    // page-colour cover rectangles are not a safe deletion mechanism.
    showMessage(hardeningText('textEditor.status.nativeDeleteUnavailable'));
  }
  cleanupEditorRuntime(editor, { restoreNativeSpans: true, reason: 'delete' });
}

// Move the active text edit by a PDF-unit delta (Alt+Arrow keys).
function nudgeActiveTextEdit(dxPdf, dyPdf) {
  if (!activeEditor) return;
  const scale = activeEditor.scale || (activeEditor.ownerDocument?.scale || 1.5);
  // Convert the PDF-space nudge into the rotated display frame.
  const canvasEl = livePageCanvas(activeEditor.pageNum, null, activeEditor.ownerDocument);
  const geometry = getTextEditGeometry(activeEditor.pageNum, canvasEl);
  const [a, b, c, d] = getPageRotationMatrix(
    geometry.pageWidth,
    geometry.pageHeight,
    geometry.rotation,
  );
  const unrotatedDy = -dyPdf;
  const shiftX = (a * dxPdf + c * unrotatedDy) * scale;
  const shiftY = (b * dxPdf + d * unrotatedDy) * scale;
  shiftPdfEditorPosition(shiftX, shiftY);
  if (Number.isFinite(activeEditor.editorBaseline)) {
    activeEditor.editorBaseline += shiftY;
  } else if (activeEditor.editorBaseline) {
    activeEditor.editorBaseline.left += shiftX;
    activeEditor.editorBaseline.top += shiftY;
  }
  if (activeEditor._recordRef) {
    if (activeEditor._recordRef.schema === 'open-pdf-studio.text-edit-record'
        && activeEditor._recordRef.version === 2) {
      activeEditor._recordRef.richText.region.x += dxPdf;
      activeEditor._recordRef.richText.region.y += dyPdf;
      for (const line of activeEditor._recordRef.richText.lines) line.baseline += dyPdf;
      activeEditor._recordRef.revision += 1;
    } else {
      activeEditor._recordRef.pdfX += dxPdf;
      activeEditor._recordRef.pdfY += dyPdf;
    }
    reRenderAddedText(activeEditor._recordRef.page);
  } else {
    // Existing-text session: coords are read from activeEditor on commit.
    activeEditor.pdfX += dxPdf;
    activeEditor.pdfY += dyPdf;
  }
}

// Remove a textEdit record from the document (undoable).
function removeTextEditRecord(rec, ownerDocument = activeEditor?.ownerDocument) {
  const doc = ownerDocument || getActiveDocument();
  if (!doc || !doc.textEdits) return false;
  const removed = runOwnerScopedTextCommit({
    ownerDocument: doc,
    attempt: () => removeTextEditRecordFromDocument(doc, rec.id, (snapshot, index) => (
      executeForDocument(doc, {
        type: 'removeTextEdit',
        textEdit: snapshot,
        index,
      })
    )),
  });
  if (!removed) return false;
  return true;
}
