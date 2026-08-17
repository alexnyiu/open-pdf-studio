import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertCompatibleOcrModelPack } from '../js/ocr/contracts/model-pack.v1.js';
import { createPaddleOcrEngineDescriptor } from '../js/ocr/paddleocr/adapter.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUNTIME_ASSETS = [
  {
    file: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    bytes: 13479978,
    sha256: 'd1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6',
  },
  {
    file: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    bytes: 24180,
    sha256: '0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3',
  },
];

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function verifyRecord(root, record) {
  const file = path.join(root, record.file);
  const info = await stat(file);
  const digest = await sha256(file);
  if (info.size !== record.bytes) throw new Error(`${record.file}: expected ${record.bytes} bytes, got ${info.size}`);
  if (digest !== record.sha256) throw new Error(`${record.file}: expected SHA-256 ${record.sha256}, got ${digest}`);
  return { file: path.relative(projectDir, file), bytes: info.size, sha256: digest };
}

export async function verifyOcrAssets() {
  const modelRoot = path.join(projectDir, 'public', 'ocr', 'pp-ocrv6-small');
  const manifest = JSON.parse(await readFile(path.join(modelRoot, 'manifest.json'), 'utf8'));
  assertCompatibleOcrModelPack(manifest, createPaddleOcrEngineDescriptor(manifest), { platform: 'macos' });
  const models = [];
  for (const record of Object.values(manifest.assets)) models.push(await verifyRecord(modelRoot, record));
  const runtime = [];
  for (const record of RUNTIME_ASSETS) runtime.push(await verifyRecord(projectDir, record));

  const lock = JSON.parse(await readFile(path.join(projectDir, 'package-lock.json'), 'utf8'));
  const dependency = lock.packages?.['node_modules/onnxruntime-web'];
  if (dependency?.version !== '1.27.0' || dependency?.license !== 'MIT') {
    throw new Error('onnxruntime-web must remain pinned to 1.27.0 under MIT');
  }
  return {
    ok: true,
    model: `${manifest.modelFamily} ${manifest.modelTier}`,
    models,
    runtime,
    package: {
      name: 'onnxruntime-web',
      version: dependency.version,
      license: dependency.license,
      integrity: dependency.integrity,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyOcrAssets(), null, 2));
}
