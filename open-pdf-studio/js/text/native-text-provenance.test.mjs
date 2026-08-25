import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchNativeTextSources,
  matchOwnedReplacementTextItems,
  sameNativeTextOwnership,
} from './native-text-matching.js';

function run(text, x, width, index) {
  return {
    decodedText: text,
    streamObjectId: '10 0 R',
    operatorIndex: index,
    ownershipState: 'source',
    eligibility: { eligible: true },
    geometry: [x, 700, width, 12],
  };
}

test('matches a PDF.js span to complete consecutive source operators', () => {
  const matches = matchNativeTextSources([
    { str: 'Hello world', width: 60, transform: [12, 0, 0, 12, 72, 700] },
  ], [run('Hello ', 72, 30, 0), run('world', 102, 30, 1)]);
  assert.deepEqual(matches.get(0)?.map((source) => source.operatorIndex), [0, 1]);
});

test('fails closed on partial or geometrically ambiguous mappings', () => {
  const partial = matchNativeTextSources([
    { str: 'Hello', width: 30, transform: [12, 0, 0, 12, 72, 700] },
  ], [run('Hello world', 72, 60, 0)]);
  assert.equal(partial.size, 0);

  const misplaced = matchNativeTextSources([
    { str: 'Hello', width: 30, transform: [12, 0, 0, 12, 300, 700] },
  ], [run('Hello', 72, 30, 0)]);
  assert.equal(misplaced.size, 0);
});

test('links every PDF.js fragment to one atomic source operator', () => {
  const source = run('The quick fox', 54, 90, 0);
  const matches = matchNativeTextSources([
    { str: 'The', width: 20, transform: [12, 0, 0, 12, 54, 700] },
    { str: ' ', width: 5, transform: [12, 0, 0, 12, 74, 700] },
    { str: 'quick', width: 35, transform: [12, 0, 0, 12, 79, 700] },
    { str: ' ', width: 5, transform: [12, 0, 0, 12, 114, 700] },
    { str: 'fox', width: 25, transform: [12, 0, 0, 12, 119, 700] },
  ], [source]);
  assert.equal(matches.size, 5);
  assert.ok([...matches.values()].every((sources) => sources[0] === source));
});

test('recognizes the same native operator ownership independent of source ordering', () => {
  const first = { markerId: 'native-a', streamObjectId: '10 0 R', operatorIndex: 2 };
  const second = { markerId: 'native-b', streamObjectId: '11 0 R', operatorIndex: 5 };
  assert.equal(sameNativeTextOwnership([first, second], [second, first]), true);
  assert.equal(sameNativeTextOwnership([first], [second]), false);
  assert.equal(sameNativeTextOwnership([], []), false);
});

test('maps a saved owned replacement back to its PDF.js text items', () => {
  const matches = matchOwnedReplacementTextItems([
    { str: 'The quick ', transform: [15, 0, 0, 15, 54, 479] },
    { str: 'red fox', transform: [15, 0, 0, 15, 130, 479] },
  ], [{ id: 'edit-1', newText: 'The quick red fox', pdfX: 54, pdfY: 479 }]);
  assert.deepEqual([...matches.entries()], [[0, 'edit-1'], [1, 'edit-1']]);
});
