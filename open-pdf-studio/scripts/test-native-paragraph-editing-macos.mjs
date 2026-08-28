import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { readOwnedTextEditManifest } from '../js/text/owned-edit-manifest.js';

assert.equal(process.platform, 'darwin', 'native paragraph packaged acceptance is macOS-only');

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const appBundle = path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || path.join(
  repoDir, 'target', 'release', 'bundle', 'macos', 'Open PDF Studio.app',
));
const artifactRoot = path.resolve(
  process.env.OPEN_PDF_STUDIO_TEST_ARTIFACT_DIR
    || path.join(projectDir, 'test-artifacts', 'packaged-editor'),
);
const reportPath = path.join(artifactRoot, 'reports', 'native-text-editing.json');
const evidencePdfPath = path.join(artifactRoot, 'reports', 'native-paragraph-save-as.pdf');
const colorEvidencePdfPath = path.join(artifactRoot, 'reports', 'native-side-by-side-save-as.pdf');
const widthEvidencePdfPath = path.join(artifactRoot, 'reports', 'native-width-compensation-save-as.pdf');
const realPdfSource = process.env.OPEN_PDF_STUDIO_NATIVE_REAL_PDF
  ? path.resolve(process.env.OPEN_PDF_STUDIO_NATIVE_REAL_PDF)
  : null;
