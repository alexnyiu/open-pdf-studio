import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { assertOcrResultV1 } from '../js/ocr/contracts/v1.js';
import {
  createOcrProcessAttribution,
  updateMacOcrProcessAttribution,
} from './ocr-process-attribution.mjs';
import { verifyOcrAssets } from './verify-ocr-assets.mjs';

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = process.env.OPS_OCR_MCP_URL || 'http://127.0.0.1:9223/mcp';
const reportPath = process.env.OPS_OCR_REPORT_PATH
  ? path.resolve(projectDir, process.env.OPS_OCR_REPORT_PATH)
  : null;
const recognitionCycles = Math.max(10, Number(process.env.OPS_OCR_RECOGNITION_CYCLES) || 10);
const cancellationCycles = Math.max(10, Number(process.env.OPS_OCR_CANCELLATION_CYCLES) || 10);
const sampleIntervalMs = 50;
const cycleSettleMs = 250;
const retainedBudgetBytes = 32 * 1024 * 1024;
const trendBudgetBytesPerCycle = 2 * 1024 * 1024;
const baselineDropToleranceBytes = 64 * 1024 * 1024;
const attribution = createOcrProcessAttribution();
let requestId = 0;

function isOcrChildCommand(command) {
  return command.includes('--ocr-child-job') || command.includes('--ocr-phase-a-child');
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toMiB(bytes) {
  return round(bytes / 1024 / 1024);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function levenshtein(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
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
  const response = await rpc('tools/call', {
    name,
    arguments: arguments_,
  });
  const text = response?.content?.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error(`${name} returned no text payload`);
  return JSON.parse(text);
}

async function callOcr(arguments_) {
  return callTool('app_ocr_phase_a_spike', arguments_);
}

async function readProcesses() {
  if (process.platform === 'win32') {
    const command = [
      '$p = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name,CommandLine',
      '$p | ConvertTo-Json -Compress',
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      pid: Number(entry.ProcessId),
      ppid: Number(entry.ParentProcessId),
      rssBytes: Number(entry.WorkingSetSize),
      name: String(entry.Name || ''),
      command: String(entry.CommandLine || ''),
    }));
  }

  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      name: path.basename(match[4].split(' ')[0]),
      command: match[4],
    } : null;
  }).filter(Boolean);
}

function findRootProcess(processes) {
  const requestedRootPid = Number(process.env.OPS_OCR_ROOT_PID);
  if (Number.isInteger(requestedRootPid) && requestedRootPid > 0) {
    return processes.find((entry) => entry.pid === requestedRootPid);
  }
  if (process.platform === 'win32') {
    return processes.find((entry) =>
      entry.name.toLowerCase() === 'open-pdf-studio.exe' && entry.command.includes('--mcp-server'));
  }
  return processes.find((entry) =>
    entry.command.includes('--mcp-server') &&
    (entry.command.includes('/target/debug/open-pdf-studio') ||
      entry.command.includes('/target/release/open-pdf-studio') ||
      entry.command.includes('Open PDF Studio.app/Contents/MacOS')));
}

function descendantPids(processes, roots) {
  const result = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (result.has(entry.ppid) && !result.has(entry.pid)) {
        result.add(entry.pid);
        changed = true;
      }
    }
  }
  return result;
}

function sumByRole(entries) {
  const roles = {};
  for (const entry of entries) {
    roles[entry.role] = (roles[entry.role] ?? 0) + entry.rssBytes;
  }
  return Object.fromEntries(Object.entries(roles).sort(([a], [b]) => a.localeCompare(b)).map(
    ([role, rssBytes]) => [role, { rssBytes, rssMiB: toMiB(rssBytes) }],
  ));
}

