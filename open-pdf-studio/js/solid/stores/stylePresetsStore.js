import { createSignal } from 'solid-js';
import { getActiveDocument, state } from '../../core/state.js';
import { applyToSelected } from './formatStore.js';
import { annotProps, storeShowProperties, updateAnnotProp } from './propertiesStore.js';
import {
  getActiveTextEditSession,
  textEditSessionOwnerIsCurrent,
} from '../../text/text-edit-session.js';
import {
  ANNOTATION_STYLE_PRESET_KEYS,
  applyAnnotationStyle,
  captureAnnotationStyle,
  resolveAnnotationStyleActionTarget,
} from '../../text/annotation-style-presets.js';
import { noteDocumentMutation } from '../../core/document-revision-state.runtime.js';

/**
 * Named line-style presets (WEERGAVE-stijlen).
 *
 * A preset captures the appearance props of the Eigenschappen-paneel
 * WEERGAVE-sectie (fill/stroke colour, opacity, line width, border style,
 * plus line endings when present) under a user-chosen name.
 *
 * Presets are DOCUMENT-level data: they live on the DocumentState
 * (`doc.stylePresets`) and are persisted inside the PDF itself via the
 * catalog entry `OPS_StylePresets` (see js/pdf/saver/style-presets.js),
 * so they travel with the document.
 *
 * Applying a preset goes through the existing edit paths so undo works:
 *  - with a selection: formatStore.applyToSelected (single undo step,
 *    same path as the ribbon style gallery);
 *  - in tool-defaults mode: propertiesStore.updateAnnotProp per key
 *    (routes into preferences, like every other panel control).
 */

// Keys a preset may carry. Anything else in a loaded preset is ignored.
export const STYLE_PRESET_KEYS = ANNOTATION_STYLE_PRESET_KEYS;

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function _captureFromPanel() {
  // Tool-defaults mode (or no selection): capture the panel values.
  const props = {};
  const p = annotProps;
  if (p.fillColor !== 'mixed') props.fillColor = p.fillColor ?? null;
  if (p.strokeColor && p.strokeColor !== 'mixed') props.strokeColor = p.strokeColor;
  if (p.color && p.color !== 'mixed') props.color = p.color;
  if (p.opacity !== 'mixed' && p.opacity !== undefined) props.opacity = parseInt(p.opacity);
  if (p.lineWidth !== 'mixed' && p.lineWidth !== undefined) props.lineWidth = parseFloat(p.lineWidth);
  if (p.borderStyle && p.borderStyle !== 'mixed') props.borderStyle = p.borderStyle;
  return props;
}

function _currentStyleActionTarget(doc = getActiveDocument()) {
  const session = getActiveTextEditSession();
  return resolveAnnotationStyleActionTarget({
    activeDocument: doc,
    editorState: state,
    activeSession: session,
    sessionOwnerIsCurrent: textEditSessionOwnerIsCurrent(session),
  });
}

/**
 * Capture the current appearance as a plain props object, from the first
 * selected annotation, or from the panel values when nothing is selected
 * (tool-defaults mode). Returns null when there is nothing to capture.
 */
