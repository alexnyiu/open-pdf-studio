import assert from 'node:assert/strict';
import test from 'node:test';

import { restoreDocumentScrollPosition } from './document-scroll-position.js';

test('a newly loaded document clears the shared container offset', () => {
  const container = { scrollLeft: 240, scrollTop: 492 };

  assert.deepEqual(restoreDocumentScrollPosition(container, {
    scrollPosition: { x: 0, y: 0 },
  }), { x: 0, y: 0 });
  assert.equal(container.scrollLeft, 0);
  assert.equal(container.scrollTop, 0);
});

test('a returning tab restores its own finite non-negative position', () => {
  const container = { scrollLeft: 0, scrollTop: 0 };

  assert.deepEqual(restoreDocumentScrollPosition(container, {
    scrollPosition: { x: 18.5, y: 310 },
  }), { x: 18.5, y: 310 });
  assert.equal(container.scrollLeft, 18.5);
  assert.equal(container.scrollTop, 310);
});

test('invalid saved offsets cannot poison a later document view', () => {
  const container = { scrollLeft: 90, scrollTop: 90 };

  assert.deepEqual(restoreDocumentScrollPosition(container, {
    scrollPosition: { x: -12, y: Number.NaN },
  }), { x: 0, y: 0 });
  assert.equal(container.scrollLeft, 0);
  assert.equal(container.scrollTop, 0);
});
