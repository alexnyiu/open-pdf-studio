import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { viewportOwnsDocumentZoom } from './viewport-zoom-ownership.js';

const documentState = {
  id: 'document-a',
  lifecycleGeneration: 3,
  viewMode: 'single',
};

const viewportState = {
  active: true,
  documentId: 'document-a',
  documentLifecycleGeneration: 3,
};

test('matching single-page viewport owns document zoom publication', () => {
  assert.equal(viewportOwnsDocumentZoom(documentState, viewportState), true);
});

test('continuous cold preview cannot overwrite the document zoom', () => {
  assert.equal(viewportOwnsDocumentZoom({
    ...documentState,
    viewMode: 'continuous',
  }, viewportState), false);
});

test('stale document or lifecycle viewport cannot overwrite document zoom', () => {
  assert.equal(viewportOwnsDocumentZoom(documentState, {
    ...viewportState,
    documentId: 'document-b',
  }), false);
  assert.equal(viewportOwnsDocumentZoom(documentState, {
    ...viewportState,
    documentLifecycleGeneration: 2,
  }), false);
  assert.equal(viewportOwnsDocumentZoom(documentState, {
    ...viewportState,
    active: false,
  }), false);
});

test('viewport render gates its document scale mirror through owner identity', async () => {
  const source = await readFile(new URL('./pdf-viewport.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /if \(viewportOwnsDocumentZoom\(doc, viewport\)\) doc\.scale = viewport\.zoom;/u,
  );
});
