import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  captureTextEditClickAwayIntent,
  guardTextEditClickAwayGesture,
  markTextEditClickAwayIntentDelivered,
  replayTextEditClickAwayIntent,
} from './text-edit-click-away-intent.js';
import { createTextEditTargetIdentity } from './text-edit-target-identity.js';

function element({ selectors = [], parent = null, dataset = {}, text = '' } = {}) {
  return {
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
  const button = element({ selectors: ['button'] });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
  const result = await replayTextEditClickAwayIntent(intent, { commitSucceeded: true });
  assert.equal(result, 'action-replayed');
  assert.equal(button.focusCalls, 1);
  assert.equal(button.clickCalls, 1);
  assert.equal(await replayTextEditClickAwayIntent(intent, { commitSucceeded: true }), 'already-replayed');
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
    beginTextEdit: async (captured) => calls.push(captured),
  });
  assert.equal(result, 'text-edit-replayed');
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
  assert.equal(result, 'invalid-target');
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
  assert.equal(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    beginTextEdit: async () => { beginCalls += 1; },
  }), 'same-text-target-suppressed');
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
  assert.equal(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    beginTextEdit: async () => { beginCalls += 1; },
  }), 'same-text-target-suppressed');
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
  assert.equal(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    beginTextEdit: async () => { beginCalls += 1; },
  }), 'text-edit-replayed');
  assert.equal(beginCalls, 1);
});

test('a failed commit never activates the captured target', async () => {
  const button = element({ selectors: ['button'] });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
  assert.equal(await replayTextEditClickAwayIntent(intent, { commitSucceeded: false }), 'commit-failed');
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
  assert.equal(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: false,
    beginTextEdit: async () => { beginCalls += 1; },
  }), 'commit-failed');
  assert.equal(beginCalls, 0);
  assert.equal(intent.replayed, false);
});

test('destructive actions are not replayed and visibly require a second click', async () => {
  const button = element({ selectors: ['button'], text: 'Delete page' });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
  let notices = 0;
  assert.equal(await replayTextEditClickAwayIntent(intent, {
    commitSucceeded: true,
    indicateUnsafe: () => { notices += 1; },
  }), 'unsafe-requires-second-click');
  assert.equal(notices, 1);
  assert.equal(button.clickCalls || 0, 0);
});

test('an activation already delivered by the browser is never replayed', async () => {
  const button = element({ selectors: ['button'] });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
  markTextEditClickAwayIntentDelivered(intent);
  assert.equal(await replayTextEditClickAwayIntent(intent, { commitSucceeded: true }), 'browser-delivered');
  assert.equal(button.clickCalls || 0, 0);
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
  const button = element({ selectors: ['button'] });
  const intent = captureTextEditClickAwayIntent({ event: pointerEvent(button), session: session() });
  const guard = guardTextEditClickAwayGesture(intent, root, {
    setTimer(callback) { timers.push(callback); return callback; },
    clearTimer() {},
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
});
