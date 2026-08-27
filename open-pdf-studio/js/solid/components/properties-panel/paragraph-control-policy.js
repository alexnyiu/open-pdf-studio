/** Rotation is not an active text-edit operation until its draft router can
 * project, validate, and commit canonical owner-scoped geometry. */
export function paragraphRotationControlVisible({
  panelMode,
  scannedTextEstimate = false,
} = {}) {
  return panelMode !== 'textEdit' && scannedTextEstimate !== true;
}
