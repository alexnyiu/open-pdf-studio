import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from './document-helpers.ts';

test('new file-backed and untitled documents default to continuous view', () => {
  assert.equal(createDocument('/tmp/example.pdf').viewMode, 'continuous');
  assert.equal(createDocument().viewMode, 'continuous');
});

test('changing one document view does not change the default for another document', () => {
  const document = createDocument('/tmp/first.pdf');
  document.viewMode = 'single';

  assert.equal(document.viewMode, 'single');
  assert.equal(createDocument('/tmp/second.pdf').viewMode, 'continuous');
});
