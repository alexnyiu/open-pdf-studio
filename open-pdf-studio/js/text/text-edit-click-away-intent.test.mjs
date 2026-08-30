import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  captureTextEditClickAwayIntent,
  executeTextEditSemanticCommand,
  guardTextEditClickAwayGesture,
  markTextEditClickAwayIntentDelivered,
  replayTextEditClickAwayIntent,
} from './text-edit-click-away-intent.js';
import { createTextEditTargetIdentity } from './text-edit-target-identity.js';

function element({
  selectors = [], parent = null, dataset = {}, text = '', id = '',
  type = '', name = '', value = '', checked = false,
} = {}) {
  return {
    id,
    type,
    name,
    value,
    checked,
    dataset,
    parentElement: parent,
    textContent: text,
    isConnected: true,
    disabled: false,
    attributes: new Map(),
    matches(selector) {
      return selectors.some((candidate) => selector.split(', ').includes(candidate));
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    contains(target) {
      let current = target;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    focus() { this.focusCalls = (this.focusCalls || 0) + 1; },
    click() { this.clickCalls = (this.clickCalls || 0) + 1; },
  };
}

function session(overrides = {}) {
  return {
    sessionId: 'session-a',
    ownerDocumentId: 'doc-a',
    ownerDocumentGeneration: 7,
    ...overrides,
  };
}

function pointerEvent(target, overrides = {}) {
  return {
    target,
    pointerId: 9,
    clientX: 120,
    clientY: 240,
    ...overrides,
  };
}

test('a normal toolbar click commits and activates the captured action exactly once', async () => {
  const button = element({ selectors: ['button'], id: 'toolbar-action' });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
  const result = await replayTextEditClickAwayIntent(intent, { commitSucceeded: true });
  assert.deepEqual(result, { status: 'replayed', actionKind: 'semantic-command', error: null });
  assert.equal(button.focusCalls, 1);
  assert.equal(button.clickCalls, 1);
  assert.deepEqual(await replayTextEditClickAwayIntent(intent, { commitSucceeded: true }), {
    status: 'not-needed', actionKind: null, error: null,
  });
  assert.equal(button.clickCalls, 1);
});

test('another text region commits and opens at the captured point after readiness', async () => {
  const layer = element({ selectors: ['.textLayer'], dataset: { page: '4' } });
  const span = element({
    selectors: ['span'],
    parent: layer,
    dataset: { editId: 'edit-2', nativeTextMarkerIds: 'm1,m2' },
  });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(span), session: session() });
  const calls = [];
  const result = await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    beginTextEdit: async (captured) => { calls.push(captured); return true; },
  });
  assert.deepEqual(result, { status: 'replayed', actionKind: 'text-edit', error: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pageNum, 4);
  assert.equal(calls[0].clientX, 120);
  assert.equal(calls[0].clientY, 240);
  assert.equal(calls[0].preferredEditId, 'edit-2');
});

test('blank text-layer space closes without capturing a text replay target', async () => {
  const layer = element({ selectors: ['.textLayer'], dataset: { page: '4' } });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(layer), session: session() });
  let beginCalls = 0;
  const result = await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    beginTextEdit: async () => { beginCalls += 1; },
  });
  assert.equal(intent.kind, 'none');
  assert.equal(intent.targetIdentity, null);
  assert.deepEqual(result, { status: 'not-needed', actionKind: null, error: null });
  assert.equal(beginCalls, 0);
});

test('same owned paragraph replay is suppressed across different rendered lines', async () => {
  const layer = element({ selectors: ['.textLayer'], dataset: { page: '4' } });
  const secondLine = element({ selectors: ['span'], parent: layer, dataset: { editId: 'edit-1' } });
  const sourceTargetIdentity = createTextEditTargetIdentity({
    documentId: 'doc-a', pageNum: 4, recordId: 'edit-1',
  });
  const intent = captureTextEditClickAwayIntent({
    event: pointerEvent(secondLine),
    session: session({ targetIdentity: sourceTargetIdentity }),
  });
  let beginCalls = 0;
  assert.deepEqual(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    beginTextEdit: async () => { beginCalls += 1; },
  }), { status: 'not-needed', actionKind: 'text-edit', error: null });
  assert.equal(beginCalls, 0);
});

test('same native paragraph replay is suppressed when the clicked marker belongs to its provenance', async () => {
  const layer = element({ selectors: ['.textLayer'], dataset: { page: '4' } });
  const laterLine = element({
    selectors: ['span'], parent: layer, dataset: { nativeTextMarkerIds: 'marker-c' },
  });
  const sourceTargetIdentity = createTextEditTargetIdentity({
    documentId: 'doc-a', pageNum: 4, markerIds: ['marker-a', 'marker-b', 'marker-c'],
  });
  const intent = captureTextEditClickAwayIntent({
    event: pointerEvent(laterLine),
    session: session({ targetIdentity: sourceTargetIdentity }),
  });
  let beginCalls = 0;
  assert.deepEqual(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    beginTextEdit: async () => { beginCalls += 1; },
  }), { status: 'not-needed', actionKind: 'text-edit', error: null });
  assert.equal(beginCalls, 0);
});

