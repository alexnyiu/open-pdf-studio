import test from 'node:test';
import assert from 'node:assert/strict';
import { createListGeometry, preserveListAnchor } from './list-geometry.js';
const geometry = rows => createListGeometry(rows, item => item.id, item => item.height);
test('variable-height lookup resolves boundaries and clamps overscroll', () => {
  const list = geometry([{id:'a',height:30},{id:'b',height:60},{id:'c',height:40}]);
  assert.deepEqual([0,29,30,89,90,999].map(offset => list.indexAt(offset)), [0,0,1,1,2,2]);
  assert.equal(list.totalHeight,130);
});
test('resizing and regrouping preserve the visible stable key and row offset', () => {
  const before = geometry([{id:'a',height:30},{id:'b',height:60},{id:'c',height:40}]);
  const after = geometry([{id:'c',height:80},{id:'a',height:30},{id:'b',height:60}]);
  assert.equal(preserveListAnchor(before, after, 42),122);
  assert.equal(preserveListAnchor(before, geometry([{id:'a',height:30},{id:'c',height:40}]),42),42);
  assert.equal(preserveListAnchor(before, geometry([]),42),0);
});
