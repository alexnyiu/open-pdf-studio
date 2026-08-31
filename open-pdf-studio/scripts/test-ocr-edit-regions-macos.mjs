import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createCanvas } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { inspectOwnedScannedTextRepairLayer } from '../js/ocr/editing/pdf-repair-layer.js';
import { inspectOwnedInvisibleOcrLayer } from '../js/ocr/pdf-writer-proof.js';
import { startPackagedApp } from './lib/macos-packaged-app.mjs';

const reflowMode = process.env.OPDS_OCR_EDIT_ACCEPTANCE_MODE === 'reflow';
assert.equal(process.platform, 'darwin', `${reflowMode ? 'paragraph reflow' : 'fixed-region'} OCR editing acceptance is macOS-only`);

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP || path.join(
  projectDir, '..', 'target', 'aarch64-apple-darwin', 'release', 'bundle', 'macos',
  'Open PDF Studio.app', 'Contents', 'MacOS', 'open-pdf-studio',
));
const appBundlePath = path.resolve(appPath, '..', '..', '..');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fixturePath = path.join(
  projectDir, 'tests', 'fixtures', 'ocr', 'editing-foundation-v1',
  'flat-scanned-region-edited.pdf',
);
const sourceFixturePath = path.join(
  projectDir, 'tests', 'fixtures', 'ocr', 'editing-foundation-v1',
  'flat-scanned-region-source.pdf',
);
const evidenceDir = path.join(projectDir, 'output', reflowMode ? 'ocr-reflow' : 'ocr-edit-regions');
const runDir = await mkdtemp(path.join(tmpdir(), reflowMode ? 'opds-ocr-reflow-' : 'opds-ocr-edit-regions-'));
const workingPdf = path.join(runDir, reflowMode ? 'reflow-working.pdf' : 'fixed-region-working.pdf');
const firstSavedPdf = path.join(runDir, reflowMode ? 'reflow-first-save.pdf' : 'fixed-region-first-save.pdf');
const sessionPath = path.join(runDir, 'session.json');
const copyHelper = path.join(runDir, 'macos-real-text-copy');
const reportPath = path.join(evidenceDir, 'acceptance.json');
const replacementLines = reflowMode
  ? ['Café Ελληνικά Привет reflows safely']
  : ['MACOS ONE', 'MACOS TWO', 'MACOS THREE'];
const replacementText = replacementLines.join('\n');
const replacementTokens = reflowMode
  ? ['Café', 'Ελληνικά', 'Привет', 'reflows', 'safely']
  : replacementLines;
let application;
let applicationPid;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const normalize = (value) => String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const occurrences = (text, token) => text.split(token).length - 1;

async function callTool(name, arguments_ = {}) {
  if (!application) throw new Error('packaged application is not ready');
  return application.callTool(name, arguments_);
}

