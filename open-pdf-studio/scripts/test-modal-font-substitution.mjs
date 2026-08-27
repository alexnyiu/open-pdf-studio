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
  failureArtifacts = await startPlaywrightFailureArtifacts(page.context(), 'modal-font-substitution');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  await page.goto('http://127.0.0.1:3041', { waitUntil: 'domcontentloaded' });

  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { requestFontSubstitutionApproval } = await import('/js/text/font-substitution-approval.js');
    const owner = {
      id: 'font-owner',
      lifecycleGeneration: 7,
      fontSubstitutionApprovals: new Map(),
      filePath: '/tmp/font-owner.pdf',
      currentPage: 1,
      pdfDoc: null,
      metadata: {},
      annotations: [],
      textEdits: [],
      undoStack: [],
      redoStack: [],
    };
    state.documents = [owner];
    state.activeDocumentIndex = 0;
    window.__fontOwner = owner;
    window.__fontApprovalPromise = requestFontSubstitutionApproval({
      documentState: owner,
      sourceFonts: ['Helvetica Neue'],
      sampleText: 'Source-owned sample',
      scope: 'paragraph',
    });
  });

  const fontDialog = page.locator('.font-substitution-dialog');
  await fontDialog.waitFor({ state: 'visible' });
  assert.match(await fontDialog.innerText(), /Helvetica Neue/u);
  assert.match(await fontDialog.innerText(), /Liberation Sans/u);
  assert.match(await fontDialog.innerText(), /Source-owned sample/u);
  assert.equal(await page.locator('.app-modal-background').evaluate((element) => element.inert), true);
  assert.equal(await page.locator('.nonmodal-dialog-background').evaluate((element) => element.inert), true);

  await page.evaluate(async () => {
    const { openDialog } = await import('/js/solid/stores/dialogStore.js');
    openDialog('message', { title: 'Top modal', message: 'Only this modal handles Escape.' });
  });
  const messageDialog = page.locator('.message-dialog');
  await messageDialog.waitFor({ state: 'visible' });
  assert.equal(await fontDialog.locator('xpath=..').getAttribute('aria-hidden'), 'true');
  assert.equal(await messageDialog.locator('xpath=..').getAttribute('aria-hidden'), null);
  await page.keyboard.press('Escape');
  await messageDialog.waitFor({ state: 'detached' });
  await fontDialog.waitFor({ state: 'visible' });
  assert.equal(await fontDialog.locator('xpath=..').getAttribute('aria-hidden'), null);

  await fontDialog.locator('input[type="checkbox"]').check();
  await fontDialog.getByRole('button', { name: 'Use substitute' }).click();
  const approval = await page.evaluate(() => window.__fontApprovalPromise);
  assert.equal(approval.approved, true);
  assert.equal(approval.faceId, 'liberation-sans-regular');
  assert.equal(await page.evaluate(() => window.__fontOwner.fontSubstitutionApprovals.size), 1);
  assert.equal(await page.locator('.app-modal-background').evaluate((element) => element.inert), false);

  const remembered = await page.evaluate(async () => {
    const { requestFontSubstitutionApproval } = await import('/js/text/font-substitution-approval.js');
    return requestFontSubstitutionApproval({
      documentState: window.__fontOwner,
      sourceFonts: ['Helvetica Neue'],
      sampleText: 'No second prompt',
      scope: 'paragraph',
    });
  });
  assert.equal(remembered.approved, true);
  assert.equal(await page.locator('.font-substitution-dialog').count(), 0);

  await page.evaluate(async () => {
    const { openDialog } = await import('/js/solid/stores/dialogStore.js');
    window.__fontOwner.stylePresets = [{
      id: 'modal-preset',
      name: 'Modal preset',
      props: { color: '#000000', lineWidth: 1 },
    }];
    openDialog('style-preset-manage');
  });
  const manageDialog = page.locator('.style-preset-manage-dialog');
  await manageDialog.waitFor({ state: 'visible' });
  assert.equal(await manageDialog.locator('.style-preset-list-row input').inputValue(), 'Modal preset');
  assert.equal(await page.locator('.app-modal-background').evaluate((element) => element.inert), true);

  await page.evaluate(async () => {
    const { openDialog } = await import('/js/solid/stores/dialogStore.js');
    openDialog('message', { title: 'Preset stack', message: 'Manage remains below this dialog.' });
  });
  await messageDialog.waitFor({ state: 'visible' });
  assert.equal(await manageDialog.locator('xpath=..').getAttribute('aria-hidden'), 'true');
  await page.keyboard.press('Escape');
  await messageDialog.waitFor({ state: 'detached' });
  await manageDialog.waitFor({ state: 'visible' });
  assert.equal(await manageDialog.locator('xpath=..').getAttribute('aria-hidden'), null);
  await page.keyboard.press('Escape');
  await manageDialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.app-modal-background').evaluate((element) => element.inert), false);

  await page.evaluate(async () => {
    const { openDialog } = await import('/js/solid/stores/dialogStore.js');
    openDialog('style-preset-create');
  });
  const createDialog = page.locator('.style-preset-create-dialog');
  await createDialog.waitFor({ state: 'visible' });
  const nameInput = createDialog.locator('#style-preset-name-input');
  await nameInput.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.activeElement?.id === 'style-preset-name-input');
  await page.keyboard.press('Escape');
  await createDialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.app-modal-background').evaluate((element) => element.inert), false);
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));

  console.log('Modal stack, style preset dialogs, inert background, and document font-approval test passed');
} catch (error) {
  await failureArtifacts?.capture(page);
  throw error;
} finally {
  await failureArtifacts?.discard();
  await browser.close();
}
