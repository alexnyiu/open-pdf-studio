import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { validateOcrApplicationPerformanceSummary } from '../js/ocr/application-performance.js';
import { inspectOwnedInvisibleOcrLayer } from '../js/ocr/pdf-writer-proof.js';
import { startPackagedApp } from './lib/macos-packaged-app.mjs';

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const manifest = JSON.parse(await readFile(path.join(
  projectDir, 'tests', 'fixtures', 'ocr', 'release-qualification-v1', 'corpus.v1.json',
), 'utf8'));
const defaultAppBinary = path.join(
  repoDir,
  'target',
  'aarch64-apple-darwin',
  'release',
  'bundle',
  'macos',
  'Open PDF Studio.app',
  'Contents',
  'MacOS',
  'open-pdf-studio',
);
const appBinary = path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP || defaultAppBinary);
const qualificationMode = process.argv.includes('--cancellation-only')
  ? 'cancellation-only'
  : process.argv.includes('--completion-only') ? 'completion-only' : 'full';
const reportFile = qualificationMode === 'cancellation-only'
  ? 'production-100-page-cancellation-latest.json'
  : 'production-100-page-latest.json';
const reportPath = path.join(projectDir, 'output', 'ocr-release-hardening', reportFile);
const runDir = await mkdtemp(path.join(tmpdir(), 'opds-ocr-100-page-'));
const fixtureDir = path.join(runDir, 'fixtures');
const copyHelper = path.join(runDir, 'macos-real-text-copy');
const startedAt = new Date().toISOString();

assert.equal(process.platform, 'darwin', '100-page production OCR qualification is macOS-only');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function gitHead() {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
  return stdout.trim();
}

function normalize(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function attributeValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\a ');
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function metrics(values) {
  return {
    samples: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

function productionWorkflowPublication(value, { uiSubscriberMounted = false } = {}) {
  const maximumOrdinaryDeliveryHz = Number(value?.maximumOrdinaryDeliveryHz);
  const bookkeepingCpuPercent = Number(value?.bookkeepingCpuPercent);
  const clonedBytes = Number(value?.clonedBytes);
  const instrumentationAvailable = Number.isFinite(maximumOrdinaryDeliveryHz)
    && Number.isFinite(bookkeepingCpuPercent)
    && Number.isFinite(clonedBytes);
  return {
    ...(value && typeof value === 'object' ? value : {}),
    maximumOrdinaryDeliveryHz,
    bookkeepingCpuPercent,
    clonedBytes,
    instrumentationAvailable,
    uiSubscriberMounted,
    realClock: true,
    syntheticEvents: false,
    virtualTime: false,
    serviceOnly: false,
    failedOpen: !instrumentationAvailable || !uiSubscriberMounted,
  };
}

function parsePackagedControllerPerformance(value) {
  const serialized = value?.dataset?.ocrPerformance;
  assert.equal(typeof serialized, 'string',
    'packaged OCR job card did not expose terminal controller performance evidence');
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`packaged OCR controller performance evidence is invalid JSON: ${error.message}`);
  }
  return parsed;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function waitUntil(description, probe, timeoutMs = 30_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let latestError = null;
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
  const suffix = latestError ? `: ${latestError.message}` : `; latest=${JSON.stringify(latest)}`;
  throw new Error(`timed out waiting for ${description}${suffix}`);
}

async function inspectInput(filePath) {
  const information = await stat(filePath);
  assert.ok(information.size <= manifest.longRun.bounds.maxInputBytes, '100-page input exceeds its declared bound');
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await readFile(filePath)) });
  const document = await loadingTask.promise;
  try {
    assert.equal(document.numPages, manifest.longRun.pageCount, 'fixture does not contain exactly 100 pages');
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      assert.equal(normalize(text.items.map((item) => item.str).join(' ')), '',
        `source fixture page ${pageNumber} unexpectedly contains native text`);
    }
    return { bytes: information.size, pageCount: document.numPages, imageOnlyPages: document.numPages };
  } finally {
    await document.destroy();
  }
}

async function extractPages(filePath, pageNumbers) {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await readFile(filePath)) });
  const document = await loadingTask.promise;
  try {
    const result = {};
    for (const pageNumber of pageNumbers) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      result[pageNumber] = normalize(text.items.map((item) => item.str).join(' '));
    }
    return { pageCount: document.numPages, pages: result };
  } finally {
    await document.destroy();
  }
}

async function readProcesses() {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], {
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

function processSnapshot(processes, applicationPid) {
  const parent = processes.find((entry) => entry.pid === applicationPid) || null;
  const children = processes.filter((entry) => entry.command.includes('--ocr-child-job')
    && descendantOf(processes, entry.pid, applicationPid));
  return { parent, children };
}

async function waitForNoChildren(applicationPid, timeoutMs = 30_000) {
  return waitUntil('all production OCR children to be reaped', async () => {
    const snapshot = processSnapshot(await readProcesses(), applicationPid);
    return snapshot.children.length === 0 ? true : null;
  }, timeoutMs, 50);
}

function createUi(app) {
  const ui = (selector) => app.callTool('app_ui_state', { selector, searchTabs: false });
  const waitUi = (selector, predicate = (value) => value.found && value.visible, timeoutMs = 30_000) =>
    waitUntil(selector, async () => {
      const value = await ui(selector);
      return predicate(value) ? value : null;
    }, timeoutMs);
  const click = async (selector, timeoutMs = 30_000) => {
    await waitUi(selector, (value) => value.found && value.visible && !value.disabled, timeoutMs);
    const result = await app.callTool('app_click_element', { selector, searchTabs: false });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.clicked, true, `${selector} was not clicked`);
  };
  return { ui, waitUi, click };
}