async function waitUntil(description, probe, timeoutMs = 30_000, intervalMs = 75) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let latestError;
  while (Date.now() < deadline) {
    try {
      latest = await probe();
      if (latest) return latest;
      latestError = null;
    } catch (error) {
      latestError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}${latestError ? `: ${latestError.message}` : `: ${JSON.stringify(latest)}`}`);
}

const ui = (selector) => callTool('app_ui_state', { selector, searchTabs: false });

async function waitUi(selector, predicate = (value) => value.found && value.visible, timeoutMs = 30_000) {
  return waitUntil(selector, async () => {
    const value = await ui(selector);
    return predicate(value) ? value : null;
  }, timeoutMs);
}

async function click(selector) {
  await waitUi(selector, (value) => value.found && value.visible && !value.disabled);
  const result = await callTool('app_click_element', { selector, searchTabs: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.clicked, true, `${selector} was not clicked`);
}

async function openPdf(pdfPath) {
  const result = await callTool('app_open_pdf', { path: pdfPath });
  assert.equal(result.ok, true, result.error);
  await waitUntil(`active PDF ${pdfPath}`, async () => {
    const viewport = await callTool('app_get_viewport_state');
    return viewport.doc?.filePath === pdfPath && viewport.pageCount === 1 ? viewport : null;
  }, 60_000);
  const singleView = await callTool('app_set_view_mode', { mode: 'single' });
  assert.equal(singleView.ok, true, singleView.error);
  await waitUntil(`single-page viewport for ${pdfPath}`, async () => {
    const viewport = await callTool('app_get_viewport_state');
    return viewport.doc?.filePath === pdfPath
      && viewport.doc?.viewMode === 'single'
      && viewport.canvas?.cssWidth > 0
      && viewport.canvas?.cssHeight > 0 ? viewport : null;
  }, 60_000);
}

async function closeActiveTab(force = false) {
  const tabs = await callTool('app_list_tabs');
  assert.ok(tabs.activeIndex >= 0, 'no active tab to close');
  const result = await callTool('app_close_tab', { index: tabs.activeIndex, force });
  assert.equal(result.ok, true, result.error);
}

async function waitRegionHit(expectedText) {
  return waitUi(
    '.textLayer span[data-ocr-region-id][data-scanned-text-edit-hit-only="true"]',
    (value) => value.found && value.visible
      && normalize(value.accessibility?.label) === normalize(expectedText)
      && value.rect.width > 5 && value.rect.height > 5,
    60_000,
  );
}

async function startRegionEditor(expectedText, sourceLineId = null) {
  const tool = await callTool('app_set_tool', { tool: 'editText' });
  assert.equal(tool.ok, true, tool.error);
  assert.equal(tool.current, 'editText');
  const selector = sourceLineId
    ? `.textLayer span[data-ocr-region-id][data-scanned-text-edit-hit-only="true"][data-ocr-line-id="${sourceLineId}"]`
    : '.textLayer span[data-ocr-region-id][data-scanned-text-edit-hit-only="true"]';
  const hit = await waitUi(selector, (value) => value.found && value.visible
    && normalize(value.accessibility?.label) === normalize(expectedText)
    && value.rect.width > 5 && value.rect.height > 5, 60_000);
  await click(selector);
  let editor;
  try {
    editor = await waitUi(
      '.pdf-text-editor',
      (value) => value.found && value.visible && value.focused && value.value === expectedText,
    );
    assert.equal(editor.accessibility.multiline, 'true');
    assert.equal(editor.accessibility.direction, 'ltr');
  } catch (error) {
    const [genericEditor, messageDialog, editorStatus, viewport, recentConsole] = await Promise.all([
      ui('.pdf-text-editor').catch(() => null),
      ui('.message-dialog').catch(() => null),
      ui('#scanned-text-edit-status').catch(() => null),
      callTool('app_get_viewport_state').catch(() => null),
      callTool('app_get_recent_console', { tail: 100 }).catch(() => null),
    ]);
    const diagnostics = {
      selector,
      hit,
      genericEditor,
      messageDialog,
      editorStatus,
      editorSession: viewport?.editorSession || null,
      editorMetrics: viewport?.editorMetrics || null,
      recentConsole,
    };
    throw new Error(`${error.message}\nOCR editor opening diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  return { editor, hit };
}

async function saveInPlace() {
  const result = await callTool('app_save_pdf');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.path, workingPdf);
}

