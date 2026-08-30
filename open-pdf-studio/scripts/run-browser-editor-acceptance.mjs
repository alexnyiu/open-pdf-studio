import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_EDITOR_ACCEPTANCE_CONTRACT,
  BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION,
} from './browser-editor-acceptance-manifest.mjs';
import { REQUIRED_BROWSER_ACCEPTANCE_SUITES } from './ocr-release-hardening-policy.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseArguments(argv) {
  const options = {
    outputPath: path.resolve(process.env.OPEN_PDF_STUDIO_BROWSER_ACCEPTANCE_REPORT
      || path.join(projectDir, 'test-artifacts', 'browser-ui', 'browser-acceptance.json')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') options.outputPath = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

async function gitHead() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'],
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

function finishLog(stream) {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

async function runSuite(name, logPath) {
  const log = createWriteStream(logPath, { flags: 'w' });
  const startedAt = new Date().toISOString();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', name], {
        cwd: projectDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => { process.stdout.write(chunk); log.write(chunk); });
      child.stderr.on('data', (chunk) => { process.stderr.write(chunk); log.write(chunk); });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
    });
    return {
      name,
      command: `npm run ${name}`,
      startedAt,
      completedAt: new Date().toISOString(),
      status: result.code === 0 && result.signal == null ? 'PASS' : 'FAIL',
      ...result,
    };
  } finally {
    await finishLog(log);
  }
}

async function waitForVite(viteState, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (viteState.exited) {
      throw new Error(
        viteState.error
          ? `Vite failed to launch before browser acceptance: ${viteState.error}`
          : `Vite exited before browser acceptance: code=${viteState.code} signal=${viteState.signal}`,
      );
    }
    try {
      const response = await fetch('http://127.0.0.1:3041/');
      if (response.ok) return;
      lastError = new Error(`Vite HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for Vite: ${lastError?.message || 'unavailable'}`);
}

export async function runBrowserEditorAcceptance(options) {
  const outputDir = path.dirname(options.outputPath);
  const logsDir = path.join(outputDir, 'logs');
  await mkdir(logsDir, { recursive: true });
  const report = {
    contract: BROWSER_EDITOR_ACCEPTANCE_CONTRACT,
    schemaVersion: BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION,
    status: 'RUNNING',
    head: await gitHead(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    suites: [],
    artifacts: [path.relative(outputDir, options.outputPath), 'vite-console.log'],
  };
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  const viteLog = createWriteStream(path.join(outputDir, 'vite-console.log'), { flags: 'w' });
  const vite = spawn(path.join(projectDir, 'node_modules', '.bin', 'vite'), [
    '--host', '127.0.0.1', '--port', '3041', '--strictPort',
  ], {
    cwd: projectDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const viteState = { exited: false, code: null, signal: null, error: null };
  vite.stdout.on('data', (chunk) => viteLog.write(chunk));
  vite.stderr.on('data', (chunk) => viteLog.write(chunk));
  vite.once('error', (error) => Object.assign(viteState, {
    exited: true,
    error: error?.message || String(error),
  }));
  vite.once('exit', (code, signal) => Object.assign(viteState, { exited: true, code, signal }));

  try {
    await waitForVite(viteState);
    for (const name of REQUIRED_BROWSER_ACCEPTANCE_SUITES) {
      const logPath = path.join(logsDir, `${name.replaceAll(':', '-')}.log`);
      report.suites.push(await runSuite(name, logPath));
      report.artifacts.push(path.relative(outputDir, logPath));
      await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    report.status = report.suites.every((suite) => suite.status === 'PASS') ? 'PASS' : 'FAIL';
  } catch (error) {
    report.status = 'FAIL';
    report.infrastructureError = error?.stack || error?.message || String(error);
  } finally {
    report.completedAt = new Date().toISOString();
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!viteState.exited) {
      try { vite.kill('SIGTERM'); } catch {}
      await Promise.race([
        new Promise((resolve) => vite.once('exit', resolve)),
        delay(2_000),
      ]);
    }
    await finishLog(viteLog);
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBrowserEditorAcceptance(parseArguments(process.argv.slice(2))).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'PASS') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || error}\n`);
    process.exitCode = 1;
  });
}
