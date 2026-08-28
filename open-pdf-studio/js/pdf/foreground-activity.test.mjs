import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPdfForegroundIdle,
  notePdfForegroundActivity,
  pdfForegroundActivitySnapshot,
  resetPdfForegroundActivityForTests,
} from './foreground-activity.js';

test('overlapping foreground activity extends one shared settle window', async () => {
  resetPdfForegroundActivityForTests();
  assert.equal(isPdfForegroundIdle(), true);
  const first = notePdfForegroundActivity('scroll', 20);
  const second = notePdfForegroundActivity('zoom', 40);
  assert.equal(second, first + 1);
  assert.equal(pdfForegroundActivitySnapshot().active, true);
  assert.equal(isPdfForegroundIdle(), false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(isPdfForegroundIdle(), true);
});
