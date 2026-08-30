import { state, getActiveDocument, getDocumentById, getPageRotation } from '../core/state.js';
import i18next from '../i18n/config.js';
import { redrawAnnotations, redrawContinuous } from '../annotations/rendering.js';
import { hasFill } from '../annotations/fill-utils.js';
import { showProperties } from '../ui/panels/properties-panel.js';
import { executeForDocument, flushPropertyChange } from '../core/undo-manager.js';
import { cloneAnnotation } from '../annotations/factory.js';
import { annotationCanvas } from '../ui/dom-elements.js';
import { viewport as vpState } from '../pdf/pdf-viewport.js';
import {
  showPdfTextEditor, hidePdfTextEditor,
  getPdfEditorRichText,
  flushPdfEditorDraftForCommit,
  adoptPdfEditorFinalTextLayout,
  getPdfEditorFormatState,
  applyPdfEditorRichTextFormat,
  applyPdfEditorRichTextParagraphFormat,
  openStickyPopup,
  setPdfEditorStatus,
} from '../bridge.js';
import {
  DEFAULT_TEXT_FORMAT_CAPABILITIES,
  cloneRichTextDocument,
  richTextFromPlainText,
  richTextToPlainText,
} from '../text/rich-text.js';
import { resolvePackagedFace } from '../text/font-catalog.js';
import { resolveAutomaticFontSubstitution } from '../text/font-substitution-policy.js';
import {
  createPageTextEditPlacement,
  createPageTextEditStyle,
} from '../text/page-text-edit-placement.js';
import { resolveTextEditPageGeometry } from '../text/text-edit-appearance.js';
import {
  applyActiveTextEditing,
  cancelActiveTextEditing,
  completeTextEditSession,
  registerTextEditSession,
} from '../text/text-edit-session.js';
import {
  applyExistingTextAnnotationDraft,
  applyTextAnnotationDraft,
  cleanTextAnnotationApplyIsNoop,
  discardTextAnnotationDraft,
  isolateTextAnnotationDraft,
} from '../text/annotation-text-draft.js';
import {
  createTextEditDirtyBaseline,
  textEditDraftIsDirty,
  textEditGeometryChanged,
} from '../text/text-edit-dirty-state.js';
import { runOwnerScopedTextCommit } from '../text/text-edit-commit.js';
import { waitForSavedDocumentSynchronization } from '../pdf/saved-document-transition.js';
import {
  awaitPageEditReady,
  PAGE_EDIT_READINESS_TIMEOUT_MS,
} from '../pdf/page-edit-readiness.js';
import { runPageEditIntent } from '../text/page-edit-intent.js';
import {
  awaitFinalTextLayout,
  disposeFinalTextLayoutSession,
} from '../text/final-text-layout.js';
import { createTextApplyResult } from '../text/text-apply-result.js';
import { createEditorLayoutRevision } from '../text/editor-layout-revision.js';
import { publishCommittedTextEdit } from '../text/text-edit-publication.js';
import { showMessage } from '../solid/stores/dialogStore.js';

function annotationApplyResult(ownerDocument, ownerGeneration, annotation, status, overrides = {}) {
  const pageNum = Number(annotation?.page) || 1;
  return createTextApplyResult({
    status,
    documentId: String(ownerDocument?.id || ''),
    documentGeneration: Number(ownerGeneration) || 0,
    pageNum,
    contentRevision: Number(ownerDocument?.revisionState?.contentRevision) || 0,
    pageRevision: Number(ownerDocument?.revisionState?.pageContentRevisions?.[pageNum]) || 0,
    editId: annotation?.id ?? null,
    editRevision: null,
    ...overrides,
  });
}

async function publishAnnotationCommit(ownerDocument, annotation) {
  let publication;
  try {
    publication = await publishCommittedTextEdit({
      documentState: ownerDocument,
      pageNum: annotation.page,
      editId: annotation.id ?? null,
      editRevision: null,
      expectedVisible: getActiveDocument() === ownerDocument,
      nativeAuthoritative: false,
    });
  } catch (error) {
    publication = Object.freeze({
      status: 'failed',
      visiblePublished: false,
      semanticPublished: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'TEXT_PUBLICATION_FAILED',
    });
  }
  if (publication.status === 'failed' || publication.status === 'deferred-unmounted') {
    ownerDocument.textEditPublicationState = Object.freeze({
      ...publication,
      editId: annotation.id == null ? null : String(annotation.id),
      recoveryActions: Object.freeze(['retry-page-publication', 'save']),
    });
    showMessage(publication.status === 'deferred-unmounted'
      ? i18next.t('textEditor.status.previewPending', { ns: 'hardening' })
      : i18next.t('textEditor.status.previewFailed', {
        ns: 'hardening',
        error: publication.error ? `\n\n${publication.error}` : '',
      }));
  } else if (publication.status === 'published'
      && ownerDocument.textEditPublicationState?.pageNum === Number(annotation.page)) {
    ownerDocument.textEditPublicationState = null;
  }
  return publication;
}

