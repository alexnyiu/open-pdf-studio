import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDialog,
  getDialogs,
  getTopDialog,
  openDialog,
} from './dialogStore.js';

test('dialog store preserves stack order and stable instance identity', () => {
  const firstId = openDialog('first');
  const secondId = openDialog('second');
  assert.deepEqual(getDialogs().map(({ id, name }) => ({ id, name })), [
    { id: firstId, name: 'first' },
    { id: secondId, name: 'second' },
  ]);
  assert.equal(getTopDialog().id, secondId);
  assert.equal(openDialog('second'), secondId, 'duplicate named modal must not fork the stack');
  closeDialog(secondId);
  assert.equal(getTopDialog().id, firstId);
  closeDialog('first');
  assert.equal(getTopDialog(), null);
});
