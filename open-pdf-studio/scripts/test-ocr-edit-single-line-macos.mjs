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

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { inspectOwnedScannedTextRepairLayer } from '../js/ocr/editing/pdf-repair-layer.js';
import { inspectOwnedInvisibleOcrLayer } from '../js/ocr/pdf-writer-proof.js';
import { startPackagedApp } from './lib/macos-packaged-app.mjs';

assert.equal(process.platform, 'darwin', 'single-line OCR editing acceptance is macOS-only');

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP || path.join(
  projectDir,
  '..',
  'target',
  'aarch64-apple-darwin',
  'release',
  'bundle',
  'macos',
  'Open PDF Studio.app',
  'Contents',
  'MacOS',
  'open-pdf-studio',
));
const appBundlePath = path.resolve(appPath, '..', '..', '..');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fixturePath = path.join(
  projectDir,
  'tests',
  'fixtures',
  'ocr',
  'editing-foundation-v1',
  'flat-scanned-line-edited.pdf',
);
const evidenceDir = path.join(projectDir, 'output', 'ocr-edit-single-line');
const runDir = await mkdtemp(path.join(tmpdir(), 'opds-ocr-edit-single-line-'));
const workingPdf = path.join(runDir, 'single-line-working.pdf');
const editedSavedPdf = path.join(runDir, 'single-line-edited-saved.pdf');
const sessionPath = path.join(runDir, 'session.json');
const copyHelper = path.join(runDir, 'macos-real-text-copy');
const reportPath = path.join(evidenceDir, 'acceptance.json');
let application;
let applicationPid;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalize(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function occurrences(text, token) {
  return text.split(token).length - 1;
}

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

async function ui(selector) {
  return callTool('app_ui_state', { selector, searchTabs: false });
}

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
}

async function closeActiveTab(force = false) {
  const tabs = await callTool('app_list_tabs');
  assert.ok(tabs.activeIndex >= 0, 'no active tab to close');
  const result = await callTool('app_close_tab', { index: tabs.activeIndex, force });
  assert.equal(result.ok, true, result.error);
}

async function startExistingLineEditor(expectedText) {
  const tool = await callTool('app_set_tool', { tool: 'editText' });
  assert.equal(tool.ok, true, tool.error);
  assert.equal(tool.current, 'editText');
  const selector = `.textLayer span[data-scanned-text-edit-hit-only="true"][aria-label="${expectedText}"]`;
  await waitUi(selector, (value) => value.found && value.visible && value.rect.width > 5 && value.rect.height > 5, 60_000);
  await click(selector);
  return waitUi('.pdf-text-editor[aria-multiline="false"][dir="ltr"]',
    (value) => value.found && value.visible && value.focused && value.value === expectedText);
}

async function ensureSectionExpanded(sectionSelector, childSelector) {
  const child = await ui(childSelector);
  if (child.found && child.visible) return child;
  await click(`${sectionSelector} > .property-section-header`);
  return waitUi(childSelector);
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

async function realCopyFromRect(rect, expectedText) {
  const y = rect.top + rect.height * 0.55;
  const { stdout } = await execFileAsync(copyHelper, [
    String(applicationPid),
    'drag',
    String(rect.left + 1),
    String(y),
    String(rect.right - 1),
    String(y),
  ], { maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'pass', 'packaged app copied no line text');
  assert.ok(normalize(result.text).includes(normalize(expectedText)),
    `packaged app copy did not include ${JSON.stringify(expectedText)}: ${JSON.stringify(result.text)}`);
  return result.text;
}

async function readProcesses() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      command: match[4],
    } : null;
  }).filter(Boolean);
}

async function waitForPidGone(pid, timeoutMs = 10_000) {
  await waitUntil(`process ${pid} to exit`, async () => {
    const processes = await readProcesses();
    return processes.some((entry) => entry.pid === pid) ? null : true;
  }, timeoutMs, 100);
}