async function waitForExactAnnotationLayout({ operation, snapshot }) {
  if (!snapshot?.layoutRevision?.fingerprint) {
    return {
      status: 'failed', rejectionCode: 'TEXT_LAYOUT_STALE_FINGERPRINT',
      rejectionReasons: ['Final text layout identity is incomplete'], document: snapshot?.document,
    };
  }
  const finalOptions = Object.freeze({
    ...snapshot.options,
    substitutionWidthAllowance: 0,
  });
  const finalRevision = createEditorLayoutRevision(
    snapshot.document,
    finalOptions,
    snapshot.identity,
  );
  const decision = await awaitFinalTextLayout({
    sessionId: snapshot.sessionId,
    draftRevision: snapshot.draftRevision,
    fingerprint: finalRevision.fingerprint,
    document: snapshot.document,
    options: finalOptions,
    identity: snapshot.identity,
    allowSafeAutoFit: true,
    signal: operation?.signal,
    timeoutMs: 5_000,
  });
  adoptPdfEditorFinalTextLayout(decision);
  if (decision.status === 'ready' || decision.status === 'auto-fitted') {
    return decision;
  }
  const reasons = decision.rejectionReasons?.join('; ')
    || decision.rejectionCode
    || i18next.t('textEditor.status.operationFailed', { ns: 'hardening' });
  setPdfEditorStatus(decision.rejectionCode === 'TEXT_LAYOUT_TIMEOUT'
    ? i18next.t('textEditor.status.layoutTimeout', { ns: 'hardening' })
    : i18next.t('textEditor.status.layoutRejected', { ns: 'hardening', reasons }), 'invalid');
  return decision;
}

