import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialDocumentRevisionState } from '../core/document-revision-state.runtime.js';
import {
  clearDocumentPerformance,
  effectiveDocumentPageRevision,
  ensureDocumentPageGeometryIndex,
  initializeDocumentPerformance,
} from './document-performance.js';

const priorWindow = globalThis.window;
const priorCustomEvent = globalThis.CustomEvent;

test.afterEach(() => {
  if (priorWindow === undefined) delete globalThis.window;
  else globalThis.window = priorWindow;
  if (priorCustomEvent === undefined) delete globalThis.CustomEvent;
  else globalThis.CustomEvent = priorCustomEvent;
});

test('document-wide mutations use the content revision as the effective page revision', () => {
  const documentState = {
    pageRenderRevisions: { 2: 3 },
    revisionState: {
      contentRevision: 7,
      pageContentRevisions: { 2: 3 },
    },
  };

  assert.equal(effectiveDocumentPageRevision(documentState, 1), 7);
  assert.equal(effectiveDocumentPageRevision(documentState, 2), 3);
});

test('structural proxy replacement rebuilds geometry under the new saved revision identity', async () => {
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  };
  const revisionState = createInitialDocumentRevisionState();
  revisionState.contentRevision = 1;
  const firstProxy = { numPages: 1 };
  const documentState = {
    id: 'geometry-document',
    lifecycleGeneration: 1,
    revisionState,
    pdfDoc: firstProxy,
    filePath: null,
    currentPage: 1,
    pageDims: { 1: { widthPt: 100, heightPt: 200 } },
    pageRotations: {},
  };
  await initializeDocumentPerformance(documentState);
  assert.equal(documentState.pageGeometryIndex.entries.length, 1);
  assert.equal(documentState.pageGeometryRevision.pdfDocument, firstProxy);

  const secondProxy = { numPages: 2 };
  documentState.pdfDoc = secondProxy;
  documentState.lifecycleGeneration = 2;
  documentState.revisionState.contentRevision = 2;
  documentState.pageDims = {
    1: { widthPt: 100, heightPt: 200 },
    2: { widthPt: 300, heightPt: 400 },
  };
  const rebuilt = await ensureDocumentPageGeometryIndex(documentState);
  assert.equal(rebuilt.entries.length, 2);
  assert.equal(documentState.pageGeometryRevision.pdfDocument, secondProxy);
  assert.equal(documentState.pageGeometryRevision.lifecycleGeneration, 2);
  assert.equal(documentState.pageGeometryRevision.contentRevision, 2);
  clearDocumentPerformance(documentState);
});
