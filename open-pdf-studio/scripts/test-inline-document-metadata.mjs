import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPlaywrightFailureArtifacts } from './playwright-failure-artifacts.mjs';

let executablePath;
try {
  await access(chromium.executablePath());
} catch {
  executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
}

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
let page;
let failureArtifacts;

try {
  page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  failureArtifacts = await startPlaywrightFailureArtifacts(page.context(), 'inline-document-metadata');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  await page.goto('http://127.0.0.1:3041', { waitUntil: 'domcontentloaded' });

  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { populateDocInfo } = await import('/js/solid/stores/propertiesStore.js');
    const metadata = {
      title: 'Original title', author: 'Original author', subject: '', keywords: 'alpha',
      creator: 'Original creator', producer: 'Original producer',
      creationDate: '2026-08-25T10:11:12.123456Z',
      modificationDate: '2026-08-25T13:14:15.000Z',
    };
    const pdfDoc = {
      numPages: 1,
      getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }) }),
      getMetadata: async () => ({ info: { PDFFormatVersion: '1.7' } }),
    };
    const createDocument = (id, title) => ({
      id, filePath: `/tmp/${id}.pdf`, currentPage: 1, pdfDoc,
      metadata: { ...metadata, title }, annotations: [], selectedAnnotations: [],
      undoStack: [], redoStack: [], savedUndoStackLength: 0, modified: false,
    });
    state.documents = [
      createDocument('inline-metadata-one', metadata.title),
      createDocument('inline-metadata-two', 'Second document'),
    ];
    state.activeDocumentIndex = 0;
    await populateDocInfo();
  });

  const value = (field) => page.locator(`[data-metadata-field="${field}"]`);
  const editor = (field) => page.locator(`[data-metadata-editor="${field}"]`);

  await value('title').dblclick();
  await editor('title').fill('設計図 – crisp metadata');
  await editor('title').press('Enter');
  await value('title').waitFor({ state: 'visible' });
  assert.equal(await value('title').innerText(), '設計図 – crisp metadata');
  let state = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const doc = state.documents[0];
    return {
      title: doc.metadata.title,
      creationDate: doc.metadata.creationDate,
      undo: doc.undoStack.length,
      modified: doc.modified,
    };
  });
  assert.deepEqual(state, {
    title: '設計図 – crisp metadata',
    creationDate: '2026-08-25T10:11:12.123456Z',
    undo: 1,
    modified: true,
  });

  await page.evaluate(async () => {
    const { undo } = await import('/js/core/undo-manager.js');
    await undo();
  });
  assert.equal(await value('title').innerText(), 'Original title');
  await page.evaluate(async () => {
    const { redo } = await import('/js/core/undo-manager.js');
    await redo();
  });
  assert.equal(await value('title').innerText(), '設計図 – crisp metadata');

  await value('author').focus();
  await value('author').press('Enter');
  await editor('author').fill('Cancelled author');
  await editor('author').press('Escape');
  assert.equal(await value('author').innerText(), 'Original author');

  await value('subject').focus();
  await value('subject').press('Space');
  await editor('subject').fill('Keyboard subject');
  await editor('subject').press('Enter');
  assert.equal(await value('subject').innerText(), 'Keyboard subject');

  await value('keywords').dblclick();
  await editor('keywords').fill('alpha, beta, γ');
  await editor('keywords').evaluate((node) => node.blur());
  await value('keywords').waitFor({ state: 'visible' });
  assert.equal(await value('keywords').innerText(), 'alpha, beta, γ');

  const beforeNoop = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[0].undoStack.length;
  });
  await value('keywords').dblclick();
  await editor('keywords').press('Enter');
  const afterNoop = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[0].undoStack.length;
  });
  assert.equal(afterNoop, beforeNoop, 'no-op metadata edits must not create undo commands');

  await value('creationDate').dblclick();
  await editor('creationDate').press('Enter');
  assert.equal(await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[0].metadata.creationDate;
  }), '2026-08-25T10:11:12.123456Z', 'untouched date must preserve its original ISO bytes');

  await page.evaluate(async () => {
    const { showDocPropertiesDialog } = await import('/js/ui/chrome/dialogs.js');
    await showDocPropertiesDialog();
  });
  const propertiesDialog = page.locator('.doc-props-dialog');
  await propertiesDialog.waitFor({ state: 'visible' });
  const modalInputs = propertiesDialog.locator('.doc-props-edit-row input');
  assert.equal(await modalInputs.nth(6).getAttribute('step'), '0.001');
  await modalInputs.nth(0).fill('Modal metadata title');
  await propertiesDialog.locator('.doc-props-save').click();
  await propertiesDialog.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return {
      title: state.documents[0].metadata.title,
      creationDate: state.documents[0].metadata.creationDate,
    };
  }), {
    title: 'Modal metadata title',
    creationDate: '2026-08-25T10:11:12.123456Z',
  }, 'full metadata modal must preserve untouched source timestamp bytes');

  assert.equal(await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { showDocPropertiesDialog } = await import('/js/ui/chrome/dialogs.js');
    const { getDialogs } = await import('/js/solid/stores/dialogStore.js');
    const originalPdfDocument = state.documents[0].pdfDoc;
    let resolveMetadata;
    state.documents[0].pdfDoc = {
      numPages: 1,
      getMetadata: () => new Promise((resolve) => { resolveMetadata = resolve; }),
      getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }) }),
    };
    const pending = showDocPropertiesDialog();
    state.activeDocumentIndex = 1;
    resolveMetadata({ info: { PDFFormatVersion: 'stale' } });
    await pending;
    state.activeDocumentIndex = 0;
    state.documents[0].pdfDoc = originalPdfDocument;
    return getDialogs().some((dialog) => dialog.name === 'doc-properties');
  }), false, 'stale asynchronous document-properties data must not open a modal');

  await value('creator').dblclick();
  await editor('creator').fill('');
  await editor('creator').press('Enter');
  assert.equal(await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[0].metadata.creator;
  }), '');

  await value('title').dblclick();
  await editor('title').fill('Tabbed title');
  await editor('title').press('Tab');
  await editor('author').waitFor({ state: 'visible' });
  assert.equal(await value('title').innerText(), 'Tabbed title');
  await editor('author').fill('Tabbed author');
  await editor('author').press('Enter');
  assert.equal(await value('author').innerText(), 'Tabbed author');

  await value('author').dblclick();
  await editor('author').press('Shift+Tab');
  await editor('title').waitFor({ state: 'visible' });
  await editor('title').press('Escape');

  await value('creationDate').dblclick();
  await editor('creationDate').fill('2026-09-01T12:34:56');
  await editor('creationDate').press('Enter');
  const savedDate = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[0].metadata.creationDate;
  });
  assert.equal(savedDate, new Date('2026-09-01T12:34:56').toISOString());

  await value('modificationDate').dblclick();
  assert.equal(await editor('modificationDate').getAttribute('type'), 'datetime-local');
  assert.equal(await editor('modificationDate').getAttribute('step'), '0.001');
  await editor('modificationDate').fill('2026-09-02T01:02:03');
  await editor('modificationDate').press('Enter');
  assert.equal(await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[0].metadata.modificationDate;
  }), new Date('2026-09-02T01:02:03').toISOString());

  await value('producer').dblclick();
  await editor('producer').fill('Committed producer');
  await editor('producer').press('Enter');
  assert.equal(await value('producer').innerText(), 'Committed producer');

  await page.locator('[data-metadata-readonly="pdfVersion"]').dblclick();
  assert.equal(await page.locator('[data-metadata-editor]').count(), 0,
    'PDF Version must remain read-only');

  await value('producer').dblclick();
  await editor('producer').fill('Must not cross tabs');
  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    state.activeDocumentIndex = 1;
    document.body.focus();
  });
  await page.waitForTimeout(50);
  const staleState = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents.map((doc) => doc.metadata.producer);
  });
  assert.deepEqual(staleState, ['Committed producer', 'Original producer']);

  const staleInfo = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { docInfo, populateDocInfo } = await import('/js/solid/stores/propertiesStore.js');
    let resolveOldPage;
    const originalPdfDocument = state.documents[0].pdfDoc;
    state.documents[0].pdfDoc = {
      numPages: 9,
      getPage: () => new Promise((resolve) => { resolveOldPage = resolve; }),
      getMetadata: async () => ({ info: { PDFFormatVersion: 'stale' } }),
    };
    state.activeDocumentIndex = 0;
    const oldRequest = populateDocInfo();
    state.activeDocumentIndex = 1;
    await populateDocInfo();
    resolveOldPage({ getViewport: () => ({ width: 72, height: 72 }) });
    await oldRequest;
    state.documents[0].pdfDoc = originalPdfDocument;
    return { filename: docInfo.filename, title: docInfo.title, version: docInfo.version };
  });
  assert.deepEqual(staleInfo, {
    filename: 'inline-metadata-two.pdf',
    title: 'Second document',
    version: '1.7',
  }, 'late document info must not overwrite the active owner snapshot');

  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { populateDocInfo } = await import('/js/solid/stores/propertiesStore.js');
    state.activeDocumentIndex = 0;
    await populateDocInfo();
  });
  await value('producer').dblclick();
  await editor('producer').fill('Closed tab write');
  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    state.documents.splice(0, 1);
    state.activeDocumentIndex = 0;
    document.body.focus();
  });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[0].metadata.producer;
  }), 'Original producer');
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));

  console.log('Inline document metadata editing, keyboard flow, undo, and stale-document guard test passed');
} catch (error) {
  await failureArtifacts?.capture(page);
  throw error;
} finally {
  await failureArtifacts?.discard();
  await browser.close();
}
