import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('could not allocate a packaged-app MCP port');
  return port;
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

export async function callMcpRpc(endpoint, id, method, params = {}, { timeoutMs = 30_000 } = {}) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      const timeoutError = new Error(`MCP ${method} timed out after ${timeoutMs}ms`, { cause: error });
      timeoutError.name = 'McpRpcTimeoutError';
      timeoutError.code = 'MCP_RPC_TIMEOUT';
      timeoutError.method = method;
      timeoutError.timeoutMs = timeoutMs;
      throw timeoutError;
    }
    throw error;
  }
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`MCP ${body.error.code}: ${body.error.message}`);
  return body.result;
}

/** Race MCP/WebView readiness against the authoritative `/usr/bin/open -W` outcome. */
export async function awaitPackagedReadiness({
  initialize,
  launchOutcome,
  timeoutMs = 90_000,
  pollIntervalMs = 100,
  now = Date.now,
  wait = delay,
} = {}) {
  if (typeof initialize !== 'function') throw new TypeError('initialize is required');
  if (!launchOutcome?.then) throw new TypeError('launchOutcome promise is required');
  const startedAt = now();
  let stage = 'before-mcp';
  let lastInitializationError = null;
  const terminalLaunchResult = (outcome) => {
    if (outcome?.kind === 'launcher-error') {
      return Object.freeze({
        status: 'launcher-error', stage, error: String(outcome.error?.message || outcome.error),
        lastInitializationError,
      });
    }
    if (outcome?.kind === 'exit') {
      return Object.freeze({
        status: 'exited', stage, code: outcome.code ?? null, signal: outcome.signal ?? null,
        lastInitializationError,
      });
    }
    return null;
  };
  while (now() - startedAt < timeoutMs) {
    const remaining = Math.max(1, timeoutMs - (now() - startedAt));
    const outcome = await Promise.race([
      Promise.resolve().then(initialize).then(
        (initialized) => ({ kind: 'initialized', initialized }),
        (error) => ({ kind: 'retry', error }),
      ),
      launchOutcome,
      wait(Math.min(pollIntervalMs, remaining)).then(() => ({ kind: 'tick' })),
    ]);
    const terminal = terminalLaunchResult(outcome);
    if (terminal) return terminal;
    if (outcome?.kind === 'initialized') {
      stage = 'before-webview';
      if (outcome.initialized?._meta?.openPdfStudio?.webviewReady === true) {
        return Object.freeze({ status: 'ready', stage: 'webview-ready', initialized: outcome.initialized });
      }
      const paused = await Promise.race([
        launchOutcome,
        wait(Math.min(pollIntervalMs, remaining)).then(() => ({ kind: 'tick' })),
      ]);
      const pausedTerminal = terminalLaunchResult(paused);
      if (pausedTerminal) return pausedTerminal;
    } else if (outcome?.kind === 'retry') {
      lastInitializationError = String(outcome.error?.message || outcome.error);
      const paused = await Promise.race([
        launchOutcome,
        wait(Math.min(pollIntervalMs, remaining)).then(() => ({ kind: 'tick' })),
      ]);
      const pausedTerminal = terminalLaunchResult(paused);
      if (pausedTerminal) return pausedTerminal;
    }
  }
  return Object.freeze({ status: 'timeout', stage, lastInitializationError });
}

export class PackagedAppLaunchError extends Error {
  constructor(evidence) {
    const exitDetail = evidence.status === 'exited'
      ? ` code=${String(evidence.code)} signal=${String(evidence.signal)}` : '';
    super(`packaged app launch failed at ${evidence.stage}: ${evidence.status}${exitDetail}`);
    this.name = 'PackagedAppLaunchError';
    this.code = 'PACKAGED_APP_LAUNCH_FAILED';
    this.evidence = Object.freeze({ ...evidence });
  }
}

