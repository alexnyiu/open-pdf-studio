import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlatformReport } from './evaluate-ocr-phase-a-reports.mjs';
import { classifyOcrGateAppPath } from './ocr-build-kind.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--') || !args[index + 1]) throw new Error(`invalid argument ${key}`);
    values[key.slice(2)] = args[index + 1];
    index += 1;
  }
  if (!values.app || !values.report) {
    throw new Error('usage: node scripts/run-ocr-phase-a-gate.mjs --app <executable> --report <json> [--port 9223]');
  }
  return values;
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function terminateProcessTree(child, childState) {
  if (childState.exited) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await waitForExit(killer);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (!childState.exited) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}

async function waitForMcp(endpoint, childState, logs, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childState.exited) {
      throw new Error(`Open PDF Studio exited before MCP startup (${childState.code ?? childState.signal})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.result?._meta?.openPdfStudio?.webviewReady === true) return;
      }
    } catch {
      // The app and WebView are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${endpoint}\n${logs.join('')}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const appPath = path.resolve(options.app);
  const buildKind = classifyOcrGateAppPath(appPath);
  const reportPath = path.resolve(options.report);
  const port = Number(options.port ?? 9223);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('port must be valid');
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const offlineProxy = 'http://127.0.0.1:9';
  const appEnv = {
    ...process.env,
    OPS_ENABLE_MCP: '1',
    OPS_TEST_PDFS_DIR: path.join(projectDir, 'tests', 'fixtures', 'ocr'),
    HTTP_PROXY: offlineProxy,
    HTTPS_PROXY: offlineProxy,
    ALL_PROXY: offlineProxy,
    NO_PROXY: '127.0.0.1,localhost',
    http_proxy: offlineProxy,
    https_proxy: offlineProxy,
    all_proxy: offlineProxy,
    no_proxy: '127.0.0.1,localhost',
    APPIMAGE_EXTRACT_AND_RUN: process.env.APPIMAGE_EXTRACT_AND_RUN ?? '1',
  };
  const child = spawn(appPath, ['--mcp-server', '--mcp-port', String(port)], {
    cwd: projectDir,
    env: appEnv,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  const childState = { exited: false, code: null, signal: null };
  const capture = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    if (logs.join('').length > 256 * 1024) logs.shift();
    process.stderr.write(text);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code, signal) => {
    childState.exited = true;
    childState.code = code;
    childState.signal = signal;
  });
  let signalCleanupStarted = false;
  const onSignal = async () => {
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    await terminateProcessTree(child, childState);
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await waitForMcp(endpoint, childState, logs);
    const measurement = spawn(process.execPath, ['scripts/measure-ocr-phase-a.mjs'], {
      cwd: projectDir,
      env: {
        ...appEnv,
        OPS_OCR_MCP_URL: endpoint,
        OPS_OCR_ROOT_PID: String(child.pid),
        OPS_OCR_REPORT_PATH: reportPath,
        OPS_OCR_BUILD_KIND: buildKind,
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    const result = await waitForExit(measurement);
    if (result.code !== 0) throw new Error(`Phase A measurement exited with ${result.code ?? result.signal}`);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const failures = validatePlatformReport(report);
    if (failures.length > 0) throw new Error(`Phase A platform gate failed:\n- ${failures.join('\n- ')}`);
    process.stdout.write(`${JSON.stringify({
      platform: report.environment.platform,
      architecture: report.environment.arch,
      reportPath,
      memoryBounded: report.memory.repeatedCycles.bounded,
      finalRetainedDeltaMiB: report.memory.repeatedCycles.finalRetainedDeltaMiB,
      linearTrendMiBPerCycle: report.memory.repeatedCycles.linearTrendMiBPerCycle,
      offline: report.offline.pass,
    }, null, 2)}\n`);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await terminateProcessTree(child, childState);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
