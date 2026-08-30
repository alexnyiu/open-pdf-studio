import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureRenderPublicationToken,
  cancelStalePdfJsRenderTasks,
  clearRenderPublicationDiagnosticsForTests,
  publishRenderResultIfCurrent,
  renderPublicationDiagnosticsSnapshot,
  renderPublicationTokenIsCurrent,
  trackPdfJsRenderTask,
} from './render-publication-token.js';
import { createInitialDocumentRevisionState } from '../core/document-revision-state.runtime.js';

function documentOwner() {
  const revisionState = createInitialDocumentRevisionState();
  revisionState.contentRevision = 1;
  revisionState.serializedRevision = 1;
  revisionState.persistedRevision = 1;
  revisionState.livePdfRevision = 1;
  revisionState.pageContentRevisions[1] = 1;
  return {
    id: 'doc-render-token',
    lifecycleGeneration: 4,
    pdfDoc: { id: 'proxy-a' },
    revisionState,
    pageRenderRevisions: revisionState.pageContentRevisions,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('a complete render publication token accepts only its exact owner revision', () => {
  const document = documentOwner();
  const token = captureRenderPublicationToken(document, 1, 'single-page');
  assert.equal(renderPublicationTokenIsCurrent(token, document), true);
  assert.equal(token.documentId, document.id);
  assert.equal(token.lifecycleGeneration, 4);
  assert.equal(token.pdfDocument, document.pdfDoc);
  assert.equal(token.contentRevision, 1);
  assert.equal(token.livePdfRevision, 1);
  assert.equal(token.pageRevision, 1);
  assert.equal(token.publishedPageRevision, 1);
  assert.equal(token.revisionAuthority, 'proxy');
});

test('a document-wide mutation without page keys publishes at contentRevision', () => {
  const document = documentOwner();
  document.revisionState.contentRevision = 2;
  document.revisionState.pageContentRevisions = {};
  document.pageRenderRevisions = document.revisionState.pageContentRevisions;
  const token = captureRenderPublicationToken(document, 1, 'blank-document');
  assert.equal(token.pageRevision, 2);
  assert.equal(token.publishedPageRevision, 1);
  assert.equal(renderPublicationTokenIsCurrent(token, document), true);
});

test('model publication explicitly owns a page revision newer than the live proxy', () => {
  const document = documentOwner();
  document.revisionState.contentRevision = 2;
  document.revisionState.pageContentRevisions[1] = 2;
  const proxy = captureRenderPublicationToken(document, 1, 'proxy');
  const model = captureRenderPublicationToken(document, 1, 'model', {
    revisionAuthority: 'model',
  });
  assert.equal(proxy.publishedPageRevision, 1);
  assert.equal(model.publishedPageRevision, 2);
  assert.equal(model.revisionAuthority, 'model');
});

const races = [
  ['old single-page raster', 'single-page-raster', (document) => { document.revisionState.pageContentRevisions[1] = 2; }],
  ['old continuous render', 'continuous-page', (document) => {
    document.pdfDoc = { id: 'proxy-b' };
    document.lifecycleGeneration += 1;
  }],
  ['tile generation', 'tile', (document) => { document.revisionState.pageContentRevisions[1] = 2; }],
  ['low-resolution preview', 'preview', (document) => { document.revisionState.contentRevision = 2; }],
  ['old live PDF revision', 'live-pdf-revision', (document) => {
    document.revisionState.livePdfRevision = 2;
  }],
  ['thumbnail render', 'thumbnail', (document) => {
    document.pdfDoc = { id: 'proxy-b' };
    document.lifecycleGeneration += 1;
  }],
  ['editable metadata extraction', 'editable-metadata', (document) => {
    document.pdfDoc = { id: 'proxy-b' };
    document.lifecycleGeneration += 1;
  }],
  ['whole-document preload', 'whole-pdf-preload', (document) => { document.revisionState.contentRevision = 2; }],
  ['native render result', 'native-render', (document) => { document.revisionState.pageContentRevisions[1] = 2; }],
];

for (const [label, source, invalidate] of races) {
  test(`paused ${label} cannot publish after its revision changes`, async () => {
    clearRenderPublicationDiagnosticsForTests();
    const document = documentOwner();
    const token = captureRenderPublicationToken(document, 1, source);
    const pause = deferred();
    let publications = 0;
    let releases = 0;
    const work = (async () => {
      const result = await pause.promise;
      return publishRenderResultIfCurrent({
        token,
        documentState: document,
        result,
        publish: () => { publications += 1; },
        release: () => { releases += 1; },
      });
    })();
    invalidate(document);
    pause.resolve({ bitmap: { close() {} } });
    assert.equal(await work, false);
    assert.equal(publications, 0);
    assert.equal(releases, 1);
    assert.equal(renderPublicationDiagnosticsSnapshot().rejectedCounts[`${source}:stale-before-publication`], 1);
  });
}

test('a current native result publishes without being released', () => {
  const document = documentOwner();
  const token = captureRenderPublicationToken(document, 1, 'native-render');
  let published = 0;
  let released = 0;
  assert.equal(publishRenderResultIfCurrent({
    token,
    documentState: document,
    result: { bitmap: {} },
    publish: () => { published += 1; },
    release: () => { released += 1; },
  }), true);
  assert.equal(published, 1);
  assert.equal(released, 0);
});

test('tracked PDF.js work is cancelled when its owner revision changes', async () => {
  clearRenderPublicationDiagnosticsForTests();
  const document = documentOwner();
  const token = captureRenderPublicationToken(document, 1, 'pdfjs-task');
  const pause = deferred();
  let cancelled = 0;
  trackPdfJsRenderTask(token, document, {
    promise: pause.promise,
    cancel: () => { cancelled += 1; },
  });
  assert.equal(renderPublicationDiagnosticsSnapshot().activePdfJsTasks, 1);
  document.revisionState.pageContentRevisions[1] = 2;
  assert.equal(cancelStalePdfJsRenderTasks(document), 1);
  assert.equal(cancelled, 1);
  assert.equal(renderPublicationDiagnosticsSnapshot().activePdfJsTasks, 0);
  pause.resolve();
  await pause.promise;
});
