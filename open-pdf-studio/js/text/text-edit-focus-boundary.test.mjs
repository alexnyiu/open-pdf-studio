import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  consumeOutsidePointerDownForTextEdit,
  documentTabStartsTextEditLifecycle,
  shouldApplyTextEditForOutsideFocus,
  shouldConsumeOutsidePointerDownForTextEdit,
  shouldSuppressOutsideApplyFollowup,
  textEditTargetIsWithinFocusBoundary,
  textEditTargetStartsLifecycleTransition,
} from './text-edit-focus-boundary.js';

function target(matches = []) {
  return {
    closest(selector) {
      return matches.some((value) => selector.includes(value)) ? this : null;
    },
  };
}

test('editor, properties, view-only controls, and modal UI stay inside the focus boundary', () => {
  assert.equal(textEditTargetIsWithinFocusBoundary(target(['.pdf-text-edit-portal'])), true);
  assert.equal(textEditTargetIsWithinFocusBoundary(target(['.properties-panel-outer'])), true);
  assert.equal(textEditTargetIsWithinFocusBoundary(target(['.pref-combo-dropdown'])), true,
    'a portaled properties combo remains inside the editor focus boundary');
  assert.equal(textEditTargetIsWithinFocusBoundary(target(['#tab-view'])), true);
  assert.equal(textEditTargetIsWithinFocusBoundary(target(['.status-viewmode-controls'])), true);
  assert.equal(textEditTargetIsWithinFocusBoundary(target(['.status-zoom-controls'])), true);
  const child = target([]);
  assert.equal(textEditTargetIsWithinFocusBoundary(child, { contains: (node) => node === child }), true);
  assert.equal(textEditTargetIsWithinFocusBoundary(target(['.modal-overlay'])), true);
  assert.equal(textEditTargetIsWithinFocusBoundary(
    target(['[role="dialog"][aria-modal="true"]']),
  ), true);
});

test('ordinary outside focus applies while window blur and actual lifecycle controls do not', () => {
  const statusInput = target([]);
  assert.equal(shouldApplyTextEditForOutsideFocus({ target: statusInput }), true);
  assert.equal(shouldApplyTextEditForOutsideFocus({
    target: statusInput,
    documentHasFocus: false,
  }), false);
  assert.equal(shouldApplyTextEditForOutsideFocus({
    target: target(['#document-tabs']),
  }), true, 'the tab-strip container is not itself a document transition');
  assert.equal(shouldApplyTextEditForOutsideFocus({
    target: target(['.document-tabs-add']),
  }), true, 'Add is an ordinary click-away until a new document actually opens');
  assert.equal(shouldApplyTextEditForOutsideFocus({
    target: target(['[data-text-edit-lifecycle-transition="true"]']),
  }), false);
  assert.equal(textEditTargetStartsLifecycleTransition(target(['#ribbon-compare'])), true);
});

test('only inactive document tabs or a return from Compare start a tab lifecycle transition', () => {
  assert.equal(documentTabStartsTextEditLifecycle({
    tabIndex: 1,
    activeDocumentIndex: 1,
  }), false);
  assert.equal(documentTabStartsTextEditLifecycle({
    tabIndex: 0,
    activeDocumentIndex: 1,
  }), true);
  assert.equal(documentTabStartsTextEditLifecycle({
    tabIndex: 1,
    activeDocumentIndex: 1,
    compareIsFocused: true,
  }), true);
});

test('document-tab markup leaves current-tab and Add clicks ordinary while marking transitions', async () => {
  const source = await readFile(
    new URL('../solid/components/DocumentTabs.jsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source,
    /id="document-tabs"[^>]*data-text-edit-lifecycle-transition/u,
    'the complete tab strip must not turn ordinary tab-bar clicks into draft cancellation');
  assert.match(source,
    /data-text-edit-lifecycle-transition=\{documentTabStartsTextEditLifecycle\(/u);
  assert.match(source,
    /class="document-tab-close" data-text-edit-lifecycle-transition="true"/u);
  assert.match(source,
    /class="document-tabs-add"[^>]*onClick=\{handleAddClick\}/u);
});

test('a primary outside pointerdown is consumed before an action can race Apply', () => {
  assert.equal(shouldConsumeOutsidePointerDownForTextEdit({
    target: target([]),
    button: 0,
  }), true);
  assert.equal(shouldConsumeOutsidePointerDownForTextEdit({
    target: target(['.properties-panel-outer']),
    button: 0,
  }), false);
  assert.equal(shouldConsumeOutsidePointerDownForTextEdit({
    target: target(['.pref-combo-dropdown']),
    button: 0,
  }), false, 'a portaled properties option must receive its pointer gesture');
  assert.equal(shouldConsumeOutsidePointerDownForTextEdit({
    target: target(['.pdf-canvas']),
    button: 1,
  }), false);

  const calls = [];
  let stopped = false;
  assert.equal(consumeOutsidePointerDownForTextEdit({
    target: target([]),
    button: 0,
    preventDefault() { calls.push('prevent'); },
    stopImmediatePropagation() { calls.push('stop'); stopped = true; },
  }), true);
  assert.deepEqual(calls, ['prevent', 'stop']);
  let competingActionRan = false;
  if (!stopped) competingActionRan = true;
  assert.equal(competingActionRan, false, 'outside control cannot supersede the session mid-Apply');
});

test('follow-up suppression is limited to the pending Apply or matching pointer session', () => {
  const outside = target([]);
  assert.equal(shouldSuppressOutsideApplyFollowup({
    target: outside,
    eventType: 'click',
    detail: 1,
    consumedSessionId: 'session-a',
    activeSessionId: 'session-a',
  }), true);
  assert.equal(shouldSuppressOutsideApplyFollowup({
    target: outside,
    eventType: 'click',
    detail: 1,
    consumedSessionId: 'session-a',
    activeSessionId: 'session-b',
  }), false, 'a later editor session must not inherit the consumed gesture');
  assert.equal(shouldSuppressOutsideApplyFollowup({
    target: outside,
    eventType: 'click',
    detail: 0,
    consumedSessionId: 'session-a',
    activeSessionId: 'session-a',
  }), false, 'keyboard and programmatic click-only activation must not inherit pointer state');
  assert.equal(shouldSuppressOutsideApplyFollowup({
    target: outside,
    eventType: 'click',
    detail: 0,
    applyPending: true,
  }), true, 'a competing action remains blocked while Apply is actually pending');
  assert.equal(shouldSuppressOutsideApplyFollowup({
    target: target(['.properties-panel-outer']),
    eventType: 'click',
    detail: 1,
    applyPending: true,
  }), false, 'the editor focus boundary remains usable during Apply bookkeeping');
});
