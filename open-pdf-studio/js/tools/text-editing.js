import { state, getActiveDocument } from '../core/state.js';
import { redrawAnnotations, redrawContinuous } from '../annotations/rendering.js';
import { hasFill } from '../annotations/fill-utils.js';
import { showProperties } from '../ui/panels/properties-panel.js';
import { recordAdd, recordModify } from '../core/undo-manager.js';
import { cloneAnnotation } from '../annotations/factory.js';
import { annotationCanvas } from '../ui/dom-elements.js';
import { viewport as vpState } from '../pdf/pdf-viewport.js';
import {
  showPdfTextEditor, hidePdfTextEditor,
  getPdfEditorText as getTextValue, getPdfEditorRichText,
  getPdfEditorFormatState,
  applyPdfEditorRichTextFormat,
  applyPdfEditorRichTextParagraphFormat,
  openStickyPopup,
} from '../bridge.js';
import {
  DEFAULT_TEXT_FORMAT_CAPABILITIES,
  richTextFromPlainText,
  richTextToPlainText,
} from '../text/rich-text.js';
import {
  proposeFontSubstitution,
  resolvePackagedFace,
} from '../text/font-catalog.js';

// Start inline text editing for textbox/callout
export function startTextEditing(annotation, { isNew = false } = {}) {
  // Idempotency guard: if already editing this same annotation, do nothing.
  // Without this, double-firing handlers (select-tool dblclick + dispatcher dblclick)
  // call finishTextEditing on a freshly-opened overlay, wiping the existing text.
  if (state.isEditingText && state.editingAnnotation === annotation) {
    return;
  }
  if (state.isEditingText) {
    finishTextEditing();
  }

  if (!['textbox', 'callout'].includes(annotation.type)) return;
  if (annotation.locked || annotation.readOnly) return;

  const sourceFamily = annotation.fontFamily || 'Arial';
  let substitution = annotation.richTextSubstitution || null;
  if (!annotation.richText && !/^liberation\s*(sans|serif|mono)/iu.test(sourceFamily)) {
    const face = resolvePackagedFace(sourceFamily, annotation.fontBold, annotation.fontItalic);
    if (!window.confirm(
      `This annotation uses an unsupported font (${sourceFamily}). `
      + `Editing requires the packaged substitute ${face.family}. Continue?`,
    )) return;
    substitution = {
      ...proposeFontSubstitution(sourceFamily, annotation.fontBold, annotation.fontItalic),
      approved: true,
      approvedAt: new Date().toISOString(),
    };
  }

  // In de doorlopende weergave is het enkelpagina-canvas 0x0 op de
  // vensteroorsprong; de overlay moet daar tegen het canvas van de PAGINA
  // van de annotatie gepositioneerd worden. Anders verschijnt de editor op
  // kale vensterco-ordinaten — als een leeg "spook-tekstvak" over het
  // linkerpaneel — terwijl de echte annotatie op de pagina staat.
  const _editDoc = getActiveDocument();
  const isContinuous = _editDoc?.viewMode === 'continuous';
  let canvas = null;
  if (isContinuous) {
    canvas = document.querySelector(
      `.page-wrapper[data-page="${annotation.page}"] .annotation-canvas`);
  }
  if (!canvas) canvas = annotationCanvas || document.getElementById('annotation-canvas');
  if (!canvas) return;

  state.isEditingText = true;
  state.editingAnnotation = annotation;
  state._textEditSnapshot = cloneAnnotation(annotation);
  state._textEditSubstitution = substitution;
  state._textEditIsNew = isNew;

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
  const doc = getActiveDocument();
  const useViewport = !isContinuous && vpState && vpState.active && doc?.filePath;
  const scale = useViewport ? vpState.zoom : (doc?.scale || 1.5);
  const offX = useViewport ? vpState.offsetX : 0;
  const offY = useViewport ? vpState.offsetY : 0;
  const width = annotation.width || 150;
  const height = annotation.height || 50;
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;

  // Calculate center position of the annotation
  const centerX = canvasRect.left + offX + (annotation.x + width / 2) * scale;
  const centerY = canvasRect.top + offY + (annotation.y + height / 2) * scale;

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
    position: 'fixed',
    left: `${centerX}px`,
    top: `${centerY}px`,
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
    transform: annotation.rotation
      ? `translate(-50%, -50%) rotate(${annotation.rotation}deg)`
      : 'translate(-50%, -50%)'
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

  // Commit function: update annotation and refresh display
  const commitFn = () => {
    if (!state.isEditingText || !state.editingAnnotation) return;

    const ann = state.editingAnnotation;
    const richDraft = getPdfEditorRichText() || richTextDocument;
    ann.richText = richDraft;
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
    if (state._textEditIsNew) {
      recordAdd(ann);
    } else if (state._textEditSnapshot && ann.id) {
      recordModify(ann.id, state._textEditSnapshot, ann);
    }

    state.isEditingText = false;
    state.editingAnnotation = null;
    state.textEditElement = null;
    state._textEditSnapshot = null;
    state._textEditSubstitution = null;
    state._textEditIsNew = false;

    if (getActiveDocument()?.viewMode === 'continuous') {
      redrawContinuous();
    } else {
      redrawAnnotations();
    }

    const _doc = getActiveDocument();
    if (_doc && _doc.selectedAnnotation === ann) {
      showProperties(ann);
    }
  };

  // Cancel function: restore original text, reset state, refresh display
  const cancelFn = () => {
    if (!state.isEditingText || !state.editingAnnotation) return;

    const ann = state.editingAnnotation;
    const snapshot = state._textEditSnapshot;
    const wasNew = state._textEditIsNew;
    const owner = getActiveDocument();
    if (wasNew) {
      const index = owner?.annotations?.findIndex((item) => item.id === ann.id) ?? -1;
      if (index >= 0) owner.annotations.splice(index, 1);
      if (owner) {
        owner.selectedAnnotations = owner.selectedAnnotations.filter((item) => item.id !== ann.id);
        if (owner.selectedAnnotation?.id === ann.id) owner.selectedAnnotation = null;
      }
    } else if (snapshot) {
      for (const key of Object.keys(ann)) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete ann[key];
      }
      Object.assign(ann, cloneAnnotation(snapshot));
    }

    state.isEditingText = false;
    state.editingAnnotation = null;
    state.textEditElement = null;
    state._textEditSnapshot = null;
    state._textEditSubstitution = null;
    state._textEditIsNew = false;

    if (getActiveDocument()?.viewMode === 'continuous') {
      redrawContinuous();
    } else {
      redrawAnnotations();
    }

    const _doc = getActiveDocument();
    if (_doc && _doc.selectedAnnotation === ann) {
      showProperties(ann);
    }
  };

  const keyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelFn();
      hidePdfTextEditor();
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
      commitFn(getTextValue());
      hidePdfTextEditor();
    }
  };
  const blur = () => setTimeout(() => {
    const activeElement = document.activeElement;
    const propertiesRoot = document.getElementById('properties-panel-root');
    if (activeElement && propertiesRoot?.contains(activeElement)) return;
    if (state.isEditingText && state.editingAnnotation === annotation) {
      commitFn();
      hidePdfTextEditor();
    }
  }, 150);
  showPdfTextEditor(styleObj, initialText, {
    onKeyDown: keyDown,
    onBlur: blur,
    options: {
      richTextDocument,
      capabilities: DEFAULT_TEXT_FORMAT_CAPABILITIES,
      displayScale: scale,
      reflowWidth: true,
      growDown: true,
      onHeightChange: (displayHeight) => {
        const appHeight = Math.max(10, displayHeight / scale);
        annotation.height = appHeight;
        const draft = getPdfEditorRichText();
        if (draft?.region) draft.region.height = appHeight;
      },
      ariaLabel: `Edit formatted ${annotation.type} text`,
    },
  });
  state.textEditElement = true;
}