async function openPdf(app, filePath) {
  const result = await app.callTool('app_open_pdf', { path: filePath });
  assert.equal(result.ok, true, result.error);
  return waitUntil(`production document ${filePath}`, async () => {
    const viewport = await app.callTool('app_get_viewport_state');
    return viewport.doc?.filePath === filePath && viewport.pageCount === 100 ? viewport : null;
  }, 60_000);
}

async function prepareEntireDocumentRecognition(controls) {
  await controls.click('.ribbon-tab[data-tab="organize"]');
  const action = await controls.ui('#ep-recognize-text');
  if (!action.found || !action.visible) await controls.click('#ribbon-collapse-toggle');
  await controls.click('#ep-recognize-text');
  await controls.waitUi('#ocr-recognition-form');
  await controls.click('input[name="ocr-page-scope"][value="entire-document"]');
  await controls.waitUi('button[type="submit"][form="ocr-recognition-form"]', (value) =>
    value.found && value.visible && !value.disabled, 60_000);
}

async function submitPreparedRecognition(controls) {
  await controls.click('button[type="submit"][form="ocr-recognition-form"]', 60_000);
  return controls.waitUi('.ocr-progress-toast[data-job-id]', (value) =>
    value.found && value.visible && Boolean(value.dataset?.jobId), 30_000);
}

async function readCounts(controls, jobId) {
  const counts = {};
  for (const state of ['completed', 'skipped', 'unsupported', 'failed', 'cancelled']) {
    const value = await controls.ui(
      `.ocr-progress-toast[data-job-id="${attributeValue(jobId)}"] [data-count-state="${state}"] dd`,
    );
    counts[state] = value.found ? Number(value.text.match(/\d+/u)?.[0] ?? Number.NaN) : Number.NaN;
  }
  return counts;
}

async function readControllerPerformance(controls, jobId, { required = true } = {}) {
  const card = await controls.ui(`.ocr-progress-toast[data-job-id="${attributeValue(jobId)}"]`);
  assert.equal(card.found, true, 'packaged OCR job card disappeared before performance collection');
  if (!card.dataset?.ocrPerformance && !required) return null;
  return parsePackagedControllerPerformance(card);
}

async function waitForOwnership(app, controls, expected, timeoutMs = 30_000) {
  const states = ['none', 'unowned', 'pending', 'saved', 'saved-with-pending-changes', 'pending-removal'];
  return waitUntil(`OCR ownership ${expected}`, async () => {
    for (const state of states) {
      if ((await controls.ui(`[data-ownership-state="${state}"]`)).found) {
        return state === expected ? state : null;
      }
    }
    return null;
  }, timeoutMs);
}

async function search(app, controls, query, expectedCount) {
  await app.callTool('app_key', { key: 'f', meta: true });
  await controls.waitUi('.find-input', (value) => value.found && value.visible && value.focused, 10_000);
  const typed = await app.callTool('app_type', { text: query });
  assert.equal(typed.ok, true, typed.error);
  let count = 0;
  if (expectedCount === 0) {
    await controls.waitUi('.find-input-wrapper.not-found', (value) => value.found && value.visible, 30_000);
  } else {
    const value = await controls.waitUi('.find-count-inline', (state) => {
      const numbers = state.text?.match(/\d+/gu);
      return state.found && state.visible && Number(numbers?.at(-1)) === expectedCount;
    }, 30_000);
    count = Number(value.text.match(/\d+/gu).at(-1));
  }
  assert.equal(count, expectedCount, `search count mismatch for ${JSON.stringify(query)}`);
  await controls.click('.find-close-btn');
  return count;
}

