import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { inspectOwnedInvisibleOcrLayer } from '../js/ocr/pdf-writer-proof.js';

assert.equal(process.platform, 'darwin', 'production OCR workflow acceptance is macOS-only');

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
const workflowManifest = JSON.parse(await readFile(path.join(
  projectDir,
  'tests',
  'fixtures',
  'ocr',
  'workflow-v1',
  'corpus.v1.json',
), 'utf8'));
const qualityManifest = JSON.parse(await readFile(path.join(
  projectDir,
  'tests',
  'fixtures',
  'ocr',
  'quality-v1',
  'corpus.v1.json',
), 'utf8'));
const evidenceDir = path.join(projectDir, 'output', 'ocr-production-workflow');
const runDir = await mkdtemp(path.join(tmpdir(), 'opds-ocr-production-workflow-'));
const fixtureDir = path.join(runDir, 'fixtures');
const sessionPath = path.join(runDir, 'session.json');
const cacheDir = path.join(runDir, 'ocr-cache');
const copyHelper = path.join(runDir, 'macos-real-text-copy');
const applicationStdoutPath = path.join(runDir, 'packaged-app.stdout.log');
const applicationStderrPath = path.join(runDir, 'packaged-app.stderr.log');
const logs = [];
let requestId = 0;
let application = null;
let applicationState = null;
let applicationPid = null;
let acceptancePassed = false;
let endpoint = null;

const criteria = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [String(index + 1), {
  status: 'pending',
  evidence: [],
}]));

function record(ids, evidence) {
  for (const id of ids) {
    criteria[String(id)].status = 'pass';
    criteria[String(id)].evidence.push(evidence);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalize(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function occurrences(text, token) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(token, offset)) >= 0) {
    count += 1;
    offset += token.length;
  }
  return count;
}

function attributeValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\a ');
}

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

function waitForExit(child) {
  if (applicationState?.exited) return Promise.resolve({
    code: applicationState.code,
    signal: applicationState.signal,
  });
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function terminateApplication() {
  if (!application || applicationState?.exited) return;
  try {
    if (applicationPid) process.kill(applicationPid, 'SIGTERM');
    else process.kill(-application.pid, 'SIGTERM');
  } catch { try { application.kill('SIGTERM'); } catch {} }
  await Promise.race([waitForExit(application), delay(2000)]);
  if (!applicationState.exited) {
    try {
      if (applicationPid) process.kill(applicationPid, 'SIGKILL');
      else process.kill(-application.pid, 'SIGKILL');
    } catch {}
  }
}

function releaseApplicationHandles() {
  for (const stream of [application?.stdout, application?.stderr]) {
    stream?.removeAllListeners();
    stream?.destroy();
  }
  application?.removeAllListeners();
  application?.unref?.();
}

async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`MCP ${body.error.code}: ${body.error.message}`);
  return body.result;
}

async function callTool(name, arguments_ = {}) {
  const result = await rpc('tools/call', { name, arguments: arguments_ });
  const text = result?.content?.find((entry) => entry.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error(`${name} returned no JSON text payload`);
  return JSON.parse(text);
}

async function waitForMcp() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (applicationState.exited) {
      throw new Error(`packaged app exited before MCP startup\n${logs.join('')}`);
    }
    try {
      const result = await rpc('initialize');
      applicationPid = result?._meta?.openPdfStudio?.processId ?? applicationPid;
      if (result?._meta?.openPdfStudio?.webviewReady === true) return result;
    } catch {}
    await delay(200);
  }
  throw new Error(`timed out waiting for packaged app MCP\n${logs.join('')}`);
}

