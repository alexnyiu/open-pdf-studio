import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import net from 'node:net';
import { chromium } from 'playwright';

assert.equal(process.platform, 'darwin', 'OCR review UI gate is macOS-only');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(url, processHandle) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Vite exited with ${processHandle.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_) {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the OCR review UI test server');
}

const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js',
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
], {
  cwd: new URL('..', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
vite.stdout.on('data', (chunk) => { serverOutput = (serverOutput + chunk).slice(-20_000); });
vite.stderr.on('data', (chunk) => { serverOutput = (serverOutput + chunk).slice(-20_000); });

let browser;
try {
  await waitForServer(`${origin}/tests/ui/ocr-review.html`, vite);
  let executablePath;
  try {
    await access(chromium.executablePath());
  } catch (_) {
    executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    await access(executablePath);
  }
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto(`${origin}/tests/ui/ocr-review.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ocrReviewHarnessReady === true);

  const panel = page.getByRole('region', { name: 'OCR Review' });
  await panel.waitFor();
  assert.equal(await panel.getByRole('navigation', { name: 'OCR review page navigation' }).count(), 1);
  assert.equal(await panel.getByRole('status').getAttribute('aria-live'), 'polite');
  assert.equal(await panel.locator('[data-ownership-state="pending"]').count(), 1);

  const lineCards = panel.locator('[data-ocr-review-line]');
  assert.equal(await lineCards.count(), 2);
  assert.deepEqual(await lineCards.locator('.ocr-review-effective-text').allTextContents(), [
    'High confidence first',
    'Low confidence second',
  ]);
  assert.match(await lineCards.nth(0).textContent(), /98% · High confidence/);
  assert.match(await lineCards.nth(1).textContent(), /!52% · Low confidence/);
  assert.equal(await panel.getByRole('heading', { name: 'Alternatives' }).count(), 0);
  assert.match(await panel.getByRole('heading', { name: 'Warnings' }).locator('..').textContent(), /Review the second line/);

  const lowFilter = panel.getByRole('checkbox', { name: 'Only low confidence (below 80%)' });
  await lowFilter.check();
  await page.waitForFunction(() => document.querySelectorAll('[data-ocr-review-line]').length === 1);
  assert.equal(await panel.locator('[data-ocr-review-line="line-low"]').count(), 1);
  await lowFilter.uncheck();
  await page.waitForFunction(() => document.querySelectorAll('[data-ocr-review-line]').length === 2);

  const highLine = panel.locator('[data-ocr-review-line="line-high"]');
  await highLine.focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.activeElement?.dataset?.ocrReviewLine === 'line-low');
  const focusStyle = await panel.locator('[data-ocr-review-line="line-low"]').evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  assert.notEqual(focusStyle.outlineStyle, 'none', 'keyboard focus must have a visible outline');
  assert.notEqual(focusStyle.outlineWidth, '0px', 'keyboard focus outline must have visible width');

  await page.keyboard.press('Enter');
  const correctionInput = panel.getByRole('textbox', { name: 'Correction for line 2' });
  await correctionInput.waitFor();
  await correctionInput.fill('Accepted low confidence text');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    window.__ocrReviewHarness.snapshot().correction === 'Accepted low confidence text');
  let snapshot = await page.evaluate(() => window.__ocrReviewHarness.snapshot());
  assert.equal(snapshot.engineLowText, 'Low confidence second', 'the immutable engine result must not change');
  assert.equal(snapshot.undoTypes.at(-1), 'ocrCorrectPage');
  assert.match(await panel.locator('[data-ocr-review-line="line-low"]').textContent(), /Accepted correction/);
  assert.equal(await panel.locator('[data-ocr-review-line="line-low"]:focus').count(), 1);

  await panel.getByRole('button', { name: 'Undo last OCR review action' }).click();
  await page.waitForFunction(() => window.__ocrReviewHarness.snapshot().correction === null);
  assert.match(await panel.locator('[data-ocr-review-line="line-low"]').textContent(), /Low confidence second/);
  await panel.getByRole('button', { name: 'Redo last OCR review action' }).click();
  await page.waitForFunction(() =>
    window.__ocrReviewHarness.snapshot().correction === 'Accepted low confidence text');
  snapshot = await page.evaluate(() => window.__ocrReviewHarness.snapshot());
  assert.equal(snapshot.undoTypes.at(-1), 'ocrCorrectPage');

  await panel.getByRole('button', { name: 'Next warning' }).click();
  await page.waitForFunction(() => document.activeElement?.dataset?.ocrReviewLine === 'line-low');
  assert.match(await panel.getByRole('status').textContent(), /OCR warning on page 1/);
  await panel.getByRole('button', { name: 'Next warning' }).click();
  await page.waitForFunction(() => window.__ocrReviewHarness.snapshot().currentPage === 3);
  assert.match(await panel.getByRole('alert').first().textContent(), /review-only/);
  assert.match(await panel.getByRole('heading', { name: 'Unsupported content' }).locator('..').textContent(), /Table reading order is unsupported/);
  snapshot = await page.evaluate(() => window.__ocrReviewHarness.snapshot());
  assert.equal(snapshot.unsupportedWriterItems, 0, 'unsupported review text must not enter the writer projection');

  const pageSelect = panel.getByRole('combobox', { name: 'Review page' });
  await pageSelect.selectOption('2');
  await page.waitForFunction(() => window.__ocrReviewHarness.snapshot().currentPage === 2);
  assert.equal(await panel.locator('[data-ownership-state="saved"]').count(), 1);
  await panel.getByRole('button', { name: 'Rerun page' }).click();
  await page.waitForFunction(() => window.__ocrReviewHarness.snapshot().rerun !== null);
  snapshot = await page.evaluate(() => window.__ocrReviewHarness.snapshot());
  assert.deepEqual(snapshot.rerun, { pageNumbers: [2], force: true, useCache: false });

  await panel.getByRole('button', { name: 'Remove page OCR' }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-ownership-state="pending-removal"]') !== null);
  snapshot = await page.evaluate(() => window.__ocrReviewHarness.snapshot());
  assert.equal(snapshot.ownedPageCount, 2);
  assert.equal(snapshot.undoTypes.at(-1), 'ocrRemoveOwned');
  assert.equal(await panel.getByRole('button', { name: 'Rerun page' }).isDisabled(), true,
    'force rerun must be unavailable after owned OCR is removed');
  await panel.getByRole('button', { name: 'Undo last OCR review action' }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-ownership-state="saved"]') !== null);

  await panel.getByRole('button', { name: 'Remove document OCR (3 pages)' }).click();
  await page.waitForFunction(() => window.__ocrReviewHarness.snapshot().ownedPageCount === 0);
  snapshot = await page.evaluate(() => window.__ocrReviewHarness.snapshot());
  assert.equal(snapshot.undoTypes.at(-1), 'ocrRemoveOwned');
  await panel.getByRole('button', { name: 'Undo last OCR review action' }).click();
  await page.waitForFunction(() => window.__ocrReviewHarness.snapshot().ownedPageCount === 3);

  await page.evaluate(() => window.__ocrReviewHarness.switchDocument(1));
  await page.waitForFunction(() =>
    document.querySelector('[data-ocr-review-line]')?.dataset.ocrReviewLine === 'line-alternative');
  assert.equal(await panel.getByRole('heading', { name: 'Alternatives' }).count(), 1);
  assert.equal(await panel.getByRole('button', { name: /Use alternative Secondary alternative text/ }).count(), 1);
  await page.evaluate(() => window.__ocrReviewHarness.switchDocument(0));
  await page.waitForFunction(() => window.__ocrReviewHarness.snapshot().activeDocumentId === 'review-document-a');
  assert.equal(await panel.getByRole('combobox', { name: 'Review page' }).inputValue(), '2');
  assert.match(await panel.locator('[data-ocr-review-line="line-saved"]').textContent(), /Saved owned text/);

  assert.deepEqual(browserErrors, [], `browser errors:\n${browserErrors.join('\n')}`);
  console.log('macOS searchable OCR review UI integration gate passed');
} catch (error) {
  if (serverOutput) error.message += `\nVite output:\n${serverOutput}`;
  throw error;
} finally {
  await browser?.close();
  if (vite.exitCode === null) vite.kill('SIGTERM');
}
