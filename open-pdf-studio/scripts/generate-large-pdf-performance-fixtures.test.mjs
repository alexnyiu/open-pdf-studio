import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('large-PDF fixture generator emits the required deterministic corpus', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'opds-large-pdf-generator-test-'));
  await execFileAsync(process.execPath, [
    path.resolve('scripts/generate-large-pdf-performance-fixtures.mjs'),
    '--output-dir', output,
  ], { timeout: 120_000 });
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.fixtures.map(({ file, pageCount }) => ({ file, pageCount })), [
    { file: 'lightweight-500.pdf', pageCount: 500 },
    { file: 'image-heavy-100.pdf', pageCount: 100 },
    { file: 'variable-page-sizes-80.pdf', pageCount: 80 },
    { file: 'rotated-pages-40.pdf', pageCount: 40 },
    { file: 'small-text-sharpness-4.pdf', pageCount: 4 },
  ]);
  assert.equal(manifest.schemaVersion, 2);
  for (const fixture of manifest.fixtures) {
    assert.equal(fixture.sha256.length, 64);
    assert.equal((await stat(path.join(output, fixture.file))).size, fixture.bytes);
  }
});
