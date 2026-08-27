import assert from 'node:assert/strict';
import test from 'node:test';

import {
  scannedFontClassFromFamily,
  scannedStyleSnapshot,
  syncScannedStyleTouchedKey,
} from './scanned-style-draft.js';

const initial = {
  family: 'Arial',
  size: 12,
  color: '#000000',
  bold: false,
  italic: false,
  alignment: 'left',
};

test('OCR style snapshots compare persisted classes instead of display aliases', () => {
  assert.equal(scannedFontClassFromFamily('Helvetica'), 'sans-serif');
  assert.equal(scannedFontClassFromFamily('Liberation Sans'), 'sans-serif');
  assert.equal(scannedFontClassFromFamily('sans-serif'), 'sans-serif');
  assert.equal(scannedFontClassFromFamily('Times New Roman'), 'serif');
  assert.equal(scannedFontClassFromFamily('Liberation Mono'), 'monospace');
  assert.deepEqual(scannedStyleSnapshot({ ...initial, family: 'Helvetica' }),
    scannedStyleSnapshot({ ...initial, family: 'Arial' }));
});

test('unchanged OCR properties do not latch the draft dirty', () => {
  const baseline = scannedStyleSnapshot(initial);
  const touched = new Set();

  assert.equal(syncScannedStyleTouchedKey(touched, baseline,
    { ...initial, family: 'Helvetica' }, 'fontClass'), false);
  assert.equal(syncScannedStyleTouchedKey(touched, baseline,
    { ...initial, color: '#000000'.toUpperCase() }, 'textColor'), false);
  assert.deepEqual([...touched], []);
});

test('OCR style markers describe the net delta and clear after a revert', () => {
  const baseline = scannedStyleSnapshot(initial);
  const touched = new Set();
  const changed = { ...initial, size: 18, alignment: 'right' };

  assert.equal(syncScannedStyleTouchedKey(touched, baseline, changed, 'fontSize'), true);
  assert.equal(syncScannedStyleTouchedKey(touched, baseline, changed, 'alignment'), true);
  assert.deepEqual([...touched].sort(), ['alignment', 'fontSize']);

  assert.equal(syncScannedStyleTouchedKey(touched, baseline, initial, 'fontSize'), false);
  assert.equal(syncScannedStyleTouchedKey(touched, baseline, initial, 'alignment'), false);
  assert.deepEqual([...touched], []);
});
