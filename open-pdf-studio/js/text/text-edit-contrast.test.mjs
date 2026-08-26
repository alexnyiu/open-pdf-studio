import test from 'node:test';
import assert from 'node:assert/strict';

import {
  colorContrastRatio,
  documentNeedsContrastAid,
  editableRunPresentation,
} from './text-edit-contrast.js';

test('contrast helper preserves canonical colors and adds the strongest editor-only halo', () => {
  const pale = editableRunPresentation('#f4f4f4', '#ffffff');
  assert.equal(pale.color, '#f4f4f4');
  assert.equal(pale.contrastAid, true);
  assert.equal(pale.haloColor, '#000000');
  assert.match(pale.textShadow, /-1px 0 #000000/);

  const dark = editableRunPresentation('#111111', '#000000');
  assert.equal(dark.color, '#111111');
  assert.equal(dark.contrastAid, true);
  assert.equal(dark.haloColor, '#ffffff');

  const blue = editableRunPresentation('#0057a8', '#ffffff');
  assert.equal(blue.color, '#0057a8');
  assert.equal(blue.contrastAid, false);
  assert.equal(blue.textShadow, 'none');
});

test('contrast classification uses the 4.5 to 1 editing threshold', () => {
  assert.ok(colorContrastRatio('#000000', '#ffffff') > 20);
  assert.equal(editableRunPresentation('#777777', '#ffffff').contrastAid, true);
  assert.equal(editableRunPresentation('#767676', '#ffffff').contrastAid, false);
});

test('mixed-color documents request a visibility aid without mutating runs', () => {
  const document = { lines: [{ runs: [
    { text: 'Blue', color: '#0057a8' },
    { text: ' Pale', color: '#f4f4f4' },
  ] }] };
  const before = structuredClone(document);
  assert.equal(documentNeedsContrastAid(document, '#ffffff'), true);
  assert.deepEqual(document, before);
});