async function processMemorySnapshot() {
  const processes = await readProcesses();
  const root = findRootProcess(processes);
  if (!root) return null;

  const activeChildren = processes.filter((entry) => isOcrChildCommand(entry.command));

  if (process.platform === 'darwin') {
    // macOS reparents WebKit XPC processes to launchd, so neither PPID nor PID
    // proximity can prove ownership of the editor's long-lived WebView. The
    // isolated OCR path never sends page pixels or model bytes there. Attribute
    // only new XPC processes that appear while a known one-job child is alive;
    // the initial system-wide WebKit set is deliberately excluded.
    updateMacOcrProcessAttribution(attribution, processes, activeChildren);
  } else {
    for (const child of activeChildren) attribution.childPids.add(child.pid);
    attribution.initialized = true;
  }

  const ordinaryTree = descendantPids(processes, [root.pid]);
  const childTrees = descendantPids(processes, attribution.childPids);
  const includedPids = new Set([
    ...ordinaryTree,
    ...attribution.childWebKitPids,
  ]);
  const included = processes.filter((entry) => includedPids.has(entry.pid)).map((entry) => {
    let role = 'app-descendant';
    if (entry.pid === root.pid) role = 'app';
    else if (attribution.childWebKitPids.has(entry.pid)) role = 'ocr-child-webkit';
    else if (childTrees.has(entry.pid)) role = isOcrChildCommand(entry.command)
      ? 'ocr-child-app'
      : 'ocr-child-descendant';
    else if (entry.command.includes('pdfium-worker')) role = 'pdfium-worker';
    return { ...entry, role };
  });

  return {
    atEpochMs: Date.now(),
    rootPid: root.pid,
    buildKind: process.env.OPS_OCR_BUILD_KIND || (root.command.includes('/target/debug/')
      ? 'debug'
      : root.command.includes('/target/release/') ||
          root.command.includes('Open PDF Studio.app/Contents/MacOS') ||
          root.name.toLowerCase() === 'open-pdf-studio.exe'
        ? 'packaged-release'
        : 'external'),
    rssBytes: included.reduce((sum, entry) => sum + entry.rssBytes, 0),
    processCount: included.length,
    roles: sumByRole(included),
    activeOcrChildPids: activeChildren.map((entry) => entry.pid),
    activeOcrChildWebKitPids: included
      .filter((entry) => entry.role === 'ocr-child-webkit')
      .map((entry) => entry.pid),
  };
}

function compactSnapshot(snapshot, processStart, extra = {}) {
  if (!snapshot) return null;
  const delta = processStart ? snapshot.rssBytes - processStart.rssBytes : 0;
  return {
    atEpochMs: snapshot.atEpochMs,
    rssBytes: snapshot.rssBytes,
    rssMiB: toMiB(snapshot.rssBytes),
    deltaFromProcessStartBytes: delta,
    deltaFromProcessStartMiB: toMiB(delta),
    processCount: snapshot.processCount,
    roles: snapshot.roles,
    activeOcrChildPids: snapshot.activeOcrChildPids,
    activeOcrChildWebKitPids: snapshot.activeOcrChildWebKitPids,
    ...extra,
  };
}

async function runWithMemorySamples(callback) {
  const samples = [];
  let active = true;
  const first = await processMemorySnapshot();
  if (first) samples.push(first);
  const sampler = (async () => {
    while (active) {
      await delay(sampleIntervalMs);
      if (!active) break;
      try {
        const sample = await processMemorySnapshot();
        if (sample) samples.push(sample);
      } catch {
        // The recognition result remains useful if a platform sampler misses a tick.
      }
    }
  })();
  const started = performance.now();
  let value;
  try {
    value = await callback();
  } finally {
    active = false;
    await sampler;
    const final = await processMemorySnapshot();
    if (final) samples.push(final);
  }
  return { value, wallMs: round(performance.now() - started), samples };
}

function nearestSample(samples, atEpochMs) {
  return samples.reduce((best, sample) => {
    const distance = Math.abs(sample.atEpochMs - atEpochMs);
    return !best || distance < best.distance ? { sample, distance } : best;
  }, null);
}

