import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');

function parseArguments(argv) {
  const options = { gateId: '', status: 'PASS', outputPath: '', head: '', commands: [], artifacts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--gate-id') options.gateId = argv[++index] || '';
    else if (value === '--status') options.status = String(argv[++index] || '').toUpperCase();
    else if (value === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (value === '--head') options.head = argv[++index] || '';
    else if (value === '--command') options.commands.push(argv[++index] || '');
    else if (value === '--artifact') options.artifacts.push(argv[++index] || '');
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(options.gateId)) throw new Error('--gate-id is required');
  if (!['PASS', 'FAIL', 'UNVERIFIED'].includes(options.status)) {
    throw new Error('--status must be PASS, FAIL, or UNVERIFIED');
  }
  if (!options.outputPath) throw new Error('--output is required');
  return options;
}

async function resolveHead(explicitHead) {
  if (explicitHead) return explicitHead;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' });
  return result.stdout.trim();
}

export async function writeGateEvidence(options) {
  const report = {
    contract: 'open-pdf-studio.release-gate-evidence',
    schemaVersion: 1,
    gateId: options.gateId,
    status: options.status,
    head: await resolveHead(options.head),
    generatedAt: new Date().toISOString(),
    testCommands: options.commands.filter(Boolean),
    artifacts: options.artifacts.filter(Boolean),
    environment: {
      ci: Boolean(process.env.CI),
      githubEventName: process.env.GITHUB_EVENT_NAME || null,
      githubRef: process.env.GITHUB_REF || null,
      githubBaseRef: process.env.GITHUB_BASE_REF || null,
      githubHeadRef: process.env.GITHUB_HEAD_REF || null,
      runnerOs: process.env.RUNNER_OS || process.platform,
      runnerArch: process.env.RUNNER_ARCH || process.arch,
    },
  };
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeGateEvidence(parseArguments(process.argv.slice(2))).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'PASS') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
