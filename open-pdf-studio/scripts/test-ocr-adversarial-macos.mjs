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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { inspectOwnedInvisibleOcrLayer } from '../js/ocr/pdf-writer-proof.js';
import { startPackagedApp } from './lib/macos-packaged-app.mjs';

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const manifest = JSON.parse(await readFile(path.join(
  projectDir, 'tests', 'fixtures', 'ocr', 'release-qualification-v1', 'corpus.v1.json',
), 'utf8'));
const defaultAppBinary = path.join(
  repoDir, 'target', 'aarch64-apple-darwin', 'release', 'bundle', 'macos',
  'Open PDF Studio.app', 'Contents', 'MacOS', 'open-pdf-studio',
);
const appBinary = path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP || defaultAppBinary);
const reportPath = path.join(projectDir, 'output', 'ocr-release-hardening', 'adversarial-latest.json');
const runDir = await mkdtemp(path.join(tmpdir(), 'opds-ocr-adversarial-macos-'));
const fixtureDir = path.join(runDir, 'fixtures');
const memoryLimit = 32 * 1024 * 1024;

assert.equal(process.platform, 'darwin', 'packaged adversarial qualification is macOS-only');

async function gitHead() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  return stdout.trim();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function attributeValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\a ');
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function withTimeout(description, promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  throw new Error(`timed out waiting for ${description}${latestError ? `: ${latestError.message}` : ''}`);
}

