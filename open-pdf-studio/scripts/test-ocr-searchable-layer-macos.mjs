import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import net from 'node:net';
import { chromium } from 'playwright';
import { startPlaywrightFailureArtifacts } from './playwright-failure-artifacts.mjs';

assert.equal(process.platform, 'darwin', 'searchable OCR UI gate is macOS-only');

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
  throw new Error('Timed out waiting for the OCR UI test server');
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
  await waitForServer(`${origin}/tests/ui/ocr-searchable-layer.html`, vite);
  let executablePath;
  try {
    await access(chromium.executablePath());
  } catch (_) {
    executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    await access(executablePath);
  }
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  page = await context.newPage();
  failureArtifacts = await startPlaywrightFailureArtifacts(context, 'ocr-searchable-layer');
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto(`${origin}/tests/ui/ocr-searchable-layer.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ocrHarnessReady === true);
  const result = await page.evaluate(() => window.__ocrHarness.run());

  assert.equal(result.searchBeforeSave, true, 'pending OCR must be searchable before save');
  assert.equal(result.ocrReplaceBlocked, true, 'legacy PDF Find/Replace must not write pending OCR');
  assert.equal(result.applicationTextMerged, true, 'application-added text must remain searchable');
  assert.equal(result.geometryHighlight, true, 'OCR search highlights must use line polygon geometry');
  assert.equal(result.accessibleAndTransparent, true, 'OCR spans must be accessible and non-painting');
  assert.deepEqual(result.baseOrder, ['Left one', 'Left two', 'Right one', 'Right two']);
  assert.equal(result.continuousPages, 2, 'continuous mode must expose OCR on both pages');
  assert.ok(Math.abs(result.zoomRatio - 2) < 0.02, `OCR span zoom ratio was ${result.zoomRatio}`);
  assert.equal(result.zoomStableIds, true, 'zoom must preserve stable OCR IDs');
  assert.equal(result.rotationStableIds, true, 'rotation must preserve stable OCR IDs');
  assert.equal(result.rotationChangedTransform, true, 'rotation must project OCR geometry into the rotated viewport');
  assert.equal(result.rerenderStableIds, true, 'page rerender must preserve OCR IDs');
  assert.equal(result.rerenderOwnedCount, 4, 'page rerender must not duplicate owned OCR nodes');
  assert.equal(result.correctionVisible, true, 'accepted review text must refresh the pending layer');
  assert.equal(result.engineResultUnchanged, true, 'review text must not mutate the engine result');
  assert.equal(result.forceApplied, true, 'force rerun must replace Open PDF Studio-owned OCR');
  assert.ok(result.forceText.includes('Right one corrected rerun'));
  assert.equal(result.unknownSurvivedForce, true, 'force rerun must preserve unknown text nodes');
  assert.deepEqual(result.cacheCounts, [2, 1], 'only the affected page cache may be invalidated');
  assert.equal(result.nativeDefaultSkipped, true, 'meaningful PDF.js text must skip OCR by default');
  assert.equal(result.nativeForceApplied, true, 'a forced result may be retained as owned state');
  assert.equal(result.nativeOcrSpanCount, 0, 'meaningful native text must suppress duplicate OCR spans');
  assert.ok(result.nativeSpanCount > 0, 'native PDF.js spans must remain present');
  assert.equal(result.vendorNodeSurvived, true, 'unknown third-party text must never be deleted');
  assert.equal(result.forcedOcrSearchCount, 0, 'forced OCR must not duplicate meaningful native search text');
  assert.equal(result.nativeSearchCount, 1, 'native text must remain searchable');
  assert.equal(result.dirtyWithoutPdfWrite, true, 'pending OCR must mark unsaved document state dirty');
  assert.equal(result.pdfSavePreservedOcrDirty, true, 'PDF save must not mark unpersisted OCR clean');
  assert.equal(result.ocrOutsideTextEdits, true, 'OCR state must remain outside textEdits');
  assert.equal(result.finalOwnedCount, 4);

  const selectedText = await page.evaluate(() => window.__ocrHarness.selectPendingOcr());
  assert.ok(selectedText.includes('Left one'));
  assert.ok(selectedText.indexOf('Left two') > selectedText.indexOf('Left one'));
  assert.ok(selectedText.indexOf('Right one corrected rerun') > selectedText.indexOf('Left two'));
  await page.keyboard.press('Meta+C');
  const copiedText = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copiedText.includes('Left one'), 'normal browser copy must include pending OCR');
  assert.ok(copiedText.includes('Right one corrected rerun'), 'copy must preserve multi-column reading order');

  assert.deepEqual(browserErrors, [], `browser errors:\n${browserErrors.join('\n')}`);
  console.log('macOS searchable OCR UI integration gate passed');
} catch (error) {
  await failureArtifacts?.capture(page);
  if (serverOutput) error.message += `\nVite output:\n${serverOutput}`;
  throw error;
} finally {
  await failureArtifacts?.discard();
  await browser?.close();
  if (vite.exitCode === null) vite.kill('SIGTERM');
}
