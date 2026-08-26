import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdtemp, readFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { readOwnedTextEditManifest } from '../js/text/owned-edit-manifest.js';

assert.equal(process.platform, 'darwin', 'native paragraph packaged acceptance is macOS-only');

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appBundle = path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || path.join(
  projectDir, '..', 'target', 'release', 'bundle', 'macos', 'Open PDF Studio.app',
));
const fixture = path.join(projectDir, 'tests', 'fixtures', 'text', 'native-paragraph-table.pdf');
const colorFixture = path.join(projectDir, 'tests', 'fixtures', 'text', 'native-side-by-side-color.pdf');
const runDir = await mkdtemp(path.join(tmpdir(), 'opds-native-paragraph-'));
const workingPdf = path.join(runDir, 'native-paragraph-working.pdf');
const colorWorkingPdf = path.join(runDir, 'native-side-by-side-working.pdf');
const saveAsPdf = path.join(runDir, 'native-paragraph-save-as.pdf');
const colorSaveAsPdf = path.join(runDir, 'native-side-by-side-save-as.pdf');
const sessionPath = path.join(runDir, 'session.json');
const stdoutPath = path.join(runDir, 'app.stdout.log');
const stderrPath = path.join(runDir, 'app.stderr.log');
let endpoint;
let requestId = 0;
let application;
let applicationPid;
let exited = false;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`MCP ${body.error.code}: ${body.error.message}`);
  return body.result;
}

async function callTool(name, arguments_ = {}) {
  const result = await rpc('tools/call', { name, arguments: arguments_ });
  const payload = result?.content?.find((entry) => entry.type === 'text')?.text;
  if (typeof payload !== 'string') throw new Error(`${name} returned no JSON payload`);
  return JSON.parse(payload);
}