async function waitUntil(description, probe, timeoutMs = 30_000, intervalMs = 50) {
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
  const suffix = latestError ? `: ${latestError.message}` : ` (latest ${JSON.stringify(latest)})`;
  throw new Error(`timed out waiting for ${description}${suffix}`);
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

const OCR_OWNERSHIP_STATES = [
  'none',
  'unowned',
  'pending',
  'saved',
  'saved-with-pending-changes',
  'pending-removal',
];

async function currentOwnershipState() {
  for (const state of OCR_OWNERSHIP_STATES) {
    if ((await ui(`[data-ownership-state="${state}"]`)).found) return state;
  }
  return null;
}

async function waitForOwnership(expected, timeoutMs = 30_000) {
  let observed = null;
  const result = await waitUntil(`OCR ownership ${expected}`, async () => {
    observed = await currentOwnershipState();
    return observed === expected ? observed : null;
  }, timeoutMs).catch((error) => {
    throw new Error(`${error.message}; observed ownership ${JSON.stringify(observed)}`);
  });
  return result;
}

async function click(selector, timeoutMs = 30_000) {
  await waitUi(selector, (value) => value.found && value.visible && !value.disabled, timeoutMs);
  const result = await callTool('app_click_element', { selector, searchTabs: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.clicked, true, `${selector} was not clicked`);
  return result;
}

async function listTabs() {
  const result = await callTool('app_list_tabs');
  assert.equal(result.ok, true, result.error);
  return result;
}

async function closeActiveTab(force = true) {
  const tabs = await listTabs();
  if (tabs.activeIndex < 0) return;
  const result = await callTool('app_close_tab', { index: tabs.activeIndex, force });
  assert.equal(result.ok, true, result.error);
}

async function openPdf(pdfPath) {
  const result = await callTool('app_open_pdf', { path: pdfPath });
  assert.equal(result.ok, true, result.error);
  await waitUntil(`active PDF ${pdfPath}`, async () => {
    const viewport = await callTool('app_get_viewport_state');
    return viewport.doc?.filePath === pdfPath && viewport.pageCount > 0 ? viewport : null;
  }, 60_000);
  return result;
}

async function startRecognition({ entireDocument = false, forceRerun = false } = {}) {
  const previous = await ui('.ocr-progress-toast[data-job-id]');
  const previousJobId = previous.found ? previous.dataset?.jobId : null;
  await click('.ribbon-tab[data-tab="organize"]');
  const recognizeAction = await ui('#ep-recognize-text');
  if (!recognizeAction.found || !recognizeAction.visible) {
    await click('#ribbon-collapse-toggle');
  }
  await click('#ep-recognize-text');
  await waitUi('#ocr-recognition-form');
  if (entireDocument) await click('input[name="ocr-page-scope"][value="entire-document"]');
  if (forceRerun) await click('input[name="ocr-existing-text"][value="force-rerun"]');
  await click('button[type="submit"][form="ocr-recognition-form"]', 60_000);
  return waitUi('.ocr-progress-toast[data-job-id]', (value) => value.found && value.visible
    && value.dataset?.jobId && value.dataset.jobId !== previousJobId, 30_000);
}

async function waitForTerminal(jobId, status = 'completed', timeoutMs = 300_000) {
  return waitUi(
    `.ocr-progress-toast[data-job-id="${attributeValue(jobId)}"] `
      + `.ocr-progress-summary[data-terminal-status="${status}"]`,
    (value) => value.found && value.visible,
    timeoutMs,
  );
}

async function search(query, expectedCount = null) {
  await callTool('app_key', { key: 'f', meta: true });
  await waitUi('.find-input', (value) => value.found && value.visible && value.focused, 10_000);
  const typed = await callTool('app_type', { text: query });
  assert.equal(typed.ok, true, typed.error);
  assert.equal(typed.editable, true, 'find input did not receive production typing');
  let count;
  if (expectedCount === 0) {
    await waitUi('.find-input-wrapper.not-found', (value) => value.found && value.visible, 30_000);
    count = 0;
  } else {
    const state = await waitUi('.find-count-inline', (value) => {
      if (!value.found || !value.visible) return false;
      const numbers = value.text.match(/\d+/gu);
      if (!numbers?.length) return false;
      const total = Number(numbers.at(-1));
      return expectedCount === null ? total >= 0 : total === expectedCount;
    }, 30_000);
    const numbers = state.text.match(/\d+/gu);
    count = Number(numbers.at(-1));
  }
  if (expectedCount !== null) assert.equal(count, expectedCount, `search count for ${JSON.stringify(query)}`);
  await click('.find-close-btn');
  return count;
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

function descendantOf(processes, pid, rootPid) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  let current = byPid.get(pid);
  const seen = new Set();
  while (current && !seen.has(current.pid)) {
    if (current.ppid === rootPid) return true;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

async function currentOcrChildren() {
  const processes = await readProcesses();
  return processes.filter((entry) => entry.command.includes('--ocr-child-job')
    && descendantOf(processes, entry.pid, applicationPid));
}

async function waitForOcrChild(timeoutMs = 30_000) {
  return waitUntil('a disposable production OCR child', async () => {
    const children = await currentOcrChildren();
    return children[0] || null;
  }, timeoutMs, 20);
}

async function waitForPidGone(pid, timeoutMs = 30_000) {
  await waitUntil(`process ${pid} to be reaped`, async () => {
    const processes = await readProcesses();
    return processes.some((entry) => entry.pid === pid) ? null : true;
  }, timeoutMs, 50);
}

async function realCopyFromRect(rect, expectedToken) {
  const startX = rect.left + Math.max(1, Math.min(3, rect.width * 0.05));
  const endX = rect.right - Math.max(1, Math.min(3, rect.width * 0.05));
  let lastResult = { status: 'empty', text: '' };
  const attempts = [
    { fraction: 0.55, contentOffsetY: 28 },
    { fraction: 0.4, contentOffsetY: 28 },
    { fraction: 0.7, contentOffsetY: 28 },
    { fraction: 0.55, contentOffsetY: 22 },
    { fraction: 0.55, contentOffsetY: 36 },
    { fraction: 0.55, contentOffsetY: 0 },
  ];
  for (const [attempt, candidate] of attempts.entries()) {
    const y = rect.top + candidate.contentOffsetY
      + Math.max(1, Math.min(rect.height - 1, rect.height * candidate.fraction));
    const [fromX, toX] = attempt === 1 ? [endX, startX] : [startX, endX];
    const { stdout } = await execFileAsync(copyHelper, [
      String(applicationPid),
      'drag',
      String(fromX),
      String(y),
      String(toX),
      String(y),
    ], { maxBuffer: 1024 * 1024 });
    lastResult = JSON.parse(stdout);
    if (lastResult.status === 'pass'
      && normalize(lastResult.text).includes(normalize(expectedToken))) return lastResult;
    await delay(200);
  }
  const { stdout } = await execFileAsync(copyHelper, [
    String(applicationPid),
    'all',
    String(rect.left + rect.width / 2),
    String(rect.top + rect.height / 2),
  ], { maxBuffer: 1024 * 1024 });
  lastResult = JSON.parse(stdout);
  if (lastResult.status === 'pass'
    && normalize(lastResult.text).includes(normalize(expectedToken))) return lastResult;
  assert.equal(lastResult.status, 'pass',
    `real macOS selection copied no text after bounded gestures: ${JSON.stringify(lastResult)}`);
  assert.ok(normalize(lastResult.text).includes(normalize(expectedToken)),
    `real macOS copy did not contain ${JSON.stringify(expectedToken)}: ${JSON.stringify(lastResult.text)}`);
  return lastResult;
}

async function realCopyOcrSpan(expectedToken) {
  await callTool('app_set_tool', { tool: 'select' });
  const selector = '.textLayer span[data-ocr-owner="open-pdf-studio"]';
  let observed = null;
  const span = await waitUntil('a selectable pending OCR span', async () => {
    observed = await ui(selector);
    return observed.found && observed.visible && observed.rect?.width > 5 && observed.rect?.height > 5
      ? observed
      : null;
  }, 30_000).catch((error) => {
    throw new Error(`${error.message}; observed span ${JSON.stringify(observed)}`);
  });
  return realCopyFromRect(span.rect, expectedToken);
}

function normalizedRect(element, canvas) {
  return {
    left: (element.left - canvas.left) / canvas.width,
    top: (element.top - canvas.top) / canvas.height,
    width: element.width / canvas.width,
    height: element.height / canvas.height,
  };
}

async function ocrGeometry(mode = 'single') {
  const spanSelector = mode === 'continuous'
    ? '.page-wrapper[data-page="1"] .textLayer span[data-ocr-owner="open-pdf-studio"]'
    : '#canvas-container .textLayer span[data-ocr-owner="open-pdf-studio"]';
  const canvasSelector = mode === 'continuous'
    ? '.page-wrapper[data-page="1"] .pdf-canvas'
    : '#pdf-canvas';
  const layerSelector = mode === 'continuous'
    ? '.page-wrapper[data-page="1"] .textLayer:has(span[data-ocr-owner="open-pdf-studio"])'
    : '#canvas-container .textLayer:has(span[data-ocr-owner="open-pdf-studio"])';
  let observed = null;
  return waitUntil(`settled ${mode} OCR geometry`, async () => {
    const span = await ui(spanSelector);
    const canvas = await ui(canvasSelector);
    const layer = await ui(layerSelector);
    if (!span.found || !span.visible || !span.rect?.width || !span.rect?.height
      || !canvas.found || !canvas.visible || !canvas.rect?.width || !canvas.rect?.height
      || !layer.found || !layer.visible || !layer.rect?.width || !layer.rect?.height) {
      return null;
    }
    let pageRect = canvas.rect;
    let viewport = null;
    if (mode === 'single') {
      const state = await callTool('app_get_viewport_state');
      viewport = state.viewport;
      if (!viewport?.active || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0
        || !Number.isFinite(viewport.offsetX) || !Number.isFinite(viewport.offsetY)
        || !Number.isFinite(viewport.pageW) || !Number.isFinite(viewport.pageH)) {
        return null;
      }
      const quarterTurn = viewport.rotation === 90 || viewport.rotation === 270;
      pageRect = {
        left: canvas.rect.left + viewport.offsetX,
        top: canvas.rect.top + viewport.offsetY,
        width: (quarterTurn ? viewport.pageH : viewport.pageW) * viewport.zoom,
        height: (quarterTurn ? viewport.pageW : viewport.pageH) * viewport.zoom,
      };
    }
    // Rotation and view-mode changes update the layer in a RAF. The MCP
    // probes above are separate requests, so the first span read can precede
    // that RAF while the layer read follows it. Re-read the span and require
    // its captured ancestor rect/style to match the layer snapshot before
    // treating this iteration as settled.
    const settledSpan = await ui(spanSelector);
    if (!settledSpan.found || !settledSpan.visible
        || !settledSpan.rect?.width || !settledSpan.rect?.height) return null;
    const spanLayerRect = settledSpan.textLayerHost?.rect;
    const sameLayerSnapshot = settledSpan.textLayerHost?.inlineStyle === layer.inlineStyle
      && settledSpan.textLayerHost?.dataset?.textLayerRequest
        === layer.dataset?.textLayerRequest
      && spanLayerRect
      && Math.abs(spanLayerRect.left - layer.rect.left) <= 0.5
      && Math.abs(spanLayerRect.top - layer.rect.top) <= 0.5
      && Math.abs(spanLayerRect.width - layer.rect.width) <= 0.5
      && Math.abs(spanLayerRect.height - layer.rect.height) <= 0.5;
    const normalized = normalizedRect(settledSpan.rect, pageRect);
    const layerAligned = ['left', 'top', 'width', 'height'].every(
      (key) => Math.abs(layer.rect[key] - pageRect[key]) <= 2,
    );
    observed = {
      span: settledSpan.rect,
      spanMatches: settledSpan.matchCount,
      spanTextLayerHost: settledSpan.textLayerHost,
      layer: layer.rect,
      layerMatches: layer.matchCount,
      layerDataset: layer.dataset,
      page: pageRect,
      normalized,
      viewport,
      layerStyle: layer.inlineStyle,
      spanStyle: settledSpan.inlineStyle,
    };
    return sameLayerSnapshot && layerAligned
      && normalized.left > -0.05 && normalized.top > -0.05
      && normalized.left + normalized.width < 1.05
      && normalized.top + normalized.height < 1.05
      ? observed
      : null;
  }, 10_000, 50).catch((error) => {
    throw new Error(`${error.message}; last geometry ${JSON.stringify(observed)}`);
  });
}

function assertGeometryNear(actual, expected, message, tolerance = 0.065) {
  for (const key of ['left', 'top', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance,
      `${message}: ${key} ${actual[key]} vs ${expected[key]}; `
        + `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function rotatedClockwise(rect) {
  return {
    left: 1 - rect.top - rect.height,
    top: rect.left,
    width: rect.height,
    height: rect.width,
  };
}

async function extractPdfJs(pdfPath) {
  const bytes = await readFile(pdfPath);
  const document = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const content = await (await document.getPage(pageNumber)).getTextContent();
      pages.push(content.items.map((item) => item.str).filter(Boolean).join('\n'));
    }
    return pages;
  } finally {
    await document.destroy();
  }
}

async function inspectPdf(pdfPath) {
  return inspectOwnedInvisibleOcrLayer(new Uint8Array(await readFile(pdfPath)));
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
    await delay(1500);
    const { stdout } = await execFileAsync(copyHelper, [String(preview.pid), 'all-center'], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'pass', 'Apple Preview copied no text');
    assert.ok(normalize(result.text).includes(normalize(expectedText)),
      `Apple Preview copy did not contain approved Unicode: ${JSON.stringify(result.text)}`);
    return result;
  } finally {
    try { process.kill(preview.pid, 'SIGTERM'); } catch {}
    await waitForPidGone(preview.pid, 10_000).catch(() => {});
  }
}

async function verifyFixtureGeometry(pdfPath) {
  const document = await PDFDocument.load(await readFile(pdfPath), { updateMetadata: false });
  const page = document.getPage(0);
  const crop = page.getCropBox();
  assert.deepEqual(
    [crop.x, crop.y, crop.width, crop.height],
    workflowManifest.outputs.imageOnly.pages[0].cropBox,
  );
  const userUnit = page.node.lookup(PDFName.of('UserUnit'), PDFNumber);
  assert.equal(userUnit.asNumber(), workflowManifest.outputs.imageOnly.pages[0].userUnit);
}

async function progressCount(state) {
  const value = await ui(`[data-count-state="${state}"] dd`);
  assert.equal(value.found, true, `missing progress count ${state}`);
  return Number(value.text.match(/\d+/u)?.[0] ?? Number.NaN);
}

await Promise.all([access(appPath), mkdir(evidenceDir, { recursive: true }), mkdir(cacheDir, { recursive: true })]);

try {
  await execFileAsync(process.execPath, [
    path.join(projectDir, 'scripts', 'generate-ocr-workflow-fixtures.mjs'),
    '--output-dir',
    fixtureDir,
  ], { cwd: projectDir, maxBuffer: 4 * 1024 * 1024 });
  const fixturePaths = {
    imageOnly: path.join(fixtureDir, workflowManifest.outputs.imageOnly.file),
    representative: path.join(fixtureDir, workflowManifest.outputs.representative.file),
    cancellation: path.join(fixtureDir, workflowManifest.outputs.cancellation.file),
  };
  const imageOnlyBaseline = path.join(runDir, 'image-only-baseline.pdf');
  const imageOnlySaveAs = path.join(runDir, 'image-only-save-as.pdf');
  const representativeSaveAs = path.join(runDir, 'representative-save-as.pdf');
  await copyFile(fixturePaths.imageOnly, imageOnlyBaseline);
  await verifyFixtureGeometry(fixturePaths.imageOnly);

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

  const port = await availablePort();
  endpoint = `http://127.0.0.1:${port}/mcp`;
  application = spawn('/usr/bin/open', [
    '-n',
    '-W',
    '--stdout', applicationStdoutPath,
    '--stderr', applicationStderrPath,
    '--env', 'OPS_ENABLE_MCP=1',
    '--env', 'OPDS_DETACHED=1',
    '--env', `OPS_TEST_SESSION_PATH=${sessionPath}`,
    '--env', `OPS_TEST_OCR_CACHE_DIR=${cacheDir}`,
    appBundlePath,
    '--args',
    '--mcp-server',
    '--mcp-port', String(port),
  ], {
    cwd: projectDir,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  applicationState = { exited: false, code: null, signal: null };
  const capture = (chunk) => {
    logs.push(chunk.toString());
    while (logs.join('').length > 512 * 1024) logs.shift();
  };
  application.stdout.on('data', capture);
  application.stderr.on('data', capture);
  application.on('exit', (code, signal) => {
    applicationState.exited = true;
    applicationState.code = code;
    applicationState.signal = signal;
  });

  await waitForMcp();
  await callTool('app_set_window_size', { width: 1200, height: 900 });

  // Real user cancellation reaches the retained controller handle and reaps its child.
  await openPdf(fixturePaths.cancellation);
  const cancelledJob = await startRecognition();
  const cancelledChild = await waitForOcrChild();
  const progress = await waitUi('.ocr-progress-track');
  assert.equal(progress.accessibility.role, 'progressbar');
  assert.equal(progress.accessibility.valueMin, '0');
  assert.equal(progress.accessibility.valueMax, '100');
  assert.ok(progress.accessibility.valueNow !== null);
  const live = await waitUi('.ocr-progress-live-region', (value) => value.found && value.visible && value.text.length > 0);
  assert.equal(live.accessibility.live, 'polite');
  assert.equal(live.accessibility.atomic, 'true');
  await click('[data-ocr-action="cancel"]');
  await waitForTerminal(cancelledJob.dataset.jobId, 'cancelled', 120_000);
  await waitForPidGone(cancelledChild.pid);
  record([1, 2, 3, 4], `packaged action created job/child ${cancelledChild.pid}; accessible progress announced; Cancel reaped it`);
  await closeActiveTab();

  // Document close uses the same real cancellation boundary.
  await openPdf(fixturePaths.cancellation);
  await startRecognition();
  const documentCloseChild = await waitForOcrChild();
  await closeActiveTab();
  await waitForPidGone(documentCloseChild.pid);
  record([20], `document close reaped active child ${documentCloseChild.pid}`);

  // Complete the image-only workflow through the real action.
  await openPdf(fixturePaths.imageOnly);
  const completedJob = await startRecognition();
  const completedChild = await waitForOcrChild();
  await waitForTerminal(completedJob.dataset.jobId, 'completed', 180_000);
  await waitForPidGone(completedChild.pid);
  const completedCacheNames = await readdir(path.join(cacheDir, 'v1')).catch(() => []);
  const completedCachePayloads = completedCacheNames.filter((name) => name.endsWith('.payload.json.gz'));
  const completedCacheMetadata = completedCacheNames.filter((name) => name.endsWith('.meta.json'));
  if (completedCachePayloads.length !== 1 || completedCacheMetadata.length !== 1) {
    const terminalToast = await ui(`.ocr-progress-toast[data-job-id="${attributeValue(completedJob.dataset.jobId)}"]`);
    const recentConsole = await callTool('app_get_recent_console', { tail: 200 });
    const diagnostics = (recentConsole.entries || [])
      .filter((entry) => JSON.stringify(entry).includes('[ocr-cache]'));
    throw new Error(`completed production cache files ${JSON.stringify(completedCacheNames)}; `
      + `terminal toast ${JSON.stringify(terminalToast)}; `
      + `terminal cache state ${JSON.stringify(terminalToast.dataset?.currentCacheState ?? null)}; `
      + `all cache states ${JSON.stringify(terminalToast.dataset?.cacheStates ?? null)}; `
      + `diagnostics ${JSON.stringify(diagnostics)}`);
  }
  assert.equal(await progressCount('completed'), 1, 'image-only workflow did not complete its page');
  assert.equal(await progressCount('skipped'), 0, 'image-only workflow unexpectedly skipped its page');
  assert.equal(await progressCount('unsupported'), 0, 'image-only workflow unexpectedly marked its page unsupported');
  assert.equal(await progressCount('failed'), 0, 'image-only workflow reported a page failure');
  assert.equal((await listTabs()).tabs.find((tab) => tab.active)?.modified, true);
  await click('[data-panel="ocr-review"]');
  await waitUi('#ocr-review-panel.active');
  await waitForOwnership('pending').catch(async (error) => {
    const ownedSpan = await ui('[data-ocr-owner="open-pdf-studio"]');
    const reviewLine = await ui('[data-ocr-review-line]');
    const consoleState = await callTool('app_get_recent_console', { tail: 50 });
    throw new Error(`${error.message}; owned span found=${ownedSpan.found}; review line found=${reviewLine.found}; console=${JSON.stringify(consoleState.entries)}`);
  });
  const firstEffective = await waitUi('[data-ocr-review-line] .ocr-review-effective-text',
    (value) => value.found && value.visible && value.text.length > 0);
  const engineText = normalize(firstEffective.text);
  assert.ok(engineText.length >= 4, 'production OCR returned no reviewable text');
  assert.equal(await search(engineText, 1), 1);
  record([5, 6], `completed child ${completedChild.pid} created pending OCR; search found ${JSON.stringify(engineText)}`);

  // Undo and redo the production OCR application itself.
  await click('[data-ocr-action="undo"]');
  await waitForOwnership('none');
  await waitUi('[data-ocr-owner="open-pdf-studio"]', (value) => !value.found);
  assert.equal(await search(engineText, 0), 0);
  assert.equal((await listTabs()).tabs.find((tab) => tab.active)?.modified, false);
  await click('[data-ocr-action="redo"]');
  await waitForOwnership('pending');
  assert.equal(await search(engineText, 1), 1);
  assert.equal((await listTabs()).tabs.find((tab) => tab.active)?.modified, true);
  record([14], 'production Undo/Redo removed and restored text, pending ownership, dirty state, and search results');

  let pendingCopy;
  try {
    pendingCopy = await realCopyOcrSpan(engineText.split(' ')[0]);
  } catch (error) {
    const recentConsole = await callTool('app_get_recent_console', { tail: 200 });
    const cacheDiagnostics = (recentConsole.entries || [])
      .filter((entry) => JSON.stringify(entry).includes('[ocr-cache]'));
    throw new Error(`${error.message}; cache diagnostics ${JSON.stringify(cacheDiagnostics)}`);
  }
  record([7], `trusted macOS drag and Command-C copied pending OCR: ${JSON.stringify(normalize(pendingCopy.text))}`);

  // Geometry remains stable through zoom, view modes, and a real page rotation.
  await callTool('app_set_view_mode', { mode: 'single' });
  await callTool('app_set_zoom', { scale: 1 });
  const baselineGeometry = await ocrGeometry('single');
  await callTool('app_set_zoom', { scale: 0.75 });
  const zoomOutGeometry = await ocrGeometry('single');
  assertGeometryNear(zoomOutGeometry.normalized, baselineGeometry.normalized, 'zoom-out OCR alignment');
  await callTool('app_set_zoom', { scale: 1.35 });
  const zoomInGeometry = await ocrGeometry('single');
  assertGeometryNear(zoomInGeometry.normalized, baselineGeometry.normalized, 'zoom-in OCR alignment');
  await callTool('app_set_zoom', { scale: 1 });
  await callTool('app_set_view_mode', { mode: 'continuous' });
  const continuousGeometry = await ocrGeometry('continuous');
  assertGeometryNear(continuousGeometry.normalized, baselineGeometry.normalized, 'continuous-mode OCR alignment');
  await callTool('app_set_view_mode', { mode: 'single' });
  await callTool('app_set_zoom', { scale: 1 });
  await click('#rotate-right');
  const rotatedGeometry = await ocrGeometry('single');
  assertGeometryNear(rotatedGeometry.normalized, rotatedClockwise(baselineGeometry.normalized),
    `90-degree OCR alignment; observed=${JSON.stringify(rotatedGeometry)}`, 0.09);
  await click('#rotate-left');
  const restoredGeometry = await ocrGeometry('single');
  assertGeometryNear(restoredGeometry.normalized, baselineGeometry.normalized, 'restored OCR alignment');
  assert.equal(await search(engineText, 1), 1);
  record([8], 'normalized OCR geometry stayed aligned across zoom, rotation, single-page, and continuous modes');

  // Review correction is an overlay over the immutable engine text.
  await click('[data-panel="ocr-review"]');
  const correction = 'Café naïve façade — € 42.50 REVIEWED';
  await click('[data-ocr-review-line]:first-child .ocr-review-secondary-button');
  await waitUi('.ocr-review-correction-editor input', (value) => value.found && value.visible && value.focused);
  const correctionTyped = await callTool('app_type', { text: correction });
  assert.equal(correctionTyped.editable, true);
  await click('.ocr-review-editor-actions .ocr-review-primary-button');
  const immutableSelector = `[data-ocr-engine-text="${attributeValue(engineText)}"]`
    + `[data-ocr-effective-text="${attributeValue(correction)}"]`;
  await waitUi(immutableSelector);
  assert.equal(await search(correction, 1), 1);
  assert.equal(await search(engineText, 0), 0);
  record([13], 'packaged review DOM retained engineText while effectiveText changed to approved Unicode');

  // Correction Undo/Redo must refresh effective search text without losing ownership.
  await click('[data-ocr-action="undo"]');
  await waitUi(`[data-ocr-effective-text="${attributeValue(engineText)}"]`);
  await waitForOwnership('pending');
  assert.equal(await search(engineText, 1), 1);
  assert.equal(await search(correction, 0), 0);
  await click('[data-ocr-action="redo"]');
  await waitUi(`[data-ocr-effective-text="${attributeValue(correction)}"]`);
  assert.equal(await search(correction, 1), 1);

  // Save, Save As, and repeat save all use the production safe-save writer.
  const saved = await callTool('app_save_pdf');
  assert.equal(saved.ok, true, saved.error);
  assert.equal((await listTabs()).tabs.find((tab) => tab.active)?.modified, false);
  await waitForOwnership('saved');
  const savedInspection = await inspectPdf(fixturePaths.imageOnly);
  assert.equal(savedInspection.length, 1);
  assert.equal(savedInspection[0].owned, true);
  assert.equal(savedInspection[0].renderingMode3Count, 1);
  const saveAs = await callTool('app_save_pdf', { path: imageOnlySaveAs });
  assert.equal(saveAs.ok, true, saveAs.error);
  const saveAsInspection = await inspectPdf(imageOnlySaveAs);
  assert.equal(saveAsInspection[0].owned, true);
  assert.equal(saveAsInspection[0].renderingMode3Count, 1);
  const repeatedSave = await callTool('app_save_pdf');
  assert.equal(repeatedSave.ok, true, repeatedSave.error);
  const repeatedInspection = await inspectPdf(imageOnlySaveAs);
  assert.equal(repeatedInspection[0].owned, true);
  assert.equal(repeatedInspection[0].renderingMode3Count, 1);
  assert.equal(repeatedInspection[0].contentRefs.length, saveAsInspection[0].contentRefs.length);
  const savedPdfJs = await extractPdfJs(imageOnlySaveAs);
  assert.equal(occurrences(normalize(savedPdfJs[0]), normalize(correction)), 1);
  record([9, 12], 'Save, Save As, and repeated Save retained exactly one owned rendering-mode-3 stream and one corrected text occurrence');

  // Reopen in the app. Search is PDF.js-backed; the visible selection layer is PDFium-backed.
  await closeActiveTab();
  assert.equal((await listTabs()).tabs.some((tab) => tab.filePath === imageOnlySaveAs), false,
    'saved document remained open before reopen proof');
  await openPdf(imageOnlySaveAs);
  assert.equal(await search(correction, 1), 1);
  const reopenedViewport = await waitUntil('PDFium reopened viewport', async () => {
    const value = await callTool('app_get_viewport_state');
    return String(value.engine).includes('PDFium') ? value : null;
  }, 60_000);
  const pdfiumLayer = await waitUi('.textLayer',
    (value) => value.found && value.visible && normalize(value.text).includes(normalize(correction)), 60_000);
  assert.ok(String(reopenedViewport.engine).includes('PDFium'));
  assert.ok(normalize(pdfiumLayer.text).includes(normalize(correction)));
  await callTool('app_set_tool', { tool: 'select' });
  const reopenedSpan = await waitUi('#canvas-container .textLayer span',
    (value) => value.found && value.visible && value.rect?.width > 5 && value.rect?.height > 5
      && normalize(value.text).includes('Café'), 60_000);
  const reopenedCopy = await realCopyFromRect(reopenedSpan.rect, 'Café');
  assert.ok(normalize(reopenedCopy.text).includes('Café'));
  const preview = await previewCopy(imageOnlySaveAs, correction);
  assert.ok(normalize(preview.text).includes(normalize(correction)));
  record([10, 11], 'reopened app search/copy, PDF.js extraction, PDFium text layer, and Apple Preview copy preserved approved Unicode');

  // Force rerun from the reopened file through the production recognition dialog:
  // no hydrated OCR state is assumed, and the writer must replace its owned stream.
  const rerunJob = await startRecognition({ forceRerun: true });
  const rerunChild = await waitForOcrChild();
  await waitForTerminal(rerunJob.dataset.jobId, 'completed', 180_000);
  await waitForPidGone(rerunChild.pid);
  await waitForOwnership('pending');
  const rerunSave = await callTool('app_save_pdf');
  assert.equal(rerunSave.ok, true, rerunSave.error);
  const rerunInspection = await inspectPdf(imageOnlySaveAs);
  const baselineInspection = await inspectPdf(imageOnlyBaseline);
  assert.equal(rerunInspection[0].owned, true);
  assert.equal(rerunInspection[0].renderingMode3Count, 1);
  assert.deepEqual(
    rerunInspection[0].contentRefs.filter((ref) => ref !== rerunInspection[0].ownedStreamRef),
    baselineInspection[0].contentRefs,
  );
  record([15], `review rerun used child ${rerunChild.pid} and replaced only the owned stream`);

  // Remove, Undo, Redo, then save. Only the owned stream disappears.
  await click('[data-ocr-action="remove-page"]');
  await waitForOwnership('pending-removal');
  assert.equal((await listTabs()).tabs.find((tab) => tab.active)?.modified, true);
  await click('[data-ocr-action="undo"]');
  await waitForOwnership('saved');
  assert.equal(await search(engineText, 1), 1);
  await click('[data-ocr-action="redo"]');
  await waitForOwnership('pending-removal');
  const removalSave = await callTool('app_save_pdf');
  assert.equal(removalSave.ok, true, removalSave.error);
  const removedInspection = await inspectPdf(imageOnlySaveAs);
  assert.equal(removedInspection[0].owned, false);
  assert.deepEqual(removedInspection[0].contentRefs, baselineInspection[0].contentRefs);
  assert.equal(normalize((await extractPdfJs(imageOnlySaveAs))[0]), '');
  record([14, 16], 'Remove/Undo/Redo restored ownership and search; saved removal restored the original non-owned content references');
  await closeActiveTab();

  // Representative production run covers policy, geometry fixtures, and unsupported diagnostics.
  await openPdf(fixturePaths.representative);
  const representativeJob = await startRecognition({ entireDocument: true });
  const representativeChild = await waitForOcrChild();
  await waitForTerminal(representativeJob.dataset.jobId, 'completed', 600_000);
  await waitForPidGone(representativeChild.pid, 60_000);
  const expectedCounts = workflowManifest.outputs.representative.expectedDefaultCounts;
  for (const state of ['completed', 'skipped', 'unsupported', 'failed']) {
    assert.equal(await progressCount(state), expectedCounts[state], `representative ${state} count`);
  }
  assert.equal(await search('NATIVE TEXT PAGE SHOULD SKIP', 1), 1);
  assert.equal(await search('MIXED NATIVE POLICY TEXT', 1), 1);
  assert.equal(await search('Café naïve façade', 1), 1);
  await callTool('app_set_view_mode', { mode: 'single' });
  await callTool('app_go_to_page', { page: 6 });
  await waitUi('#canvas-container .textLayer[data-page="6"]');
  assert.equal((await ui('#canvas-container .textLayer[data-page="6"] '
    + '[data-ocr-owner="open-pdf-studio"]')).found, false);
  await callTool('app_go_to_page', { page: 7 });
  await waitUi('#canvas-container .textLayer[data-page="7"]');
  assert.equal((await ui('#canvas-container .textLayer[data-page="7"] '
    + '[data-ocr-owner="open-pdf-studio"]')).found, false);
  const pageSevenText = normalize((await extractPdfJs(fixturePaths.representative))[6]);
  assert.equal(occurrences(pageSevenText, 'MIXED NATIVE POLICY TEXT'), 1);
  await callTool('app_go_to_page', { page: 8 });
  await click('[data-panel="ocr-review"]');
  const unsupported = await waitUi('.ocr-review-unsupported-summary[role="alert"]',
    (value) => value.found && value.visible && value.text.length > 0);
  assert.ok(unsupported.text.length > 0);
  await waitUi('.ocr-review-issues.unsupported li',
    (value) => value.found && value.visible && value.text.length > 0);
  await waitUi('#canvas-container .textLayer[data-page="8"]');
  assert.equal((await ui('#canvas-container .textLayer[data-page="8"] '
    + '[data-ocr-owner="open-pdf-studio"]')).found, false);
  assert.equal(await search('Alpha 12 48.20', 0), 0);
  record([17, 18, 19], 'default production run skipped native and mixed pages, deduplicated native text, and exposed an unsupported alert with no searchable OCR layer');

  const representativeSaved = await callTool('app_save_pdf', { path: representativeSaveAs });
  if (!representativeSaved.ok) {
    const saveDialog = await ui('.message-dialog-body');
    const recentConsole = await callTool('app_get_recent_console', { tail: 100 });
    throw new Error(`${representativeSaved.error}; dialog ${JSON.stringify(saveDialog)}; `
      + `recent console ${JSON.stringify(recentConsole)}`);
  }
  const representativeInspection = await inspectPdf(representativeSaveAs);
  assert.deepEqual(
    representativeInspection.map((page) => page.owned),
    [true, true, true, true, true, false, false, false],
  );
  for (const page of representativeInspection.slice(0, 5)) {
    assert.equal(page.renderingMode3Count, 1);
  }
  const representativeText = await extractPdfJs(representativeSaveAs);
  assert.ok(normalize(representativeText[3]).includes('Café naïve façade'));
  await openPdf(representativeSaveAs);
  await callTool('app_set_view_mode', { mode: 'single' });
  await callTool('app_go_to_page', { page: 4 });
  await waitUntil('PDFium Unicode text layer', async () => {
    const state = await ui('.textLayer');
    const viewport = await callTool('app_get_viewport_state');
    return state.found && normalize(state.text).includes('Café naïve façade')
      && String(viewport.engine).includes('PDFium') ? { state, viewport } : null;
  }, 60_000);
  await closeActiveTab();
  await closeActiveTab();
  record([8, 9, 11, 17, 18, 19], 'saved representative corpus proved CropBox/UserUnit, skew, dense, columns, Unicode, skip/dedup, and unsupported policies in packaged output');

  // Application close goes through the visible window control while a real child is active.
  await openPdf(fixturePaths.cancellation);
  await startRecognition();
  const applicationCloseChild = await waitForOcrChild();
  await click('.window-btn-close');
  await Promise.race([
    waitForExit(application),
    delay(60_000).then(() => { throw new Error('packaged app did not exit after its close control'); }),
  ]);
  await waitForPidGone(applicationCloseChild.pid);
  record([20], `application close reaped active child ${applicationCloseChild.pid} before exit`);

  for (const [id, criterion] of Object.entries(criteria)) {
    assert.equal(criterion.status, 'pass', `criterion ${id} has no production acceptance evidence`);
  }

  const result = {
    status: 'pass',
    platform: 'macos',
    appPath,
    appBytes: (await stat(appPath)).size,
    runDir,
    productionEntry: 'Organize ribbon #ep-recognize-text -> RecognizeTextDialog -> startOcrFromApplicationAction -> OcrWorkflowService -> OcrApplicationController.startDocumentJob',
    syntheticStateInjection: false,
    testOnlyOcrEntryPointUsed: false,
    genericAutomationUsed: [
      'open/switch/close document',
      'click visible production controls',
      'type into visible production controls',
      'query visible geometry/accessibility state',
      'trusted macOS mouse and keyboard events for copy',
    ],
    fixtureContract: workflowManifest.contract,
    qualityFixtureContract: qualityManifest.contract,
    criteria,
    externalReaders: {
      pdfJs: 'pass',
      pdfium: 'pass',
      applePreview: 'pass',
    },
    disposableChildren: {
      cancelled: cancelledChild.pid,
      documentClose: documentCloseChild.pid,
      completed: completedChild.pid,
      rerun: rerunChild.pid,
      representative: representativeChild.pid,
      applicationClose: applicationCloseChild.pid,
    },
  };
  await writeFile(path.join(evidenceDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  acceptancePassed = true;
} catch (error) {
  for (const logPath of [applicationStdoutPath, applicationStderrPath]) {
    try {
      const contents = await readFile(logPath, 'utf8');
      if (contents) logs.push(contents);
    } catch {}
  }
  if (logs.length) error.message += `\nPackaged app output:\n${logs.join('')}`;
  throw error;
} finally {
  await terminateApplication();
  releaseApplicationHandles();
}

// pdfjs-dist/@napi-rs/canvas may retain native event-loop resources after every
// document and subprocess has been explicitly disposed. Exit only after the
// full acceptance run and cleanup have both completed successfully.
if (acceptancePassed) process.exit(0);
