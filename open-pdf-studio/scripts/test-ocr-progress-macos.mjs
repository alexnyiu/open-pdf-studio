import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import net from 'node:net';
import { chromium } from 'playwright';
import { startPlaywrightFailureArtifacts } from './playwright-failure-artifacts.mjs';

assert.equal(process.platform, 'darwin', 'OCR progress UI gate is macOS-only');

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
  throw new Error('Timed out waiting for the OCR progress UI test server');
}

async function countValue(toast, state) {
  return Number(await toast.locator(`[data-count-state="${state}"] dd`).textContent());
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
  await waitForServer(`${origin}/tests/ui/ocr-progress.html`, vite);
  let executablePath;
  try {
    await access(chromium.executablePath());
  } catch (_) {
    executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    await access(executablePath);
  }
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  page = await browser.newPage();
  failureArtifacts = await startPlaywrightFailureArtifacts(page.context(), 'ocr-progress');
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto(`${origin}/tests/ui/ocr-progress.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ocrProgressHarnessReady === true);

  const toast = page.locator('.ocr-progress-toast');
  await toast.waitFor();
  assert.equal(await toast.count(), 1);
  assert.match(await toast.textContent(), /scan-a\.pdf/);
  assert.doesNotMatch(await toast.textContent(), /Users|Private/);
  const firstTabBadge = page.locator('.document-tab').nth(0).locator('.document-tab-ocr-badge');
  await firstTabBadge.waitFor();
  assert.equal(await firstTabBadge.textContent(), '0%');
  assert.equal(await page.locator('.document-tab').nth(1).locator('.document-tab-ocr-badge').count(), 0);
  const initial = await page.evaluate(() => window.__ocrProgressHarness.snapshot());
  assert.equal(initial.retainedHandle, true);
  assert.doesNotMatch(JSON.stringify(initial.fullSnapshot), /Users|Private/);

  const stateSequence = [
    [1, 'queued', 0.01],
    [1, 'rasterizing', 0.08],
    [1, 'preprocessing', 0.14],
    [1, 'recognizing', 0.28],
    [1, 'validating', 0.38],
    [1, 'applying', 0.44],
    [1, 'completed', 0.5],
    [2, 'skipped', 0.58],
    [3, 'unsupported', 0.66],
    [4, 'failed', 0.74],
    [5, 'cancelled', 0.8],
  ];
  for (const [pageNumber, stateName, fraction] of stateSequence) {
    await page.evaluate(([pageValue, stateValue, fractionValue]) => {
      window.__ocrProgressHarness.emit(pageValue, stateValue, fractionValue);
    }, [pageNumber, stateName, fraction]);
    await page.waitForFunction((expected) =>
      document.querySelector('.ocr-progress-state')?.dataset.pageState === expected, stateName);
  }
  assert.equal(await toast.getByRole('progressbar').getAttribute('aria-valuenow'), '80');
  assert.equal(await firstTabBadge.textContent(), '80%');
  assert.match(await toast.textContent(), /Page 5 of 5/);
  for (const stateName of ['completed', 'skipped', 'unsupported', 'failed', 'cancelled']) {
    assert.equal(await countValue(toast, stateName), 1, stateName);
  }

  await page.evaluate(() => {
    window.__ocrProgressHarness.resetLiveMutations();
    for (let index = 0; index < 12; index += 1) {
      window.__ocrProgressHarness.emit(5, 'recognizing', 0.81 + index / 100);
    }
  });
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(() => window.__ocrProgressHarness.liveMutations()) <= 1);
  await page.waitForTimeout(1_600);
  assert.ok(await page.evaluate(() => window.__ocrProgressHarness.liveMutations()) <= 2);

  await toast.getByRole('button', { name: 'Hide' }).click();
  await page.waitForFunction(() => document.querySelector('.ocr-progress-toast')?.classList.contains('ocr-progress-collapsed'));
  assert.equal((await page.evaluate(() => window.__ocrProgressHarness.snapshot())).retainedHandle, true);
  assert.equal(await toast.count(), 1);

  await page.evaluate(() => window.__ocrProgressHarness.switchDocument(1));
  await toast.waitFor();
  assert.match(await toast.textContent(), /scan-a\.pdf/);
  await page.evaluate(() => window.__ocrProgressHarness.switchDocument(0));
  await toast.waitFor();
  assert.equal(await toast.evaluate((element) => element.classList.contains('ocr-progress-collapsed')), true);
  await toast.getByRole('button', { name: 'Show details' }).click();

  await toast.getByRole('button', { name: 'Cancel OCR' }).click();
  const cancellingButton = toast.getByRole('button', { name: 'Cancelling…' });
  await cancellingButton.waitFor();
  assert.equal(await cancellingButton.isDisabled(), true);
  let snapshot = await page.evaluate(() => window.__ocrProgressHarness.snapshot());
  assert.deepEqual(snapshot.cancellationReasons, ['user-cancelled']);
  assert.equal(snapshot.active.status, 'cancelling');
  assert.equal(snapshot.active.finishedAt, null);

  await page.evaluate(() => window.__ocrProgressHarness.switchDocument(1));
  await cancellingButton.waitFor();
  await page.evaluate(() => window.__ocrProgressHarness.switchDocument(0));
  await cancellingButton.waitFor();

  await page.evaluate(() => window.__ocrProgressHarness.resolveTerminal('cancelled'));
  await page.waitForFunction(() =>
    document.querySelector('.ocr-progress-summary')?.dataset.terminalStatus === 'cancelled');
  assert.match(await toast.textContent(), /Cancelled:/);
  for (const stateName of ['completed', 'skipped', 'unsupported', 'failed', 'cancelled']) {
    assert.equal(await countValue(toast, stateName), 1, stateName);
  }
  assert.equal(await toast.getByRole('button', { name: 'Retry' }).count(), 0);
  assert.doesNotMatch(await toast.textContent(), /may be temporary/);
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await toast.waitFor({ state: 'detached' });
  snapshot = await page.evaluate(() => window.__ocrProgressHarness.snapshot());
  assert.equal(snapshot.active.terminalSummary.status, 'cancelled');

  await page.evaluate(() => window.__ocrProgressHarness.startFailure(false));
  await page.waitForFunction(() =>
    document.querySelector('.ocr-progress-summary')?.dataset.terminalStatus === 'failed');
  assert.equal(await toast.getByRole('button', { name: 'Retry' }).count(), 0);
  assert.doesNotMatch(await toast.textContent(), /may be temporary/);
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await toast.waitFor({ state: 'detached' });

  await page.evaluate(() => window.__ocrProgressHarness.startFailure(true));
  await page.waitForFunction(() =>
    document.querySelector('.ocr-progress-summary')?.dataset.terminalStatus === 'failed');
  assert.match(await toast.textContent(), /may be temporary/);
  const retryButton = toast.getByRole('button', { name: 'Retry' });
  await retryButton.waitFor();
  const startsBeforeRetry = (await page.evaluate(() => window.__ocrProgressHarness.snapshot())).startCount;
  await retryButton.click();
  await page.waitForFunction((minimum) =>
    window.__ocrProgressHarness.snapshot().startCount > minimum, startsBeforeRetry);
  assert.equal(await toast.count(), 1);
  assert.equal(await toast.getByRole('button', { name: 'Cancel OCR' }).count(), 1);
  assert.equal((await page.evaluate(() => window.__ocrProgressHarness.snapshot())).retainedHandle, true);

  assert.deepEqual(browserErrors, [], `browser errors:\n${browserErrors.join('\n')}`);
  console.log('macOS OCR progress and cancellation UI integration gate passed');
} catch (error) {
  await failureArtifacts?.capture(page);
  if (serverOutput) error.message += `\nVite output:\n${serverOutput}`;
  throw error;
} finally {
  await failureArtifacts?.discard();
  await browser?.close();
  if (vite.exitCode === null) vite.kill('SIGTERM');
}