async function extractedText(pdfPath) {
  const document = await pdfjsLib.getDocument({
    data: new Uint8Array(await readFile(pdfPath)),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const content = await (await document.getPage(1)).getTextContent();
    return content.items.map((item) => item.str).filter(Boolean).join('\n');
  } finally {
    await document.destroy();
  }
}

async function renderedPage(pdfPath) {
  const document = await pdfjsLib.getDocument({
    data: new Uint8Array(await readFile(pdfPath)),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return {
      width: canvas.width,
      height: canvas.height,
      data: new Uint8ClampedArray(context.getImageData(0, 0, canvas.width, canvas.height).data),
    };
  } finally {
    await document.destroy();
  }
}

function comparePixels(before, after, approvedRegion = null) {
  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);
  let changedPixels = 0;
  let outsideApprovedChangedPixels = 0;
  for (let index = 0; index < before.data.length; index += 4) {
    if ([0, 1, 2, 3].every((channel) => before.data[index + channel] === after.data[index + channel])) continue;
    changedPixels += 1;
    const pixel = index / 4;
    const x = pixel % before.width;
    const y = Math.floor(pixel / before.width);
    const inside = approvedRegion && x >= approvedRegion.x && y >= approvedRegion.y
      && x < approvedRegion.x + approvedRegion.width
      && y < approvedRegion.y + approvedRegion.height;
    if (!inside) outsideApprovedChangedPixels += 1;
  }
  return { changedPixels, outsideApprovedChangedPixels };
}

async function readProcesses() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? { pid: Number(match[1]), command: match[4] } : null;
  }).filter(Boolean);
}

async function waitForPidGone(pid, timeoutMs = 10_000) {
  await waitUntil(`process ${pid} to exit`, async () =>
    (await readProcesses()).some((entry) => entry.pid === pid) ? null : true, timeoutMs, 100);
}

async function copyAllFromReader(pid, reader) {
  let latest = { status: 'empty', text: '' };
  await waitUntil(`${reader} searchable text`, async () => {
    try {
      const { stdout } = await execFileAsync(copyHelper, [String(pid), 'all-center'], {
        maxBuffer: 4 * 1024 * 1024,
      });
      latest = JSON.parse(stdout);
      return latest.status === 'pass'
        && replacementTokens.every((token) => normalize(latest.text).includes(normalize(token)))
        ? latest : null;
    } catch {
      return null;
    }
  }, 30_000, 500);
  return normalize(latest.text);
}

async function copyFromRect(pid, reader, rect) {
  let latest = { status: 'empty', text: '' };
  await waitUntil(`${reader} selected native text`, async () => {
    try {
      const y = rect.top + rect.height * 0.55;
      const { stdout } = await execFileAsync(copyHelper, [
        String(pid),
        'drag',
        String(rect.left + 1),
        String(y),
        String(rect.right - 1),
        String(y),
      ], { maxBuffer: 4 * 1024 * 1024 });
      latest = JSON.parse(stdout);
      return latest.status === 'pass'
        && replacementTokens.some((token) => normalize(latest.text).includes(normalize(token)))
        ? latest : null;
    } catch {
      return null;
    }
  }, 30_000, 500);
  return normalize(latest.text);
}

async function previewCopy(pdfPath) {
  const before = new Set((await readProcesses())
    .filter((entry) => entry.command.includes('/Preview.app/Contents/MacOS/Preview'))
    .map((entry) => entry.pid));
  await execFileAsync('/usr/bin/open', ['-n', '-a', 'Preview', pdfPath]);
  const preview = await waitUntil('dedicated Apple Preview process', async () =>
    (await readProcesses()).find((entry) => entry.command.includes('/Preview.app/Contents/MacOS/Preview')
      && !before.has(entry.pid)) || null, 30_000, 100);
  try {
    return await copyAllFromReader(preview.pid, 'Apple Preview');
  } finally {
    try { process.kill(preview.pid, 'SIGTERM'); } catch {}
    await waitForPidGone(preview.pid).catch(() => {});
  }
}

async function chromeCopy(pdfPath) {
  const profileDir = path.join(runDir, 'chrome-profile');
  await mkdir(profileDir, { recursive: true });
  const chrome = spawn(chromePath, [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--new-window',
    pathToFileURL(pdfPath).href,
  ], { detached: true, stdio: 'ignore' });
  try {
    await waitUntil('Google Chrome PDFium viewer', async () =>
      (await readProcesses()).some((entry) => entry.pid === chrome.pid) ? chrome.pid : null, 15_000, 100);
    return await copyAllFromReader(chrome.pid, 'Google Chrome PDFium viewer');
  } finally {
    try { process.kill(-chrome.pid, 'SIGTERM'); } catch { try { chrome.kill('SIGTERM'); } catch {} }
    await waitForPidGone(chrome.pid).catch(() => {});
  }
}