test('a different native paragraph still opens in the committing gesture', async () => {
  const layer = element({ selectors: ['.textLayer'], dataset: { page: '4' } });
  const otherParagraph = element({
    selectors: ['span'], parent: layer, dataset: { nativeTextMarkerIds: 'marker-z' },
  });
  const sourceTargetIdentity = createTextEditTargetIdentity({
    documentId: 'doc-a', pageNum: 4, markerIds: 'marker-a marker-b marker-c',
  });
  const intent = captureTextEditClickAwayIntent({
    event: pointerEvent(otherParagraph),
    session: session({ targetIdentity: sourceTargetIdentity }),
  });
  let beginCalls = 0;
  assert.deepEqual(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    beginTextEdit: async () => { beginCalls += 1; return true; },
  }), { status: 'replayed', actionKind: 'text-edit', error: null });
  assert.equal(beginCalls, 1);
});

test('a failed commit never activates the captured target', async () => {
  const button = element({ selectors: ['button'], id: 'commit-failure-action' });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
  assert.deepEqual(await replayTextEditClickAwayIntent(intent, { commitSucceeded: false }), {
    status: 'not-needed', actionKind: null, error: null,
  });
  assert.equal(button.focusCalls || 0, 0);
  assert.equal(button.clickCalls || 0, 0);
});

test('a failed commit retains the original session and never replays a text target', async () => {
  const layer = element({ selectors: ['.textLayer'], dataset: { page: '4' } });
  const otherParagraph = element({
    selectors: ['span'], parent: layer, dataset: { nativeTextMarkerIds: 'marker-z' },
  });
  const intent = captureTextEditClickAwayIntent({
    event: pointerEvent(otherParagraph),
    session: session({
      targetIdentity: createTextEditTargetIdentity({
        documentId: 'doc-a', pageNum: 4, markerIds: 'marker-a marker-b',
      }),
    }),
  });
  let beginCalls = 0;
  assert.deepEqual(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: false,
    beginTextEdit: async () => { beginCalls += 1; },
  }), { status: 'not-needed', actionKind: null, error: null });
  assert.equal(beginCalls, 0);
  assert.equal(intent.replayed, false);
});

test('destructive actions are not replayed and visibly require a second click', async () => {
  const button = element({ selectors: ['button'], text: 'Delete page' });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
  let notices = 0;
  assert.deepEqual(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    indicateUnsafe: () => { notices += 1; },
  }), {
    status: 'unsafe',
    actionKind: 'semantic-command',
    error: 'The captured action requires a second explicit activation',
  });
  assert.equal(notices, 1);
  assert.equal(button.clickCalls || 0, 0);
});

test('an activation already delivered by the browser is never replayed', async () => {
  const button = element({ selectors: ['button'], id: 'browser-delivered-action' });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
  markTextEditClickAwayIntentDelivered(intent);
  assert.deepEqual(await replayTextEditClickAwayIntent(intent, { commitSucceeded: true }), {
    status: 'not-needed', actionKind: null, error: null,
  });
  assert.equal(button.clickCalls || 0, 0);
});

test('OCR identity suppresses another line in the same region and opens a different region once', async () => {
  const layer = element({ selectors: ['.textLayer'], dataset: { page: '6' } });
  const sameRegionLine = element({
    selectors: ['span'],
    parent: layer,
    dataset: {
      ocrLineId: 'line-2',
      ocrRegionId: 'region-a',
      ocrRegionLineIds: 'line-1 line-2',
      ocrRecognitionGeneration: 'recognition-8',
    },
  });
  const sourceIdentity = createTextEditTargetIdentity({
    documentId: 'doc-a', pageNum: 6,
    recognitionGeneration: 'recognition-8', regionId: 'region-a',
    lineIds: ['line-1', 'line-2'],
  });
  const sameIntent = captureTextEditClickAwayIntent({
    event: pointerEvent(sameRegionLine),
    session: session({ targetIdentity: sourceIdentity }),
  });
  let opens = 0;
  assert.deepEqual(await replayTextEditClickAwayIntent(sameIntent, {
    commitSucceeded: true,
    beginTextEdit: async () => { opens += 1; return true; },
  }), { status: 'not-needed', actionKind: 'text-edit', error: null });
  assert.equal(opens, 0);

  const differentRegionLine = element({
    selectors: ['span'],
    parent: layer,
    dataset: {
      ocrLineId: 'line-3',
      ocrRegionId: 'region-b',
      ocrRegionLineIds: 'line-3 line-4',
      ocrRecognitionGeneration: 'recognition-8',
    },
  });
  const differentIntent = captureTextEditClickAwayIntent({
    event: pointerEvent(differentRegionLine),
    session: session({ targetIdentity: sourceIdentity }),
  });
  assert.deepEqual(await replayTextEditClickAwayIntent(differentIntent, {
    commitSucceeded: true,
    beginTextEdit: async () => { opens += 1; return true; },
  }), { status: 'replayed', actionKind: 'text-edit', error: null });
  assert.equal(opens, 1);
});

