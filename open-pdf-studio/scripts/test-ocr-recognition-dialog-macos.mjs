import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import net from 'node:net';
import { chromium } from 'playwright';
import { startPlaywrightFailureArtifacts } from './playwright-failure-artifacts.mjs';

assert.equal(process.platform, 'darwin', 'recognition dialog UI gate is macOS-only');

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
  throw new Error('Timed out waiting for the recognition dialog UI test server');
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
let page;
let failureArtifacts;
try {
  await waitForServer(`${origin}/tests/ui/ocr-recognition-dialog.html`, vite);
  let executablePath;
  try {
    await access(chromium.executablePath());
  } catch (_) {
    executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    await access(executablePath);
  }
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  page = await browser.newPage();
  failureArtifacts = await startPlaywrightFailureArtifacts(page.context(), 'ocr-recognition-dialog');
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto(`${origin}/tests/ui/ocr-recognition-dialog.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ocrHarnessReady === true);

  const dialog = page.getByRole('dialog', { name: 'Recognize Text' });
  await dialog.waitFor();
  await page.evaluate(() => window.__ocrRecognitionHarness.switchDocument(1));
  await dialog.waitFor({ state: 'detached' });
  await page.evaluate(() => {
    window.__ocrRecognitionHarness.switchDocument(0);
    window.__ocrRecognitionHarness.reopen();
  });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('combobox', { name: 'Language' }).isDisabled(), true);
  assert.equal(await dialog.getByRole('checkbox', { name: 'Automatic page orientation' }).isDisabled(), true);
  assert.equal(await dialog.getByRole('checkbox', { name: 'Deskew pages' }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: 'Close' }).count(), 1);
  assert.match(await dialog.textContent(), /Offline\./);
  assert.match(await dialog.textContent(), /Unsupported or outside the passing scope:/);

  await page.waitForFunction(() => {
    const button = document.querySelector("button[type='submit'][form='ocr-recognition-form']");
    return button && !button.disabled;
  });
  assert.equal(await page.evaluate(() => document.activeElement?.value), 'current-page');

  await dialog.getByRole('radio', { name: 'Page range' }).check();
  await dialog.getByRole('spinbutton', { name: 'From', exact: true }).fill('4');
  await dialog.getByRole('spinbutton', { name: 'to', exact: true }).fill('2');
  assert.equal(await dialog.getByRole('button', { name: 'Start' }).isDisabled(), true);
  assert.match(await dialog.getByRole('alert').textContent(), /valid range/);

  await dialog.getByRole('spinbutton', { name: 'From', exact: true }).fill('2');
  await dialog.getByRole('spinbutton', { name: 'to', exact: true }).fill('4');
  await dialog.getByRole('radio', { name: 'Force rerun' }).check();
  assert.equal(await dialog.getByRole('checkbox', { name: /Keep completed pages/ }).isChecked(), true);

  const closeButton = dialog.getByRole('button', { name: 'Close' });
  const cancelButton = dialog.getByRole('button', { name: 'Cancel' });
  await cancelButton.focus();
  await page.keyboard.press('Tab');
  assert.equal(await closeButton.evaluate((element) => document.activeElement === element), true);

  const header = dialog.locator('.modal-header');
  const before = await dialog.boundingBox();
  await header.hover();
  await page.mouse.down();
  await page.mouse.move(before.x + 80, before.y + 80);
  await page.mouse.up();
  assert.equal(await dialog.evaluate((element) => element.style.transform), 'none');

  const startButton = dialog.getByRole('button', { name: 'Start' });
  await startButton.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'detached' });
  const result = await page.evaluate(() => window.__ocrRecognitionHarness.result());
  assert.deepEqual(result.receivedStart.pageNumbers, [2, 3, 4]);
  assert.equal(result.receivedStart.force, true);
  assert.equal(result.receivedStart.keepCompletedPages, true);
  assert.deepEqual(result.receivedStart.languagePolicy, { mode: 'automatic', languages: [], scripts: [] });
  assert.deepEqual(result.receivedStart.orientation, { mode: 'none', degrees: null });
  assert.equal(result.receivedStart.deskew, false);
  assert.equal(result.retainedRealHandle, true);
  assert.deepEqual(browserErrors, [], `browser errors:\n${browserErrors.join('\n')}`);
  console.log('macOS OCR recognition dialog integration gate passed');
} catch (error) {
  await failureArtifacts?.capture(page);
  if (serverOutput) error.message += `\nVite output:\n${serverOutput}`;
  throw error;
} finally {
  await failureArtifacts?.discard();
  await browser?.close();
  if (vite.exitCode === null) vite.kill('SIGTERM');
}