export async function startPackagedApp({
  appBinary,
  appBundle: requestedAppBundle,
  cwd,
  env = {},
  initialFiles = [],
  startupTimeoutMs = 90_000,
  artifactDir = null,
  launchLabel = 'packaged-app',
  retainLogs = Boolean(artifactDir),
} = {}) {
  if (process.platform !== 'darwin') throw new Error('packaged app control is macOS-only');
  const appBundle = requestedAppBundle
    ? path.resolve(requestedAppBundle)
    : appBinary ? path.resolve(appBinary, '..', '..', '..') : null;
  const resolvedBinary = appBinary
    ? path.resolve(appBinary)
    : appBundle ? path.join(appBundle, 'Contents', 'MacOS', 'open-pdf-studio') : null;
  if (!appBundle || !resolvedBinary) throw new TypeError('appBinary or appBundle is required');
  await Promise.all([
    access(resolvedBinary),
    access(path.join(appBundle, 'Contents', 'Info.plist')),
  ]);

  const launchParent = artifactDir ? path.resolve(artifactDir) : tmpdir();
  await mkdir(launchParent, { recursive: true });
  const launchRoot = await mkdtemp(path.join(launchParent, `${launchLabel}-`));
  const appStdoutPath = path.join(launchRoot, 'app.stdout.log');
  const appStderrPath = path.join(launchRoot, 'app.stderr.log');
  const failureEvidencePath = path.join(launchRoot, 'launch-failure.json');
  await Promise.all([writeFile(appStdoutPath, ''), writeFile(appStderrPath, '')]);
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const appEnvironment = {
    OPS_ENABLE_MCP: '1',
    OPDS_DETACHED: '1',
    ...env,
  };
  const openArguments = ['-n', '-W', '--stdout', appStdoutPath, '--stderr', appStderrPath];
  for (const [name, value] of Object.entries(appEnvironment)) {
    openArguments.push('--env', `${name}=${value}`);
  }
  openArguments.push(appBundle, '--args', '--mcp-server', '--mcp-port', String(port));
  // Exercise the production command-line open-files queue with real fixtures.
  for (const file of initialFiles) openArguments.push(path.resolve(file));
  const child = spawn('/usr/bin/open', openArguments, {
    cwd,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { exited: false, exit: null, launcherError: null };
  const logs = [];
  let logLength = 0;
  const logOffsets = new Map([[appStdoutPath, 0], [appStderrPath, 0]]);
  const capture = (chunk) => {
    const value = chunk.toString();
    logs.push(value);
    logLength += value.length;
    while (logLength > 256 * 1024 && logs.length > 1) {
      logLength -= logs.shift().length;
    }
  };
  const syncAppLogs = () => {
    for (const logPath of logOffsets.keys()) {
      let value;
      try { value = readFileSync(logPath, 'utf8'); } catch { continue; }
      const offset = logOffsets.get(logPath) ?? 0;
      if (value.length > offset) capture(value.slice(offset));
      logOffsets.set(logPath, value.length);
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const launchOutcome = new Promise((resolve) => {
    child.once('error', (error) => {
      state.launcherError = error;
      resolve({ kind: 'launcher-error', error });
    });
    child.once('exit', (code, signal) => {
      state.exited = true;
      state.exit = { code, signal };
      resolve({ kind: 'exit', code, signal });
    });
  });

  const readiness = await awaitPackagedReadiness({
    initialize: () => callMcpRpc(endpoint, 1, 'initialize', {}, { timeoutMs: 1_000 }),
    launchOutcome,
    timeoutMs: startupTimeoutMs,
  });
  if (readiness.status !== 'ready') {
    if (!state.exited) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      await Promise.race([waitForExit(child), delay(1_000)]);
    }
    syncAppLogs();
    const evidence = Object.freeze({
      contract: 'open-pdf-studio.packaged-launch-failure',
      schemaVersion: 1,
      status: readiness.status,
      stage: readiness.stage,
      code: readiness.code ?? state.exit?.code ?? null,
      signal: readiness.signal ?? state.exit?.signal ?? null,
      bundlePath: appBundle,
      executablePath: resolvedBinary,
      stdoutPath: appStdoutPath,
      stderrPath: appStderrPath,
      launchRoot,
      lastInitializationError: readiness.lastInitializationError ?? null,
      generatedAt: new Date().toISOString(),
    });
    await writeFile(failureEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const error = new PackagedAppLaunchError(evidence);
    error.message += `\nstdout: ${appStdoutPath}\nstderr: ${appStderrPath}`;
    throw error;
  }

  let requestId = 1;
  const initialized = readiness.initialized;
  const applicationPid = initialized?._meta?.openPdfStudio?.processId ?? null;
  const identity = Object.freeze({
    bundlePath: appBundle,
    executablePath: resolvedBinary,
    processId: applicationPid,
    webviewReady: initialized?._meta?.openPdfStudio?.webviewReady === true,
  });
  return {
    appBinary: resolvedBinary,
    appBundle,
    child,
    endpoint,
    processId: applicationPid ?? child.pid,
    initialized,
    identity,
    launchRoot,
    appStdoutPath,
    appStderrPath,
    logs,
    state,
    markLogs() {
      syncAppLogs();
      return logs.join('').length;
    },
    logsAfter(mark) {
      syncAppLogs();
      return logs.join('').slice(mark);
    },
    async callTool(name, arguments_ = {}) {
      const result = await callMcpRpc(
        endpoint,
        ++requestId,
        'tools/call',
        { name, arguments: arguments_ },
        { timeoutMs: 30_000 },
      );
      syncAppLogs();
      const text = result?.content?.find((item) => item.type === 'text')?.text;
      if (typeof text !== 'string') throw new Error(`${name} returned no JSON text payload`);
      return JSON.parse(text);
    },
    async stop() {
      if (!state.exited) {
        try {
          if (applicationPid) process.kill(applicationPid, 'SIGTERM');
          else process.kill(-child.pid, 'SIGTERM');
        } catch { try { child.kill('SIGTERM'); } catch {} }
        await Promise.race([waitForExit(child), delay(2_000)]);
        if (!state.exited) {
          try {
            if (applicationPid) process.kill(applicationPid, 'SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          } catch {}
          try { child.kill('SIGKILL'); } catch {}
          await Promise.race([waitForExit(child), delay(1_000)]);
        }
      }
      syncAppLogs();
      if (!retainLogs) await rm(launchRoot, { recursive: true, force: true });
    },
  };
}

export async function preflightPackagedApp(options = {}) {
  const application = await startPackagedApp({ ...options, launchLabel: 'preflight', retainLogs: true });
  try {
    return Object.freeze({
      contract: 'open-pdf-studio.packaged-launch-preflight',
      schemaVersion: 1,
      status: 'PASS',
      generatedAt: new Date().toISOString(),
      ...application.identity,
      stdoutPath: application.appStdoutPath,
      stderrPath: application.appStderrPath,
    });
  } finally {
    await application.stop();
  }
}