function lifecycleCheckpoint(lifecycle, samples, stage, processStart) {
  const checkpoint = lifecycle.find((entry) => entry.stage === stage);
  if (!checkpoint) return null;
  const nearest = nearestSample(samples, checkpoint.atEpochMs);
  return compactSnapshot(nearest?.sample, processStart, {
    lifecycleStage: stage,
    lifecycleAtEpochMs: checkpoint.atEpochMs,
    sampleOffsetMs: nearest ? nearest.sample.atEpochMs - checkpoint.atEpochMs : null,
    lifecycleDetail: Object.fromEntries(Object.entries(checkpoint).filter(
      ([key]) => !['stage', 'atEpochMs'].includes(key),
    )),
  });
}

async function snapshotAfter(baseEpochMs, delayMs, processStart) {
  const remaining = baseEpochMs + delayMs - Date.now();
  if (remaining > 0) await delay(remaining);
  return compactSnapshot(await processMemorySnapshot(), processStart, {
    delayAfterWorkerTerminationMs: delayMs,
  });
}

function peakSnapshot(samples) {
  return samples.reduce((peak, sample) => !peak || sample.rssBytes > peak.rssBytes ? sample : peak, null);
}

function linearSlope(values) {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator ? numerator / denominator : 0;
}

async function listFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  }
  await visit(root);
  return output;
}

