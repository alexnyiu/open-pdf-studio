import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedDiff } from './bounded-diff.js';
import { diffPageTexts, diffPageTextsForPresentation } from './text-diff.js';

test('divergent long inputs are explicitly coarse and retain all source lines', () => {
  const a = Array.from({ length: 10000 }, (_, i) => `old ${i}`);
  const b = Array.from({ length: 10000 }, (_, i) => `new ${i}`);
  const ops = boundedDiff(a, b);
  assert.equal(ops.partial, true);
  assert.equal(ops.length, 20000);
  assert.deepEqual(ops.filter(o => o.op !== 'ins').map(o => a[o.oldIdx]), a);
  assert.deepEqual(ops.filter(o => o.op !== 'del').map(o => b[o.newIdx]), b);
  assert.equal(diffPageTexts([{ page: 1, lines: a }], [{ page: 1, lines: b }])[0].partial, true);
});

test('anchors preserve matching text across page boundaries', () => {
  assert.deepEqual(diffPageTexts([{ page: 1, lines: ['one', 'two'] }],
    [{ page: 1, lines: ['one'] }, { page: 2, lines: ['two'] }]), []);
});

test('diff operations reconstruct both inputs with duplicates and empty regions', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let n = 0; n < 100; n++) {
    const a = Array.from({ length: rand() % 40 }, () => String(rand() % 7));
    const b = Array.from({ length: rand() % 40 }, () => String(rand() % 7));
    const ops = boundedDiff(a, b);
    assert.deepEqual(ops.filter(o => o.op !== 'ins').map(o => a[o.oldIdx]), a);
    assert.deepEqual(ops.filter(o => o.op !== 'del').map(o => b[o.newIdx]), b);
    for (const op of ops) if (op.op === 'eq') assert.equal(a[op.oldIdx], b[op.newIdx]);
  }
});

test('worker presentation retains unchanged words and marks changed words once', () => {
  const [change] = diffPageTextsForPresentation(
    [{ page: 1, lines: ['the red door'] }], [{ page: 1, lines: ['the blue door'] }]);
  assert.equal(change.partial, false);
  assert.deepEqual(change.words.oldParts, [
    { text: 'the', changed: false }, { text: 'red', changed: true }, { text: 'door', changed: false },
  ]);
  assert.equal(change.words.newParts.map(part => part.text).join(' '), 'the blue door');
});

test('word refinement hitting its work limit cannot appear exhaustive', () => {
  const oldText = Array.from({ length: 3000 }, (_, i) => `old${i}`).join(' ');
  const newText = Array.from({ length: 3000 }, (_, i) => `new${i}`).join(' ');
  const [change] = diffPageTextsForPresentation(
    [{ page: 1, lines: [oldText] }], [{ page: 1, lines: [newText] }]);
  assert.equal(change.partial, true);
  assert.equal(change.words.partial, true);
  assert.equal(change.words.oldParts.map(part => part.text).join(' '), oldText);
  assert.equal(change.words.newParts.map(part => part.text).join(' '), newText);
});