async function copyAllFromExternalReader(pid, reader, expectedText) {
  let latest = { status: 'empty', text: '' };
  await waitUntil(`${reader} searchable text`, async () => {
    try {
      const { stdout } = await execFileAsync(copyHelper, [String(pid), 'all-center'], {
        maxBuffer: 4 * 1024 * 1024,
      });
      latest = JSON.parse(stdout);
      return latest.status === 'pass'
        && normalize(latest.text).includes(normalize(expectedText)) ? latest : null;
    } catch {
      return null;
    }
  }, 30_000, 500);
  assert.ok(normalize(latest.text).includes(normalize(expectedText)),
    `${reader} copy did not contain ${JSON.stringify(expectedText)}: ${JSON.stringify(latest.text)}`);
  return normalize(latest.text);
}

async function previewCopy(pdfPath, expectedText) {
  const before = new Set((await readProcesses())
    .filter((entry) => entry.command.includes('/Preview.app/Contents/MacOS/Preview'))
    .map((entry) => entry.pid));
  await execFileAsync('/usr/bin/open', ['-n', '-a', 'Preview', pdfPath]);
  const preview = await waitUntil('a dedicated Apple Preview process', async () => {
    const processes = await readProcesses();
    return processes.find((entry) => entry.command.includes('/Preview.app/Contents/MacOS/Preview')
      && !before.has(entry.pid)) || null;
  }, 30_000, 100);
  try {
    return await copyAllFromExternalReader(preview.pid, 'Apple Preview', expectedText);
  } finally {
    try { process.kill(preview.pid, 'SIGTERM'); } catch {}
    await waitForPidGone(preview.pid).catch(() => {});
  }
}

async function chromeCopy(pdfPath, expectedText) {
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
    await waitUntil('Google Chrome PDF viewer process', async () => {
      const processes = await readProcesses();
      return processes.some((entry) => entry.pid === chrome.pid) ? chrome.pid : null;
    }, 15_000, 100);
    return await copyAllFromExternalReader(chrome.pid, 'Google Chrome PDF viewer', expectedText);
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
  access(chromePath),
  mkdir(evidenceDir, { recursive: true }),
  copyFile(fixturePath, workingPdf),
]);

