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
  return Boolean(target.closest?.(TEXT_EDIT_FOCUS_BOUNDARY_SELECTOR));
}

export function textEditTargetStartsLifecycleTransition(target) {
  return Boolean(target?.closest?.(TEXT_EDIT_LIFECYCLE_TRANSITION_SELECTOR));
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
    && !textEditTargetStartsLifecycleTransition(target));
}

export function shouldConsumeOutsidePointerDownForTextEdit({
  target,
  portal = null,
  button = 0,
} = {}) {
  if (button !== 0
      || textEditTargetIsWithinFocusBoundary(target, portal)
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
      || textEditTargetStartsLifecycleTransition(target)) return false;
  // Native compatibility mouse events carry a positive click count. Keyboard
  // activation and HTMLElement.click() use detail=0 and must not inherit a
  // consumed pointer gesture from an earlier Apply or editor session.
  const samePointerGesture = Number(detail) > 0
    && Boolean(consumedSessionId)
    && consumedSessionId === activeSessionId;
  return applyPending === true || samePointerGesture;
}
