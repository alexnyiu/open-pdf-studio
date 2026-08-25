import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

async function rpc(endpoint, id, method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`MCP ${body.error.code}: ${body.error.message}`);
  return body.result;
}

export async function startPackagedApp({
  appBinary,
  cwd,
  env = {},
  startupTimeoutMs = 90_000,
} = {}) {
  if (process.platform !== 'darwin') throw new Error('packaged app control is macOS-only');
  if (!appBinary) throw new TypeError('appBinary is required');
  await access(appBinary);
  const appBundle = path.resolve(appBinary, '..', '..', '..');
  await access(path.join(appBundle, 'Contents', 'Info.plist'));
  const launchRoot = await mkdtemp(path.join(tmpdir(), 'opds-packaged-launch-'));
  const appStdoutPath = path.join(launchRoot, 'app.stdout.log');
  const appStderrPath = path.join(launchRoot, 'app.stderr.log');
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const appEnvironment = {
    OPS_ENABLE_MCP: '1',
    OPDS_DETACHED: '1',
    ...env,
  };
  const openArguments = [
    '-n',
    '-W',
    '--stdout', appStdoutPath,
    '--stderr', appStderrPath,
  ];
  for (const [name, value] of Object.entries(appEnvironment)) {
    openArguments.push('--env', `${name}=${value}`);
  }
  openArguments.push(appBundle, '--args', '--mcp-server', '--mcp-port', String(port));
  const child = spawn('/usr/bin/open', openArguments, {
    cwd,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { exited: false };
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
  child.on('exit', () => { state.exited = true; });

  const deadline = Date.now() + startupTimeoutMs;
  let initialized = null;
  while (Date.now() < deadline) {
    if (state.exited) {
      syncAppLogs();
      await rm(launchRoot, { recursive: true, force: true });
      throw new Error(`packaged app exited before MCP startup\n${logs.join('')}`);
    }
    try {
      initialized = await rpc(endpoint, 1, 'initialize');
      if (initialized?._meta?.openPdfStudio?.webviewReady === true) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (Date.now() >= deadline) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    syncAppLogs();
    await rm(launchRoot, { recursive: true, force: true });
    throw new Error(`timed out waiting for packaged app MCP\n${logs.join('')}`);
  }

  let requestId = 1;
  const applicationPid = initialized?._meta?.openPdfStudio?.processId ?? null;
  return {
    appBinary,
    child,
    endpoint,
    processId: applicationPid ?? child.pid,
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
      const result = await rpc(endpoint, ++requestId, 'tools/call', { name, arguments: arguments_ });
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
        await Promise.race([
          waitForExit(child),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        if (!state.exited) {
          try {
            if (applicationPid) process.kill(applicationPid, 'SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          } catch {}
          try { child.kill('SIGKILL'); } catch {}
          await Promise.race([
            waitForExit(child),
            new Promise((resolve) => setTimeout(resolve, 1_000)),
          ]);
        }
      }
      syncAppLogs();
      await rm(launchRoot, { recursive: true, force: true });
    },
  };
}