await execFileAsync('/usr/bin/swiftc', [
  path.join(projectDir, 'scripts', 'macos-real-text-copy.swift'),
  '-o',
  copyHelper,
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
  syntheticStateInjection: false,
  testOnlyEntryPoint: false,
  assertions: {},
};

try {
  application = await startPackagedApp({
    appBundle: appBundlePath,
    cwd: projectDir,
    env: { OPS_TEST_SESSION_PATH: sessionPath },
    artifactDir: path.join(evidenceDir, 'launch-logs'),
    launchLabel: 'ocr-edit-single-line',
    startupTimeoutMs: 90_000,
  });
  applicationPid = application.processId;
  await callTool('app_set_window_size', { width: 1320, height: 900 });
  await openPdf(workingPdf);

  const editor = await startExistingLineEditor('EDIT TEXT');
  assert.equal(editor.accessibility.label, 'Edit scanned text line: EDIT TEXT');
  const liveStatus = await waitUi('#scanned-text-edit-status',
    (value) => value.found && value.visible && /estimates/iu.test(value.text));
  assert.match(liveStatus.text, /isolated scanned text line/iu);
  assert.equal(liveStatus.accessibility.role, 'status');
  assert.equal(liveStatus.accessibility.live, 'polite');
  assert.equal(liveStatus.accessibility.atomic, 'true');
  await ensureSectionExpanded('#prop-text-format-section', '.scanned-text-estimate-note');
  const estimateNote = await ui('.scanned-text-estimate-note');
  assert.match(estimateNote.text, /not recovered exactly/iu);
  assert.equal((await ui('#prop-text-format-section .text-style-btn u')).found, false);
  assert.equal((await ui('#prop-text-format-section .text-style-btn s')).found, false);
  await ensureSectionExpanded('#prop-paragraph-section', '#prop-paragraph-section .text-align-buttons');
  assert.equal((await ui('#prop-paragraph-section input')).found, false,
    'line spacing and rotation controls must not appear for scanned single-line editing');
  await click('#prop-text-format-section .text-style-btn:nth-of-type(1)');
  await click('#prop-paragraph-section .text-align-btn:nth-of-type(2)');

  // Formatting controls intentionally do not steal focus back from the user.
  // Return to the editor and make the replacement selection explicit before
  // typing, matching the production keyboard flow.
  await click('.pdf-text-editor[aria-multiline="false"][dir="ltr"]');
  await callTool('app_key', { key: 'a', meta: true });
  const typed = await callTool('app_type', { text: 'NEW TEXT' });
  assert.equal(typed.editable, true);
  assert.equal((await ui('.pdf-text-editor')).value, 'NEW TEXT');
  const plainEnter = await callTool('app_key', { key: 'Enter' });
  await waitUi('#scanned-text-edit-status',
    (value) => value.found && value.visible && /Line breaks are not supported/iu.test(value.text))
    .catch(async (error) => {
      const [editorAfterEnter, statusAfterEnter, viewportAfterEnter] = await Promise.all([
        ui('.pdf-text-editor'),
        ui('#scanned-text-edit-status'),
        callTool('app_get_viewport_state'),
      ]);
      throw new Error(`${error.message}; plainEnter=${JSON.stringify(plainEnter)}; `
        + `editor=${JSON.stringify(editorAfterEnter)}; status=${JSON.stringify(statusAfterEnter)}; `
        + `viewport=${JSON.stringify(viewportAfterEnter)}`);
    });
  assert.equal((await ui('.pdf-text-editor')).value, 'NEW TEXT');
  await callTool('app_key', { key: 'Enter', meta: true });
  await waitUi('.pdf-text-editor', (value) => !value.found);
  await waitUi('.textLayer span[data-scanned-text-edit-hit-only="true"][aria-label="NEW TEXT"]');

  await callTool('app_key', { key: 'z', meta: true });
  await waitUi('.textLayer span[data-scanned-text-edit-hit-only="true"][aria-label="EDIT TEXT"]');
  await callTool('app_key', { key: 'z', meta: true, shift: true });
  await waitUi('.textLayer span[data-scanned-text-edit-hit-only="true"][aria-label="NEW TEXT"]');
  evidence.assertions.exactUndoRedo = true;

  await saveInPlace();
  await copyFile(workingPdf, editedSavedPdf);
  const editedPdfJsText = await extractedText(editedSavedPdf);
  assert.equal(occurrences(editedPdfJsText, 'NEW TEXT'), 1);
  assert.equal(occurrences(editedPdfJsText, 'EDIT TEXT'), 0);
  assert.equal(occurrences(editedPdfJsText, 'SCAN TEXT'), 0);
  const [editedVisible] = await inspectOwnedScannedTextRepairLayer(new Uint8Array(await readFile(editedSavedPdf)));
  const [editedInvisible] = await inspectOwnedInvisibleOcrLayer(new Uint8Array(await readFile(editedSavedPdf)));
  assert.equal(editedVisible.owned, true);
  assert.equal(editedVisible.selectionIds.length, 1);
  assert.equal(editedInvisible.owned, true);
  const editedSelection = editedVisible.state.pages[0].selections[0];
  assert.equal(editedSelection.content.replacementText, 'NEW TEXT');
  assert.equal(editedSelection.content.searchableText.text, 'NEW TEXT');
  assert.equal(editedSelection.content.layout.baselineAligned, true);
  assert.equal(editedSelection.content.layout.glyphCoverage, 'complete');
  assert.equal(editedSelection.content.estimatedStyle.weight.value, 'bold');
  assert.equal(editedSelection.content.estimatedStyle.alignment.value, 'center');
  assert.equal(Object.values(editedSelection.content.estimatedStyle)
    .every((value) => value.estimated === true), true);
  evidence.assertions.firstSave = {
    pdfJsReplacementOccurrences: 1,
    visibleOwnedSelections: 1,
    invisibleOwned: true,
    stateRevision: editedVisible.stateRevision,
    nativePdfiumGatePassed: true,
  };
  await closeActiveTab();
  await openPdf(workingPdf);
  await startExistingLineEditor('NEW TEXT');
  await callTool('app_key', { key: 'Escape' });
  await waitUi('.pdf-text-editor', (value) => !value.found);
  const nativeSpan = await waitUi('.textLayer span:not([data-ocr-owner])',
    (value) => value.found && value.visible && normalize(value.text).includes('NEW TEXT')
      && value.rect.width > 5 && value.rect.height > 5);
  const copied = await realCopyFromRect(nativeSpan.rect, 'NEW TEXT');
  evidence.assertions.reopenAndCopy = { reopenedOwnedEditor: true, copiedText: normalize(copied) };

  await saveInPlace();
  const repeatedVisible = (await inspectOwnedScannedTextRepairLayer(
    new Uint8Array(await readFile(workingPdf)),
  ))[0];
  const repeatedText = await extractedText(workingPdf);
  assert.equal(repeatedVisible.selectionIds.length, 1);
  assert.equal(repeatedVisible.contentRefs.length, editedVisible.contentRefs.length);
  assert.equal(occurrences(repeatedText, 'NEW TEXT'), 1);
  evidence.assertions.repeatedSave = {
    visibleOwnedSelections: 1,
    contentStreamCount: repeatedVisible.contentRefs.length,
    pdfJsReplacementOccurrences: 1,
  };

  await startExistingLineEditor('NEW TEXT');
  await click('.text-edit-delete-btn');
  await waitUi('.textLayer span[data-scanned-text-edit-hit-only="true"]', (value) => !value.found);
  await callTool('app_key', { key: 'z', meta: true });
  await waitUi('.textLayer span[data-scanned-text-edit-hit-only="true"][aria-label="NEW TEXT"]');
  await callTool('app_key', { key: 'z', meta: true, shift: true });
  await waitUi('.textLayer span[data-scanned-text-edit-hit-only="true"]', (value) => !value.found);
  await saveInPlace();
  const restoredText = await extractedText(workingPdf);
  assert.equal(occurrences(restoredText, 'SCAN TEXT'), 1);
  assert.equal(occurrences(restoredText, 'NEW TEXT'), 0);
  assert.equal((await inspectOwnedScannedTextRepairLayer(
    new Uint8Array(await readFile(workingPdf)),
  ))[0].owned, false);
  assert.equal((await inspectOwnedInvisibleOcrLayer(
    new Uint8Array(await readFile(workingPdf)),
  ))[0].owned, true);
  evidence.assertions.removalRestoration = {
    visibleOwned: false,
    originalSearchableOccurrences: 1,
    replacementOccurrences: 0,
    undoRedoBeforeSave: true,
    nativePdfiumGatePassed: true,
  };

  await terminateApplication();
  evidence.assertions.externalReaders = {
    applePreviewCopy: await previewCopy(editedSavedPdf, 'NEW TEXT'),
    googleChromePdfViewerCopy: await chromeCopy(editedSavedPdf, 'NEW TEXT'),
  };

  evidence.status = 'pass';
  evidence.completedAt = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'pass', reportPath, testDir: runDir }, null, 2));
} catch (error) {
  evidence.status = 'fail';
  evidence.error = error instanceof Error ? error.stack || error.message : String(error);
  evidence.logs = application?.logsAfter?.(0).slice(-20_000) || '';
  await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`).catch(() => {});
  throw error;
} finally {
  await terminateApplication();
}
