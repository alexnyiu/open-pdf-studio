import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalFreeTextContent } from './free-text-content.js';
import {
  createRichTextDocument,
  createTextLine,
  createTextRun,
} from '../../text/rich-text.js';

test('owned soft wraps never become authored newlines after reopen', () => {
  const richText = createRichTextDocument([
    createTextLine([createTextRun('Callout production')], { baseline: 100, breakAfter: 'soft' }),
    createTextLine([createTextRun(' acceptance')], { baseline: 116, breakAfter: 'hard' }),
  ], { x: 10, y: 80, width: 150, height: 60, rotation: 0 });

  assert.equal(canonicalFreeTextContent({
    contentsObj: { str: 'Callout production acceptance' },
    textContent: ['Callout production', 'acceptance'],
  }, richText), 'Callout production acceptance');
});

test('PDF Contents wins over appearance wrapping for foreign FreeText', () => {
  assert.equal(canonicalFreeTextContent({
    contentsObj: { str: 'Canonical sentence' },
    contents: 'Legacy sentence',
    textContent: ['Canonical', 'sentence'],
  }), 'Canonical sentence');
  assert.equal(canonicalFreeTextContent({
    contents: 'Legacy canonical sentence',
    textContent: ['Legacy canonical', 'sentence'],
  }), 'Legacy canonical sentence');
});

test('appearance text remains a fail-soft fallback when Contents is absent', () => {
  assert.equal(canonicalFreeTextContent({ textContent: ['First', 'Second'] }), 'First\nSecond');
  assert.equal(canonicalFreeTextContent({}), '');
});