// Finish inline text editing (called externally, e.g. when switching tools)
export function finishTextEditing() {
  if (!state.isEditingText || !state.editingAnnotation) return;

  const annotation = state.editingAnnotation;

  // Get the current text value from the Solid store
  const richDraft = getPdfEditorRichText();
  if (richDraft) {
    annotation.richText = richDraft;
    annotation.richTextSubstitution = state._textEditSubstitution || null;
    annotation.text = richTextToPlainText(richDraft);
    annotation.textFormatCapabilities = DEFAULT_TEXT_FORMAT_CAPABILITIES;
    const primary = richDraft.lines[0]?.runs[0];
    if (primary) {
      annotation.fontFamily = primary.faceId.includes('mono') ? 'Liberation Mono'
        : primary.faceId.includes('serif') ? 'Liberation Serif' : 'Liberation Sans';
      annotation.fontSize = primary.size;
      annotation.textColor = primary.color;
      annotation.fontBold = primary.bold;
      annotation.fontItalic = primary.italic;
      annotation.fontUnderline = primary.underline;
      annotation.fontStrikethrough = primary.strikeout;
    }
    annotation.textAlign = richDraft.lines[0]?.alignment || annotation.textAlign || 'left';
  } else {
    annotation.text = getTextValue();
  }
  annotation.modifiedAt = new Date().toISOString();

  if (state._textEditIsNew) {
    recordAdd(annotation);
  } else if (state._textEditSnapshot && annotation.id) {
    recordModify(annotation.id, state._textEditSnapshot, annotation);
  }

  hidePdfTextEditor();

  // Reset state
  state.isEditingText = false;
  state.editingAnnotation = null;
  state.textEditElement = null;
  state._textEditSnapshot = null;
  state._textEditSubstitution = null;
  state._textEditIsNew = false;

  // Refresh display
  if (getActiveDocument()?.viewMode === 'continuous') {
    redrawContinuous();
  } else {
    redrawAnnotations();
  }

  // Update properties panel
  const _doc2 = getActiveDocument();
  if (_doc2 && _doc2.selectedAnnotation === annotation) {
    showProperties(annotation);
  }
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
    case 'lineSpacing': {
      const size = current?.size || 14;
      return applyPdfEditorRichTextParagraphFormat('baselineAdvance', Number(value) * size);
    }
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
