export const TEXT_EDIT_FOCUS_BOUNDARY_SELECTOR = [
  '[data-text-edit-focus-boundary="true"]',
  '.pdf-text-edit-portal',
  '.properties-panel-outer',
  // PrefComboBox/PrefSelect menus are portaled to document.body, so ancestry
  // alone cannot identify them as part of the properties-panel interaction.
  '.pref-combo-dropdown',
  // View-only controls must remain usable without ending or dirtying the
  // owner session. A page/status-content click still commits the draft.
  '#tab-view',
  '.status-viewmode-controls',
  '.status-zoom-controls',
  '.modal-overlay',
  '[role="dialog"][aria-modal="true"]',
].join(', ');

// These controls synchronously cancel the draft through the document lifecycle.
// Click-away must not race them and turn a mandated discard into an Apply.
export const TEXT_EDIT_LIFECYCLE_TRANSITION_SELECTOR = [
  '[data-text-edit-lifecycle-transition="true"]',
  '#ribbon-compare',
  '#organize-compare',
  '.window-btn-close',
  '#attachments-panel .attachments-toolbar-btn',
].join(', ');

export const TEXT_EDIT_COMMIT_ACTION_SELECTOR = '[data-text-edit-commit-action="true"]';

function targetMatchesSelectorAncestor(target, selector) {
  if (!target) return false;
  try {
    if (target.closest?.(selector)) return true;
  } catch { /* fall through to the namespace-safe ancestor walk */ }
  // WebKit can return null from SVGElement.closest() when the matching
  // ancestor is an HTML button. Walk parentElement explicitly so icon paths,
  // rects, and use elements inherit the control's text-edit semantics.
  let current = target;
  while (current) {
    try {
      if (current.matches?.(selector)) return true;
    } catch { /* ignore nodes that cannot evaluate the selector */ }
    current = current.parentElement || current.getRootNode?.()?.host || null;
  }
  return false;
}

/** Only a real document/compare-tab switch is a lifecycle cancellation. */
export function documentTabStartsTextEditLifecycle({
  tabIndex,
  activeDocumentIndex,
  compareIsFocused = false,
} = {}) {
  return Number.isInteger(tabIndex)
    && (compareIsFocused === true || tabIndex !== activeDocumentIndex);
}

export function textEditTargetIsWithinFocusBoundary(target, portal = null) {
  if (!target) return false;
  if (portal?.contains?.(target)) return true;
  return targetMatchesSelectorAncestor(target, TEXT_EDIT_FOCUS_BOUNDARY_SELECTOR);
}

export function textEditTargetStartsLifecycleTransition(target) {
  return targetMatchesSelectorAncestor(target, TEXT_EDIT_LIFECYCLE_TRANSITION_SELECTOR);
}

export function textEditTargetStartsCommitAction(target) {
  return targetMatchesSelectorAncestor(target, TEXT_EDIT_COMMIT_ACTION_SELECTOR);
}

/**
 * Reparenting an editor portal can transiently drop focus onto the document.
 * Restore it only in that case (or when it never left the portal). A later
 * explicit focus move to zoom, formatting, or another control must win.
 */
export function shouldRestoreTextEditorFocusAfterHostTransition({
  portal = null,
  activeElement = null,
  body = null,
  documentElement = null,
} = {}) {
  if (!portal) return false;
  return !activeElement
    || activeElement === body
    || activeElement === documentElement
    || portal.contains?.(activeElement) === true;
}

export function shouldApplyTextEditForOutsideFocus({
  target,
  portal = null,
  documentHasFocus = true,
  body = null,
  documentElement = null,
} = {}) {
  return Boolean(documentHasFocus
    && target
    && target !== body
    && target !== documentElement
    && !textEditTargetIsWithinFocusBoundary(target, portal)
    && !textEditTargetStartsCommitAction(target)
    && !textEditTargetStartsLifecycleTransition(target));
}

export function shouldConsumeOutsidePointerDownForTextEdit({
  target,
  portal = null,
  button = 0,
} = {}) {
  if (button !== 0
      || textEditTargetIsWithinFocusBoundary(target, portal)
      || textEditTargetStartsCommitAction(target)
      || textEditTargetStartsLifecycleTransition(target)) return false;
  return Boolean(target);
}

export function consumeOutsidePointerDownForTextEdit(event, portal = null) {
  if (!shouldConsumeOutsidePointerDownForTextEdit({
    target: event?.target,
    portal,
    button: event?.button,
  })) return false;
  // The initiating control must not deactivate or supersede the session while
  // its asynchronous exact-layout Apply is pending. The user's next click can
  // activate that control after the editor has closed.
  event.preventDefault?.();
  event.stopImmediatePropagation?.();
  return true;
}

export function shouldSuppressOutsideApplyFollowup({
  target,
  portal = null,
  button = 0,
  eventType = '',
  detail = 0,
  applyPending = false,
  consumedSessionId = null,
  activeSessionId = null,
} = {}) {
  const primary = button === 0 || (eventType === 'click' && button == null);
  if (!primary
      || textEditTargetIsWithinFocusBoundary(target, portal)
      || textEditTargetStartsCommitAction(target)
      || textEditTargetStartsLifecycleTransition(target)) return false;
  // Native compatibility mouse events carry a positive click count. Keyboard
  // activation and HTMLElement.click() use detail=0 and must not inherit a
  // consumed pointer gesture from an earlier Apply or editor session.
  const samePointerGesture = Number(detail) > 0
    && Boolean(consumedSessionId)
    && consumedSessionId === activeSessionId;
  return applyPending === true || samePointerGesture;
}