async function copyVisibleText(app, controls, expectedText) {
  await app.callTool('app_set_view_mode', { mode: 'single' });
  await app.callTool('app_set_zoom', { scale: 1 });
  await app.callTool('app_set_tool', { tool: 'select' });
  let stableSpanKey = null;
  let stableSpanSamples = 0;
  let observed = null;
  const span = await waitUntil('settled current OCR text span', async () => {
    const viewport = await app.callTool('app_get_viewport_state');
    const value = await controls.ui('#canvas-container .textLayer span');
    const owned = await controls.ui(
      '#canvas-container .textLayer[data-page="1"] span[data-ocr-owner="open-pdf-studio"]',
    );
    const layer = await controls.ui('#canvas-container .textLayer[data-page="1"]');
    observed = { viewport, value, owned, layer };
    if (viewport.pageEditReadiness?.ready !== true
        || viewport.renderPublicationDiagnostics?.activePdfJsTasks !== 0) return null;
    if (!value.found || !value.visible || value.rect?.width <= 5 || value.rect?.height <= 5
        || !normalize(value.text).includes(normalize(expectedText).split(' ')[0])) return null;
    const key = [value.rect.left, value.rect.top, value.rect.width, value.rect.height]
      .map((part) => Math.round(Number(part) * 100) / 100).join(':');
    stableSpanSamples = key === stableSpanKey ? stableSpanSamples + 1 : 1;
    stableSpanKey = key;
    return stableSpanSamples >= 3 ? value : null;
  }, 60_000, 100).catch((error) => {
    throw new Error(`${error.message}; observed=${JSON.stringify(observed)}`);
  });
  const rect = span.rect;
  const startX = rect.left + Math.max(1, Math.min(3, rect.width * 0.05));
  const endX = rect.right - Math.max(1, Math.min(3, rect.width * 0.05));
  const token = normalize(expectedText).split(' ')[0];
  let latest = { status: 'empty', text: '' };
  const diagnostics = [];
  const runCopyHelper = async (arguments_) => {
    const { stdout } = await execFileAsync(copyHelper, [String(app.processId), ...arguments_], {
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  };
  const inspectSelection = async (gesture, copyResult) => {
    const viewport = await app.callTool('app_get_viewport_state');
    const selection = viewport.textSelection || null;
    diagnostics.push({ gesture, copyResult, selection });
    if (copyResult.status === 'pass' && normalize(copyResult.text).includes(token)) {
      return normalize(copyResult.text);
    }
    if (!selection?.hasSelection || !normalize(selection.selectedText).includes(token)) return null;
    const retry = await runCopyHelper(['copy']);
    diagnostics.push({ gesture: { mode: 'copy-existing-selection' }, copyResult: retry, selection });
    return retry.status === 'pass' && normalize(retry.text).includes(token)
      ? normalize(retry.text)
      : null;
  };
  const attempts = [
    { fraction: 0.55, contentOffsetY: 0 },
    { fraction: 0.55, contentOffsetY: 28 },
    { fraction: 0.4, contentOffsetY: 28 },
    { fraction: 0.7, contentOffsetY: 28 },
    { fraction: 0.55, contentOffsetY: 22 },
    { fraction: 0.55, contentOffsetY: 36 },
  ];
  for (const [attempt, candidate] of attempts.entries()) {
    const y = rect.top + candidate.contentOffsetY
      + Math.max(1, Math.min(rect.height - 1, rect.height * candidate.fraction));
    const [fromX, toX] = attempt === 1 ? [endX, startX] : [startX, endX];
    latest = await runCopyHelper([
      'drag',
      String(fromX),
      String(y),
      String(toX),
      String(y),
    ]);
    const copied = await inspectSelection({ mode: 'drag', fromX, toX, y }, latest);
    if (copied) return copied;
    await delay(200);
  }
  latest = await runCopyHelper([
    'all',
    String(rect.left + rect.width / 2),
    String(rect.top + rect.height / 2),
  ]);
  const copied = await inspectSelection({ mode: 'all' }, latest);
  if (copied) return copied;
  if (latest.status !== 'pass') {
    const error = new Error(
      `trusted macOS copy produced no text after bounded selection attempts: ${JSON.stringify({ latest, diagnostics })}`,
    );
    error.copyResult = { latest, diagnostics };
    throw error;
  }
  assert.ok(normalize(latest.text).includes(token),
    `trusted macOS copy did not contain ${JSON.stringify(expectedText)}: ${JSON.stringify(latest.text)}`);
  return normalize(latest.text);
}

async function cacheEvidence(cacheDir) {
  const names = await readdir(path.join(cacheDir, 'v1')).catch(() => []);
  const payloads = names.filter((name) => /^[a-f0-9]{64}\.payload\.json\.gz$/u.test(name));
  const metadata = names.filter((name) => /^[a-f0-9]{64}\.meta\.json$/u.test(name));
  const unexpected = names.filter((name) => !payloads.includes(name) && !metadata.includes(name));
  return { payloads: payloads.length, metadata: metadata.length, unexpected };
}

async function nativeJobTempEvidence(applicationPid) {
  const base = path.join(tmpdir(), 'org.openaec.openpdfstudio', 'ocr-v1');
  const sessionNames = (await readdir(base).catch(() => []))
    .filter((name) => name.startsWith(`session-p${applicationPid}-`));
  const files = [];
  for (const sessionName of sessionNames) {
    for (const name of await readdir(path.join(base, sessionName)).catch(() => [])) {
      files.push(`${sessionName}/${name}`);
    }
  }
  return { sessionNames, files };
}

async function startSession(name) {
  const root = path.join(runDir, name);
  const cacheDir = path.join(root, 'ocr-cache');
  await mkdir(cacheDir, { recursive: true });
  const app = await startPackagedApp({
    appBinary,
    cwd: projectDir,
    env: {
      OPS_TEST_SESSION_PATH: path.join(root, 'session.json'),
      OPS_TEST_OCR_CACHE_DIR: cacheDir,
    },
  });
  await app.callTool('app_set_window_size', { width: 1200, height: 900 });
  return { app, cacheDir, controls: createUi(app) };
}

async function sampleJob({ app, controls, jobId, stopWhen, timeoutMs }) {
  const started = Date.now();
  const childPids = new Set();
  const pageDurations = [];
  const uiLatencies = [];
  const progressValues = [];
  let maximumConcurrentChildren = 0;
  let peakParentRssBytes = 0;
  let peakChildRssBytes = 0;
  let previousCompleted = 0;
  let previousCompletionAt = started;
  let lastUiAt = 0;
  let latestCounts = null;
  let latestWorkflowMetrics = null;
  while (Date.now() - started <= timeoutMs) {
    const processes = await readProcesses();
    const snapshot = processSnapshot(processes, app.processId);
    maximumConcurrentChildren = Math.max(maximumConcurrentChildren, snapshot.children.length);
    peakParentRssBytes = Math.max(peakParentRssBytes, snapshot.parent?.rssBytes || 0);
    for (const child of snapshot.children) {
      childPids.add(child.pid);
      peakChildRssBytes = Math.max(peakChildRssBytes, child.rssBytes);
    }
    if (Date.now() - lastUiAt >= 400) {
      const uiStarted = Date.now();
      const progress = await controls.ui(
        `.ocr-progress-toast[data-job-id="${attributeValue(jobId)}"] .ocr-progress-track`,
      );
      const tabs = await app.callTool('app_list_tabs');
      assert.equal(tabs.ok, true, tabs.error);
      const viewport = await app.callTool('app_get_viewport_state');
      latestWorkflowMetrics = viewport.ocrWorkflowMetrics || latestWorkflowMetrics;
      uiLatencies.push(Date.now() - uiStarted);
      const valueNow = Number(progress.accessibility?.valueNow);
      if (Number.isFinite(valueNow)) {
        assert.ok(!progressValues.length || valueNow >= progressValues.at(-1), 'production progress regressed');
        progressValues.push(valueNow);
      }
      latestCounts = await readCounts(controls, jobId);
      if (latestCounts.completed > previousCompleted) {
        const now = Date.now();
        const increment = latestCounts.completed - previousCompleted;
        const perPage = (now - previousCompletionAt) / increment;
        for (let index = 0; index < increment; index += 1) pageDurations.push(perPage);
        previousCompleted = latestCounts.completed;
        previousCompletionAt = now;
      }
      lastUiAt = Date.now();
      const stopped = await stopWhen({ counts: latestCounts, snapshot, elapsedMs: Date.now() - started });
      if (stopped) {
        const controllerPerformance = await readControllerPerformance(controls, jobId, { required: false });
        return {
          elapsedMs: Date.now() - started,
          counts: latestCounts,
          childPids: [...childPids],
          maximumConcurrentChildren,
          peakParentRssBytes,
          peakChildRssBytes,
          pageTiming: metrics(pageDurations),
          uiResponsiveness: metrics(uiLatencies),
          progress: {
            samples: progressValues.length,
            first: progressValues[0] ?? null,
            last: progressValues.at(-1) ?? null,
            monotonic: true,
          },
          workflowPublication: productionWorkflowPublication(latestWorkflowMetrics, {
            uiSubscriberMounted: latestCounts !== null,
          }),
          controllerPerformance,
          snapshot,
        };
      }
    }
    await delay(35);
  }
  throw new Error(`100-page production job exceeded ${timeoutMs}ms; latest counts ${JSON.stringify(latestCounts)}`);
}

async function parentRss(applicationPid) {
  return processSnapshot(await readProcesses(), applicationPid).parent?.rssBytes || 0;
}

async function stableParentRss(applicationPid, { timeoutMs = 20_000, sampleIntervalMs = 1_000 } = {}) {
  const started = Date.now();
  const samples = [];
  while (Date.now() - started <= timeoutMs) {
    const value = await parentRss(applicationPid);
    if (value > 0) samples.push(value);
    if (samples.length >= 4) {
      const recent = samples.slice(-4);
      if (Math.max(...recent) - Math.min(...recent) <= 2 * 1024 * 1024) {
        return { rssBytes: recent.at(-1), samples, stable: true };
      }
    }
    await delay(sampleIntervalMs);
  }
  throw new Error(`parent RSS did not settle within ${timeoutMs}ms: ${JSON.stringify(samples.slice(-6))}`);
}

async function completeRun(filePath, sourceHash) {
  const session = await startSession('complete');
  const { app, controls, cacheDir } = session;
  try {
    await openPdf(app, filePath);
    await prepareEntireDocumentRecognition(controls);
    const baselineMemory = await stableParentRss(app.processId);
    const baselineParentRssBytes = baselineMemory.rssBytes;
    const job = await submitPreparedRecognition(controls);
    const jobId = job.dataset.jobId;
    const sampled = await sampleJob({
      app,
      controls,
      jobId,
      timeoutMs: manifest.longRun.bounds.timeoutMs,
      stopWhen: async ({ counts }) => {
        const terminal = await controls.ui(
          `.ocr-progress-toast[data-job-id="${attributeValue(jobId)}"] .ocr-progress-summary[data-terminal-status="completed"]`,
        );
        return terminal.found && terminal.visible && counts.completed === 100;
      },
    });
    assert.deepEqual(sampled.counts, {
      completed: 100, skipped: 0, unsupported: 0, failed: 0, cancelled: 0,
    });
    assert.equal(sampled.maximumConcurrentChildren, 1, 'OCR inference was not serialized');
    assert.equal(sampled.childPids.length, 100, 'one disposable production child was not observed per page');
    assert.ok(sampled.uiResponsiveness.maxMs < 5_000, 'production UI stopped responding during OCR');
    assert.ok(sampled.progress.last === 100, 'production progress did not reach 100%');
    assert.ok(sampled.workflowPublication?.maximumOrdinaryDeliveryHz <= 10,
      `production OCR UI publication exceeded 10 Hz: ${sampled.workflowPublication?.maximumOrdinaryDeliveryHz}`);
    assert.ok(sampled.workflowPublication?.bookkeepingCpuPercent < 1,
      'production OCR bookkeeping exceeded 1 percent CPU');
    assert.deepEqual(validateOcrApplicationPerformanceSummary(sampled.controllerPerformance, {
      expectedPageCount: 100,
      requireCompleteCoverage: true,
      requireCompleteResources: true,
    }), [], 'production OCR controller stage/resource evidence is incomplete');
    await waitForNoChildren(app.processId);
    const completionParentRssBytes = await parentRss(app.processId);
    const cacheAfterCompletion = await cacheEvidence(cacheDir);
    assert.equal(cacheAfterCompletion.payloads, 100,
      'completed production cache does not contain 100 payloads at terminal completion');
    assert.equal(cacheAfterCompletion.metadata, 100,
      'completed production cache does not contain 100 metadata records at terminal completion');
    assert.deepEqual(cacheAfterCompletion.unexpected, [],
      'completed production cache contains temporary or unexpected files at terminal completion');
    assert.equal(await sha256(filePath), sourceHash, 'source PDF changed before Save As');
    await delay(5_000);
    const settledMemory = await stableParentRss(app.processId);
    const settledParentRssBytes = settledMemory.rssBytes;
    const settledMemoryDeltaBytes = Math.max(0, settledParentRssBytes - baselineParentRssBytes);
    assert.ok(settledMemoryDeltaBytes <= manifest.longRun.bounds.settledMemoryDeltaBytes,
      `settled parent RSS grew by ${settledMemoryDeltaBytes} bytes`);
    report.completion = {
      status: 'IN_PROGRESS',
      exactPageCounts: sampled.counts,
      serializedInference: sampled.maximumConcurrentChildren === 1,
      childProcessesObserved: sampled.childPids.length,
      childProcessesSurviving: 0,
      progress: sampled.progress,
      workflowPublication: sampled.workflowPublication,
      controllerPerformance: sampled.controllerPerformance,
      processingTimeMs: sampled.elapsedMs,
      pageTiming: sampled.pageTiming,
      uiResponsiveness: sampled.uiResponsiveness,
      memory: {
        baselineParentRssBytes,
        peakParentRssBytes: sampled.peakParentRssBytes,
        peakChildRssBytes: sampled.peakChildRssBytes,
        completionParentRssBytes,
        settledParentRssBytes,
        settledMemoryDeltaBytes,
        allowedSettledDeltaBytes: manifest.longRun.bounds.settledMemoryDeltaBytes,
        baselineSamples: baselineMemory.samples.length,
        settledSamples: settledMemory.samples.length,
      },
      cacheAfterCompletion,
    };

    await controls.click('[data-panel="ocr-review"]');
    await controls.waitUi('#ocr-review-panel.active');
    for (const sample of manifest.longRun.samplePages) {
      await app.callTool('app_go_to_page', { page: sample.pageNumber });
      await waitForOwnership(app, controls, 'pending', 60_000);
      await search(app, controls, sample.searchText, 1);
    }
    await app.callTool('app_go_to_page', { page: 1 });
    let copyEvidence;
    try {
      const copiedText = await copyVisibleText(app, controls, manifest.longRun.samplePages[0].searchText);
      copyEvidence = { status: 'PASS', page1: copiedText };
    } catch (error) {
      const authorization = error.copyResult?.authorization;
      const unavailable = authorization?.accessibilityTrusted === false
        || authorization?.postEventTrusted === false;
      copyEvidence = {
        status: unavailable ? 'UNVERIFIED' : 'FAIL',
        reason: error.message,
        result: error.copyResult ?? null,
      };
    }
    report.completion.copy = copyEvidence;

    const savePath = path.join(runDir, 'production-100-page-saved.pdf');
    const saveStartedAt = Date.now();
    const save = await app.callTool('app_save_pdf', { path: savePath });
    const saveDurationMs = Date.now() - saveStartedAt;
    if (!save.ok) {
      const message = await controls.ui('.message-dialog-body p');
      throw new Error(`${save.error}; user-visible failure ${JSON.stringify(message.text || null)}; `
        + `save duration ${saveDurationMs}ms`);
    }
    await waitForOwnership(app, controls, 'saved', 120_000);
    const originalSourceHashAfterSave = await sha256(filePath);
    assert.equal(originalSourceHashAfterSave, sourceHash, 'Save As modified the original source');
    const savedInspection = await inspectOwnedInvisibleOcrLayer(await readFile(savePath));
    assert.equal(savedInspection.length, 100);
    for (const [index, page] of savedInspection.entries()) {
      assert.equal(page.owned, true, `saved page ${index + 1} has no owned OCR stream`);
      assert.equal(page.renderingMode3Count, 1, `saved page ${index + 1} does not have exactly one invisible stream`);
    }
    const savedPdfJs = await extractPages(savePath, [1, 50, 100]);
    assert.equal(savedPdfJs.pageCount, 100);
    for (const sample of manifest.longRun.samplePages) {
      assert.ok(savedPdfJs.pages[sample.pageNumber].includes(normalize(sample.searchText)),
        `PDF.js did not extract page ${sample.pageNumber} sample text`);
    }

    const tabs = await app.callTool('app_list_tabs');
    const close = await app.callTool('app_close_tab', { index: tabs.activeIndex, force: true });
    assert.equal(close.ok, true, close.error);
    await openPdf(app, savePath);
    for (const sample of manifest.longRun.samplePages) {
      await app.callTool('app_go_to_page', { page: sample.pageNumber });
      await search(app, controls, sample.searchText, 1);
    }
    await app.callTool('app_go_to_page', { page: 50 });
    const pdfiumText = await controls.waitUi('#canvas-container .textLayer', (value) =>
      value.found && value.visible
        && normalize(value.text).includes(normalize(manifest.longRun.samplePages[1].searchText)), 60_000);
    assert.ok(normalize(pdfiumText.text).includes(normalize(manifest.longRun.samplePages[1].searchText)));

    await delay(5_000);
    const reopenedMemory = await stableParentRss(app.processId);
    const cache = await cacheEvidence(cacheDir);
    assert.equal(cache.payloads, 100, 'completed production cache does not contain 100 payloads');
    assert.equal(cache.metadata, 100, 'completed production cache does not contain 100 metadata records');
    assert.deepEqual(cache.unexpected, [], 'completed production cache contains temporary or unexpected files');
    const nativeJobTemp = await nativeJobTempEvidence(app.processId);
    assert.deepEqual(nativeJobTemp.files, [], 'completed production OCR left native request/result files');
    const consoleState = await app.callTool('app_get_recent_console', { tail: 200 });
    const sensitive = JSON.stringify(consoleState.entries || []);
    assert.doesNotMatch(sensitive, /stale|generation.token|generation mismatch|late result/iu,
      'complete run logged stale/generation-token evidence');
    return {
      status: copyEvidence.status,
      jobId,
      exactPageCounts: sampled.counts,
      serializedInference: sampled.maximumConcurrentChildren === 1,
      childProcessesObserved: sampled.childPids.length,
      childProcessesSurviving: 0,
      progress: sampled.progress,
      workflowPublication: sampled.workflowPublication,
      controllerPerformance: sampled.controllerPerformance,
      processingTimeMs: sampled.elapsedMs,
      pageTiming: sampled.pageTiming,
      uiResponsiveness: sampled.uiResponsiveness,
      memory: {
        baselineParentRssBytes,
        peakParentRssBytes: sampled.peakParentRssBytes,
        peakChildRssBytes: sampled.peakChildRssBytes,
        completionParentRssBytes,
        settledParentRssBytes,
        settledMemoryDeltaBytes,
        allowedSettledDeltaBytes: manifest.longRun.bounds.settledMemoryDeltaBytes,
        baselineSamples: baselineMemory.samples.length,
        settledSamples: settledMemory.samples.length,
        reopenedParentRssBytes: reopenedMemory.rssBytes,
        reopenedSamples: reopenedMemory.samples.length,
      },
      search: { page1: 1, page50: 1, page100: 1 },
      copy: copyEvidence,
      saveReopen: {
        savedPath: savePath,
        saveDurationMs,
        ownedPages: 100,
        renderingMode3StreamsPerPage: 1,
      },
      externalReaders: { pdfJs: 'PASS', pdfium: 'PASS' },
      cacheAfterCompletion,
      cache,
      nativeJobTemp,
      sourceOriginalPreserved: originalSourceHashAfterSave === sourceHash,
      staleOrGenerationTokenErrors: 0,
    };
  } finally {
    await app.stop();
    await waitForNoChildren(app.processId, 10_000).catch(() => {});
  }
}

async function cancellationRun(filePath, sourceHash) {
  const session = await startSession('cancellation');
  const { app, controls, cacheDir } = session;
  try {
    await openPdf(app, filePath);
    await prepareEntireDocumentRecognition(controls);
    const job = await submitPreparedRecognition(controls);
    const jobId = job.dataset.jobId;
    let activeAtCancel = null;
    let cancelClickedAt = null;
    const beforeCancel = await sampleJob({
      app,
      controls,
      jobId,
      timeoutMs: manifest.longRun.bounds.timeoutMs,
      stopWhen: async ({ counts, snapshot }) => {
        if (counts.completed < 55 || snapshot.children.length !== 1) return false;
        activeAtCancel = snapshot.children[0];
        cancelClickedAt = Date.now();
        await controls.click('[data-ocr-action="cancel"]');
        return true;
      },
    });
    assert.ok(activeAtCancel?.pid, 'no active second-half child was captured for cancellation');
    report.cancellation = {
      status: 'IN_PROGRESS',
      completedAtCancel: beforeCancel.counts.completed,
      activeChildPidAtCancel: activeAtCancel.pid,
      childPidsObservedBeforeCancel: beforeCancel.childPids,
    };
    const terminal = await controls.waitUi(
      `.ocr-progress-toast[data-job-id="${attributeValue(jobId)}"] .ocr-progress-summary[data-terminal-status="cancelled"]`,
      (value) => value.found && value.visible,
      120_000,
    );
    assert.ok(terminal.found);
    await waitForNoChildren(app.processId);
    const terminalCounts = await readCounts(controls, jobId);
    assert.ok(terminalCounts.completed >= 55 && terminalCounts.completed < 100,
      `cancel did not retain only second-half completed pages: ${JSON.stringify(terminalCounts)}`);
    assert.equal(terminalCounts.cancelled, 100 - terminalCounts.completed);
    assert.equal(terminalCounts.skipped, 0);
    assert.equal(terminalCounts.unsupported, 0);
    assert.equal(terminalCounts.failed, 0);

    const countsAtTerminal = structuredClone(terminalCounts);
    const workflowAtTerminal = productionWorkflowPublication(
      (await app.callTool('app_get_viewport_state')).ocrWorkflowMetrics,
      { uiSubscriberMounted: true },
    );
    const controllerPerformance = await readControllerPerformance(controls, jobId);
    assert.deepEqual(validateOcrApplicationPerformanceSummary(controllerPerformance, {
      expectedPageCount: 100,
      requireCompleteCoverage: false,
      requireCompleteResources: true,
    }), [], 'cancelled OCR controller stage/resource evidence is incomplete');
    const pidsAtTerminal = new Set(beforeCancel.childPids);
    await delay(10_000);
    const lateProcesses = processSnapshot(await readProcesses(), app.processId).children;
    const countsAfterSettling = await readCounts(controls, jobId);
    const workflowAfterSettling = productionWorkflowPublication(
      (await app.callTool('app_get_viewport_state')).ocrWorkflowMetrics,
      { uiSubscriberMounted: true },
    );
    assert.deepEqual(countsAfterSettling, countsAtTerminal, 'page counts changed after cancellation became terminal');
    assert.deepEqual(lateProcesses, [], 'OCR child survived or started after terminal cancellation');
    assert.equal((await readProcesses()).some((entry) => entry.pid === activeAtCancel.pid), false,
      'active cancellation child was not reaped');
    assert.equal(workflowAfterSettling.publications, workflowAtTerminal.publications,
      'OCR workflow published after cancellation became terminal');
    assert.equal(workflowAfterSettling.deliveryBatches, workflowAtTerminal.deliveryBatches,
      'OCR workflow delivered a UI batch after cancellation became terminal');

    await controls.click('[data-panel="ocr-review"]');
    await controls.waitUi('#ocr-review-panel.active');
    for (const sample of manifest.longRun.samplePages.slice(0, 2)) {
      await app.callTool('app_go_to_page', { page: sample.pageNumber });
      await waitForOwnership(app, controls, 'pending', 60_000);
      await search(app, controls, sample.searchText, 1);
    }
    await app.callTool('app_go_to_page', { page: 100 });
    await waitForOwnership(app, controls, 'none', 60_000);
    await search(app, controls, manifest.longRun.samplePages[2].searchText, 0);
    assert.equal(await sha256(filePath), sourceHash, 'cancelled production OCR modified the source PDF');
    const cache = await cacheEvidence(cacheDir);
    assert.equal(cache.payloads, terminalCounts.completed,
      'cancelled production cache payload count does not match retained completed pages');
    assert.equal(cache.metadata, terminalCounts.completed,
      'cancelled production cache metadata count does not match retained completed pages');
    assert.deepEqual(cache.unexpected, [], 'cancelled production cache contains temporary or unexpected files');
    const nativeJobTemp = await nativeJobTempEvidence(app.processId);
    assert.deepEqual(nativeJobTemp.files, [], 'cancelled production OCR left native request/result files');
    return {
      status: 'PASS',
      jobId,
      cancelClickedAt,
      activeChildPidAtCancel: activeAtCancel.pid,
      activeChildReaped: true,
      queuedPagesStopped: true,
      lateResultsApplied: false,
      workflowPublicationAtTerminal: workflowAtTerminal,
      workflowPublicationAfterSettling: workflowAfterSettling,
      controllerPerformance,
      childProcessesSurviving: 0,
      childPidsObservedBeforeCancel: [...pidsAtTerminal],
      countsAtTerminal,
      countsAfterSettling,
      keepCompletedPolicy: {
        page1SearchCount: 1,
        page50SearchCount: 1,
        page100SearchCount: 0,
        completedOwnership: 'pending',
        unprocessedOwnership: 'none',
      },
      cache,
      nativeJobTemp,
      sourceOriginalPreserved: true,
    };
  } finally {
    await app.stop();
    await waitForNoChildren(app.processId, 10_000).catch(() => {});
  }
}

let report = {
  contract: 'open-pdf-studio.ocr.production-100-page-qualification',
  schemaVersion: 1,
  qualificationMode,
  startedAt,
  finishedAt: null,
  status: 'FAIL',
  head: await gitHead(),
  platform: { operatingSystem: process.platform, architecture: process.arch },
  appBinary,
  automation: {
    visibleProductionChain: [
      '#ep-recognize-text',
      '#ocr-recognition-form',
      'entire-document',
      'OcrWorkflowService',
      'OcrApplicationController',
      'native disposable child',
    ],
    genericPackagedUiAutomation: true,
    ocrStateInjectionUsed: false,
    unitControllerUsed: false,
    adapterDirectlyUsed: false,
    developmentOnlyOcrMcpEntryPointUsed: false,
    testOnlyOcrEntryPointUsed: false,
  },
  fixture: null,
  completion: null,
  cancellation: null,
  performance: null,
  error: null,
};

try {
  await Promise.all([access(appBinary), mkdir(path.dirname(reportPath), { recursive: true })]);
  await execFileAsync(process.execPath, [
    path.join(projectDir, 'scripts', 'generate-ocr-release-qualification-fixtures.mjs'),
    '--output-dir', fixtureDir,
    '--mode', 'long-run',
  ], { cwd: projectDir, maxBuffer: 4 * 1024 * 1024 });
  if (qualificationMode !== 'cancellation-only') {
    await execFileAsync('/usr/bin/swiftc', [
      path.join(projectDir, 'scripts', 'macos-real-text-copy.swift'),
      '-o', copyHelper,
    ], {
      cwd: projectDir,
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: path.join(runDir, 'swift-module-cache'),
        SWIFT_MODULECACHE_PATH: path.join(runDir, 'swift-module-cache'),
      },
      maxBuffer: 4 * 1024 * 1024,
    });
  }
  const completePath = path.join(fixtureDir, manifest.longRun.files.complete);
  const cancellationPath = path.join(fixtureDir, manifest.longRun.files.cancellation);
  const [completeInput, cancellationInput, completeHash, cancellationHash] = await Promise.all([
    inspectInput(completePath),
    inspectInput(cancellationPath),
    sha256(completePath),
    sha256(cancellationPath),
  ]);
  report.fixture = {
    generatedDynamically: true,
    generatedArtifactsCommitted: false,
    complete: { ...completeInput, sha256: completeHash },
    cancellation: { ...cancellationInput, sha256: cancellationHash },
  };
  if (qualificationMode !== 'cancellation-only') {
    report.completion = await completeRun(completePath, completeHash);
  }
  if (qualificationMode !== 'completion-only') {
    report.cancellation = await cancellationRun(cancellationPath, cancellationHash);
  }
  report.performance = {
    applicationController: report.completion?.controllerPerformance
      ?? report.cancellation?.controllerPerformance
      ?? null,
    cancellationApplicationController: report.cancellation?.controllerPerformance ?? null,
    workflowPublication: (report.completion?.workflowPublication
      ?? report.cancellation?.workflowPublicationAfterSettling)
      ? {
        ...(report.completion?.workflowPublication
          ?? report.cancellation?.workflowPublicationAfterSettling),
        latePublicationAfterCancel: report.cancellation
          ? report.cancellation.lateResultsApplied !== false
          : null,
      }
      : null,
    progressMonotonic: qualificationMode === 'cancellation-only'
      ? report.cancellation?.countsAtTerminal?.completed === report.cancellation?.countsAfterSettling?.completed
      : report.completion?.progress?.monotonic === true,
    lateResultsApplied: report.cancellation?.lateResultsApplied ?? null,
  };
  const completionPass = qualificationMode === 'cancellation-only' || report.completion?.status === 'PASS';
  const cancellationPass = qualificationMode === 'completion-only' || report.cancellation?.status === 'PASS';
  report.status = completionPass && cancellationPass ? 'PASS' : 'FAIL';
  if (!completionPass && report.completion?.copy?.status !== 'PASS') {
    report.error = {
      name: report.completion.copy.status === 'UNVERIFIED'
        ? 'EnvironmentUnavailable'
        : 'QualificationFailure',
      message: report.completion.copy.reason,
    };
  }
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'PASS' && process.env.OPDS_KEEP_RELEASE_QUALIFICATION_TEMP !== '1') {
    await rm(runDir, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== 'PASS') process.exitCode = 1;
