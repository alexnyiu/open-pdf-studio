/** Resolve the one visible inline-editor status without allowing lower-priority
 * preview notices to overwrite ownership, validity, or shaping state. */
export function resolveEditorStatus({
  editorStatus = '',
  statusKind = null,
  layoutState = null,
  pathologicalStatus = '',
  previewOverflow = false,
  overflowStatus = '',
  defaultStatus = '',
} = {}) {
  const layout = layoutState || {};
  const statuses = layout.statuses || {};
  if (statusKind === 'stale-owner' && editorStatus) return editorStatus;

  const boundaryInvalid = !layout.pending && (statuses.pageOrColumn || statuses.layout);
  const exactInvalid = !layout.pending && layout.valid === false;
  if (boundaryInvalid || exactInvalid) {
    return layout.message || boundaryInvalid || statuses.overflow || editorStatus || defaultStatus;
  }
  if (statusKind === 'invalid' && editorStatus) return editorStatus;

  if (layout.pending) return layout.message || statuses.shaping || editorStatus || defaultStatus;
  if (statusKind === 'shaping' && editorStatus) return editorStatus;

  if (pathologicalStatus) return pathologicalStatus;
  if (previewOverflow && overflowStatus) return overflowStatus;

  const information = [statuses.overlap, statuses.contrast].filter(Boolean).join(' ');
  return information || editorStatus || defaultStatus;
}