// Start inline text editing for textbox/callout
export async function startTextEditing(annotation, {
  isNew = false,
  readinessGranted = false,
} = {}) {
  // Idempotency guard: if already editing this same annotation, do nothing.
  // Without this, double-firing handlers (select-tool dblclick + dispatcher dblclick)
  // call finishTextEditing on a freshly-opened overlay, wiping the existing text.
  if (state.isEditingText && (state.editingAnnotation === annotation
      || (annotation?.id != null && state._textEditSnapshot?.id != null
        && String(annotation.id) === String(state._textEditSnapshot.id)))) {
    return;
  }
  if (state.isEditingText) {
    cancelActiveTextEditing('superseded');
  }

  if (!['textbox', 'callout'].includes(annotation.type)) return;
  if (annotation.locked || annotation.readOnly) return;

  let ownerDocument = getActiveDocument();
  if (!ownerDocument) return;
  if (!readinessGranted) {
    const annotationId = annotation.id == null ? null : String(annotation.id);
    const pageNum = annotation.page || ownerDocument.currentPage || 1;
    try {
      const intent = await runPageEditIntent({
        documentState: ownerDocument,
        pageNum,
        waitForSynchronization: waitForSavedDocumentSynchronization,
        resolveDocument: getDocumentById,
        awaitReadiness: (documentState, page, options) => (
          documentState.pdfDoc
            ? awaitPageEditReady(documentState, page, {
              ...options,
              timeoutMs: options?.timeoutMs || PAGE_EDIT_READINESS_TIMEOUT_MS,
            })
            : Promise.resolve()
        ),
        readinessTimeoutMs: PAGE_EDIT_READINESS_TIMEOUT_MS,
        activate: ({ documentState }) => {
          const liveAnnotation = isNew
            ? annotation
            : documentState.annotations?.find(
              (candidate) => String(candidate.id) === annotationId,
            );
          if (!liveAnnotation) return false;
          return startTextEditing(liveAnnotation, { isNew, readinessGranted: true });
        },
      });
      if (!intent.activated && intent.action === 'retry-page-edit') {
        showMessage(i18next.t('textEditor.status.pageNotReady', { ns: 'hardening' }));
      }
      return intent.activated ? intent.value : false;
    } catch (error) {
      if (error?.name !== 'AbortError') console.warn('[text-edit] Page readiness failed:', error);
      return false;
    }
  }
  ownerDocument = getDocumentById(ownerDocument.id);
  if (!ownerDocument) return false;
  if (getActiveDocument() !== ownerDocument) return false;
  const ownerGeneration = ownerDocument.lifecycleGeneration;
  const sourceAnnotation = annotation;

  const sourceFamily = annotation.fontFamily || 'Arial';
  let substitution = annotation.richTextSubstitution || null;
  if (!annotation.richText && !/^liberation\s*(sans|serif|mono)/iu.test(sourceFamily)) {
    substitution = resolveAutomaticFontSubstitution({
      sourceFonts: [sourceFamily],
      bold: annotation.fontBold,
      italic: annotation.fontItalic,
      sampleText: annotation.text || '',
      scope: 'annotation',
    });
    if (!substitution) return false;
  }

  // Never open a detached draft against a tab or document generation that
  // stopped owning the creation gesture.
  if (getActiveDocument() !== ownerDocument
      || getDocumentById(ownerDocument.id) !== ownerDocument
      || ownerDocument.lifecycleGeneration !== ownerGeneration) return false;

  // In de doorlopende weergave is het enkelpagina-canvas 0x0 op de
  // vensteroorsprong; de overlay moet daar tegen het canvas van de PAGINA
  // van de annotatie gepositioneerd worden. Anders verschijnt de editor op
  // kale vensterco-ordinaten — als een leeg "spook-tekstvak" over het
  // linkerpaneel — terwijl de echte annotatie op de pagina staat.
  const isContinuous = ownerDocument.viewMode === 'continuous';
  let canvas = null;
  if (isContinuous) {
    canvas = document.querySelector(
      `.page-wrapper[data-page="${annotation.page}"] .annotation-canvas`);
  }
  if (!canvas) canvas = annotationCanvas || document.getElementById('annotation-canvas');
  if (!canvas) return false;

  // Finish any property action that preceded the double-click while the owner
  // is still unchanged. Property changes made after this point target only the
  // isolated editor draft and are recorded with Apply as one undo unit.
  flushPropertyChange();
  // Existing annotations remain immutable while their transient editor is
  // open. Text, appearance, metadata, and geometry controls all target this
  // isolated draft; Apply emits one owner-scoped modify operation and Cancel
  // simply drops it. New annotations are already detached drafts.
  annotation = isolateTextAnnotationDraft(sourceAnnotation, { isNew, clone: cloneAnnotation });
  const originalSnapshot = cloneAnnotation(sourceAnnotation);
  const editorIsNew = isNew;

  // Get canvas position
  const canvasRect = canvas.getBoundingClientRect();

  // Calculate position based on annotation.
  // Viewport mode (vector renderer): annotations are placed at
  //   screen = canvasRect + offset + ann_pos * zoom
  // Legacy mode: annotations are placed at
  //   screen = canvasRect + ann_pos * scale
  // The textarea overlay must use the SAME math the annotation canvas uses,
  // otherwise it appears off-screen and the user can't find/edit the text.
  // In de doorlopende weergave geldt: scherm = paginacanvas-rect + pos * doc.scale
  // (zelfde formule als clipboard/visibleCenterOnPage). Het viewport-singleton
  // (vpState) hoort bij de ENKELpagina-weergave en blijft na een moduswissel
  // `active` staan; zijn zoom/offsets meenemen zet de overlay naast het scherm.
  const doc = ownerDocument;
  const useViewport = !isContinuous && vpState && vpState.active && doc?.filePath;
  const scale = useViewport ? vpState.zoom : (doc?.scale || 1.5);
  const offX = useViewport ? vpState.offsetX : 0;
  const offY = useViewport ? vpState.offsetY : 0;
  const width = annotation.width || 150;
  const height = annotation.height || 50;
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;

  // Grow-down editors use a top-left canonical anchor so zoom and content
  // growth never move the source top edge.
  const editorLeft = canvasRect.left + offX + annotation.x * scale;
  const editorTop = canvasRect.top + offY + annotation.y * scale;

  // Build a CSS font-family fallback chain matching shapes.js
  // drawTextboxContent — some editors emit "SegoeUI" (no space)
  // which neither Canvas nor CSS resolves to the installed Segoe UI family
  // without the camelCase-expanded variant in the fallback list. Without
  // this, edit-mode textarea silently falls back to the browser default
  // (Times Serif on Windows), giving a font that differs from what the
  // canvas renders → user sees one shape while editing, another after
  // commit.
  const rawFontFamily = annotation.fontFamily || 'Arial';
  const _cssQuote = s => `"${s.replace(/"/g, '\\"')}"`;
  const _expanded = rawFontFamily.replace(/([a-z])([A-Z])/g, '$1 $2');
  const _chain = [];
  if (_expanded !== rawFontFamily) _chain.push(_cssQuote(_expanded));
  _chain.push(/[\s"',]/.test(rawFontFamily) ? _cssQuote(rawFontFamily) : rawFontFamily);
  _chain.push('sans-serif');
  const cssFontFamily = _chain.join(', ');

  // Match the canvas padding (lineWidth, no minimum) so wrap-points line
  // up. Was `2 * scale` which added a 2pt margin the canvas no longer has.
  const editPadding = (annotation.lineWidth ?? 0) * scale;

  // Build style object for the textarea overlay
  const styleObj = {
    position: 'absolute',
    left: `${editorLeft}px`,
    top: `${editorTop}px`,
    width: `${scaledWidth}px`,
    height: `${scaledHeight}px`,
    'font-size': `${(annotation.fontSize || 14) * scale}px`,
    'font-family': cssFontFamily,
    color: annotation.textColor || annotation.color || '#000000',
    'background-color': hasFill(annotation.fillColor) ? annotation.fillColor : '#ffffff',
    border: `${(annotation.lineWidth ?? 1) * scale}px solid ${annotation.strokeColor || '#000000'}`,
    padding: `${editPadding}px`,
    'box-sizing': 'border-box',
    resize: 'none',
    outline: 'none',
    'z-index': '1200',
    overflow: 'hidden',
    transform: annotation.rotation ? `rotate(${annotation.rotation}deg)` : 'none',
    'transform-origin': '0 0',
  };

  // Apply text styles
  if (annotation.fontBold) styleObj['font-weight'] = 'bold';
  if (annotation.fontItalic) styleObj['font-style'] = 'italic';
  if (annotation.textAlign) styleObj['text-align'] = annotation.textAlign;
  // Line spacing: CSS line-height adds half-leading above first line.
  // To show spacing only below text, we shift the textarea up inside a clipping wrapper.
  // Match shapes.js DEFAULT_LINE_SPACING (=1.2) so the edit overlay shows
  // the same line gap the canvas will draw on commit.
  const ls = annotation.lineSpacing || 1.2;
  styleObj['line-height'] = ls;
  const halfLeading = ((ls - 1) * (annotation.fontSize || 14) * scale) / 2;
  // Pass halfLeading offset to the overlay component via a custom property
  styleObj['--text-offset'] = `${halfLeading}px`;

  const pageDims = doc?.pageDims?.[annotation.page];
  const geometry = resolveTextEditPageGeometry(
    pageDims,
    canvasRect.width / Math.max(scale, 0.0001),
    canvasRect.height / Math.max(scale, 0.0001),
    getPageRotation(annotation.page),
  );
  const placement = createPageTextEditPlacement({
    documentId: doc.id,
    pageNum: annotation.page,
    pageWidth: geometry.pageWidth,
    pageHeight: geometry.pageHeight,
    canonicalBounds: {
      x: annotation.x,
      y: annotation.y,
      width,
      height,
    },
    sourceScale: scale,
    sourceRotation: geometry.rotation,
    canonicalStyle: createPageTextEditStyle({
      geometry: { width, height, zIndex: 1200 },
      typography: {
        fontFamily: cssFontFamily,
        fontSize: annotation.fontSize || 14,
        lineHeightMultiplier: ls,
        fontWeight: annotation.fontBold ? 'bold' : 'normal',
        fontStyle: annotation.fontItalic ? 'italic' : 'normal',
        textAlign: annotation.textAlign || 'left',
        color: annotation.textColor || annotation.color || '#000000',
      },
      padding: { all: annotation.lineWidth ?? 0 },
      border: {
        width: annotation.lineWidth ?? 1,
        style: 'solid',
        color: annotation.strokeColor || '#000000',
        boxSizing: 'border-box',
      },
      decoration: {
        backgroundColor: hasFill(annotation.fillColor) ? annotation.fillColor : '#ffffff',
        outlineStyle: 'none',
        textOffset: ((ls - 1) * (annotation.fontSize || 14)) / 2,
      },
      layout: { resize: 'none', overflow: 'hidden' },
    }),
    sourceClientAnchor: { left: editorLeft, top: editorTop },
    mode: 'annotation-text',
    elementRotation: annotation.rotation || 0,
    anchor: 'top-left',
    generation: ownerGeneration,
  });

  const initialText = annotation.text || '';
  const face = resolvePackagedFace(sourceFamily, annotation.fontBold, annotation.fontItalic);
  const richTextDocument = annotation.richText || richTextFromPlainText(initialText, {
    faceId: face.id,
    size: annotation.fontSize || 14,
    color: annotation.textColor || annotation.color || '#000000',
    bold: annotation.fontBold === true,
    italic: annotation.fontItalic === true,
    underline: annotation.fontUnderline === true,
    strikeout: annotation.fontStrikethrough === true,
    baselineAdvance: (annotation.fontSize || 14) * (annotation.lineSpacing || 1.2),
    alignment: annotation.textAlign || 'left',
  }, {
    x: annotation.x,
    y: annotation.y,
    width: annotation.width || 150,
    height: annotation.height || 50,
    rotation: annotation.rotation || 0,
    baseline: annotation.y + (annotation.fontSize || 14),
    baselineDirection: 'increasing-y',
  });
  const dirtyBaseline = createTextEditDirtyBaseline({
    text: initialText,
    richText: richTextDocument,
    record: annotation,
  });

  let session = null;
  let mountOwner = null;
  let draftHeight = height;
  const runtimeOwnsSharedState = () => (
    state.isEditingText === true && state.editingAnnotation === annotation
  );
  const completeOwnedSession = () => {
    disposeFinalTextLayoutSession(session?.sessionId);
    completeTextEditSession(session?.sessionId);
  };
  const resetEditingState = () => {
    if (!runtimeOwnsSharedState()) return false;
    state.isEditingText = false;
    state.editingAnnotation = null;
    state.textEditElement = null;
    state._textEditSnapshot = null;
    state._textEditSubstitution = null;
    state._textEditIsNew = false;
    return true;
  };
  const closeEditingState = (reason) => {
    completeOwnedSession();
    const closeResult = hidePdfTextEditor(mountOwner, reason);
    if (closeResult.status === 'superseded') return closeResult;
    resetEditingState();
    return closeResult;
  };
  const redrawOwnerIfVisible = () => {
    if (getActiveDocument() !== ownerDocument) return;
    if (ownerDocument.viewMode === 'continuous') redrawContinuous();
    else redrawAnnotations();
    const selectedSource = isNew ? annotation : sourceAnnotation;
    if (ownerDocument.selectedAnnotation === selectedSource) showProperties(selectedSource);
  };

  // Commit function: update only the immutable owner document.
  const commitFn = async (operation) => {
    if (!runtimeOwnsSharedState()) {
      return annotationApplyResult(
        ownerDocument, ownerGeneration, sourceAnnotation, 'superseded',
      );
    }

    let currentOwner = getDocumentById(ownerDocument.id);
    if (currentOwner !== ownerDocument || currentOwner.lifecycleGeneration !== ownerGeneration) {
      cancelFn('stale-owner');
      return annotationApplyResult(
        ownerDocument, ownerGeneration, sourceAnnotation, 'superseded',
      );
    }

    const ann = annotation;
    const wasDirtyBeforeFlush = session?.isDirty?.() === true;
    const snapshot = flushPdfEditorDraftForCommit({
      sessionId: session?.sessionId,
      ownerDocumentId: ownerDocument.id,
      ownerDocumentGeneration: ownerGeneration,
    });
    if (!snapshot) {
      setPdfEditorStatus(i18next.t('textEditor.status.operationFailed', {
        ns: 'hardening',
      }), 'invalid');
      return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'rejected', {
        rejectionCode: 'TEXT_LAYOUT_STALE_FINGERPRINT',
        recoveryActions: ['keep-editing'],
      });
    }
    // A clean existing annotation closes before exact shaping can normalize
    // transient layout caches or turn a source mismatch into a false reject.
    if (cleanTextAnnotationApplyIsNoop({
      isNew: editorIsNew,
      isDirty: wasDirtyBeforeFlush || snapshot.authoredChangedByFlush === true,
    })) {
      const closed = closeEditingState('noop');
      if (closed.status === 'superseded') {
        return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'superseded');
      }
      redrawOwnerIfVisible();
      return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'noop');
    }
    const layoutDecision = await waitForExactAnnotationLayout({ operation, snapshot });
    const richDraft = layoutDecision.document;
    currentOwner = getDocumentById(ownerDocument.id);
    if (!operation?.isCurrent()
        || currentOwner !== ownerDocument
        || currentOwner.lifecycleGeneration !== ownerGeneration) {
      return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'superseded');
    }
    if (!richDraft || !['ready', 'auto-fitted'].includes(layoutDecision.status)) {
      return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'rejected', {
        rejectionCode: layoutDecision.rejectionCode || 'TEXT_LAYOUT_FAILED',
        recoveryActions: ['insert-line-break', 'keep-editing'],
      });
    }
    if (richDraft.region) {
      draftHeight = richDraft.region.height;
      ann.x = richDraft.region.x;
      ann.y = richDraft.region.y;
      ann.width = richDraft.region.width;
      ann.height = richDraft.region.height;
    }
    ann.richText = cloneRichTextDocument(richDraft);
    ann.richTextSubstitution = substitution;
    ann.textFormatCapabilities = DEFAULT_TEXT_FORMAT_CAPABILITIES;
    ann.text = richTextToPlainText(richDraft);
    const primary = richDraft.lines[0]?.runs[0];
    if (primary) {
      ann.fontFamily = primary.faceId.includes('mono') ? 'Liberation Mono'
        : primary.faceId.includes('serif') ? 'Liberation Serif' : 'Liberation Sans';
      ann.fontSize = primary.size;
      ann.textColor = primary.color;
      ann.fontBold = primary.bold;
      ann.fontItalic = primary.italic;
      ann.fontUnderline = primary.underline;
      ann.fontStrikethrough = primary.strikeout;
    }
    ann.textAlign = richDraft.lines[0]?.alignment || ann.textAlign || 'left';
    ann.modifiedAt = new Date().toISOString();

    // Apply auto-grown height back to annotation
    if (editorIsNew) {
      const applied = runOwnerScopedTextCommit({
        ownerDocument,
        attempt: () => applyTextAnnotationDraft({
          ownerDocument,
          annotation: ann,
          // Property controls may have queued bookkeeping for this detached
          // draft. Flush while it is absent so Apply remains one undo unit.
          beforeAttach: flushPropertyChange,
          record: (draft) => executeForDocument(ownerDocument, {
            type: 'addAnnotation',
            annotation: cloneAnnotation(draft),
          }),
        }),
        rollback: () => {
          const index = ownerDocument.annotations?.indexOf(ann) ?? -1;
          if (index >= 0) ownerDocument.annotations.splice(index, 1);
        },
      });
      if (!applied) {
        setPdfEditorStatus(i18next.t('textEditor.status.operationFailed', {
          ns: 'hardening',
        }), 'invalid');
        return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'rejected', {
          rejectionCode: 'TEXT_OWNER_COMMIT_FAILED',
          recoveryActions: ['keep-editing'],
        });
      }
    } else if (originalSnapshot && ann.id) {
      const applied = runOwnerScopedTextCommit({
        ownerDocument,
        attempt: () => applyExistingTextAnnotationDraft({
          annotation: sourceAnnotation,
          draft: ann,
          clone: cloneAnnotation,
          record: ({ oldState, newState }) => executeForDocument(ownerDocument, {
            type: 'modifyAnnotation',
            id: ann.id,
            oldState,
            newState,
          }),
        }),
      });
      if (!applied) {
        setPdfEditorStatus(i18next.t('textEditor.status.operationFailed', {
          ns: 'hardening',
        }), 'invalid');
        return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'rejected', {
          rejectionCode: 'TEXT_OWNER_COMMIT_FAILED',
          recoveryActions: ['keep-editing'],
        });
      }
    } else {
      setPdfEditorStatus(i18next.t('textEditor.status.operationFailed', {
        ns: 'hardening',
      }), 'invalid');
      return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'rejected', {
        rejectionCode: 'TEXT_OWNER_RECORD_MISSING',
        recoveryActions: ['keep-editing'],
      });
    }
    const publication = await publishAnnotationCommit(ownerDocument, ann);
    const closed = closeEditingState('published');
    if (closed.status === 'superseded') {
      return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'superseded', {
        ownerCommitted: true,
        publicationError: publication.status === 'failed'
          ? publication.error || publication.errorCode || 'Page publication failed'
          : null,
      });
    }
    if (publication.status !== 'published') redrawOwnerIfVisible();
    const adjustment = layoutDecision.status === 'auto-fitted'
      ? {
          kind: 'auto-grow-width',
          deltaWidthPt: layoutDecision.autoFit.nextBounds.width
            - layoutDecision.autoFit.priorBounds.width,
          deltaHeightPt: layoutDecision.autoFit.nextBounds.height
            - layoutDecision.autoFit.priorBounds.height,
        }
      : null;
    if (publication.status === 'superseded') {
      return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'superseded', {
        ownerCommitted: true,
        publicationError: publication.error || 'Page publication was superseded',
      });
    }
    return annotationApplyResult(ownerDocument, ownerGeneration, ann, 'applied', {
      ownerCommitted: true,
      visiblePublished: publication.status === 'published'
        && publication.visiblePublished === true,
      semanticPublished: publication.status === 'published'
        && publication.semanticPublished === true,
      layoutAdjustment: adjustment,
      publicationError: publication.status === 'failed'
        ? publication.error || publication.errorCode || 'Page publication failed'
        : null,
    });
  };

  // Cancel function: restore original text, reset state, refresh display
  const cancelFn = () => {
    const ann = annotation;
    const snapshot = originalSnapshot;
    const wasNew = editorIsNew;
    const owner = getDocumentById(ownerDocument.id);
    if (wasNew) {
      discardTextAnnotationDraft(owner, ann);
    } else if (snapshot) {
      for (const key of Object.keys(ann)) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete ann[key];
      }
      Object.assign(ann, cloneAnnotation(snapshot));
    }

    const closed = closeEditingState('cancel');
    if (closed.status !== 'superseded') redrawOwnerIfVisible();
    return closed.status !== 'superseded';
  };

  const keyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelActiveTextEditing('escape');
      import('./manager.js').then((module) => module.setTool?.('select'));
      return;
    }
    if ((event.metaKey || event.ctrlKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      const key = event.key.toLowerCase();
      const format = getPdfEditorFormatState();
      if (key === 'b') {
        const bold = format.bold !== true;
        applyPdfEditorRichTextFormat({
          bold,
          faceId: resolvePackagedFace(format.faceId, bold, format.italic === true)?.id,
        });
      }
      if (key === 'i') {
        const italic = format.italic !== true;
        applyPdfEditorRichTextFormat({
          italic,
          faceId: resolvePackagedFace(format.faceId, format.bold === true, italic)?.id,
        });
      }
      if (key === 'u') applyPdfEditorRichTextFormat({ underline: format.underline !== true });
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void applyActiveTextEditing();
    }
  };
  const blur = () => {};
  // Exact-layout fingerprints include the immutable editor-session identity.
  // Register before mounting so the overlay's first reactive layout request is
  // born with the same session identity that will validate its Worker result.
  // Mounting first creates a race where the initial request has no session ID,
  // its completed result is rejected as stale, and Apply remains pending.
  session = registerTextEditSession({
    ownerDocumentId: ownerDocument.id,
    ownerDocumentGeneration: ownerGeneration,
    pageNum: annotation.page,
    kind: annotation.type,
    isDirty: () => {
      const richDraft = getPdfEditorRichText() || richTextDocument;
      return textEditDraftIsDirty(dirtyBaseline, {
        text: richTextToPlainText(richDraft),
        richText: richDraft,
        record: annotation,
        geometryChanged: textEditGeometryChanged(draftHeight, height),
      });
    },
    commit: commitFn,
    cancel: cancelFn,
  });
  if (!session) {
    discardTextAnnotationDraft(ownerDocument, annotation);
    return false;
  }
  // Registering this session synchronously cancels the previous owner. Publish
  // shared annotation state only after that cancellation has finished, so the
  // old owner's cleanup cannot clear the new draft before it mounts.
  state.isEditingText = true;
  state.editingAnnotation = annotation;
  state._textEditSnapshot = originalSnapshot;
  state._textEditSubstitution = substitution;
  state._textEditIsNew = editorIsNew;
  mountOwner = showPdfTextEditor(styleObj, initialText, {
    onKeyDown: keyDown,
    onBlur: blur,
    runtimeOwner: {
      sessionId: session.sessionId,
      documentId: ownerDocument.id,
      documentGeneration: ownerGeneration,
    },
    options: {
      richTextDocument,
      capabilities: DEFAULT_TEXT_FORMAT_CAPABILITIES,
      placement,
      displayScale: scale,
      reflowWidth: true,
      growDown: true,
      expandableRegion: {
        manualLineBreaks: false,
        directManipulation: true,
        width: richTextDocument.region.width,
        contentWidth: Math.max(1, richTextDocument.region.width - (2 * (annotation.lineWidth || 0))),
        contentInset: annotation.lineWidth || 0,
        contentInsetPx: (annotation.lineWidth || 0) * scale,
        minimumHeight: height,
        anchorTop: annotation.y,
        pageBounds: { x: 0, y: 0, width: geometry.pageWidth, height: geometry.pageHeight },
        columnBounds: null,
        editorBackground: hasFill(annotation.fillColor) ? annotation.fillColor : '#ffffff',
        existingBounds: (ownerDocument.annotations || [])
          .filter((candidate) => candidate !== sourceAnnotation
            && String(candidate?.id) !== String(annotation.id)
            && candidate.page === annotation.page)
          .filter((candidate) => [candidate.x, candidate.y, candidate.width, candidate.height]
            .every(Number.isFinite))
          .map((candidate) => ({
            id: `annotation:${candidate.id}`,
            x: candidate.x,
            y: candidate.y,
            width: candidate.width,
            height: candidate.height,
          })),
        editId: `annotation:${annotation.id}`,
        displayScale: scale,
        inkPadding: annotation.lineWidth || 0,
        inkPaddingPx: (annotation.lineWidth || 0) * scale,
        onDraftLayout: (layout) => {
          draftHeight = layout.requiredHeight;
        },
      },
      ariaLabel: i18next.t('textEditor.aria.editAnnotation', {
        ns: 'hardening',
        type: annotation.type,
      }),
    },
  });
  if (isNew) {
    ownerDocument.selectedAnnotations = [annotation];
    ownerDocument.selectedAnnotation = annotation;
  }
  if (getActiveDocument() === ownerDocument) showProperties(annotation);
  state.textEditElement = true;
  return true;
}