const realEvidencePdfPath = path.join(artifactRoot, 'reports', 'native-real-pdf-page-3-save.pdf');
const realPageScreenshotPath = path.join(artifactRoot, 'reports', 'native-real-pdf-page-3.png');
const fixture = path.join(projectDir, 'tests', 'fixtures', 'text', 'native-paragraph-table.pdf');
const colorFixture = path.join(projectDir, 'tests', 'fixtures', 'text', 'native-side-by-side-color.pdf');
const widthFixture = path.join(projectDir, 'tests', 'fixtures', 'text', 'native-helvetica-width-compensation.pdf');
const runDir = await mkdtemp(path.join(tmpdir(), 'opds-native-paragraph-'));
const workingPdf = path.join(runDir, 'native-paragraph-working.pdf');
const colorWorkingPdf = path.join(runDir, 'native-side-by-side-working.pdf');
const widthWorkingPdf = path.join(runDir, 'native-width-compensation-working.pdf');
const saveAsPdf = path.join(runDir, 'native-paragraph-save-as.pdf');
const colorSaveAsPdf = path.join(runDir, 'native-side-by-side-save-as.pdf');
const widthSaveAsPdf = path.join(runDir, 'native-width-compensation-save-as.pdf');
const realWorkingPdf = path.join(runDir, 'native-real-pdf-page-3-working.pdf');
const sessionPath = path.join(runDir, 'session.json');
const stdoutPath = path.join(runDir, 'app.stdout.log');
const stderrPath = path.join(runDir, 'app.stderr.log');
let endpoint;
let requestId = 0;
let application;
let applicationPid;
let exited = false;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function gitHead() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git rev-parse exited with ${code}`));
    });
  });
}

async function sha256(pdfPath) {
  return createHash('sha256').update(await readFile(pdfPath)).digest('hex');
}

async function ownedManifestIdentity(pdfPath) {
  const pdfDocument = await PDFDocument.load(await readFile(pdfPath));
  const manifest = await readOwnedTextEditManifest(pdfDocument);
  const serialized = JSON.stringify(manifest);
  return {
    sha256: createHash('sha256').update(serialized).digest('hex'),
    pageCount: manifest.pages.length,
    editCount: manifest.pages.reduce((count, page) => count + page.edits.length, 0),
    revisions: manifest.pages.flatMap((page) => page.edits.map((edit) => edit.revision)),
  };
}

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
  return result;
}

async function pointerClick(selector) {
  const state = await waitUi(selector, (value) => (
    value.found && value.visible && !value.disabled
      && value.rect?.width > 2 && value.rect?.height > 2
  ), 60_000);
  const result = await callTool('app_mouse_click', {
    x: state.rect.x + state.rect.width / 2,
    y: state.rect.y + state.rect.height / 2,
  });
  assert.equal(result.ok, true, result.error);
  return result;
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

async function openEditor(selector, expectedText, expectedPage = '1') {
  await click(selector);
  try {
    const editor = await waitUi('.pdf-text-editor', (value) => (
      value.found && value.visible && value.focused
        && String(value.value ?? value.text ?? '').includes(expectedText)
    ), 15_000);
    assert.equal(editor.pageTextEditHost?.attached, true,
      `editor was not mounted in a PDF page host: ${JSON.stringify(editor)}`);
    assert.equal(editor.pageTextEditHost?.page, expectedPage);
    assert.equal(editor.computedStyle?.position, 'absolute');
    assert.equal(editor.computedStyle?.boxShadow, 'none');
    assert.notEqual(editor.computedStyle?.overflowX, 'scroll');
    assert.notEqual(editor.computedStyle?.overflowY, 'scroll');
    return editor;
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
  await callTool('app_key', { key: 'a', meta: true });
  const typed = await callTool('app_type', { text });
  assert.equal(typed.ok, true, typed.error);
  // app_click_element focuses form controls before dispatching click, matching
  // the focus hand-off produced by a real pointer. app_mouse_click intentionally
  // dispatches raw pointer/mouse events and does not synthesize browser focus.
  const outsideClick = await click('.status-page-input');
  try {
    await waitUi('.pdf-text-editor', (value) => !value.found, 30_000);
  } catch (error) {
    const [editor, status, consoleLog] = await Promise.all([
      ui('.pdf-text-editor').catch(() => null),
      ui('#native-text-edit-status').catch(() => null),
      callTool('app_get_recent_console').catch(() => null),
    ]);
    throw new Error(`formatted text did not commit on click-away: ${JSON.stringify({ outsideClick, editor, status, consoleLog })}`, {
      cause: error,
    });
  }
}

async function save(pathname = null) {
  const result = await callTool('app_save_pdf', pathname ? { path: pathname } : {});
  assert.equal(result.ok, true, result.error);
  return result.path;
}

async function pdfJsText(pdfPath, pageNumber = 1) {
  const document = await pdfjsLib.getDocument({
    data: new Uint8Array(await readFile(pdfPath)), isEvalSupported: false, verbosity: 0,
  }).promise;
  try {
    const content = await (await document.getPage(pageNumber)).getTextContent();
    return content.items.map((item) => item.str).filter(Boolean).join('\n');
  } finally {
    await document.destroy();
  }
}

await mkdir(path.dirname(reportPath), { recursive: true });
const report = {
  contract: 'open-pdf-studio.native-text-packaged-acceptance',
  schemaVersion: 1,
  status: 'RUNNING',
  head: await gitHead(),
  generatedAt: new Date().toISOString(),
  platform: { os: process.platform, architecture: process.arch },
  packagedApp: {
    bundlePath: appBundle,
    signingScope: 'CI usability and hardened-runtime compatibility; not Developer ID or notarization evidence',
  },
  productionUiOnly: true,
  syntheticStateSeeding: false,
  testOnlyEntryPoint: false,
  checks: {
    saveReopen: 'PENDING',
    genuineReeditPointerAction: 'PENDING',
    repeatSaveIdempotence: 'PENDING',
    sideBySideIsolation: 'PENDING',
    canonicalSourceAlignment: 'PENDING',
    scrollAttachment: 'PENDING',
    substitutionWidthCompensation: 'PENDING',
    firstSaveClickCommit: 'PENDING',
  },
  saveEvidence: null,
  artifacts: [],
  testCommands: [realPdfSource
    ? 'OPEN_PDF_STUDIO_NATIVE_REAL_PDF=<local PDF> npm run test:native-text-editing:macos'
    : 'npm run test:native-text-editing:macos'],
};
if (realPdfSource) report.checks.realPdfPage3 = 'PENDING';
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

try {
  const preparation = [
    access(appBundle), access(fixture), access(colorFixture), access(widthFixture),
    copyFile(fixture, workingPdf), copyFile(colorFixture, colorWorkingPdf),
    copyFile(widthFixture, widthWorkingPdf),
  ];
  if (realPdfSource) preparation.push(access(realPdfSource), copyFile(realPdfSource, realWorkingPdf));
  await Promise.all(preparation);
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
  await waitUi(
    nativeSelector,
    (value) => value.found && value.visible && value.rect.width > 5,
    60_000,
  );
  const initialEditor = await openEditor(nativeSelector, 'ARCALYST penetration');
  const hiddenSourceAtOpen = await ui(nativeSelector);
  assert.ok(Math.abs(initialEditor.rect.left - hiddenSourceAtOpen.rect.left) <= 0.5,
    `editor/source left edge differed: ${JSON.stringify({ initialEditor, hiddenSourceAtOpen })}`);
  assert.ok(Math.abs(initialEditor.rect.top - hiddenSourceAtOpen.rect.top) <= 0.5,
    `editor/source top edge differed: ${JSON.stringify({ initialEditor, hiddenSourceAtOpen })}`);
  report.checks.canonicalSourceAlignment = 'PASS';
  await callTool('app_set_zoom', { scale: 1.25 });
  await waitUi('.pdf-text-editor', (value) => (
    value.found && value.visible && value.focused && value.pageTextEditHost?.attached
      && String(value.value ?? value.text ?? '').includes('ARCALYST penetration')
  ), 30_000);
  await callTool('app_set_view_mode', { mode: 'continuous' });
  const continuousEditor = await waitUi('.pdf-text-editor', (value) => (
    value.found && value.visible && value.focused && value.pageTextEditHost?.attached
      && String(value.pageTextEditHost?.parentClass).includes('canvas-container-cont')
      && String(value.value ?? value.text ?? '').includes('ARCALYST penetration')
  ), 30_000);
  const continuousSourceBefore = await ui(nativeSelector);
  const relativeBeforeScroll = {
    left: continuousEditor.rect.left - continuousSourceBefore.rect.left,
    top: continuousEditor.rect.top - continuousSourceBefore.rect.top,
  };
  await callTool('app_scroll', {
    x: Math.round(continuousEditor.rect.x + continuousEditor.rect.width / 2),
    y: Math.round(continuousEditor.rect.y + continuousEditor.rect.height / 2),
    dy: 120,
  });
  const scrolledEditor = await waitUi('.pdf-text-editor', (value) => (
    value.found && value.visible && value.focused && value.pageTextEditHost?.attached
      && String(value.value ?? value.text ?? '').includes('ARCALYST penetration')
  ), 30_000);
  const continuousSourceAfter = await ui(nativeSelector);
  const relativeAfterScroll = {
    left: scrolledEditor.rect.left - continuousSourceAfter.rect.left,
    top: scrolledEditor.rect.top - continuousSourceAfter.rect.top,
  };
  assert.ok(Math.abs(relativeAfterScroll.left - relativeBeforeScroll.left) <= 0.5,
    `editor drifted horizontally while scrolling: ${JSON.stringify({ relativeBeforeScroll, relativeAfterScroll })}`);
  assert.ok(Math.abs(relativeAfterScroll.top - relativeBeforeScroll.top) <= 0.5,
    `editor drifted vertically while scrolling: ${JSON.stringify({ relativeBeforeScroll, relativeAfterScroll })}`);
  report.checks.scrollAttachment = 'PASS';
  await callTool('app_set_view_mode', { mode: 'single' });
  await callTool('app_set_zoom', { scale: 1 });
  await waitUi('.pdf-text-editor', (value) => (
    value.found && value.visible && value.focused && value.pageTextEditHost?.attached
      && value.pageTextEditHost?.parentId === 'canvas-container'
      && String(value.value ?? value.text ?? '').includes('ARCALYST penetration')
  ), 30_000);
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
  report.checks.saveReopen = 'PASS';
  report.checks.genuineReeditPointerAction = 'PASS';

  const firstSaveSha256 = await sha256(saveAsPdf);
  const firstManifestIdentity = await ownedManifestIdentity(saveAsPdf);
  await save();
  const repeatedSaveSha256 = await sha256(saveAsPdf);
  const repeatedManifestIdentity = await ownedManifestIdentity(saveAsPdf);
  assert.equal(repeatedSaveSha256, firstSaveSha256,
    'native repeat Save without edits changed PDF bytes');
  assert.deepEqual(repeatedManifestIdentity, firstManifestIdentity,
    'native repeat Save without edits changed the owned-edit object structure');
  report.checks.repeatSaveIdempotence = 'PASS';
  report.saveEvidence = {
    firstSaveSha256,
    repeatedSaveSha256,
    firstOwnedManifest: firstManifestIdentity,
    repeatedOwnedManifest: repeatedManifestIdentity,
    byteIdentity: true,
    ownedObjectStructureIdentity: true,
  };

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
  assert.ok(rightColorEditor.rect.left > leftColorEditor.rect.right + 2,
    `right editor crossed the inferred gutter: ${JSON.stringify({ leftColorEditor, rightColorEditor })}`);
  await replaceAndCommit('Independent packaged right paragraph');
  assert.equal(await save(colorSaveAsPdf), colorSaveAsPdf);
  await closeActiveTab();
  await openPdf(colorSaveAsPdf);
  await setEditTool();
  const reopenedRight = await openEditor('.textLayer span[data-owned-text-edit-hit="true"]',
    'Independent packaged right paragraph');
  assert.ok(reopenedRight.rect.left > leftColorEditor.rect.right + 2,
    'reopened right editor crossed the inferred gutter');
  await callTool('app_key', { key: 'Escape' });
  assert.match(await pdfJsText(colorSaveAsPdf), /Independent packaged right paragraph/u);

  report.checks.sideBySideIsolation = 'PASS';

  await closeActiveTab();
  await openPdf(widthWorkingPdf);
  await setEditTool();
  const widthSelector = '.textLayer span[data-item-index="0"]';
  await waitUi(widthSelector, (value) => (
    value.found && value.visible
      && String(value.accessibility?.label ?? value.text).includes('EUV (extreme ultraviolet')
  ), 60_000);
  await openEditor(widthSelector, 'EUV (extreme ultraviolet');
  const widthLayout = await waitUntil('bounded substitution width compensation', async () => {
    const viewport = await callTool('app_get_viewport_state');
    const layout = viewport.editorMetrics?.layoutState;
    return layout?.pending === false
      && layout.valid === true
      && Number.isFinite(layout.result?.widthCompensation)
      ? layout : null;
  }, 30_000);
  assert.ok(Math.abs(widthLayout.result.widthCompensation - 0.393557) <= 0.00001,
    `unexpected substitution compensation: ${JSON.stringify(widthLayout.result)}`);
  assert.ok(Math.abs(widthLayout.result.sourceWidth - 215.199998) <= 0.00001,
    `unexpected source width: ${JSON.stringify(widthLayout.result)}`);
  assert.ok(widthLayout.result.effectiveContentWidth <= widthLayout.result.sourceWidth + 1 + 1e-6);
  assert.equal((await ui('.font-substitution-dialog')).found, false);
  assert.equal((await ui('.pdf-text-editor-apply')).found, false);
  assert.equal((await ui('.pdf-text-editor-cancel')).found, false);
  report.checks.substitutionWidthCompensation = 'PASS';

  const widthReplacement = [
    'EUV (extreme ultraviolet lithography; advanced chip-printing technology',
    'used for leading-edge semiconductors)/High-NA (high numerical',
    'aperture; a next-generation EUV system capable of printing even',
    'smaller circuit patterns onto waferx)',
  ].join('\n');
  await callTool('app_key', { key: 'a', meta: true });
  const widthTyped = await callTool('app_type', { text: widthReplacement });
  assert.equal(widthTyped.ok, true, widthTyped.error);
  await waitUntil('edited width fixture exact validation', async () => {
    const viewport = await callTool('app_get_viewport_state');
    const layout = viewport.editorMetrics?.layoutState;
    return layout?.pending === false && layout.valid === true
      && layout.requestedFingerprint === layout.validatedFingerprint ? layout : null;
  }, 30_000);
  const widthBeforeSave = await sha256(widthWorkingPdf);
  await click('.quick-access-btn[data-action="save"]');
  await waitUi('.pdf-text-editor', (value) => !value.found, 60_000);
  try {
    await waitUntil('first Save click writes width fixture', async () => (
      await sha256(widthWorkingPdf) !== widthBeforeSave ? true : null
    ), 60_000);
  } catch (error) {
    const [tabs, viewport, loading, consoleLog] = await Promise.all([
      callTool('app_list_tabs').catch(() => null),
      callTool('app_get_viewport_state').catch(() => null),
      ui('.loading-overlay').catch(() => null),
      callTool('app_get_recent_console').catch(() => null),
    ]);
    throw new Error(`first Save click committed but did not write width fixture: ${JSON.stringify({
      tabs, viewport, loading, consoleLog,
    })}`, { cause: error });
  }
  report.checks.firstSaveClickCommit = 'PASS';

  await closeActiveTab();
  await openPdf(widthWorkingPdf);
  assert.match(await pdfJsText(widthWorkingPdf), /smaller circuit patterns onto waferx\)/u);
  await setEditTool();
  const widthReedit = await openEditor(
    '.textLayer span[data-owned-text-edit-hit="true"]',
    'EUV (extreme ultraviolet',
  );
  assert.match(String(widthReedit.value ?? widthReedit.text), /waferx/u);
  await callTool('app_key', { key: 'Escape' });
  assert.equal(await save(widthSaveAsPdf), widthSaveAsPdf);

  const evidenceCopies = [
    copyFile(saveAsPdf, evidencePdfPath),
    copyFile(colorSaveAsPdf, colorEvidencePdfPath),
    copyFile(widthSaveAsPdf, widthEvidencePdfPath),
  ];
  const evidenceArtifacts = [
    path.relative(path.dirname(reportPath), evidencePdfPath),
    path.relative(path.dirname(reportPath), colorEvidencePdfPath),
    path.relative(path.dirname(reportPath), widthEvidencePdfPath),
  ];

  // Optional local production acceptance for a user-supplied real document.
  // CI keeps using the compact deterministic fixture above; this path never
  // commits or mutates the supplied source PDF.
  if (realPdfSource) {
    const realSourceSha256 = await sha256(realPdfSource);
    await closeActiveTab();
    await openPdf(realWorkingPdf);
    const openedRealPdf = await callTool('app_get_viewport_state');
    assert.ok(openedRealPdf.pageCount >= 3, 'real PDF must contain page 3');
    const navigation = await callTool('app_go_to_page', { page: 3 });
    assert.equal(navigation.ok, true, navigation.error);
    await waitUntil('real PDF page 3', async () => {
      const viewport = await callTool('app_get_viewport_state');
      return viewport.doc?.currentPage === 3 ? viewport : null;
    }, 60_000);
    await setEditTool();

    const firstLineSelector = '.textLayer[data-page="3"] span[data-item-index="256"]';
    const middleLineSelector = '.textLayer[data-page="3"] span[data-item-index="263"]';
    const finalLineSelector = '.textLayer[data-page="3"] span[data-item-index="269"]';
    await waitUi(firstLineSelector, (value) => (
      value.found && value.visible && String(value.text).includes('EUV')
    ), 90_000);

    const paragraphOpenings = [];
    for (const selector of [firstLineSelector, middleLineSelector, finalLineSelector]) {
      const editor = await openEditor(selector, 'EUV (extreme ultraviolet', '3');
      paragraphOpenings.push({ selector, rect: editor.rect });
      await callTool('app_key', { key: 'Escape' });
      await waitUi('.pdf-text-editor', (value) => !value.found, 30_000);
    }
    for (const opening of paragraphOpenings.slice(1)) {
      for (const field of ['left', 'top', 'width', 'height']) {
        assert.ok(Math.abs(opening.rect[field] - paragraphOpenings[0].rect[field]) <= 0.5,
          `page-3 paragraph ${field} changed by clicked line: ${JSON.stringify(paragraphOpenings)}`);
      }
    }

    const realEditor = await openEditor(middleLineSelector, 'EUV (extreme ultraviolet', '3');
    const sourceAtOpen = await ui(firstLineSelector);
    assert.ok(Math.abs(realEditor.rect.left - sourceAtOpen.rect.left) <= 0.5,
      `real PDF editor/source left edge differed: ${JSON.stringify({ realEditor, sourceAtOpen })}`);
    assert.ok(Math.abs(realEditor.rect.top - sourceAtOpen.rect.top) <= 0.5,
      `real PDF editor/source top edge differed: ${JSON.stringify({ realEditor, sourceAtOpen })}`);
    assert.equal((await ui('.font-substitution-dialog')).found, false);
    assert.equal((await ui('.pdf-text-editor-apply')).found, false);
    assert.equal((await ui('.pdf-text-editor-cancel')).found, false);

    const realWidthLayout = await waitUntil('real PDF page-3 width compensation', async () => {
      const viewport = await callTool('app_get_viewport_state');
      const layout = viewport.editorMetrics?.layoutState;
      return layout?.pending === false && layout.valid === true
        && layout.requestedFingerprint === layout.validatedFingerprint
        && Number.isFinite(layout.result?.widthCompensation) ? layout : null;
    }, 30_000);
    assert.ok(Math.abs(realWidthLayout.result.widthCompensation - 0.393557) <= 0.001,
      `unexpected real PDF substitution compensation: ${JSON.stringify(realWidthLayout.result)}`);
    assert.ok(realWidthLayout.result.widthCompensation <= 1 + 1e-6);
    assert.ok(realWidthLayout.result.effectiveContentWidth
      <= realWidthLayout.result.sourceWidth + 1 + 1e-6);

    await callTool('app_set_view_mode', { mode: 'continuous' });
    const realContinuousEditor = await waitUi('.pdf-text-editor', (value) => (
      value.found && value.visible && value.focused
        && value.pageTextEditHost?.attached && value.pageTextEditHost?.page === '3'
        && String(value.pageTextEditHost?.parentClass).includes('canvas-container-cont')
    ), 30_000);
    const realSourceBeforeScroll = await waitUi(firstLineSelector, (value) => (
      value.found && value.rect?.width > 0 && value.rect?.height > 0
    ), 30_000);
    const realRelativeBeforeScroll = {
      left: realContinuousEditor.rect.left - realSourceBeforeScroll.rect.left,
      top: realContinuousEditor.rect.top - realSourceBeforeScroll.rect.top,
    };
    await callTool('app_scroll', {
      x: Math.round(realContinuousEditor.rect.x + realContinuousEditor.rect.width / 2),
      y: Math.round(realContinuousEditor.rect.y + realContinuousEditor.rect.height / 2),
      dy: 120,
    });
    await delay(500);
    const realScrolledEditor = await waitUi('.pdf-text-editor', (value) => (
      value.found && value.visible && value.focused
        && value.pageTextEditHost?.attached && value.pageTextEditHost?.page === '3'
    ), 30_000);
    const realSourceAfterScroll = await waitUi(firstLineSelector, (value) => (
      value.found && value.rect?.width > 0 && value.rect?.height > 0
    ), 30_000);
    const realRelativeAfterScroll = {
      left: realScrolledEditor.rect.left - realSourceAfterScroll.rect.left,
      top: realScrolledEditor.rect.top - realSourceAfterScroll.rect.top,
    };
    assert.ok(Math.abs(realRelativeAfterScroll.left - realRelativeBeforeScroll.left) <= 0.5,
      `real PDF editor drifted horizontally while scrolling: ${JSON.stringify({ realRelativeBeforeScroll, realRelativeAfterScroll })}`);
    assert.ok(Math.abs(realRelativeAfterScroll.top - realRelativeBeforeScroll.top) <= 0.5,
      `real PDF editor drifted vertically while scrolling: ${JSON.stringify({ realRelativeBeforeScroll, realRelativeAfterScroll })}`);

    await callTool('app_set_view_mode', { mode: 'single' });
    await waitUi('.pdf-text-editor', (value) => (
      value.found && value.visible && value.focused
        && value.pageTextEditHost?.attached && value.pageTextEditHost?.page === '3'
        && value.pageTextEditHost?.parentId === 'canvas-container'
    ), 30_000);
    const realReplacement = [
      'EUV (extreme ultraviolet lithography; advanced chip-printing technology',
      'used for leading-edge semiconductors)/High-NA (high numerical',
      'aperture; a next-generation EUV system capable of printing even',
      'smaller chip features) lithography (the chip-making process that prints',
      'extremely small circuit patterns onto waferx)',
    ].join('\n');
    await callTool('app_key', { key: 'a', meta: true });
    const realTyped = await callTool('app_type', { text: realReplacement });
    assert.equal(realTyped.ok, true, realTyped.error);
    await waitUntil('real PDF edited exact validation', async () => {
      const viewport = await callTool('app_get_viewport_state');
      const layout = viewport.editorMetrics?.layoutState;
      return layout?.pending === false && layout.valid === true
        && layout.requestedFingerprint === layout.validatedFingerprint ? layout : null;
    }, 30_000);
    const realBeforeSaveSha256 = await sha256(realWorkingPdf);
    await click('.quick-access-btn[data-action="save"]');
    await waitUi('.pdf-text-editor', (value) => !value.found, 60_000);
    await waitUntil('first Save click writes real PDF page 3', async () => (
      await sha256(realWorkingPdf) !== realBeforeSaveSha256 ? true : null
    ), 90_000);

    await closeActiveTab();
    await openPdf(realWorkingPdf);
    const reopenedNavigation = await callTool('app_go_to_page', { page: 3 });
    assert.equal(reopenedNavigation.ok, true, reopenedNavigation.error);
    await waitUi(
      '.textLayer[data-page="3"] span[data-owned-text-edit-hit="true"]',
      (value) => value.found && value.visible,
      90_000,
    );
    assert.match(await pdfJsText(realWorkingPdf, 3), /extremely small circuit patterns onto waferx\)/u);
    await setEditTool();
    await openEditor(
      '.textLayer[data-page="3"] span[data-owned-text-edit-hit="true"]',
      'EUV (extreme ultraviolet',
      '3',
    );
    const reopenedRuns = await richRunStates();
    assert.ok(reopenedRuns.some((run) => String(run.text).includes('waferx')),
      `saved page-3 edit could not be genuinely reopened: ${JSON.stringify(reopenedRuns)}`);
    await callTool('app_key', { key: 'Escape' });

    const firstRealSaveSha256 = await sha256(realWorkingPdf);
    await save();
    const repeatedRealSaveSha256 = await sha256(realWorkingPdf);
    assert.equal(repeatedRealSaveSha256, firstRealSaveSha256,
      'real PDF repeat Save without edits changed PDF bytes');
    const realScreenshot = await callTool('app_screenshot_view', { width: 1600 });
    assert.equal(realScreenshot.ok, true, realScreenshot.error);
    await writeFile(realPageScreenshotPath, Buffer.from(realScreenshot.png_base64, 'base64'));
    assert.equal(await sha256(realPdfSource), realSourceSha256,
      'local acceptance mutated the supplied source PDF');

    report.realPdfEvidence = {
      sourcePath: realPdfSource,
      sourceSha256: realSourceSha256,
      sourcePreserved: await sha256(realPdfSource) === realSourceSha256,
      page: 3,
      clickedItemIndexes: [256, 263, 269],
      paragraphOpenings,
      widthCompensation: realWidthLayout.result.widthCompensation,
      sourceWidth: realWidthLayout.result.sourceWidth,
      effectiveContentWidth: realWidthLayout.result.effectiveContentWidth,
      relativeBeforeScroll: realRelativeBeforeScroll,
      relativeAfterScroll: realRelativeAfterScroll,
      firstSaveSha256: firstRealSaveSha256,
      repeatedSaveSha256: repeatedRealSaveSha256,
      repeatSaveByteIdentity: true,
    };
    report.checks.realPdfPage3 = 'PASS';
    evidenceCopies.push(copyFile(realWorkingPdf, realEvidencePdfPath));
    evidenceArtifacts.push(
      path.relative(path.dirname(reportPath), realEvidencePdfPath),
      path.relative(path.dirname(reportPath), realPageScreenshotPath),
    );
  }

  await Promise.all(evidenceCopies);
  report.artifacts = evidenceArtifacts;
  report.status = Object.values(report.checks).every((status) => status === 'PASS') ? 'PASS' : 'FAIL';
  report.completedAt = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Packaged native paragraph editing acceptance passed: ${saveAsPdf}; ${colorSaveAsPdf}; ${widthSaveAsPdf}`);
} catch (error) {
  for (const [name, status] of Object.entries(report.checks)) {
    if (status === 'PENDING') report.checks[name] = 'NOT_RUN';
  }
  report.status = 'FAIL';
  report.completedAt = new Date().toISOString();
  report.error = error.stack || error.message || String(error);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  if (application && !exited) {
    try { process.kill(applicationPid || -application.pid, 'SIGTERM'); } catch {}
    await delay(500);
  }
}