async function packageMeasurement() {
  const distDir = path.join(projectDir, 'dist');
  const files = await listFiles(distDir);
  const records = await Promise.all(files.map(async (file) => ({
    file: path.relative(distDir, file),
    bytes: (await stat(file)).size,
  })));
  const ocr = records.filter((record) =>
    record.file.startsWith(`ocr${path.sep}`) ||
    /^assets[/\\](?:ort-wasm-simd-threaded|worker-|spike-|child-runner-)/.test(record.file),
  );
  const builtOcrBytes = ocr.reduce((sum, record) => sum + record.bytes, 0);
  return {
    builtOcrBytes,
    builtOcrMiB: toMiB(builtOcrBytes),
    totalDistBytes: records.reduce((sum, record) => sum + record.bytes, 0),
    artifacts: ocr.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

function cycleRecord({ index, type, cancelAfterMs = null, run, after, processStart, expectedText }) {
  const response = run.value;
  const peak = peakSnapshot(run.samples);
  const common = {
    index,
    type,
    wallMs: run.wallMs,
    cancelAfterMs,
    childPid: response.isolation?.childPid ?? null,
    childExitStatus: response.isolation?.exitStatus ?? null,
    childReaped: response.isolation?.reaped === true,
    isolationBoundary: response.isolation?.boundary ?? null,
    peakRssBytes: peak?.rssBytes ?? null,
    peakRssMiB: peak ? toMiB(peak.rssBytes) : null,
    settledRssBytes: after?.rssBytes ?? null,
    settledRssMiB: after ? toMiB(after.rssBytes) : null,
    settledDeltaFromProcessStartBytes: after ? after.rssBytes - processStart.rssBytes : null,
    activeOcrChildPidsAfterSettle: after?.activeOcrChildPids ?? [],
    cleanup: response.cleanup ?? null,
  };
  if (type === 'recognition') {
    const result = assertOcrResultV1(response.result);
    return {
      ...common,
      exactNormalizedMatch: normalizeText(result.text) === expectedText,
      modelStartupMs: result.metrics.modelStartupMs,
      totalOcrMs: result.metrics.totalOcrMs,
      resources: response.resources,
    };
  }
  return {
    ...common,
    cancelled: response.cancelled === true,
    cancellationMethod: response.cancellation?.method ?? null,
    cancellationLatencyMs: response.cancellation?.latencyMs ?? null,
    resources: response.resources,
  };
}

async function runSettledCycle(arguments_, processStart) {
  const run = await runWithMemorySamples(() => callOcr(arguments_));
  await delay(cycleSettleMs);
  const after = await processMemorySnapshot();
  return { run, after };
}

async function timedViewerTool(name, arguments_, ocrState = null) {
  const started = performance.now();
  const value = await callTool(name, arguments_);
  return {
    name,
    arguments: arguments_,
    wallMs: round(performance.now() - started),
    ok: value?.ok === true,
    completedBeforeOcrResult: ocrState ? ocrState.settled === false : null,
    result: name === 'app_get_viewport_state'
      ? {
          engine: value?.engine ?? null,
          docScale: value?.doc?.scale ?? null,
          viewportZoom: value?.viewport?.zoom ?? null,
          canvasWidth: value?.canvas?.width ?? null,
          canvasHeight: value?.canvas?.height ?? null,
        }
      : value,
  };
}

async function measureViewerResponsiveness(fixturePath, selected, expectedText) {
  const opened = await timedViewerTool('app_open_pdf', { path: fixturePath });
  if (!opened.ok) throw new Error(opened.result?.error || 'Viewer could not open OCR fixture');

  const baseline = [];
  for (const scale of [1, 1.15, 1]) {
    baseline.push(await timedViewerTool('app_set_zoom', { scale }));
  }
  baseline.push(await timedViewerTool('app_get_viewport_state', {}));

  const ocrState = { settled: false };
  const ocrStarted = performance.now();
  const ocrPromise = callOcr({
    path: fixturePath,
    page_index: selected.pageIndex,
    scale: 2,
  }).finally(() => {
    ocrState.settled = true;
  });
  await delay(75);

  const duringOcr = [];
  for (const scale of [1.1, 1.25, 1]) {
    duringOcr.push(await timedViewerTool('app_set_zoom', { scale }, ocrState));
    duringOcr.push(await timedViewerTool('app_get_viewport_state', {}, ocrState));
  }
  const ocrResponse = await ocrPromise;
  const ocrWallMs = round(performance.now() - ocrStarted);
  if (!ocrResponse.ok || ocrResponse.cancelled) {
    throw new Error(ocrResponse.error || 'Viewer responsiveness OCR job failed');
  }
  const ocrResult = assertOcrResultV1(ocrResponse.result);
  const after = await processMemorySnapshot();
  const baselineLatencies = baseline.map((record) => record.wallMs);
  const duringLatencies = duringOcr.map((record) => record.wallMs);
  const allDuringRequestsSucceeded = duringOcr.every((record) => record.ok);
  const allDuringRequestsCompletedBeforeOcr = duringOcr.every(
    (record) => record.completedBeforeOcrResult,
  );

  return {
    method: 'MCP round-trip timing for awaited viewer zoom renders and viewport probes while a separate isolated OCR request is in flight',
    fixtureOpened: opened,
    baseline,
    duringOcr,
    baselineMaximumWallMs: Math.max(...baselineLatencies),
    duringOcrMaximumWallMs: Math.max(...duringLatencies),
    ocrWallMs,
    ocrExactNormalizedMatch: normalizeText(ocrResult.text) === expectedText,
    allDuringRequestsSucceeded,
    allDuringRequestsCompletedBeforeOcr,
    responsiveWhileOcrActive: allDuringRequestsSucceeded && allDuringRequestsCompletedBeforeOcr,
    activeOcrChildPidsAfterProbe: after?.activeOcrChildPids ?? [],
    acceptanceNote: 'No approved viewer-latency threshold was provided; raw baseline and concurrent timings are reported without inventing one.',
  };
}

const golden = JSON.parse(await readFile(
  path.join(projectDir, 'tests', 'fixtures', 'ocr', 'golden.json'),
  'utf8',
));
const selected = golden.fixtures.find((fixture) => fixture.selectedForSpike);
if (!selected) throw new Error('No selected Phase A OCR fixture');
const fixturePath = path.join(projectDir, 'tests', 'fixtures', 'ocr', selected.file);
const fixtureHashBefore = createHash('sha256').update(await readFile(fixturePath)).digest('hex');
if (fixtureHashBefore !== selected.sha256) throw new Error('Selected OCR fixture checksum changed before measurement');
const expectedText = normalizeText(selected.expectedLines.join(' '));

// Run this against a freshly launched debug/release app. This first external
// sample is the process-start baseline used by every later checkpoint.
const processStart = await processMemorySnapshot();
if (!processStart) throw new Error('Could not find a running Open PDF Studio --mcp-server process');

await rpc('initialize', {
  protocolVersion: '2025-03-26',
  clientInfo: { name: 'open-pdf-studio-ocr-phase-a-memory-gate', version: '2' },
  capabilities: {},
});

const assets = await verifyOcrAssets();
const cold = await runWithMemorySamples(() => callOcr({
  path: fixturePath,
  page_index: selected.pageIndex,
  scale: 2,
}));
if (!cold.value.ok || cold.value.cancelled) {
  throw new Error(cold.value.error || 'Cold OCR measurement did not return a result');
}
const result = assertOcrResultV1(cold.value.result);
const workerTermination = cold.value.lifecycle.find((entry) => entry.stage === 'worker-terminated');
if (!workerTermination) throw new Error('Cold OCR lifecycle did not report Worker termination');

const afterWorker2s = await snapshotAfter(workerTermination.atEpochMs, 2000, processStart);
const afterWorker5s = await snapshotAfter(workerTermination.atEpochMs, 5000, processStart);
const afterWorker30s = await snapshotAfter(workerTermination.atEpochMs, 30000, processStart);

const recognitionRecords = [];
recognitionRecords.push(cycleRecord({
  index: 1,
  type: 'recognition',
  run: cold,
  after: afterWorker2s,
  processStart,
  expectedText,
}));
for (let index = 2; index <= recognitionCycles; index += 1) {
  const cycle = await runSettledCycle({
    path: fixturePath,
    page_index: selected.pageIndex,
    scale: 2,
  }, processStart);
  if (!cycle.run.value.ok || cycle.run.value.cancelled) {
    throw new Error(cycle.run.value.error || `Recognition cycle ${index} failed`);
  }
  recognitionRecords.push(cycleRecord({
    index,
    type: 'recognition',
    run: cycle.run,
    after: cycle.after,
    processStart,
    expectedText,
  }));
}

const cancellationRecords = [];
const cancellationDelays = [0, 25, 75, 150, 300];
for (let index = 1; index <= cancellationCycles; index += 1) {
  const cancelAfterMs = cancellationDelays[(index - 1) % cancellationDelays.length];
  const cycle = await runSettledCycle({
    path: fixturePath,
    page_index: selected.pageIndex,
    scale: 2,
    cancel_after_ms: cancelAfterMs,
  }, processStart);
  if (!cycle.run.value.ok || !cycle.run.value.cancelled ||
      cycle.run.value.cancellation?.method !== 'native-child-process-terminate') {
    throw new Error(`Cancellation cycle ${index} was not initiated by the parent controller`);
  }
  cancellationRecords.push(cycleRecord({
    index,
    type: 'cancellation',
    cancelAfterMs,
    run: cycle.run,
    after: cycle.after,
    processStart,
    expectedText,
  }));
}

await delay(2000);
const afterRepeatedCycles = await processMemorySnapshot();
const fixtureHashAfter = createHash('sha256').update(await readFile(fixturePath)).digest('hex');
if (fixtureHashAfter !== fixtureHashBefore) throw new Error('OCR Phase A mutated the source PDF');

// This probe runs after the final repeated-cycle memory checkpoint so loading
// the fixture into the visible viewer cannot contaminate the memory gate.
const viewerResponsiveness = await measureViewerResponsiveness(
  fixturePath,
  selected,
  expectedText,
);

const actualText = normalizeText(result.text);
const editDistance = levenshtein(expectedText, actualText);
const characterAccuracy = expectedText.length
  ? Math.max(0, 1 - editDistance / Math.max(expectedText.length, actualText.length))
  : 1;
const allRecords = [...recognitionRecords, ...cancellationRecords];
const settledValues = allRecords.map((record) => record.settledRssBytes).filter(Number.isFinite);
const trendBytesPerCycle = linearSlope(settledValues);
const maximumPerCycleSettledDeltaBytes = settledValues.length
  ? Math.max(...settledValues.map((value) => value - processStart.rssBytes))
  : null;
const finalRetainedDeltaBytes = afterRepeatedCycles.rssBytes - processStart.rssBytes;
const maximumSettledDeltaBytes = maximumPerCycleSettledDeltaBytes === null
  ? finalRetainedDeltaBytes
  : Math.max(maximumPerCycleSettledDeltaBytes, finalRetainedDeltaBytes);
const minimumSettledDeltaBytes = settledValues.length
  ? Math.min(...settledValues.map((value) => value - processStart.rssBytes), finalRetainedDeltaBytes)
  : finalRetainedDeltaBytes;
// A large negative delta is not proof of cleanup: it usually means the
// baseline cohort contained a process that did not belong to the app. Fail
// closed instead of allowing that attribution error to hide retained memory.
const attributionStable = minimumSettledDeltaBytes >= -baselineDropToleranceBytes;
const uniqueChildPids = new Set(allRecords.map((record) => record.childPid).filter(Number.isInteger));
const bounded = maximumSettledDeltaBytes !== null &&
  maximumSettledDeltaBytes <= retainedBudgetBytes &&
  finalRetainedDeltaBytes <= retainedBudgetBytes &&
  attributionStable &&
  trendBytesPerCycle <= trendBudgetBytesPerCycle &&
  afterRepeatedCycles.activeOcrChildPids.length === 0 &&
  recognitionRecords.every((record) => record.exactNormalizedMatch && record.childExitStatus === 0) &&
  cancellationRecords.every((record) => record.cancelled && record.childReaped &&
    record.cleanup?.requestFileRemoved === true && record.cleanup?.resultFileRemoved === true) &&
  uniqueChildPids.size === recognitionCycles + cancellationCycles;

const checkpoints = {
  processStart: compactSnapshot(processStart, processStart),
  beforeModelInitialization: lifecycleCheckpoint(
    cold.value.lifecycle, cold.samples, 'before-model-initialization', processStart,
  ),
  afterModelInitialization: lifecycleCheckpoint(
    cold.value.lifecycle, cold.samples, 'after-model-initialization', processStart,
  ),
  afterOnePageInference: lifecycleCheckpoint(
    cold.value.lifecycle, cold.samples, 'after-one-page-inference', processStart,
  ),
  immediatelyBeforeDisposal: lifecycleCheckpoint(
    cold.value.lifecycle, cold.samples, 'immediately-before-engine-disposal', processStart,
  ),
  afterOcrEngineDisposal: lifecycleCheckpoint(
    cold.value.lifecycle, cold.samples, 'after-ocr-engine-disposal', processStart,
  ),
  afterWorkerTermination2s: afterWorker2s,
  afterWorkerTermination5s: afterWorker5s,
  afterWorkerTermination30s: afterWorker30s,
  afterRepeatedRecognitionAndCancellationCycles: compactSnapshot(
    afterRepeatedCycles, processStart, { recognitionCycles, cancellationCycles },
  ),
};

const successResources = cold.value.resources ?? {};
const offlinePolicyEnforced = recognitionRecords.every(
  (record) => record.resources?.offline?.policyEnforced === true &&
    record.resources?.offline?.selfTestPassed === true,
);
const blockedExternalRequestCount = recognitionRecords.reduce(
  (sum, record) => sum + (record.resources?.offline?.blockedExternalRequestCount ?? 0),
  0,
);
const report = {
  schemaVersion: 3,
  measuredAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    endpoint,
    buildKind: processStart.buildKind,
    debugBuild: processStart.buildKind === 'debug',
  },
  fixture: {
    id: selected.id,
    path: path.relative(projectDir, fixturePath),
    pageIndex: selected.pageIndex,
    sha256: selected.sha256,
    unchangedAfterRun: true,
    expectedLines: selected.expectedLines,
  },
  result,
  timing: {
    coldIsolatedWallMs: cold.wallMs,
    ...result.metrics,
    recognitionCycles: {
      minimumWallMs: Math.min(...recognitionRecords.map((record) => record.wallMs)),
      medianWallMs: [...recognitionRecords].sort((a, b) => a.wallMs - b.wallMs)[
        Math.floor(recognitionRecords.length / 2)
      ].wallMs,
      maximumWallMs: Math.max(...recognitionRecords.map((record) => record.wallMs)),
    },
    cancellationCycles: {
      minimumWallMs: Math.min(...cancellationRecords.map((record) => record.wallMs)),
      medianWallMs: [...cancellationRecords].sort((a, b) => a.wallMs - b.wallMs)[
        Math.floor(cancellationRecords.length / 2)
      ].wallMs,
      maximumWallMs: Math.max(...cancellationRecords.map((record) => record.wallMs)),
    },
  },
  memory: {
    method: process.platform === 'win32'
      ? 'sum of WorkingSetSize for the MCP app tree plus each disposable OCR child tree, sampled every 50 ms'
      : process.platform === 'darwin'
        ? 'sum of RSS for the MCP app/PDFium process tree plus WebKit XPC processes born while each disposable OCR child is alive, sampled every 50 ms'
        : 'sum of RSS for the MCP app tree plus each disposable OCR child tree, sampled every 50 ms',
    caveat: process.platform === 'darwin'
      ? 'OS RSS includes shared and allocator-retained pages. The editor WebView is excluded because launchd reparenting makes its XPC ownership unprovable from process metadata and the isolated OCR path never transfers raster/model bytes into it; parent native allocations, PDFium, the OCR child, and its newly born WebKit cohort are included.'
      : 'OS RSS includes shared and allocator-retained pages; lifecycle checkpoints distinguish released live objects from resident allocator pages.',
    checkpoints,
    repeatedCycles: {
      recognition: recognitionRecords,
      cancellation: cancellationRecords,
      uniqueChildProcesses: uniqueChildPids.size,
      maximumPerCycleSettledDeltaBytes,
      maximumPerCycleSettledDeltaMiB: toMiB(maximumPerCycleSettledDeltaBytes),
      maximumSettledDeltaBytes,
      maximumSettledDeltaMiB: toMiB(maximumSettledDeltaBytes),
      minimumSettledDeltaBytes,
      minimumSettledDeltaMiB: toMiB(minimumSettledDeltaBytes),
      finalRetainedDeltaBytes,
      finalRetainedDeltaMiB: toMiB(finalRetainedDeltaBytes),
      linearTrendBytesPerCycle: round(trendBytesPerCycle),
      linearTrendMiBPerCycle: toMiB(trendBytesPerCycle),
      attributionStable,
      acceptance: {
        retainedBudgetBytes,
        retainedBudgetMiB: toMiB(retainedBudgetBytes),
        trendBudgetBytesPerCycle,
        trendBudgetMiBPerCycle: toMiB(trendBudgetBytesPerCycle),
        baselineDropToleranceBytes,
        baselineDropToleranceMiB: toMiB(baselineDropToleranceBytes),
        minimumRecognitionCycles: 10,
        minimumCancellationCycles: 10,
        freshChildRequiredPerCycle: true,
        noActiveChildAfterSettle: true,
      },
      bounded,
    },
  },
  resourceLifetime: {
    classification: bounded
      ? 'WebView allocator retention, bounded by one-job native child process; no cycle-over-cycle process leak observed'
      : 'unresolved process retention; production memory gate remains failed',
    liveJavaScriptReferencesDropped: successResources.liveJavaScriptPageReferences === 0,
    jobEnvelopeDropped: successResources.jobEnvelopeDropped === true,
    onnxSessionsReleased: successResources.onnxSessionsReleased === true,
    openCv: successResources.openCv,
    imageData: successResources.imageData,
    imageBitmap: successResources.imageBitmap,
    typedArrayOwnership: successResources.typedArrayOwnership,
    senderBufferDetached: successResources.senderBufferDetached,
    transferredBuffersDropped: successResources.transferredBuffersDropped === true,
    eventListenersRemoved: successResources.eventListenersRemoved === true,
    messagePorts: successResources.messagePorts,
    modelCache: {
      fetchMode: 'no-store',
      modelByteReferencesDropped: checkpoints.afterModelInitialization?.lifecycleDetail
        ?.modelByteReferencesDropped === true,
    },
    maximumAdapterInstancesPerChild: Math.max(
      0,
      ...recognitionRecords.map((record) => record.resources?.maximumAdapterInstances ?? 0),
    ),
    duplicateModelInstances: recognitionRecords.some(
      (record) => record.resources?.duplicateModelInstances === true,
    ),
    staleResultRetentionPrevented: true,
    staleResultVerification: 'js/ocr/engine.test.mjs removes listeners, empties pending requests, and ignores a saved stale callback after cancellation',
    cancellationNote: 'Parent-controlled cancellation terminates and reaps the one-job application child, so in-flight ONNX/WASM allocations are reclaimed at the process boundary.',
    trueProcessLeakObserved: !bounded,
  },
  isolation: {
    boundary: cold.value.isolation?.boundary,
    oneJob: cold.value.isolation?.oneJob,
    rationale: 'Worker termination did not release WebKit allocator pages to the long-lived app process; process exit is the reclamation boundary.',
  },
  accuracy: {
    normalizedExpected: expectedText,
    normalizedActual: actualText,
    editDistance,
    characterAccuracy: round(characterAccuracy, 4),
    exactNormalizedMatch: expectedText === actualText,
    allRecognitionCyclesExact: recognitionRecords.every((record) => record.exactNormalizedMatch),
  },
  cancellation: {
    cycles: cancellationCycles,
    delaysMs: cancellationDelays,
    allTerminatedWorkers: cancellationRecords.every(
      (record) => record.cancelled &&
        record.cancellationMethod === 'native-child-process-terminate' && record.childReaped,
    ),
    method: 'native-child-process-terminate',
    maximumLatencyMs: Math.max(...cancellationRecords.map(
      (record) => record.cancellationLatencyMs ?? 0,
    )),
  },
  offline: {
    pass: offlinePolicyEnforced && assets.ok,
    externalNetworkRequestsRequired: false,
    sameOriginAssetGuard: true,
    allWorkerFetchesGuarded: offlinePolicyEnforced,
    externalBlockSelfTestPassed: recognitionRecords.every(
      (record) => record.resources?.offline?.selfTestPassed === true,
    ),
    allowedOrigin: successResources.offline?.allowedOrigin ?? null,
    coldRunAllowedRequestCount: successResources.offline?.allowedRequestCount ?? null,
    blockedExternalRequestCount,
    vendoredAssetsChecksumVerified: assets.ok,
    physicalNetworkDisabledDuringRun: false,
    limitation: 'Every Worker fetch is mechanically restricted to its application origin and vendored assets are checksum-verified; this run did not disable the host network interface.',
  },
  viewerResponsiveness,
  packageSize: await packageMeasurement(),
  gate: {
    memoryRemediationPass: bounded,
    platformValidated: `${process.platform}-${process.arch}`,
    crossPlatformProductionDecision: process.platform === 'darwin'
      ? 'Windows and Linux live runs still required'
      : 'Other supported desktop platforms still require live runs',
  },
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, serialized, 'utf8');
  console.log(JSON.stringify({
    reportPath,
    memoryRemediationPass: report.gate.memoryRemediationPass,
    recognitionCycles,
    cancellationCycles,
    finalRetainedDeltaMiB: report.memory.repeatedCycles.finalRetainedDeltaMiB,
    linearTrendMiBPerCycle: report.memory.repeatedCycles.linearTrendMiBPerCycle,
    viewerResponsiveWhileOcrActive: report.viewerResponsiveness.responsiveWhileOcrActive,
  }, null, 2));
} else {
  console.log(serialized);
}
