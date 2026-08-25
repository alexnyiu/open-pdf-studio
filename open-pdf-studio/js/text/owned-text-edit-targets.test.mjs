import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedTextEditLineTargets } from './owned-text-edit-targets.js';

test('creates stable line hit regions from canonical rich-text geometry', () => {
  const record = {
    id: 'edit-stable',
    richText: {
      region: { x: 100, y: 450, width: 180, height: 28 },
      lines: [
        {
          id: 'line-a', baseline: 470, alignment: 'left',
          runs: [{ text: 'Mixed ', size: 10, geometry: { width: 32 } }, { text: 'style', size: 10, geometry: { width: 24 } }],
        },
        {
          id: 'line-b', baseline: 458, alignment: 'right',
          runs: [{ text: 'second line', size: 10, shaped: { advance: 70 } }],
        },
      ],
    },
  };
  const targets = ownedTextEditLineTargets(record);
  assert.deepEqual(targets.map((target) => target.id), [
    'edit-stable:line:line-a', 'edit-stable:line:line-b',
  ]);
  assert.equal(targets[0].width, 56);
  assert.equal(targets[1].x, 210);
  assert.equal(targets[1].recordId, 'edit-stable');
});