test('a text activation that returns false truthfully reports not-opened', async () => {
  const layer = element({ selectors: ['.textLayer'], dataset: { page: '2' } });
  const span = element({ selectors: ['span'], parent: layer, dataset: { editId: 'missing' } });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(span), session: session() });
  assert.deepEqual(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    beginTextEdit: async () => false,
  }), {
    status: 'not-opened', actionKind: 'text-edit',
    error: 'The captured text target did not open',
  });
  assert.equal(intent.replayed, false);
});

test('a stable semantic command resolves a replacement control after commit', async () => {
  const original = element({ selectors: ['button'], id: 'replacement-action' });
  const replacement = element({ selectors: ['button'], id: 'replacement-action' });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(original), session: session() });
  original.isConnected = false;
  const documentRoot = { getElementById: (id) => id === replacement.id ? replacement : null };
  const result = await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    executeSemanticCommand: (command) => executeTextEditSemanticCommand(command, { documentRoot }),
  });
  assert.deepEqual(result, { status: 'replayed', actionKind: 'semantic-command', error: null });
  assert.equal(replacement.clickCalls, 1);
  assert.equal(original.clickCalls || 0, 0);
});

test('checkbox, radio, menu, tool, and focus handoffs use bounded command kinds', async () => {
  const checkbox = element({
    selectors: ['input[type="checkbox"]'], type: 'checkbox', name: 'grid', value: 'on', checked: false,
  });
  const checkboxIntent = captureTextEditClickAwayIntent({
    event: pointerEvent(checkbox), session: session(),
  });
  assert.equal(checkboxIntent.semanticCommand.type, 'toggle-option');
  assert.deepEqual(await replayTextEditClickAwayIntent(checkboxIntent, {
    commitSucceeded: true,
  }), { status: 'replayed', actionKind: 'semantic-command', error: null });

  const radio = element({
    selectors: ['input[type="radio"]'], id: 'radio-fit', type: 'radio', checked: false,
  });
  const menu = element({ selectors: ['[role="menuitem"]'], id: 'menu-properties' });
  for (const control of [radio, menu]) {
    const intent = captureTextEditClickAwayIntent({ event: pointerEvent(control), session: session() });
    const result = await replayTextEditClickAwayIntent(intent, { commitSucceeded: true });
    assert.equal(result.status, 'replayed');
    assert.equal(result.actionKind, 'semantic-command');
    assert.equal(control.clickCalls, 1);
  }

  const tool = element({
    selectors: ['button'],
    dataset: { textEditCommand: 'set-tool', textEditTool: 'select' },
  });
  const toolIntent = captureTextEditClickAwayIntent({ event: pointerEvent(tool), session: session() });
  const commands = [];
  assert.deepEqual(await replayTextEditClickAwayIntent(toolIntent, {
    commitSucceeded: true,
    executeSemanticCommand: async (command) => { commands.push(command); return true; },
  }), { status: 'replayed', actionKind: 'semantic-command', error: null });
  assert.deepEqual(commands, [{ type: 'set-tool', tool: 'select' }]);

  const focus = element({ selectors: ['input:not([type="hidden"])'] });
  const focusIntent = captureTextEditClickAwayIntent({ event: pointerEvent(focus), session: session() });
  assert.deepEqual(await replayTextEditClickAwayIntent(focusIntent, { commitSucceeded: true }), {
    status: 'replayed', actionKind: 'focus', error: null,
  });
  assert.equal(focus.focusCalls, 1);
});