// Finish inline text editing (called externally, e.g. when switching tools)
export function finishTextEditing() {
  return applyActiveTextEditing();
}

export function applyActiveAnnotationTextStyle(key, value) {
  if (!state.isEditingText || !state.editingAnnotation) return false;
  const current = getPdfEditorRichText()?.lines?.[0]?.runs?.[0];
  switch (key) {
    case 'fontFamily':
      return applyPdfEditorRichTextFormat({
        faceId: resolvePackagedFace(value, current?.bold, current?.italic)?.id,
      });
    case 'fontSize':
    case 'textFontSize': return applyPdfEditorRichTextFormat({ size: Number(value) });
    case 'textColor':
    case 'color': return applyPdfEditorRichTextFormat({ color: value });
    case 'fontBold': return applyPdfEditorRichTextFormat({
      bold: Boolean(value),
      faceId: resolvePackagedFace(current?.faceId, value, current?.italic)?.id,
    });
    case 'fontItalic': return applyPdfEditorRichTextFormat({
      italic: Boolean(value),
      faceId: resolvePackagedFace(current?.faceId, current?.bold, value)?.id,
    });
    case 'fontUnderline': return applyPdfEditorRichTextFormat({ underline: Boolean(value) });
    case 'fontStrikethrough': return applyPdfEditorRichTextFormat({ strikeout: Boolean(value) });
    case 'textAlign': return applyPdfEditorRichTextParagraphFormat('alignment', value);
    case 'lineSpacing': return applyPdfEditorRichTextParagraphFormat(
      'lineSpacingMultiplier', Number(value),
    );
    default: return false;
  }
}

// Add comment/sticky note at position and open popup for editing
export function addComment(x, y) {
  const annotation = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
    type: 'comment',
    page: getActiveDocument()?.currentPage || 1,
    x: x,
    y: y,
    width: 24,
    height: 24,
    text: '',
    color: state.preferences.commentColor || '#FFFF00',
    fillColor: state.preferences.commentColor || '#FFFF00',
    icon: state.preferences.commentIcon || 'comment',
    author: state.defaultAuthor,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    locked: false,
    printable: true,
    popupOpen: true
  };

  const doc = getActiveDocument();
  if (doc) doc.annotations.push(annotation);
  recordAdd(annotation);

  if (doc?.viewMode === 'continuous') {
    redrawContinuous();
  } else {
    redrawAnnotations();
  }

  // Open popup immediately for text entry
  openStickyPopup(annotation);
}
