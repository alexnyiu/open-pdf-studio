import assert from 'node:assert/strict';
import test from 'node:test';

import {
  documentPreloadMode,
  normalizePdfPreloadMode,
  shouldPreloadEntireDocument,
  shouldDeepPreloadDocument,
  shouldPreloadNearby,
} from './preload-policy.js';
import { createPdfPerformanceProfile } from './render-performance.js';

test('legacy preload preferences migrate to adaptive or off', () => {
  assert.equal(normalizePdfPreloadMode(undefined, true), 'adaptive');
  assert.equal(normalizePdfPreloadMode(undefined, false), 'off');
  assert.equal(documentPreloadMode({ pdfPreloadMode: 'entire' }), 'entire');
});

test('large-document entire preload remains navigation-only', () => {
  const small = {
    performanceProfile: createPdfPerformanceProfile({ pageCount: 12, fileBytes: 1 }),
  };
  const large = {
    performanceProfile: createPdfPerformanceProfile({ pageCount: 108, fileBytes: 1 }),
  };
  assert.equal(shouldDeepPreloadDocument(small), true);
  assert.equal(shouldDeepPreloadDocument(large), false);
  assert.equal(shouldPreloadEntireDocument(large, { pdfPreloadMode: 'entire' }), true,
    'the navigation pass may still visit all pages');
});

test('adaptive mode warms nearby pages and only fully prewarms bounded documents', () => {
  const preferences = { pdfPreloadMode: 'adaptive' };
  assert.equal(shouldPreloadNearby(preferences), true);
  assert.equal(shouldPreloadEntireDocument({
    performanceProfile: createPdfPerformanceProfile({ pageCount: 12, fileBytes: 1 }),
  }, preferences), true);
  assert.equal(shouldPreloadEntireDocument({
    performanceProfile: createPdfPerformanceProfile({ pageCount: 108, fileBytes: 1 }),
  }, preferences), false);
});