test('the gesture guard consumes a native compatibility click and survives until settlement', async () => {
  const listeners = new Map();
  const timers = [];
  const root = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const button = element({ selectors: ['button'], id: 'guard-action' });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
  const guard = guardTextEditClickAwayGesture(intent, root, {
    setTimer(callback) { const timer = { callback }; timers.push(timer); return timer; },
    clearTimer(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  let prevented = 0;
  listeners.get('click')({
    type: 'click',
    target: button,
    detail: 1,
    preventDefault() { prevented += 1; },
    stopImmediatePropagation() {},
  });
  await guard.settled;
  assert.equal(prevented, 1);
  assert.equal(intent.compatibilityClickConsumed, true);
  assert.equal(listeners.size, 0);
  assert.equal(timers.length, 0);
});

test('pointercancel, lost capture, blur, hidden document, and watchdog always settle and clean up', async () => {
  const scenarios = [
    ['pointercancel', 'pointercancel'],
    ['lostpointercapture', 'lostpointercapture'],
    ['blur', 'window-blur'],
    ['visibilitychange', 'document-hidden'],
    ['watchdog', 'watchdog'],
  ];
  for (const [trigger, expectedReason] of scenarios) {
    const listeners = new Map();
    const timers = [];
    const root = {
      hidden: trigger === 'visibilitychange',
      visibilityState: trigger === 'visibilitychange' ? 'hidden' : 'visible',
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type, listener) {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
    };
    const button = element({ selectors: ['button'], id: `settle-${trigger}` });
    const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
    const guard = guardTextEditClickAwayGesture(intent, root, {
      windowRoot: root,
      visibilityRoot: root,
      watchdogMs: 25,
      setTimer(callback, delay) {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    });
    if (trigger === 'watchdog') timers.find((timer) => timer.delay === 25).callback();
    else listeners.get(trigger)({ type: trigger, pointerId: 9 });
    assert.deepEqual(await guard.settled, { reason: expectedReason });
    assert.equal(listeners.size, 0);
    assert.equal(timers.length, 0);
  }
});

test('the production overlay captures before consumption and routes text replay through readiness', async () => {
  const source = await readFile(
    new URL('../solid/components/PdfTextEditOverlay.jsx', import.meta.url),
    'utf8',
  );
  const handler = source.slice(
    source.indexOf('const handleOutsidePointerDown = (event) => {'),
    source.indexOf('\n  const handleOutsideFocusIn', source.indexOf('const handleOutsidePointerDown')),
  );
  assert.ok(
    handler.indexOf('captureTextEditClickAwayIntent({ event, session })')
      < handler.indexOf('consumeOutsidePointerDownForTextEdit(event, portalRef)'),
    'intent and coordinates are captured before pointerdown is consumed',
  );
  assert.match(handler, /guardTextEditClickAwayGesture\(intent, document\)/u);
  assert.match(source, /replayTextEditClickAwayIntent\(capturedIntent/u);
  assert.match(source, /startTextLayerEditAtClientPointWhenReady\(\{/u);
  assert.match(source, /await settleCapturedGesture\(\)/u);
  assert.match(handler, /acquireOutsidePageLeases\(session, intent\)/u);
  assert.match(source, /releaseOutsidePageLeases\(capturedLeases\)/u);
  assert.match(source, /const replayResult = await replayTextEditClickAwayIntent/u);
  assert.match(source, /pdf-text-editor-layout-recovery/u);
});

test('production OCR replay identity is stamped and editor activation is truthful', async () => {
  const source = await readFile(new URL('../tools/text-edit-tool.js', import.meta.url), 'utf8');
  assert.match(source, /span\.dataset\.ocrRegionId = String\(identityRegion\.id\)/u);
  assert.match(source, /span\.dataset\.ocrRecognitionGeneration = String\(recognitionGeneration\)/u);
  assert.match(source, /editor\.ocrTargetIdentity = Object\.freeze/u);
  assert.match(source, /export async function startTextLayerEditAtClientPointWhenReady/u);
  assert.doesNotMatch(
    source.slice(
      source.indexOf('export async function startTextLayerEditAtClientPointWhenReady'),
      source.indexOf('\nfunction enableTextLayerHover'),
    ),
    /void start(?:Scanned|Pdf)TextEditing/u,
  );
});

test('a record refresh exception cannot bypass editor cleanup', async () => {
  const source = await readFile(new URL('../tools/text-edit-tool.js', import.meta.url), 'utf8');
  const recordCancel = source.slice(
    source.indexOf('const cancelEditing = () => {', source.indexOf('export function startTextEditEditing')),
    source.indexOf('\n\n  activeEditor = {', source.indexOf('const cancelEditing = () => {', source.indexOf('export function startTextEditEditing'))),
  );
  assert.match(recordCancel, /try \{[\s\S]*reRenderAddedText\(pageNum\);[\s\S]*\} finally \{[\s\S]*cleanupEditorRuntime\(editor\)/u);
  const genericCancel = source.slice(
    source.indexOf('function cancelPdfTextEditing'),
    source.indexOf('\n/**', source.indexOf('function cancelPdfTextEditing')),
  );
  assert.match(genericCancel, /finally \{[\s\S]*cleanupEditorRuntime\(editor/u);
});