export function captureCurrentStyle() {
  const doc = getActiveDocument();
  const target = _currentStyleActionTarget(doc);
  if (target.mode === 'stale-text-draft') return null;
  const props = target.annotation
    ? captureAnnotationStyle(target.annotation)
    : _captureFromPanel();
  // Drop 'mixed' leftovers defensively.
  for (const k of Object.keys(props)) {
    if (props[k] === 'mixed') delete props[k];
    if (!STYLE_PRESET_KEYS.includes(k)) delete props[k];
  }
  return Object.keys(props).length > 0 ? props : null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply a style-props object to the current selection (single undo step via
 * formatStore.applyToSelected). Without a selection, routes through
 * updateAnnotProp so tool-defaults mode keeps working.
 */
export function applyStyleToSelection(props) {
  if (!props) return;
  const doc = getActiveDocument();
  const target = _currentStyleActionTarget(doc);
  if (target.mode === 'stale-text-draft') return;
  if (target.mode === 'text-draft') {
    const draft = target.annotation;
    if (draft.locked) return;
    if (applyAnnotationStyle(draft, props)) {
      draft.modifiedAt = new Date().toISOString();
      // Refresh the copied panel values without recording an annotation
      // mutation. The draft remains detached until the editor's Apply action.
      storeShowProperties(draft);
    }
    return;
  }
  const sel = doc ? doc.selectedAnnotations : [];
  if (sel && sel.length > 0) {
    applyToSelected((ann) => applyAnnotationStyle(ann, props));
    return;
  }
  // Tool-defaults mode: the panel shows a synthetic annotation; updateAnnotProp
  // routes each write into state.preferences.
  if (annotProps.id === '__tool-defaults__') {
    if (props.color !== undefined) updateAnnotProp('color', props.color);
    if (props.strokeColor !== undefined) updateAnnotProp('strokeColor', props.strokeColor);
    if (props.fillColor !== undefined) updateAnnotProp('fillColor', props.fillColor);
    if (props.opacity !== undefined) updateAnnotProp('opacity', props.opacity);
    if (props.lineWidth !== undefined) updateAnnotProp('lineWidth', props.lineWidth);
    if (props.borderStyle !== undefined) updateAnnotProp('borderStyle', props.borderStyle);
    if (props.startHead !== undefined) updateAnnotProp('startHead', props.startHead);
    if (props.endHead !== undefined) updateAnnotProp('endHead', props.endHead);
    if (props.headSize !== undefined) updateAnnotProp('headSize', props.headSize);
  }
}

// ---------------------------------------------------------------------------
// Preset CRUD (document-level, persisted in the PDF on save)
// ---------------------------------------------------------------------------

function _newId() {
  return 'sp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Presets of the active document (reactive: state is createMutable). */
export function getStylePresets() {
  const doc = getActiveDocument();
  return (doc && Array.isArray(doc.stylePresets)) ? doc.stylePresets : [];
}

/**
 * Create a named preset from the current appearance. Returns the preset,
 * or null when there is no document / nothing to capture / empty name.
 */
export function createStylePreset(name) {
  const doc = getActiveDocument();
  if (!doc) return null;
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const props = captureCurrentStyle();
  if (!props) return null;
  const preset = { id: _newId(), name: trimmed, props };
  doc.stylePresets = [...(doc.stylePresets || []), preset];
  noteDocumentMutation(doc, { reason: 'style-preset:create' });
  return preset;
}

export function deleteStylePreset(id) {
  const doc = getActiveDocument();
  if (!doc || !Array.isArray(doc.stylePresets)) return;
  const next = doc.stylePresets.filter(p => p.id !== id);
  if (next.length !== doc.stylePresets.length) {
    doc.stylePresets = next;
    noteDocumentMutation(doc, { reason: 'style-preset:delete' });
  }
}

export function renameStylePreset(id, name) {
  const doc = getActiveDocument();
  if (!doc || !Array.isArray(doc.stylePresets)) return;
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  doc.stylePresets = doc.stylePresets.map(p =>
    p.id === id ? { ...p, name: trimmed } : p
  );
  noteDocumentMutation(doc, { reason: 'style-preset:rename' });
}

/** Apply a stored preset (by id) to the current selection. */
export function applyStylePresetById(id) {
  const preset = getStylePresets().find(p => p.id === id);
  if (preset) applyStyleToSelection(preset.props);
}

// ---------------------------------------------------------------------------
// Copy / paste style (app-level clipboard, works across documents)
// ---------------------------------------------------------------------------

const [copiedStyle, setCopiedStyle] = createSignal(null);
export { copiedStyle };

export function copyStyleFromSelection() {
  const props = captureCurrentStyle();
  if (props) setCopiedStyle(props);
  return props;
}

export function pasteStyleToSelection() {
  const props = copiedStyle();
  if (props) applyStyleToSelection(props);
}
