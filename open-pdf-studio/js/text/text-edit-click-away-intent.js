const SAFE_ACTION_SELECTOR = [
  'button',
  '[role="button"]',
  '[role="menuitem"]',
  'input[type="button"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
].join(', ');

const FOCUS_TARGET_SELECTOR = [
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[tabindex]',
].join(', ');

const DESTRUCTIVE_SELECTOR = [
  '[data-destructive="true"]',
  '[data-danger="true"]',
  '[data-text-edit-replay="never"]',
  '.danger',
  '.destructive',
].join(', ');

const DESTRUCTIVE_LABEL = /\b(delete|discard|remove|erase|reset|clear|close)\b/iu;

function closestAcrossNamespaces(target, selector) {
  if (!target) return null;
  try {
    const match = target.closest?.(selector);
    if (match) return match;
  } catch { /* fall through to the namespace-safe walk */ }
  let current = target;
  while (current) {
    try {
      if (current.matches?.(selector)) return current;
    } catch { /* ignore nodes that cannot evaluate the selector */ }
    current = current.parentElement || current.getRootNode?.()?.host || null;
  }
  return null;
}

function destructiveControl(control) {
  if (!control) return false;
  if (closestAcrossNamespaces(control, DESTRUCTIVE_SELECTOR)) return true;
  const label = [
    control.getAttribute?.('aria-label'),
    control.getAttribute?.('title'),
    control.getAttribute?.('name'),
    control.value,
    control.textContent,
  ].filter(Boolean).join(' ');
  return DESTRUCTIVE_LABEL.test(label);
}

function pageNumberForTarget(target, textLayer) {
  const pageOwner = textLayer || closestAcrossNamespaces(
    target,
    '.page-wrapper[data-page], .canvas-container-cont[data-page]',
  );
  const pageNum = Number(pageOwner?.dataset?.page);
  return Number.isInteger(pageNum) && pageNum > 0 ? pageNum : null;
}

function targetBelongsToIntent(intent, target) {
  if (!intent || !target) return false;
  const boundary = intent.actionTarget || intent.textLayer || intent.target;
  return boundary === target || boundary?.contains?.(target) === true;
}

function controlStillValid(control) {
  return Boolean(control
    && control.isConnected !== false
    && control.disabled !== true
    && control.getAttribute?.('aria-disabled') !== 'true');
}

/** Capture the intended action and pointer coordinates before Apply consumes the gesture. */
export function captureTextEditClickAwayIntent({ event, session } = {}) {
  const target = event?.target || null;
  if (!target || !session?.sessionId) return null;
  const textLayer = closestAcrossNamespaces(target, '.textLayer');
  const textSpan = textLayer ? closestAcrossNamespaces(target, 'span') : null;
  const actionTarget = textLayer ? null : closestAcrossNamespaces(target, SAFE_ACTION_SELECTOR);
  const focusTarget = actionTarget || (textLayer
    ? null : closestAcrossNamespaces(target, FOCUS_TARGET_SELECTOR));
  const kind = textLayer ? 'text-edit' : actionTarget ? 'action' : focusTarget ? 'focus' : 'none';
  return {
    sessionId: session.sessionId,
    documentId: String(session.ownerDocumentId || ''),
    documentGeneration: Number(session.ownerDocumentGeneration) || 0,
    pointerId: Number.isFinite(event.pointerId) ? event.pointerId : null,
    clientX: Number(event.clientX) || 0,
    clientY: Number(event.clientY) || 0,
    pageNum: pageNumberForTarget(target, textLayer),
    preferredEditId: textSpan?.dataset?.editId || '',
    preferredMarkerIds: textSpan?.dataset?.nativeTextMarkerIds || '',
    preferredOcrLineId: textSpan?.dataset?.ocrLineId || '',
    kind,
    target,
    textLayer,
    actionTarget,
    focusTarget,
    destructive: destructiveControl(actionTarget),
    browserDelivered: false,
    compatibilityClickConsumed: false,
    replayed: false,
    replaying: false,
  };
}

/** Record an unconsumed browser activation so replay cannot activate it twice. */
export function markTextEditClickAwayIntentDelivered(intent) {
  if (!intent) return false;
  intent.browserDelivered = true;
  return true;
}

/**
 * Keep the consumed pointer gesture owned after the editor portal unmounts.
 * Replay waits for pointerup/click settlement, so a fast commit cannot race a
 * later browser compatibility click and activate the target twice.
 */
export function guardTextEditClickAwayGesture(
  intent,
  eventRoot = globalThis.document,
  { setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  let settled = false;
  let settleTimer = null;
  let resolveSettled;
  const settledPromise = new Promise((resolve) => { resolveSettled = resolve; });
  const remove = () => {
    eventRoot?.removeEventListener?.('mousedown', consumeCompatibilityMouse, true);
    eventRoot?.removeEventListener?.('click', consumeCompatibilityMouse, true);
    eventRoot?.removeEventListener?.('pointerup', settlePointer, true);
    eventRoot?.removeEventListener?.('pointercancel', settlePointer, true);
    if (settleTimer) clearTimer(settleTimer);
    settleTimer = null;
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    remove();
    resolveSettled(true);
  };
  function matchingPointer(event) {
    return intent?.pointerId == null
      || event?.pointerId == null
      || Number(event.pointerId) === Number(intent.pointerId);
  }
  function consumeCompatibilityMouse(event) {
    if (intent?.replaying || Number(event?.detail) <= 0
        || !targetBelongsToIntent(intent, event?.target)) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    if (event.type === 'click') {
      intent.compatibilityClickConsumed = true;
      finish();
    }
  }
  function settlePointer(event) {
    if (!matchingPointer(event)) return;
    if (event?.type === 'pointercancel') {
      finish();
      return;
    }
    // A native click follows pointerup before the next timer task. The timer
    // covers drags and controls for which the browser emits no click.
    if (!settleTimer) settleTimer = setTimer(finish, 0);
  }
  eventRoot?.addEventListener?.('mousedown', consumeCompatibilityMouse, true);
  eventRoot?.addEventListener?.('click', consumeCompatibilityMouse, true);
  eventRoot?.addEventListener?.('pointerup', settlePointer, true);
  eventRoot?.addEventListener?.('pointercancel', settlePointer, true);
  return Object.freeze({
    settled: settledPromise,
    dispose: finish,
  });
}

/** Replay one safe captured action only after the editor commit succeeds. */
export async function replayTextEditClickAwayIntent(intent, {
  commitSucceeded = false,
  ownerIsCurrent = () => true,
  beginTextEdit = async () => false,
  indicateUnsafe = () => {},
} = {}) {
  if (!intent || commitSucceeded !== true) return 'commit-failed';
  if (intent.replayed) return 'already-replayed';
  if (intent.browserDelivered) return 'browser-delivered';
  if (!ownerIsCurrent(intent)) return 'stale-owner';
  if (intent.destructive) {
    indicateUnsafe(intent);
    return 'unsafe-requires-second-click';
  }
  if (intent.kind === 'text-edit') {
    if (!Number.isInteger(intent.pageNum)) return 'invalid-target';
    intent.replayed = true;
    await beginTextEdit(intent);
    return 'text-edit-replayed';
  }
  const target = intent.actionTarget || intent.focusTarget;
  if (!controlStillValid(target)) return 'invalid-target';
  intent.replaying = true;
  try {
    target.focus?.({ preventScroll: true });
    if (intent.kind === 'action') target.click?.();
    intent.replayed = true;
  } finally {
    intent.replaying = false;
  }
  return intent.kind === 'action' ? 'action-replayed' : 'focus-replayed';
}
