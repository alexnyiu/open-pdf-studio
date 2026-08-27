/**
 * Existing annotations edit an isolated clone; new annotations are already
 * detached drafts created by the drawing tool and retain their identity.
 */
export function isolateTextAnnotationDraft(annotation, {
  isNew = false,
  clone = (value) => structuredClone(value),
} = {}) {
  if (!annotation) return null;
  return isNew ? annotation : clone(annotation);
}

/**
 * True only while `annotation` is the detached textbox/callout draft owned by
 * the active inline editor. Mutations in this state belong to the editor's
 * single Apply/Cancel transaction and must not create standalone undo work.
 */
export function isActiveTextAnnotationDraft(annotation, editingState = {}) {
  return Boolean(
    editingState.isEditingText
      && editingState.editingAnnotation === annotation
      && ['textbox', 'callout'].includes(annotation?.type),
  );
}

/** Resolve the immutable-session draft even if a selection refresh has made
 * the properties panel point at the persisted source annotation again. */
export function activeTextAnnotationDraft(editingState = {}) {
  const draft = editingState.editingAnnotation;
  return isActiveTextAnnotationDraft(draft, editingState) ? draft : null;
}

/** Record ordinary annotation changes immediately, but leave active text-draft
 * changes for the editor's one owner-scoped Apply command. */
export function recordAnnotationMutationOutsideTextDraft({
  annotation,
  before,
  editingState = {},
  record,
} = {}) {
  if (!annotation || typeof record !== 'function') return false;
  if (isActiveTextAnnotationDraft(annotation, editingState)) return false;
  record(annotation.id, before, annotation);
  return true;
}

/** Exact-layout normalization alone never creates an existing-document edit. */
export function cleanTextAnnotationApplyIsNoop({ isNew = false, isDirty = false } = {}) {
  return isNew !== true && isDirty !== true;
}

function restoreAnnotation(target, snapshot, clone) {
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete target[key];
  }
  Object.assign(target, clone(snapshot));
}

/**
 * Publish one isolated existing-annotation draft while preserving the source
 * object's identity used by selection/rendering. Recording happens after the
 * visible source is updated; a rejected recorder rolls the source back.
 */
export function applyExistingTextAnnotationDraft({
  annotation,
  draft,
  clone = (value) => structuredClone(value),
  record,
} = {}) {
  if (!annotation || !draft || annotation === draft || typeof record !== 'function') return false;
  const oldState = clone(annotation);
  const newState = clone(draft);
  restoreAnnotation(annotation, newState, clone);
  try {
    if (record({ oldState, newState }) === true) return true;
  } catch {
    // Roll back below so a failed undo recorder cannot leak an untracked edit.
  }
  restoreAnnotation(annotation, oldState, clone);
  return false;
}

/**
 * Attach a new textbox/callout draft to its immutable owner exactly once.
 *
 * The draft stays outside `ownerDocument.annotations` while the editor is
 * open. `beforeAttach` is intentionally run while it is still detached so
 * debounced property bookkeeping cannot mistake draft-only changes for a
 * separate document mutation. `record` runs only after the annotation is
 * present, matching the undo manager's add-command contract.
 */
export function applyTextAnnotationDraft({
  ownerDocument,
  annotation,
  beforeAttach = null,
  record,
} = {}) {
  if (!ownerDocument || !annotation || !Array.isArray(ownerDocument.annotations)) return false;
  if (typeof record !== 'function') return false;

  const duplicate = ownerDocument.annotations.some((candidate) =>
    candidate === annotation
    || (annotation.id != null && candidate?.id != null
      && String(candidate.id) === String(annotation.id)));
  if (duplicate) return false;

  try {
    beforeAttach?.();
  } catch {
    return false;
  }

  ownerDocument.annotations.push(annotation);
  try {
    if (record(annotation) === true) return true;
  } catch {
    // Roll back below. A failed recorder must never leave an untracked edit.
  }

  const attachedIndex = ownerDocument.annotations.indexOf(annotation);
  if (attachedIndex >= 0) ownerDocument.annotations.splice(attachedIndex, 1);
  return false;
}

/** Remove a not-yet-applied draft reference without touching same-id content. */
export function discardTextAnnotationDraft(ownerDocument, annotation) {
  if (!ownerDocument || !annotation) return false;
  let removed = false;
  const index = ownerDocument.annotations?.indexOf(annotation) ?? -1;
  if (index >= 0) {
    ownerDocument.annotations.splice(index, 1);
    removed = true;
  }

  if (Array.isArray(ownerDocument.selectedAnnotations)) {
    ownerDocument.selectedAnnotations = ownerDocument.selectedAnnotations
      .filter((candidate) => candidate !== annotation);
  }
  if (ownerDocument.selectedAnnotation === annotation) {
    ownerDocument.selectedAnnotation = ownerDocument.selectedAnnotations?.[0] || null;
  }
  return removed;
}
