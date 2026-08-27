import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consumeTextEditEscape,
  isEditableKeyboardTarget,
  selectAllTextEditorContent,
  shouldCancelTextEditForEscape,
  shouldRedirectTextEditorSelectAll,
} from './keyboard-focus-boundary.js';

function event(target, overrides = {}) {
  return {
    key: 'a',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    ...overrides,
  };
}

test('form fields and contenteditable descendants retain native Select All', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const target = { tagName, closest: () => null };
    assert.equal(isEditableKeyboardTarget(target), true);
    assert.equal(shouldRedirectTextEditorSelectAll(event(target), true), false);
  }
  const descendant = { tagName: 'SPAN', closest: () => ({ contentEditable: 'true' }) };
  assert.equal(shouldRedirectTextEditorSelectAll(event(descendant), true), false);
});

test('Select All redirects to an active text editor only from a non-editable target', () => {
  const button = { tagName: 'BUTTON', closest: () => null };
  assert.equal(shouldRedirectTextEditorSelectAll(event(button), true), true);
  assert.equal(shouldRedirectTextEditorSelectAll(event(button), false), false);
  assert.equal(shouldRedirectTextEditorSelectAll(event(button, { shiftKey: true }), true), false);
});

test('Escape cancels an active edit from properties controls but preserves ordinary inputs', () => {
  const propertiesTarget = (tagName) => ({
    tagName,
    closest(selector) {
      return selector.includes('.properties-panel-outer') ? this : null;
    },
  });
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const target = propertiesTarget(tagName);
    assert.equal(isEditableKeyboardTarget(target), true);
    assert.equal(shouldCancelTextEditForEscape({ key: 'Escape', target }, true), true);
    assert.equal(shouldCancelTextEditForEscape({ key: 'ArrowDown', target }, true), false);
    assert.equal(shouldCancelTextEditForEscape({ key: 'Escape', target }, false), false);
  }

  const combobox = propertiesTarget('BUTTON');
  assert.equal(shouldCancelTextEditForEscape({ key: 'Escape', target: combobox }, true), true);
  assert.equal(shouldCancelTextEditForEscape({
    key: 'Escape',
    target: { tagName: 'INPUT', closest: () => null },
  }, true), false, 'an unrelated editable control retains native Escape behavior');
  assert.equal(shouldCancelTextEditForEscape({
    key: 'Escape',
    target: {
      tagName: 'BUTTON',
      closest(selector) {
        if (selector.includes('.properties-panel-outer')) return this;
        if (selector.includes('.modal-overlay')) return this;
        return null;
      },
    },
  }, true), false, 'the top modal retains ownership of Escape');

  const calls = [];
  const input = propertiesTarget('INPUT');
  assert.equal(consumeTextEditEscape({
    key: 'Escape',
    target: input,
    preventDefault() { calls.push('prevent'); },
    stopPropagation() { calls.push('stop'); },
  }, true, (reason) => calls.push(`cancel:${reason}`)), true);
  assert.deepEqual(calls, ['prevent', 'stop', 'cancel:escape'],
    'Cancel runs synchronously before keydown returns');
});

test('redirected Select All supports both plain and contenteditable text editors', () => {
  let plainFocused = 0;
  let plainSelected = 0;
  assert.equal(selectAllTextEditorContent({
    focus() { plainFocused += 1; },
    select() { plainSelected += 1; },
  }), true);
  assert.deepEqual([plainFocused, plainSelected], [1, 1]);

  const rich = { isContentEditable: true, focus() {} };
  const selected = [];
  const range = { selectNodeContents(node) { selected.push(['range', node]); } };
  const selection = {
    removeAllRanges() { selected.push(['clear']); },
    addRange(value) { selected.push(['add', value]); },
  };
  assert.equal(selectAllTextEditorContent(rich, {
    getSelection: () => selection,
    createRange: () => range,
  }), true);
  assert.deepEqual(selected, [['range', rich], ['clear'], ['add', range]]);
});
