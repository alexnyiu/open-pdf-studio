import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  inspectExecutable,
  verifyExecutableTarget,
} from './verify-pdfium-sidecar.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');

function thinMachO(cpuType) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0xcffaedfe, 0);
  bytes.writeUInt32LE(cpuType, 4);
  return bytes;
}

function fatMachO(cpuTypes) {
  const bytes = Buffer.alloc(8 + cpuTypes.length * 20);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpuType, index) => bytes.writeUInt32BE(cpuType, 8 + index * 20));
  return bytes;
}

function elf(machine) {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

function pe(machine) {
  const bytes = Buffer.alloc(0x90);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'binary');
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

test('sidecar verifier recognizes all supported executable formats', () => {
  assert.deepEqual(inspectExecutable(thinMachO(0x0100000c)), {
    format: 'mach-o', architectures: ['arm64'],
  });
  assert.deepEqual(inspectExecutable(elf(62)), {
    format: 'elf', architectures: ['x86_64'],
  });
  assert.deepEqual(inspectExecutable(pe(0x8664)), {
    format: 'pe', architectures: ['x86_64'],
  });
});

test('sidecar verifier requires both slices for a universal macOS worker', () => {
  const universal = fatMachO([0x0100000c, 0x01000007]);
  assert.deepEqual(verifyExecutableTarget(universal, 'universal-apple-darwin'), {
    target: 'universal-apple-darwin',
    format: 'mach-o-fat',
    architectures: ['arm64', 'x86_64'],
  });
  assert.throws(
    () => verifyExecutableTarget(thinMachO(0x0100000c), 'universal-apple-darwin'),
    /expected arm64\+x86_64, found arm64/,
  );
});

test('sidecar verifier rejects a mislabeled target architecture', () => {
  assert.throws(
    () => verifyExecutableTarget(thinMachO(0x0100000c), 'x86_64-apple-darwin'),
    /architecture mismatch/,
  );
  assert.throws(
    () => verifyExecutableTarget(pe(0xaa64), 'x86_64-pc-windows-msvc'),
    /architecture mismatch/,
  );
});

test('desktop workflows validate staged sidecars before bundling', async () => {
  for (const workflowName of ['ci.yml', 'release.yml', 'nightly.yml']) {
    const workflow = await readFile(path.join(repoDir, '.github', 'workflows', workflowName), 'utf8');
    assert.match(workflow, /verify-pdfium-sidecar\.mjs x86_64-pc-windows-msvc/);
    assert.match(workflow, /verify-pdfium-sidecar\.mjs x86_64-unknown-linux-gnu/);
    assert.match(workflow, /verify-pdfium-sidecar\.mjs aarch64-apple-darwin/);
    assert.match(workflow, /verify-pdfium-sidecar\.mjs x86_64-apple-darwin/);
    assert.match(workflow, /verify-pdfium-sidecar\.mjs universal-apple-darwin/);
  }
});

test('cross-target builds never fall back to the host worker', async () => {
  const buildScript = await readFile(path.join(projectDir, 'src-tauri', 'build.rs'), 'utf8');
  assert.match(buildScript, /let host = std::env::var\("HOST"\)/);
  assert.match(buildScript, /if host == target/);
  assert.match(buildScript, /validate_binary_target/);
});
