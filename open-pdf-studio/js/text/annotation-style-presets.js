/** Appearance fields that may be copied into a named style preset. */
export const ANNOTATION_STYLE_PRESET_KEYS = Object.freeze([
  'fillColor', 'strokeColor', 'color', 'opacity', 'lineWidth',
  'borderStyle', 'startHead', 'endHead', 'headSize',
]);

const STROKE_COLOR_DRIVEN_TYPES = new Set([
  'parametricSymbol', 'polyline', 'cloudPolyline', 'spline', 'draw',
]);

const LINE_HEAD_TYPES = new Set(['arrow', 'line', 'polyline', 'measureDistance']);
const TEXT_ANNOTATION_TYPES = new Set(['textbox', 'callout']);

/**
 * Resolve the transient textbox/callout draft only when its immutable session
 * still belongs to the active document generation. The persisted annotation
 * may remain selected while this detached draft is open, so callers must check
 * this target before consulting `selectedAnnotations`.
 */
export function resolveAnnotationStyleActionTarget({
  activeDocument,
  editorState,
  activeSession,
  sessionOwnerIsCurrent = false,
} = {}) {
  const draft = editorState?.editingAnnotation;
  const generation = Number(activeDocument?.lifecycleGeneration) || 0;
  const sessionGeneration = Number(activeSession?.ownerDocumentGeneration) || 0;
  const hasTextDraftState = Boolean(
    editorState?.isEditingText === true
      && draft
      && TEXT_ANNOTATION_TYPES.has(draft.type),
  );
  const ownsActiveDocument = Boolean(
    activeDocument
      && hasTextDraftState
      && activeSession
      && sessionOwnerIsCurrent === true
      && activeSession.ownerDocumentId === activeDocument.id
      && sessionGeneration === generation
      && activeSession.kind === draft.type
      && (!Number.isInteger(draft.page) || activeSession.pageNum === draft.page),
  );

  if (ownsActiveDocument) {
    return Object.freeze({ mode: 'text-draft', annotation: draft });
  }
  // Never fall through to the persisted selected source while editor state is
  // present but its owner/session identity is stale. Lifecycle teardown owns
  // cancellation; style actions fail closed until that synchronous cleanup.
  if (hasTextDraftState) {
    return Object.freeze({ mode: 'stale-text-draft', annotation: null });
  }

  const selected = Array.isArray(activeDocument?.selectedAnnotations)
    ? activeDocument.selectedAnnotations
    : [];
  const annotation = selected[0] || activeDocument?.selectedAnnotation || null;
  return annotation
    ? Object.freeze({ mode: 'selection', annotation })
    : Object.freeze({ mode: 'none', annotation: null });
}

export function captureAnnotationStyle(annotation) {
  if (!annotation) return null;
  const props = {};
  // null means an explicit transparent fill and must survive capture.
  if ('fillColor' in annotation) props.fillColor = annotation.fillColor ?? null;
  if (annotation.strokeColor !== undefined) props.strokeColor = annotation.strokeColor;
  if (annotation.color !== undefined) props.color = annotation.color;
  if (annotation.opacity !== undefined) props.opacity = Math.round(annotation.opacity * 100);
  if (annotation.lineWidth !== undefined) props.lineWidth = parseFloat(annotation.lineWidth);
  if (annotation.borderStyle !== undefined) props.borderStyle = annotation.borderStyle;
  if (annotation.startHead !== undefined) props.startHead = annotation.startHead;
  if (annotation.endHead !== undefined) props.endHead = annotation.endHead;
  if (annotation.headSize !== undefined) props.headSize = annotation.headSize;
  return props;
}

function appearanceFingerprint(annotation) {
  return JSON.stringify({
    fillColor: annotation?.fillColor,
    strokeColor: annotation?.strokeColor,
    color: annotation?.color,
    opacity: annotation?.opacity,
    lineWidth: annotation?.lineWidth,
    borderStyle: annotation?.borderStyle,
    startHead: annotation?.startHead,
    endHead: annotation?.endHead,
    headSize: annotation?.headSize,
  });
}

/** Apply normalized preset fields and report whether the annotation changed. */
export function applyAnnotationStyle(annotation, props) {
  if (!annotation || !props) return false;
  const before = appearanceFingerprint(annotation);

  if (props.color !== undefined) {
    annotation.color = props.color;
    if (STROKE_COLOR_DRIVEN_TYPES.has(annotation.type)) annotation.strokeColor = props.color;
  }
  if (props.strokeColor !== undefined) {
    annotation.strokeColor = props.strokeColor;
    if (annotation.type === 'parametricSymbol') annotation.color = props.strokeColor;
  }
  if (props.fillColor !== undefined && 'fillColor' in annotation) {
    annotation.fillColor = props.fillColor;
  }
  if (props.opacity !== undefined) {
    const opacity = Math.max(0, Math.min(100, parseInt(props.opacity)));
    if (!Number.isNaN(opacity)) annotation.opacity = opacity / 100;
  }
  if (props.lineWidth !== undefined) {
    const lineWidth = parseFloat(props.lineWidth);
    if (!Number.isNaN(lineWidth)) annotation.lineWidth = lineWidth;
  }
  if (props.borderStyle !== undefined) annotation.borderStyle = props.borderStyle;

  const takesHeads = LINE_HEAD_TYPES.has(annotation.type)
    || annotation.startHead !== undefined || annotation.endHead !== undefined;
  if (takesHeads) {
    if (props.startHead !== undefined) annotation.startHead = props.startHead;
    if (props.endHead !== undefined) annotation.endHead = props.endHead;
    if (props.headSize !== undefined) annotation.headSize = props.headSize;
  }

  return appearanceFingerprint(annotation) !== before;
}
