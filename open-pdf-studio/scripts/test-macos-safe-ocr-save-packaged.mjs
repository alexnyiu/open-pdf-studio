import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  chmod,
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
import { fileURLToPath } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

assert.equal(process.platform, 'darwin', 'packaged safe-save gate is macOS-only');

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.resolve(
  process.env.OPEN_PDF_STUDIO_PACKAGED_APP
    || path.join(projectDir, '..', 'target', 'aarch64-apple-darwin', 'release', 'bundle', 'macos', 'Open PDF Studio.app', 'Contents', 'MacOS', 'open-pdf-studio'),
);
const sourcePath = path.join(projectDir, 'output', 'pdf', 'open-pdf-studio-ocr-writer-proof.pdf');
const evidenceDir = path.join(projectDir, 'output', 'ocr-safe-save-packaged');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function terminateProcessTree(child, childState) {
  if (childState.exited) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  await Promise.race([waitForExit(child), new Promise((resolve) => setTimeout(resolve, 1500))]);
  if (!childState.exited) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
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

async function waitForMcp(endpoint, childState, logs) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (childState.exited) throw new Error(`packaged app exited before MCP startup\n${logs.join('')}`);
    try {
      const result = await rpc(endpoint, 1, 'initialize');
      if (result?._meta?.openPdfStudio?.webviewReady === true) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for packaged app MCP\n${logs.join('')}`);
}

function toolCaller(endpoint) {
  let id = 1;
  return async (name, arguments_ = {}) => {
    const result = await rpc(endpoint, ++id, 'tools/call', { name, arguments: arguments_ });
    const text = result?.content?.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error(`${name} returned no JSON text payload`);
    return JSON.parse(text);
  };
}

async function extractedPages(pdfPath) {
  const bytes = await readFile(pdfPath);
  const document = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const content = await (await document.getPage(pageNumber)).getTextContent();
      pages.push(content.items.map((item) => item.str).filter(Boolean));
    }
    return pages;
  } finally {
    await document.destroy();
  }
}

async function renderHashes(pdfPath, renderDir, label) {
  const prefix = path.join(renderDir, label);
  await execFileAsync(process.env.OPEN_PDF_STUDIO_PDFTOPPM || 'pdftoppm', [
    '-r', '144', '-png', pdfPath, prefix,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const names = (await readdir(renderDir))
    .filter((name) => name.startsWith(`${label}-`) && name.endsWith('.png'))
    .sort();
  assert.ok(names.length > 0, `Poppler rendered no pages for ${label}`);
  return Promise.all(names.map(async (name) => sha256(await readFile(path.join(renderDir, name)))));
}

async function privateCandidates(testDir) {
  return (await readdir(testDir)).filter((name) => name.includes('.open-pdf-studio-')
    && (name.endsWith('.candidate') || name.endsWith('.baseline')));
}

await Promise.all([access(appPath), access(sourcePath), mkdir(evidenceDir, { recursive: true })]);
const testDir = await mkdtemp(path.join(tmpdir(), 'opds-packaged-safe-save-'));
const renderDir = path.join(testDir, 'renders');
await mkdir(renderDir);
const sourceBaselinePath = path.join(testDir, 'source-baseline.pdf');
const inPlacePath = path.join(testDir, 'save-in-place.pdf');
const saveAsPath = path.join(testDir, 'save-as.pdf');
const readOnlyPath = path.join(testDir, 'read-only-save.pdf');
await Promise.all([
  copyFile(sourcePath, sourceBaselinePath),
  copyFile(sourcePath, inPlacePath),
  copyFile(sourcePath, readOnlyPath),
]);
await chmod(inPlacePath, 0o640);
await execFileAsync('/usr/bin/xattr', ['-w', 'com.openpdfstudio.safe-save-test', 'preserve-me', inPlacePath]);

const port = await availablePort();
const endpoint = `http://127.0.0.1:${port}/mcp`;
const child = spawn(appPath, ['--mcp-server', '--mcp-port', String(port)], {
  cwd: projectDir,
  env: { ...process.env, OPS_ENABLE_MCP: '1' },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childState = { exited: false };
const logs = [];
const capture = (chunk) => {
  logs.push(chunk.toString());
  while (logs.join('').length > 256 * 1024) logs.shift();
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.on('exit', () => { childState.exited = true; });

try {
  await waitForMcp(endpoint, childState, logs);
  const callTool = toolCaller(endpoint);
  const opened = await callTool('app_open_pdf', { path: inPlacePath });
  assert.equal(opened.ok, true, opened.error);
  const saved = await callTool('app_save_pdf');
  assert.equal(saved.ok, true, saved.error);
  assert.equal((await stat(inPlacePath)).mode & 0o777, 0o640, 'in-place save did not preserve permissions');
  const xattr = await execFileAsync('/usr/bin/xattr', ['-p', 'com.openpdfstudio.safe-save-test', inPlacePath]);
  assert.equal(xattr.stdout.trim(), 'preserve-me', 'in-place save did not preserve safe extended metadata');
  assert.deepEqual(await privateCandidates(testDir), [], 'in-place save left private candidates');

  const savedAs = await callTool('app_save_pdf', { path: saveAsPath });
  assert.equal(savedAs.ok, true, savedAs.error);
  assert.equal((await stat(saveAsPath)).mode & 0o777, 0o644, 'Save As did not use normal PDF permissions');
  assert.deepEqual(await privateCandidates(testDir), [], 'Save As left private candidates');
  const reopened = await callTool('app_open_pdf', { path: saveAsPath });
  assert.equal(reopened.ok, true, reopened.error);

  const openedReadOnly = await callTool('app_open_pdf', { path: readOnlyPath });
  assert.equal(openedReadOnly.ok, true, openedReadOnly.error);
  const unsavedMutation = await callTool('app_create_annotation', {
    type: 'box',
    page: 1,
    props: { x: 12, y: 12, width: 24, height: 18, lineWidth: 1 },
  });
  assert.equal(unsavedMutation.ok, true, unsavedMutation.error);
  const readOnlyBefore = sha256(await readFile(readOnlyPath));
  const testDirMode = (await stat(testDir)).mode & 0o777;
  let readOnlySave;
  // Atomic replacement is controlled by the destination directory, not the
  // existing file's mode: a 0444 file can still be replaced when its parent
  // is writable. Remove directory write permission as well so this exercises
  // a genuine candidate-creation/replace failure.
  await chmod(readOnlyPath, 0o444);
  await chmod(testDir, 0o555);
  try {
    readOnlySave = await callTool('app_save_pdf');
  } finally {
    await chmod(testDir, testDirMode);
    await chmod(readOnlyPath, 0o644);
  }
  assert.equal(readOnlySave.ok, false, 'read-only destination unexpectedly saved');
  assert.equal(sha256(await readFile(readOnlyPath)), readOnlyBefore, 'failed read-only save changed the original');
  assert.deepEqual(await privateCandidates(testDir), [], 'failed read-only save left private candidates');

  const [sourceText, inPlaceText, saveAsText] = await Promise.all([
    extractedPages(sourceBaselinePath),
    extractedPages(inPlacePath),
    extractedPages(saveAsPath),
  ]);
  assert.deepEqual(inPlaceText, sourceText, 'PDF.js extraction changed after packaged Save');
  assert.deepEqual(saveAsText, sourceText, 'PDF.js extraction changed after packaged Save As');
  const [sourcePixels, inPlacePixels, saveAsPixels] = await Promise.all([
    renderHashes(sourceBaselinePath, renderDir, 'source'),
    renderHashes(inPlacePath, renderDir, 'in-place'),
    renderHashes(saveAsPath, renderDir, 'save-as'),
  ]);
  assert.deepEqual(inPlacePixels, sourcePixels, 'visible pixels changed after packaged Save');
  assert.deepEqual(saveAsPixels, sourcePixels, 'visible pixels changed after packaged Save As');

  const result = {
    status: 'pass',
    appPath,
    testDir,
    saveInPlace: 'pass',
    saveAs: 'pass',
    readOnlyOriginalPreserved: 'pass',
    destinationDirectoryWriteProtected: 'pass',
    unsavedMutationBeforeFailure: 'pass',
    permissionsPreserved: 'pass',
    macosExtendedMetadataPreserved: 'pass',
    candidateCleanup: 'pass',
    pdfJsReopenExtraction: 'pass',
    popplerExactPixelComparisonAt144Dpi: 'pass',
    pagePixelSha256: sourcePixels,
  };
  await writeFile(path.join(evidenceDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (logs.length) error.message += `\nPackaged app output:\n${logs.join('')}`;
  throw error;
} finally {
  await terminateProcessTree(child, childState);
}
