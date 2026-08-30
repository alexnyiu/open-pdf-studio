import {
  createTextEditTargetIdentity,
  sameTextEditTarget,
} from './text-edit-target-identity.js';
import { textApplyResultCompletesInteraction } from './text-apply-result.js';

const SAFE_ACTION_SELECTOR = [
  'button',
  '[role="button"]',
  '[role="menuitem"]',
  'input[type="button"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[data-text-edit-command]',
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
const COMMAND_TYPES = new Set(['set-tool', 'toggle-option', 'open-panel', 'activate-control']);
const REPLAY_STATUSES = new Set([
  'not-needed', 'replayed', 'not-opened', 'unsafe', 'stale', 'failed',
]);

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

function controlLocator(control) {
  const controlId = String(control?.id || control?.getAttribute?.('id') || '').trim();
  if (controlId) return { controlId, inputType: null, inputName: null, inputValue: null };
  const inputType = String(control?.type || control?.getAttribute?.('type') || '').toLowerCase();
  const inputName = String(control?.name || control?.getAttribute?.('name') || '').trim();
  const inputValue = String(control?.value ?? control?.getAttribute?.('value') ?? '');
  if (['checkbox', 'radio'].includes(inputType) && inputName) {
    return { controlId: null, inputType, inputName, inputValue };
  }
  return null;
}

function frozenCommand(value) {
  return value ? Object.freeze(value) : null;
}

/** Capture a stable command instead of retaining behavior in a replaceable DOM node. */
export function captureTextEditSemanticCommand(control) {
  if (!control) return null;
  const declaredType = String(control.dataset?.textEditCommand || '').trim();
  if (declaredType) {
    if (!COMMAND_TYPES.has(declaredType)) return null;
    if (declaredType === 'set-tool') {
      const tool = String(control.dataset?.textEditTool || '').trim();
      return tool ? frozenCommand({ type: declaredType, tool }) : null;
    }
    if (declaredType === 'open-panel') {
      const panel = String(control.dataset?.textEditPanel || '').trim();
      return panel ? frozenCommand({ type: declaredType, panel, ...controlLocator(control) }) : null;
    }
    if (declaredType === 'toggle-option') {
      const option = String(control.dataset?.textEditOption || '').trim();
      if (option) return frozenCommand({
        type: declaredType,
        option,
        nextValue: control.dataset?.textEditNextValue ?? null,
        ...controlLocator(control),
      });
    }
  }
  const locator = controlLocator(control);
  const inputType = String(control.type || control.getAttribute?.('type') || '').toLowerCase();
  if (['checkbox', 'radio'].includes(inputType) && locator) {
    return frozenCommand({
      type: 'toggle-option',
      ...locator,
      nextChecked: inputType === 'radio' ? true : control.checked !== true,
    });
  }
  if (locator && (control.matches?.('button, [role="button"], [role="menuitem"], input[type="button"]')
      || control.dataset?.textEditReplay === 'simple')) {
    return frozenCommand({ type: 'activate-control', ...locator });
  }
  return null;
}

function resolveCommandControl(command, documentRoot, fallbackTarget = null) {
  let control = null;
  if (command?.controlId) control = documentRoot?.getElementById?.(command.controlId) || null;
  if (!control && command?.inputName) {
    const candidates = documentRoot?.querySelectorAll?.('input') || [];
    control = [...candidates].find((candidate) => (
      String(candidate.type || '').toLowerCase() === command.inputType
      && String(candidate.name || '') === command.inputName
      && String(candidate.value ?? '') === command.inputValue
    )) || null;
  }
  if (!control && controlStillValid(fallbackTarget)) control = fallbackTarget;
  return controlStillValid(control) ? control : null;
}

/** Execute only semantic commands or proven simple native control activations. */
export async function executeTextEditSemanticCommand(command, {
  documentRoot = globalThis.document,
  fallbackTarget = null,
  dispatchCommand = null,
} = {}) {
  if (!command || !COMMAND_TYPES.has(command.type)) return false;
  if (['set-tool', 'open-panel'].includes(command.type)) {
    return typeof dispatchCommand === 'function'
      ? (await dispatchCommand(command)) === true : false;
  }
  if (command.type === 'toggle-option' && command.option
      && typeof dispatchCommand === 'function'
      && (await dispatchCommand(command)) === true) return true;
  const control = resolveCommandControl(command, documentRoot, fallbackTarget);
  if (!control) return false;
  control.focus?.({ preventScroll: true });
  control.click?.();
  return true;
}

function replayResult(status, actionKind = null, error = null) {
  if (!REPLAY_STATUSES.has(status)) throw new TypeError(`Unsupported replay status: ${status}`);
  return Object.freeze({
    status,
    actionKind,
    error: error == null ? null : String(error),
  });
}

/** Capture the intended action and pointer coordinates before Apply consumes the gesture. */
export function captureTextEditClickAwayIntent({ event, session } = {}) {
  const target = event?.target || null;
  if (!target || !session?.sessionId) return null;
  const textLayer = closestAcrossNamespaces(target, '.textLayer');
  const textSpan = textLayer ? closestAcrossNamespaces(target, 'span') : null;
  const preferredEditId = textSpan?.dataset?.editId || '';
  const preferredMarkerIds = textSpan?.dataset?.nativeTextMarkerIds || '';
  const preferredOcrLineId = textSpan?.dataset?.ocrLineId || '';
  const preferredOcrRegionId = textSpan?.dataset?.ocrRegionId || '';
  const preferredOcrLineIds = textSpan?.dataset?.ocrRegionLineIds || preferredOcrLineId;
  const preferredOcrRecognitionGeneration = textSpan?.dataset?.ocrRecognitionGeneration || '';
  const editableTextSpan = textSpan && (
    preferredEditId || preferredMarkerIds || preferredOcrLineId
  ) ? textSpan : null;
  const actionTarget = textLayer ? null : closestAcrossNamespaces(target, SAFE_ACTION_SELECTOR);
  const semanticCommand = actionTarget ? captureTextEditSemanticCommand(actionTarget) : null;
  const focusTarget = actionTarget || (textLayer
    ? null : closestAcrossNamespaces(target, FOCUS_TARGET_SELECTOR));
  const kind = editableTextSpan
    ? 'text-edit' : semanticCommand ? 'semantic-command' : actionTarget ? 'unsafe-action'
      : focusTarget ? 'focus' : 'none';
  const pageNum = pageNumberForTarget(target, textLayer);
  const targetIdentity = editableTextSpan ? createTextEditTargetIdentity({
    documentId: session.ownerDocumentId,
    pageNum,
    recordId: preferredEditId,
    markerIds: preferredMarkerIds,
    recognitionGeneration: preferredOcrRecognitionGeneration,
    regionId: preferredOcrRegionId,
    lineIds: preferredOcrLineIds,
  }) : null;
  return {
    sessionId: session.sessionId,
    documentId: String(session.ownerDocumentId || ''),
    documentGeneration: Number(session.ownerDocumentGeneration) || 0,
    pointerId: Number.isFinite(event.pointerId) ? event.pointerId : null,
    clientX: Number(event.clientX) || 0,
    clientY: Number(event.clientY) || 0,
    pageNum,
    preferredEditId,
    preferredMarkerIds,
    preferredOcrLineId,
    preferredOcrRegionId,
    preferredOcrLineIds,
    preferredOcrRecognitionGeneration,
    sourceTargetIdentity: session.targetIdentity || null,
    targetIdentity,
    kind,
    target,
    textLayer,
    actionTarget,
    semanticCommand,
    focusTarget,
    destructive: destructiveControl(actionTarget),
    browserDelivered: false,
    compatibilityClickConsumed: false,
    gestureSettlementReason: null,
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

/** Keep a consumed pointer owned until every compatibility-event path settles. */
export function guardTextEditClickAwayGesture(
  intent,
  eventRoot = globalThis.document,
  {
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    windowRoot = eventRoot?.defaultView || globalThis.window,
    visibilityRoot = eventRoot?.nodeType === 9 ? eventRoot : globalThis.document,
    watchdogMs = 1_500,
  } = {},
) {
  let settled = false;
  let pointerTimer = null;
  let watchdogTimer = null;
  let resolveSettled;
  const settledPromise = new Promise((resolve) => { resolveSettled = resolve; });
  const remove = () => {
    eventRoot?.removeEventListener?.('mousedown', consumeCompatibilityMouse, true);
    eventRoot?.removeEventListener?.('click', consumeCompatibilityMouse, true);
    eventRoot?.removeEventListener?.('pointerup', settlePointer, true);
    eventRoot?.removeEventListener?.('pointercancel', settlePointer, true);
    eventRoot?.removeEventListener?.('lostpointercapture', settlePointer, true);
    windowRoot?.removeEventListener?.('blur', settleWindowBlur, true);
    visibilityRoot?.removeEventListener?.('visibilitychange', settleVisibility, true);
    if (pointerTimer) clearTimer(pointerTimer);
    if (watchdogTimer) clearTimer(watchdogTimer);
    pointerTimer = null;
    watchdogTimer = null;
  };
  const finish = (reason = 'disposed') => {
    if (settled) return;
    settled = true;
    if (intent) intent.gestureSettlementReason = reason;
    remove();
    resolveSettled(Object.freeze({ reason }));
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
      finish('compatibility-click');
    }
  }
  function settlePointer(event) {
    if (!matchingPointer(event)) return;
    if (event?.type === 'pointercancel' || event?.type === 'lostpointercapture') {
      finish(event.type);
      return;
    }
    if (!pointerTimer) pointerTimer = setTimer(() => finish('pointerup'), 0);
  }
  function settleWindowBlur() { finish('window-blur'); }
  function settleVisibility() {
    if (visibilityRoot?.hidden === true || visibilityRoot?.visibilityState === 'hidden') {
      finish('document-hidden');
    }
  }
  eventRoot?.addEventListener?.('mousedown', consumeCompatibilityMouse, true);
  eventRoot?.addEventListener?.('click', consumeCompatibilityMouse, true);
  eventRoot?.addEventListener?.('pointerup', settlePointer, true);
  eventRoot?.addEventListener?.('pointercancel', settlePointer, true);
  eventRoot?.addEventListener?.('lostpointercapture', settlePointer, true);
  windowRoot?.addEventListener?.('blur', settleWindowBlur, true);
  visibilityRoot?.addEventListener?.('visibilitychange', settleVisibility, true);
  watchdogTimer = setTimer(() => finish('watchdog'), Math.max(1, Number(watchdogMs) || 1_500));
  return Object.freeze({
    settled: settledPromise,
    dispose: () => finish('disposed'),
  });
}

/** Replay one captured intent only after the initiating Apply is terminal. */
export async function replayTextEditClickAwayIntent(intent, {
  applyResult = null,
  ownerIsCurrent = () => true,
  beginTextEdit = async () => Object.freeze({ activated: false, reason: 'not-available' }),
  executeSemanticCommand = (command) => executeTextEditSemanticCommand(command, {
    fallbackTarget: intent?.actionTarget,
  }),
  indicateUnsafe = () => {},
} = {}) {
  if (!intent || !textApplyResultCompletesInteraction(applyResult)) {
    return replayResult('not-needed');
  }
  if (intent.replayed || intent.browserDelivered) return replayResult('not-needed');
  if (!ownerIsCurrent(intent)) return replayResult('stale', null, 'Document owner changed');
  if (intent.destructive || intent.kind === 'unsafe-action') {
    indicateUnsafe(intent);
    return replayResult('unsafe', intent.kind === 'focus' ? 'focus' : 'semantic-command',
      'The captured action requires a second explicit activation');
  }
  if (intent.kind === 'text-edit') {
    if (!Number.isInteger(intent.pageNum)) {
      return replayResult('not-opened', 'text-edit', 'The captured page is unavailable');
    }
    if (sameTextEditTarget(intent.sourceTargetIdentity, intent.targetIdentity)) {
      intent.replayed = true;
      return replayResult('not-needed', 'text-edit');
    }
    try {
      const opened = await beginTextEdit(intent);
      if (opened?.activated !== true) {
        return replayResult('not-opened', 'text-edit', 'The captured text target did not open');
      }
      intent.replayed = true;
      return replayResult('replayed', 'text-edit');
    } catch (error) {
      return replayResult('failed', 'text-edit', error instanceof Error ? error.message : error);
    }
  }
  if (intent.kind === 'semantic-command') {
    try {
      intent.replaying = true;
      const activated = await executeSemanticCommand(intent.semanticCommand, intent);
      if (activated !== true) {
        return replayResult('not-opened', 'semantic-command', 'The captured command is unavailable');
      }
      intent.replayed = true;
      return replayResult('replayed', 'semantic-command');
    } catch (error) {
      return replayResult('failed', 'semantic-command', error instanceof Error ? error.message : error);
    } finally {
      intent.replaying = false;
    }
  }
  if (intent.kind === 'focus') {
    const target = intent.focusTarget;
    if (!controlStillValid(target)) {
      return replayResult('not-opened', 'focus', 'The captured focus target is unavailable');
    }
    try {
      target.focus?.({ preventScroll: true });
      intent.replayed = true;
      return replayResult('replayed', 'focus');
    } catch (error) {
      return replayResult('failed', 'focus', error instanceof Error ? error.message : error);
    }
  }
  return replayResult('not-needed');
}
