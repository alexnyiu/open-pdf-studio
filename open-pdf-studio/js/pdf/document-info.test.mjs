import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectDocumentInfoSnapshot,
  createEmptyDocumentInfo,
} from './document-info.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeDocument(pdfDocument) {
  return {
    id: 'owner',
    lifecycleGeneration: 4,
    filePath: '/tmp/owned.pdf',
    currentPage: 2,
    pdfDoc: pdfDocument,
    metadata: {
      title: 'Owned title',
      author: 'Author',
      subject: '',
      keywords: 'one, two',
      creator: 'Creator',
      producer: 'Producer',
      creationDate: '2026-08-25T10:11:12.123Z',
      modificationDate: null,
    },
    annotations: [{ page: 1 }, { page: 2 }, { page: 2 }],
  };
}

test('document info is collected as one complete owner snapshot', async () => {
  const documentState = makeDocument({
    numPages: 3,
    getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }) }),
    getMetadata: async () => ({ info: { PDFFormatVersion: '1.7' } }),
  });
  const result = await collectDocumentInfoSnapshot(documentState, {
    noFileOpen: 'No file open',
    onPageCount: ({ count, page }) => `${count}@${page}`,
  });
  assert.equal(result.filename, 'owned.pdf');
  assert.equal(result.pages, '2 / 3');
  assert.equal(result.pageSize, '215.9 x 279.4 mm');
  assert.equal(result.version, '1.7');
  assert.equal(result.title, 'Owned title');
  assert.equal(result.subject, '-');
  assert.equal(result.annotCount, '3');
  assert.equal(result.annotPage, '2@2');
  assert.notEqual(result.creationDate, '-');
});

test('document info aborts after a stale getPage result', async () => {
  const page = deferred();
  let current = true;
  let metadataReads = 0;
  const pending = collectDocumentInfoSnapshot(makeDocument({
    numPages: 3,
    getPage: () => page.promise,
    getMetadata: async () => {
      metadataReads += 1;
      return { info: { PDFFormatVersion: '1.7' } };
    },
  }), { isCurrent: () => current });
  current = false;
  page.resolve({ getViewport: () => ({ width: 1, height: 1 }) });
  assert.equal(await pending, null);
  assert.equal(metadataReads, 0);
});

test('document info aborts after a stale metadata result', async () => {
  const metadata = deferred();
  let current = true;
  const pending = collectDocumentInfoSnapshot(makeDocument({
    numPages: 3,
    getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }) }),
    getMetadata: () => metadata.promise,
  }), { isCurrent: () => current });
  await Promise.resolve();
  current = false;
  metadata.resolve({ info: { PDFFormatVersion: '2.0' } });
  assert.equal(await pending, null);
});

test('no-document snapshot resets every field', async () => {
  assert.deepEqual(
    await collectDocumentInfoSnapshot(null, { noFileOpen: 'No file open' }),
    createEmptyDocumentInfo('No file open'),
  );
});