async function terminateApplication() {
  await application?.stop?.();
}

await Promise.all([
  access(appPath),
  access(fixturePath),
  access(sourceFixturePath),
  access(chromePath),
  mkdir(evidenceDir, { recursive: true }),
  copyFile(fixturePath, workingPdf),
]);

await execFileAsync('/usr/bin/swiftc', [
  path.join(projectDir, 'scripts', 'macos-real-text-copy.swift'), '-o', copyHelper,
], {
  cwd: projectDir,
  env: {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: path.join(runDir, 'swift-module-cache'),
    SWIFT_MODULECACHE_PATH: path.join(runDir, 'swift-module-cache'),
  },
  maxBuffer: 4 * 1024 * 1024,
});

const evidence = {
  status: 'running',
  platform: process.platform,
  packagedApp: appBundlePath,
  testDir: runDir,
  productionEntryPath: true,
  testOnlyEntryPoint: false,
  assertions: {},
};

try {
  application = await startPackagedApp({
    appBundle: appBundlePath,
    cwd: projectDir,
    env: { OPS_TEST_SESSION_PATH: sessionPath },
    artifactDir: path.join(evidenceDir, 'launch-logs'),
    launchLabel: reflowMode ? 'ocr-reflow' : 'ocr-edit-regions',
    startupTimeoutMs: 90_000,
  });
  applicationPid = application.processId;
  await callTool('app_set_window_size', { width: 1320, height: 900 });
  await openPdf(workingPdf);

  for (const sourceLineId of ['region-line-2', 'region-line-3']) {
    const probe = await startRegionEditor('REGION ONE\nREGION TWO\nREGION THREE', sourceLineId);
    assert.equal(probe.editor.value, 'REGION ONE\nREGION TWO\nREGION THREE');
    await callTool('app_key', { key: 'Escape' });
    await waitUi('.pdf-text-editor', (value) => !value.found);
  }
  evidence.assertions.clickAnyOwnedSourceLine = true;

  const { editor } = await startRegionEditor('REGION ONE\nREGION TWO\nREGION THREE', 'region-line-1');
  assert.match(editor.accessibility.label, /fixed region/iu);
  const status = await waitUi('#scanned-text-edit-status',
    (value) => value.found && value.visible && /fixed original region/iu.test(value.text))
    .catch(async (error) => {
      const [genericEditor, scannedStatus, nativeStatus, viewport] = await Promise.all([
        ui('.pdf-text-editor'),
        ui('#scanned-text-edit-status'),
        ui('#native-text-edit-status'),
        callTool('app_get_viewport_state'),
      ]);
      throw new Error(`${error.message}; editor=${JSON.stringify(genericEditor)}; `
        + `scannedStatus=${JSON.stringify(scannedStatus)}; nativeStatus=${JSON.stringify(nativeStatus)}; `
        + `viewport=${JSON.stringify(viewport)}`);
    });
  assert.equal(status.accessibility.role, 'status');
  assert.equal(status.accessibility.live, 'polite');
  assert.equal(status.accessibility.atomic, 'true');
  if (reflowMode) assert.match(status.text, /single paragraph reflows inside this region/iu);
  const typed = await callTool('app_type', { text: replacementText });
  assert.equal(typed.editable, true);
  assert.equal((await ui('.pdf-text-editor')).value, replacementText);
  await callTool('app_key', { key: 'Enter', meta: true });
  await waitUi('.pdf-text-editor', (value) => !value.found);
  await waitRegionHit(replacementText);

  await callTool('app_key', { key: 'z', meta: true });
  await waitRegionHit('REGION ONE\nREGION TWO\nREGION THREE');
  await callTool('app_key', { key: 'z', meta: true, shift: true });
  await waitRegionHit(replacementText);
  evidence.assertions.undoRedo = true;

  await saveInPlace();
  await copyFile(workingPdf, firstSavedPdf);
  const pdfJsText = await extractedText(firstSavedPdf);
  for (const token of replacementTokens) assert.equal(occurrences(pdfJsText, token), 1);
  for (const line of ['REGION ONE', 'REGION TWO', 'REGION THREE', 'SCAN ONE', 'SCAN TWO', 'SCAN THREE']) {
    assert.equal(occurrences(pdfJsText, line), 0);
  }
  const [visible] = await inspectOwnedScannedTextRepairLayer(new Uint8Array(await readFile(firstSavedPdf)));
  const [invisible] = await inspectOwnedInvisibleOcrLayer(new Uint8Array(await readFile(firstSavedPdf)));
  assert.equal(visible.owned, true);
  assert.equal(invisible.owned, true);
  assert.equal(visible.selectionIds.length, 1);
  const selection = visible.state.pages[0].selections[0];
  assert.equal(selection.content.scope,
    reflowMode ? 'approved-region-paragraph-reflow' : 'fixed-region-multiline');
  assert.equal(selection.content.replacementText, replacementText);
  assert.equal(selection.content.visibleReplacement.text, selection.content.searchableText.text);
  const savedLayoutLines = selection.content.layout.lines.map((line) => line.text);
  assert.deepEqual(
    selection.content.searchableText.lines.map((line) => line.text),
    savedLayoutLines,
  );
  assert.equal(savedLayoutLines.join(reflowMode ? ' ' : '\n'), replacementText);
  if (reflowMode) {
    assert.equal(selection.content.layout.shaping, 'fontkit-liberation-ltr-v1');
    assert.equal(selection.content.layout.direction, 'ltr');
    assert.equal(selection.content.layout.glyphCoverage, 'complete');
    assert.ok(savedLayoutLines.length >= 2, 'production paragraph must visibly wrap');
  }
  assert.equal(selection.content.layout.clippingPrevented, true);
  assert.equal(selection.content.layout.overflow, false);
  assert.equal(selection.content.visibleReplacement.outsideEditRegionChangedPixels, 0);
  const sourceRaster = await renderedPage(sourceFixturePath);
  const firstSavedRaster = await renderedPage(firstSavedPdf);
  const pixelDifference = comparePixels(sourceRaster, firstSavedRaster, selection.repair.approvedRegion);
  assert.ok(pixelDifference.changedPixels > 0);
  assert.equal(pixelDifference.outsideApprovedChangedPixels, 0);
  evidence.assertions.firstSave = {
    pdfJsLines: savedLayoutLines.length,
    ownedVisible: true,
    ownedInvisible: true,
    nativePdfiumGatePassed: true,
    outsideEditRegionChangedPixels: pixelDifference.outsideApprovedChangedPixels,
  };

  await closeActiveTab();
  await openPdf(workingPdf);
  const reopenedEditor = await startRegionEditor(replacementText);
  if (reflowMode) {
    assert.match(reopenedEditor.editor.accessibility.label, /paragraph reflow region/iu);
    const reopenedStatus = await waitUi('#scanned-text-edit-status',
      (value) => value.found && value.visible && /approved original OCR region/iu.test(value.text));
    assert.equal(reopenedStatus.accessibility.role, 'status');
    assert.equal(reopenedStatus.accessibility.live, 'polite');
  }
  await callTool('app_key', { key: 'Escape' });
  const nativeRegion = await waitUi('.textLayer span:not([data-ocr-owner])',
    (value) => value.found && value.visible && replacementTokens.some((token) => normalize(value.text).includes(normalize(token)))
      && value.rect.width > 5 && value.rect.height > 5);
  const selectTool = await callTool('app_set_tool', { tool: 'select' });
  assert.equal(selectTool.current, 'select');
  evidence.assertions.reopenAndCopy = {
    ownedEditor: true,
    copiedText: await copyFromRect(applicationPid, 'Open PDF Studio', nativeRegion.rect),
  };

  await saveInPlace();
  const repeatedText = await extractedText(workingPdf);
  for (const token of replacementTokens) assert.equal(occurrences(repeatedText, token), 1);
  const [repeatedVisible] = await inspectOwnedScannedTextRepairLayer(new Uint8Array(await readFile(workingPdf)));
  assert.equal(repeatedVisible.selectionIds.length, 1);
  assert.equal(repeatedVisible.contentRefs.length, visible.contentRefs.length);
  const repeatedPixelDifference = comparePixels(firstSavedRaster, await renderedPage(workingPdf));
  assert.equal(repeatedPixelDifference.changedPixels, 0);
  evidence.assertions.repeatedSave = {
    visibleSelectionCount: 1,
    contentStreamCount: repeatedVisible.contentRefs.length,
    pdfJsLines: savedLayoutLines.length,
    changedPixels: repeatedPixelDifference.changedPixels,
    nativePdfiumGatePassed: true,
  };

  await startRegionEditor(replacementText);
  await callTool('app_type', { text: 'UNBREAKABLETOKEN'.repeat(40) });
  await callTool('app_key', { key: 'Enter', meta: true });
  await waitUi('#scanned-text-edit-status',
    (value) => value.found && value.visible && /rejected/iu.test(value.text));
  assert.equal((await ui('.pdf-text-editor')).found, true, 'overflow rejection must retain the editor');
  await callTool('app_key', { key: 'Escape' });
  evidence.assertions.explicitOverflowRejection = true;

  if (reflowMode) {
    const rejectionCases = [
      ['Missing ☃ glyph', /no glyph for U\+2603/iu, 'missingGlyph'],
      ['Unsupported 漢 script', /Script for U\+6F22/iu, 'unsupportedScript'],
      ['שלום direction', /Right-to-left reflow is unavailable/iu, 'unsupportedDirection'],
    ];
    evidence.assertions.explicitFailureMessages = {};
    for (const [text, pattern, key] of rejectionCases) {
      await closeActiveTab();
      await openPdf(workingPdf);
      await startRegionEditor(replacementText);
      const typedFailure = await callTool('app_type', { text });
      assert.equal(typedFailure.editable, true);
      assert.equal((await ui('.pdf-text-editor')).value, text);
      await callTool('app_key', { key: 'Enter', meta: true });
      const rejected = await waitUi('#scanned-text-edit-status',
        (value) => value.found && value.visible && /rejected/iu.test(value.text));
      assert.match(rejected.text, pattern);
      assert.equal(rejected.accessibility.role, 'status');
      assert.equal(rejected.accessibility.live, 'polite');
      assert.equal((await ui('.pdf-text-editor')).found, true,
        `${key} rejection must retain the editor`);
      await callTool('app_key', { key: 'Escape' });
      evidence.assertions.explicitFailureMessages[key] = rejected.text;
    }
  }

  await terminateApplication();
  evidence.assertions.externalReaders = {
    applePreviewCopy: await previewCopy(firstSavedPdf),
    chromePdfiumCopy: await chromeCopy(firstSavedPdf),
  };
  evidence.status = 'pass';
  evidence.completedAt = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'pass', reportPath, testDir: runDir }, null, 2));
} catch (error) {
  evidence.status = 'fail';
  evidence.error = error instanceof Error ? error.stack || error.message : String(error);
  evidence.logs = application?.logsAfter?.(0).slice(-20_000) || '';
  if (application && !application.state.exited) {
    evidence.runtimeDiagnostics = await Promise.all([
      ui('.pdf-text-editor').catch(() => null),
      ui('.message-dialog').catch(() => null),
      ui('#scanned-text-edit-status').catch(() => null),
      callTool('app_get_viewport_state').catch(() => null),
      callTool('app_get_recent_console', { tail: 200 }).catch(() => null),
    ]).then(([editor, messageDialog, editorStatus, viewport, recentConsole]) => ({
      editor,
      messageDialog,
      editorStatus,
      viewport,
      recentConsole,
    }));
  }
  await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`).catch(() => {});
  throw error;
} finally {
  await terminateApplication();
}
