import test from 'node:test';
import assert from 'node:assert/strict';

import { createUnsavedClosePromptCoordinator } from './unsaved-close-prompt.js';

test('concurrent prompts for one owner share one dialog and resolve once', async () => {
  const opened = [];
  const closed = [];
  const coordinator = createUnsavedClosePromptCoordinator({
    open(name, data) {
      opened.push({ name, data });
      return 'dialog-owner-a';
    },
    close(id) { closed.push(id); },
  });

  const first = coordinator.request({ documentId: 'owner-a', fileName: 'A.pdf' });
  const second = coordinator.request({ documentId: 'owner-a', fileName: 'A.pdf' });
  assert.equal(first, second);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].data.settle('cancel'), true);
  assert.equal(opened[0].data.settle('dontsave'), false);
  assert.equal(await first, 'cancel');
  assert.equal(await second, 'cancel');
  assert.deepEqual(closed, ['dialog-owner-a']);
  assert.equal(coordinator.hasPending('owner-a'), false);
});

test('different owner prompts stack and settle independently', async () => {
  const opened = [];
  const closed = [];
  const coordinator = createUnsavedClosePromptCoordinator({
    open(name, data) {
      const id = `dialog-${opened.length + 1}`;
      opened.push({ id, name, data });
      return id;
    },
    close(id) { closed.push(id); },
  });

  const first = coordinator.request({ documentId: 'owner-a', fileName: 'A.pdf' });
  const second = coordinator.request({ documentId: 'owner-b', fileName: 'B.pdf' });
  assert.equal(opened.length, 2);
  opened[1].data.settle('dontsave');
  assert.equal(await second, 'dontsave');
  assert.equal(coordinator.hasPending('owner-a'), true);
  opened[0].data.settle('save');
  assert.equal(await first, 'save');
  assert.deepEqual(closed, ['dialog-2', 'dialog-1']);
});

test('dirty text-edit state is forwarded to the close dialog', async () => {
  const opened = [];
  const coordinator = createUnsavedClosePromptCoordinator({
    open(name, data) {
      opened.push({ name, data });
      return 'dialog-owner-a';
    },
    close() {},
  });

  const pending = coordinator.request({
    documentId: 'owner-a',
    fileName: 'A.pdf',
    dirtyTextEdit: true,
    documentModified: false,
  });
  assert.equal(opened[0].data.dirtyTextEdit, true);
  assert.equal(opened[0].data.documentModified, false);
  opened[0].data.settle('cancel');
  assert.equal(await pending, 'cancel');
});