async function waitUntil(description, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await probe().catch(() => null);
    if (latest) return latest;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}: ${JSON.stringify(latest)}`);
}

async function ui(selector) {
  return callTool('app_ui_state', { selector, searchTabs: false });
}

async function richRunStates(maxLines = 32, maxRuns = 16) {
  const states = [];
  for (let line = 0; line < maxLines; line += 1) {
    let foundLine = false;
    for (let run = 1; run <= maxRuns; run += 1) {
      const value = await ui(`.pdf-text-editor [data-rich-line-index="${line}"] > [data-rich-run]:nth-child(${run})`);
      if (!value.found) break;
      foundLine = true;
      states.push(value);
    }
    if (!foundLine && line > 0) break;
  }
  return states;
}

async function waitUi(selector, predicate = (value) => value.found && value.visible, timeoutMs = 30_000) {
  return waitUntil(selector, async () => {
    const value = await ui(selector);
    return predicate(value) ? value : null;
  }, timeoutMs);
}

async function click(selector) {
  await waitUi(selector, (value) => value.found && value.visible && !value.disabled, 60_000);
  const result = await callTool('app_click_element', { selector, searchTabs: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.clicked, true, `${selector} was not clicked`);
}

async function openPdf(pdfPath) {
  const result = await callTool('app_open_pdf', { path: pdfPath });
  assert.equal(result.ok, true, result.error);
  await waitUntil(`open PDF ${pdfPath}`, async () => {
    const viewport = await callTool('app_get_viewport_state');
    return viewport.doc?.filePath === pdfPath ? viewport : null;
  }, 60_000);
}

async function closeActiveTab() {
  const tabs = await callTool('app_list_tabs');
  const result = await callTool('app_close_tab', { index: tabs.activeIndex, force: true });
  assert.equal(result.ok, true, result.error);
}

async function setEditTool() {
  const result = await callTool('app_set_tool', { tool: 'editText' });
  assert.equal(result.current, 'editText');
}

async function openEditor(selector, expectedText) {
  await click(selector);
  try {
    return await waitUi('.pdf-text-editor', (value) => (
      value.found && value.visible && value.focused
        && String(value.value ?? value.text ?? '').includes(expectedText)
    ), 15_000);
  } catch (error) {
    const [dialog, consoleLog, sourceState] = await Promise.all([
      ui('.message-dialog-overlay').catch(() => null),
      callTool('app_get_recent_console').catch(() => null),
      ui(selector).catch(() => null),
    ]);
    throw new Error(`editor did not open: ${JSON.stringify({ selector, expectedText, sourceState, dialog, consoleLog })}`, {
      cause: error,
    });
  }
}

async function replaceAndCommit(text) {
  const typed = await callTool('app_type', { text });
  assert.equal(typed.ok, true, typed.error);
  await callTool('app_key', { key: 'Enter', meta: true });
  await waitUi('.pdf-text-editor', (value) => !value.found, 30_000);
}

async function save(pathname = null) {
  const result = await callTool('app_save_pdf', pathname ? { path: pathname } : {});
  assert.equal(result.ok, true, result.error);
  return result.path;
}

async function pdfJsText(pdfPath) {
  const document = await pdfjsLib.getDocument({
    data: new Uint8Array(await readFile(pdfPath)), isEvalSupported: false, verbosity: 0,
  }).promise;
  try {
    const content = await (await document.getPage(1)).getTextContent();
    return content.items.map((item) => item.str).filter(Boolean).join('\n');
  } finally {
    await document.destroy();
  }
}

await Promise.all([
  access(appBundle), access(fixture), access(colorFixture),
  copyFile(fixture, workingPdf), copyFile(colorFixture, colorWorkingPdf),
]);

try {
  const port = await availablePort();
  endpoint = `http://127.0.0.1:${port}/mcp`;
  application = spawn('/usr/bin/open', [
    '-n', '-W', '--stdout', stdoutPath, '--stderr', stderrPath,
    '--env', 'OPS_ENABLE_MCP=1', '--env', 'OPDS_DETACHED=1',
    '--env', `OPS_TEST_SESSION_PATH=${sessionPath}`,
    appBundle, '--args', '--mcp-server', '--mcp-port', String(port),
  ], { cwd: projectDir, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  application.once('exit', () => { exited = true; });
  const initialized = await waitUntil('packaged app MCP', async () => {
    if (exited) throw new Error('packaged app exited');
    const result = await rpc('initialize');
    applicationPid = result?._meta?.openPdfStudio?.processId || applicationPid;
    return result?._meta?.openPdfStudio?.webviewReady ? result : null;
  }, 90_000);
  assert.ok(initialized);
  await callTool('app_set_window_size', { width: 1320, height: 900 });
  await openPdf(workingPdf);
  await setEditTool();

  const nativeSelector = '.textLayer span[data-item-index="2"]';
  await waitUi(nativeSelector, (value) => value.found && value.visible && value.rect.width > 5, 60_000);
  await openEditor(nativeSelector, 'ARCALYST penetration');
  const firstReplacement = 'Packaged first line\nPackaged second line';
  await replaceAndCommit(firstReplacement);

  const ownedSelector = '.textLayer span[data-owned-text-edit-hit="true"]';
  const unsavedReedit = await openEditor(ownedSelector, 'Packaged first line');
  assert.equal(String(unsavedReedit.value ?? unsavedReedit.text).includes('Packaged second line'), true);
  await callTool('app_key', { key: 'Escape' });
  await save();
  const savedReedit = await openEditor(ownedSelector, 'Packaged first line');
  assert.equal(String(savedReedit.value ?? savedReedit.text).includes('Packaged second line'), true);
  await callTool('app_key', { key: 'Escape' });

  await closeActiveTab();
  await openPdf(workingPdf);
  await setEditTool();
  await openEditor(ownedSelector, 'Packaged first line');
  const secondReplacement = 'Reopened first line\nReopened second line';
  await replaceAndCommit(secondReplacement);
  assert.equal(await save(saveAsPdf), saveAsPdf);

  await closeActiveTab();
  await openPdf(saveAsPdf);
  await setEditTool();
  const saveAsReedit = await openEditor(ownedSelector, 'Reopened first line');
  assert.equal(String(saveAsReedit.value ?? saveAsReedit.text).includes('Reopened second line'), true);
  await callTool('app_key', { key: 'Escape' });
  await save();

  const pdfBytes = await readFile(saveAsPdf);
  const pdfDocument = await PDFDocument.load(pdfBytes);
  const manifest = await readOwnedTextEditManifest(pdfDocument);
  assert.equal(manifest.pages.length, 1);
  assert.equal(manifest.pages[0].edits.length, 1);
  assert.equal(manifest.pages[0].edits[0].revision, 2);
  assert.equal(manifest.pages[0].edits[0].ownedLayerId,
    `OpenPDFStudioTextEdit-${manifest.pages[0].edits[0].id}`);
  const extracted = await pdfJsText(saveAsPdf);
  assert.equal(extracted.split('Reopened first line').length - 1, 1);
  assert.equal(extracted.split('Reopened second line').length - 1, 1);
  const pdfiumLayer = await waitUi('.textLayer', (value) => (
    value.found && String(value.text).includes('Reopened first line')
  ), 60_000);
  assert.ok(String(pdfiumLayer.text).includes('Reopened second line'));

  await closeActiveTab();
  await openPdf(colorWorkingPdf);
  await setEditTool();
  const leftColorSelector = '.textLayer span[data-item-index="4"]';
  const rightColorSelector = '.textLayer span[data-item-index="16"]';
  const leftSource = await waitUi(leftColorSelector, (value) => value.found && value.visible && value.rect.width > 5, 60_000);
  const rightSource = await waitUi(rightColorSelector, (value) => value.found && value.visible && value.rect.width > 5, 60_000);
  const leftColorEditor = await openEditor(leftColorSelector, 'Mounjaro and Zepbound');
  assert.equal(String(leftColorEditor.value ?? leftColorEditor.text).includes('The growth runway'), false);
  assert.ok(leftColorEditor.rect.right < rightSource.rect.left,
    'packaged side-by-side editor crossed the inferred gutter');
  const packagedRuns = await richRunStates();
  const blueRun = packagedRuns.find((run) => String(run.text).includes('blue emphasis'));
  const grayRun = packagedRuns.find((run) => String(run.text).includes('gray explanation'));
  const paleRun = packagedRuns.find((run) => String(run.text).includes('pale detail'));
  assert.ok(blueRun, `blue source run was not preserved: ${JSON.stringify(packagedRuns)}`);
  assert.ok(grayRun, `gray source run was not preserved: ${JSON.stringify(packagedRuns)}`);
  assert.ok(paleRun, `pale source run was not preserved: ${JSON.stringify(packagedRuns)}`);
  assert.equal(blueRun.dataset.contrastAid, 'false', JSON.stringify(packagedRuns));
  assert.equal(grayRun.dataset.contrastAid, 'false',
    `ordinary small gray text must render without a blurring halo: ${JSON.stringify(grayRun)}`);
  assert.match(grayRun.inlineStyle, /text-shadow:\s*none/u);
  assert.equal(paleRun.dataset.contrastAid, 'true', JSON.stringify(packagedRuns));
  assert.match(paleRun.inlineStyle, /text-shadow:\s*none/u);
  assert.match(paleRun.inlineStyle, /background-color:\s*rgb\(0,\s*0,\s*0\)/u);
  const colorStatus = await waitUi('#native-text-edit-status');
  assert.match(colorStatus.text, /editing-only backing/u);
  await callTool('app_key', { key: 'Escape' });

  const rightColorEditor = await openEditor(rightColorSelector, 'The growth runway');
  assert.equal(String(rightColorEditor.value ?? rightColorEditor.text).includes('Mounjaro and Zepbound'), false);
  assert.ok(rightColorEditor.rect.left >= rightSource.rect.left - 2);
  await replaceAndCommit('Independent packaged right paragraph');
  assert.equal(await save(colorSaveAsPdf), colorSaveAsPdf);
  await closeActiveTab();
  await openPdf(colorSaveAsPdf);
  await setEditTool();
  const reopenedRight = await openEditor('.textLayer span[data-owned-text-edit-hit="true"]',
    'Independent packaged right paragraph');
  assert.ok(reopenedRight.rect.left >= rightSource.rect.left - 2);
  await callTool('app_key', { key: 'Escape' });
  assert.match(await pdfJsText(colorSaveAsPdf), /Independent packaged right paragraph/u);

  console.log(`Packaged native paragraph editing acceptance passed: ${saveAsPdf}; ${colorSaveAsPdf}`);
} finally {
  if (application && !exited) {
    try { process.kill(applicationPid || -application.pid, 'SIGTERM'); } catch {}
    await delay(500);
  }
}