async function readProcesses() {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? {
      pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, command: match[4],
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

function snapshot(processes, applicationPid) {
  return {
    parent: processes.find((entry) => entry.pid === applicationPid) || null,
    children: processes.filter((entry) => entry.command.includes('--ocr-child-job')
      && descendantOf(processes, entry.pid, applicationPid)),
  };
}

async function stableParentRss(applicationPid, { timeoutMs = 20_000, sampleIntervalMs = 1_000 } = {}) {
  const started = Date.now();
  const samples = [];
  while (Date.now() - started <= timeoutMs) {
    const value = snapshot(await readProcesses(), applicationPid).parent?.rssBytes || 0;
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

async function waitForNoChildren(applicationPid, timeoutMs = 30_000) {
  return waitUntil('all adversarial OCR children to be reaped', async () => {
    const current = snapshot(await readProcesses(), applicationPid);
    return current.children.length === 0 ? true : null;
  }, timeoutMs, 50);
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

async function cacheEvidence(cacheDir) {
  const names = await readdir(path.join(cacheDir, 'v1')).catch(() => []);
  return {
    payloads: names.filter((name) => /^[a-f0-9]{64}\.payload\.json\.gz$/u.test(name)).length,
    metadata: names.filter((name) => /^[a-f0-9]{64}\.meta\.json$/u.test(name)).length,
    temporary: names.filter((name) => name.startsWith('.ocr-cache-') && name.endsWith('.tmp')),
  };
}

function controls(app) {
  const ui = (selector) => app.callTool('app_ui_state', { selector, searchTabs: false });
  const waitUi = (selector, predicate = (value) => value.found && value.visible, timeoutMs = 30_000) =>
    waitUntil(selector, async () => {
      const value = await ui(selector);
      return predicate(value) ? value : null;
    }, timeoutMs);
  const click = async (selector, timeoutMs = 30_000) => {
    await waitUi(selector, (value) => value.found && value.visible && !value.disabled, timeoutMs);
    const value = await app.callTool('app_click_element', { selector, searchTabs: false });
    assert.equal(value.ok, true, value.error);
    assert.equal(value.clicked, true, `${selector} was not clicked`);
  };
  return { ui, waitUi, click };
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
  return { app, cacheDir, controls: controls(app) };
}

async function openPdf(app, filePath, timeoutMs = 30_000) {
  return withTimeout('packaged PDF open', app.callTool('app_open_pdf', { path: filePath }), timeoutMs);
}

async function prepareRecognition(ui, { entireDocument = false } = {}) {
  await ui.click('.ribbon-tab[data-tab="organize"]');
  const action = await ui.ui('#ep-recognize-text');
  if (!action.found || !action.visible) await ui.click('#ribbon-collapse-toggle');
  await ui.click('#ep-recognize-text');
  await ui.waitUi('#ocr-recognition-form');
  if (entireDocument) await ui.click('input[name="ocr-page-scope"][value="entire-document"]');
  await ui.waitUi('button[type="submit"][form="ocr-recognition-form"]', (value) =>
    value.found && value.visible && !value.disabled, 60_000);
}

async function submitPreparedRecognition(ui) {
  await ui.click('button[type="submit"][form="ocr-recognition-form"]', 60_000);
  return ui.waitUi('.ocr-progress-toast[data-job-id]', (value) =>
    value.found && value.visible && Boolean(value.dataset?.jobId), 30_000);
}

async function terminalStatus(ui, jobId, timeoutMs) {
  const value = await ui.waitUi(
    `.ocr-progress-toast[data-job-id="${attributeValue(jobId)}"] .ocr-progress-summary[data-terminal-status]`,
    (state) => state.found && state.visible && Boolean(state.dataset?.terminalStatus),
    timeoutMs,
  );
  return value.dataset.terminalStatus;
}

async function progressCount(ui, jobId, state) {
  const value = await ui.ui(
    `.ocr-progress-toast[data-job-id="${attributeValue(jobId)}"] [data-count-state="${state}"] dd`,
  );
  assert.equal(value.found, true, `missing ${state} progress count`);
  return Number(value.text.match(/\d+/u)?.[0]);
}

async function inspectNoOwnedStream(filePath) {
  const bytes = await readFile(filePath);
  try {
    const inspection = await inspectOwnedInvisibleOcrLayer(new Uint8Array(bytes));
    return inspection.every((page) => page.owned === false);
  } catch {
    return !bytes.includes(Buffer.from('OpenPDFStudioOCR'))
      && !bytes.includes(Buffer.from('open-pdf-studio'));
  }
}

async function dimensionFailureCase(value) {
  const filePath = path.join(fixtureDir, value.file);
  const originalHash = await sha256(filePath);
  const session = await startSession(`dimension-${value.id}`);
  const { app, controls: ui, cacheDir } = session;
  try {
    const opened = await openPdf(app, filePath, 30_000);
    assert.equal(opened.ok, true, opened.error);
    await prepareRecognition(ui);
    const baseline = await stableParentRss(app.processId);
    const baselineRssBytes = baseline.rssBytes;
    const job = await submitPreparedRecognition(ui);
    const status = await terminalStatus(ui, job.dataset.jobId, 60_000);
    assert.equal(status, 'failed', `${value.id} did not fail safely`);
    assert.equal(await progressCount(ui, job.dataset.jobId, 'failed'), 1);
    await waitForNoChildren(app.processId);
    const responseStarted = Date.now();
    const tabs = await app.callTool('app_list_tabs');
    const responseMs = Date.now() - responseStarted;
    assert.equal(tabs.ok, true, tabs.error);
    assert.ok(responseMs < 5_000, `${value.id} left the UI unresponsive`);
    assert.equal(await sha256(filePath), originalHash, `${value.id} modified its original`);
    assert.equal(await inspectNoOwnedStream(filePath), true, `${value.id} created a partial owned stream`);
    assert.equal((await ui.ui('[data-ocr-owner="open-pdf-studio"]')).found, false,
      `${value.id} applied a visible/invisible OCR result after failure`);
    const cache = await cacheEvidence(cacheDir);
    assert.deepEqual(cache, { payloads: 0, metadata: 0, temporary: [] });
    const nativeJobTemp = await nativeJobTempEvidence(app.processId);
    assert.deepEqual(nativeJobTemp.files, []);
    const settled = await stableParentRss(app.processId);
    const settledRssBytes = settled.rssBytes;
    const settledDeltaBytes = Math.max(0, settledRssBytes - baselineRssBytes);
    assert.ok(settledDeltaBytes <= memoryLimit,
      `${value.id} retained ${settledDeltaBytes} bytes after settling`);
    return {
      status: 'PASS', expectedResult: value.expectedResult, actualResult: 'failed-safely',
      terminalStatus: status, responseMs, originalPreserved: true, partialOwnedStream: false,
      childProcessesSurviving: 0, cache, nativeJobTemp,
      memory: {
        baselineRssBytes, settledRssBytes, settledDeltaBytes, allowedDeltaBytes: memoryLimit,
        baselineSamples: baseline.samples.length, settledSamples: settled.samples.length,
      },
    };
  } finally {
    await app.stop();
    await waitForNoChildren(app.processId, 10_000).catch(() => {});
  }
}

async function parserUiCase(value) {
  const filePath = path.join(fixtureDir, value.file);
  const originalHash = await sha256(filePath);
  const session = await startSession(`parser-${value.id}`);
  const { app, controls: ui, cacheDir } = session;
  try {
    const started = Date.now();
    const opened = await openPdf(app, filePath, Math.max(10_000, value.bounds.timeoutMs));
    let actualResult;
    let recognition = null;
    if (opened.ok === true) {
      actualResult = 'bounded-completion';
      const tabs = await app.callTool('app_list_tabs');
      assert.equal(tabs.ok, true, tabs.error);
      if (value.expectedResult === 'rejected') {
        await prepareRecognition(ui);
        const job = await submitPreparedRecognition(ui);
        const status = await terminalStatus(ui, job.dataset.jobId, 30_000);
        assert.equal(status, 'failed', 'excessive page count was not rejected by production OCR');
        recognition = { terminalStatus: status, failed: await progressCount(ui, job.dataset.jobId, 'failed') };
        actualResult = 'rejected';
      }
    } else {
      actualResult = value.expectedResult === 'rejected' ? 'rejected' : 'failed-safely';
    }
    assert.equal(actualResult, value.expectedResult,
      `${value.id} produced ${actualResult}; expected ${value.expectedResult}`);
    const responseStarted = Date.now();
    const responsive = await app.callTool('app_list_tabs');
    const responseMs = Date.now() - responseStarted;
    assert.equal(responsive.ok, true, responsive.error);
    assert.ok(responseMs < 5_000, `${value.id} left the app unresponsive`);
    await waitForNoChildren(app.processId);
    assert.equal(await sha256(filePath), originalHash, `${value.id} modified its original`);
    assert.equal(await inspectNoOwnedStream(filePath), true, `${value.id} created an owned stream`);
    const cache = await cacheEvidence(cacheDir);
    assert.deepEqual(cache, { payloads: 0, metadata: 0, temporary: [] });
    const nativeJobTemp = await nativeJobTempEvidence(app.processId);
    assert.deepEqual(nativeJobTemp.files, []);
    return {
      status: 'PASS', expectedResult: value.expectedResult, actualResult,
      elapsedMs: Date.now() - started, responseMs, originalPreserved: true,
      partialOwnedStream: false, childProcessesSurviving: 0, recognition, cache, nativeJobTemp,
    };
  } finally {
    await app.stop();
    await waitForNoChildren(app.processId, 10_000).catch(() => {});
  }
}

async function pathologicalCancellation(value) {
  const filePath = path.join(fixtureDir, value.file);
  const originalHash = await sha256(filePath);
  const session = await startSession('pathological-cancellation');
  const { app, controls: ui, cacheDir } = session;
  try {
    const opened = await openPdf(app, filePath, 30_000);
    assert.equal(opened.ok, true, opened.error);
    await prepareRecognition(ui, { entireDocument: true });
    const baseline = await stableParentRss(app.processId);
    const baselineRssBytes = baseline.rssBytes;
    const job = await submitPreparedRecognition(ui);
    const activeChild = await waitUntil('pathological OCR child', async () => {
      const current = snapshot(await readProcesses(), app.processId);
      return current.children[0] || null;
    }, 60_000, 20);
    await ui.click('[data-ocr-action="cancel"]');
    const status = await terminalStatus(ui, job.dataset.jobId, value.bounds.timeoutMs);
    assert.equal(status, 'cancelled');
    await waitForNoChildren(app.processId);
    assert.equal((await readProcesses()).some((process) => process.pid === activeChild.pid), false,
      'pathological child was not reaped');
    const counts = {};
    for (const state of ['completed', 'failed', 'cancelled']) {
      counts[state] = await progressCount(ui, job.dataset.jobId, state);
    }
    assert.equal(counts.completed + counts.failed + counts.cancelled, value.bounds.maxPages);
    const terminalCounts = structuredClone(counts);
    await delay(5_000);
    for (const state of ['completed', 'failed', 'cancelled']) {
      counts[state] = await progressCount(ui, job.dataset.jobId, state);
    }
    assert.deepEqual(counts, terminalCounts, 'late result changed pathological cancellation state');
    assert.equal(await sha256(filePath), originalHash, 'pathological cancellation modified the original');
    assert.equal(await inspectNoOwnedStream(filePath), true, 'pathological cancellation wrote a partial stream');
    const cache = await cacheEvidence(cacheDir);
    assert.deepEqual(cache.temporary, []);
    const nativeJobTemp = await nativeJobTempEvidence(app.processId);
    assert.deepEqual(nativeJobTemp.files, []);
    const settled = await stableParentRss(app.processId);
    const settledRssBytes = settled.rssBytes;
    const settledDeltaBytes = Math.max(0, settledRssBytes - baselineRssBytes);
    assert.ok(settledDeltaBytes <= memoryLimit,
      `pathological cancellation retained ${settledDeltaBytes} bytes after settling`);
    const responseStarted = Date.now();
    assert.equal((await app.callTool('app_list_tabs')).ok, true);
    const responseMs = Date.now() - responseStarted;
    assert.ok(responseMs < 5_000);
    return {
      status: 'PASS', expectedResult: value.expectedResult, actualResult: 'failed-safely',
      activeChildPid: activeChild.pid, activeChildReaped: true, lateResultApplied: false,
      counts: terminalCounts, responseMs, childProcessesSurviving: 0,
      originalPreserved: true, partialOwnedStream: false, cache, nativeJobTemp,
      memory: {
        baselineRssBytes, settledRssBytes, settledDeltaBytes, allowedDeltaBytes: memoryLimit,
        baselineSamples: baseline.samples.length, settledSamples: settled.samples.length,
      },
    };
  } finally {
    await app.stop();
    await waitForNoChildren(app.processId, 10_000).catch(() => {});
  }
}

const report = {
  contract: 'open-pdf-studio.ocr.adversarial-packaged-qualification',
  schemaVersion: 1,
  head: await gitHead(),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: 'FAIL',
  platform: { operatingSystem: process.platform, architecture: process.arch },
  appBinary,
  automation: {
    visibleProductionAction: '#ep-recognize-text',
    genericPackagedUiAutomation: true,
    developmentOnlyOcrMcpEntryPointUsed: false,
    testOnlyOcrEntryPointUsed: false,
  },
  cases: {},
  error: null,
};

try {
  await Promise.all([access(appBinary), mkdir(path.dirname(reportPath), { recursive: true })]);
  await execFileAsync(process.execPath, [
    path.join(projectDir, 'scripts', 'generate-ocr-release-qualification-fixtures.mjs'),
    '--output-dir', fixtureDir,
    '--mode', 'adversarial',
  ], { cwd: projectDir, maxBuffer: 4 * 1024 * 1024 });

  for (const id of [
    'extreme-declared-page-dimensions', 'excessive-raster-pixel-count', 'oversized-page-side',
  ]) {
    const value = manifest.adversarialCases.find((candidate) => candidate.id === id);
    report.cases[id] = await dimensionFailureCase(value);
  }
  for (const value of manifest.adversarialCases.filter((candidate) => candidate.kind === 'pdf-parser')) {
    report.cases[value.id] = await parserUiCase(value);
  }
  const cancellation = manifest.adversarialCases.find(
    (candidate) => candidate.id === 'pathological-input-cancellation',
  );
  report.cases[cancellation.id] = await pathologicalCancellation(cancellation);
  report.status = 'PASS';
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
