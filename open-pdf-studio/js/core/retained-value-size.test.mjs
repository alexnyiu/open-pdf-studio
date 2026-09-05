import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRetainedBytes } from './retained-value-size.js';
test('retained estimate counts a shared backing buffer once and terminates on cycles', () => {
  const buffer = new ArrayBuffer(1024 * 1024);
  const root = { first: new Uint8Array(buffer), second: new Uint8Array(buffer, 10, 20) };
  root.self = root;
  const bytes = estimateRetainedBytes(root);
  assert.ok(bytes >= buffer.byteLength && bytes < buffer.byteLength + 1024);
});
test('independent page snapshots and nested strings are accounted for', () => {
  const a = new Uint8Array(1024), b = a.slice();
  assert.ok(estimateRetainedBytes({ before: a, after: b, text: 'x'.repeat(100) }) >= 2248);
  assert.equal(estimateRetainedBytes(new Map([['k', new Set([a])]])) > 1024, true);
});
