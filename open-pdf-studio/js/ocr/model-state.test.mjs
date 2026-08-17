import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  OPTIONAL_OCR_MODEL_PACKS,
  OcrModelPackState,
} from './model-state.js';

const approvedManifest = JSON.parse(await readFile(
  new URL('../../public/ocr/pp-ocrv6-small/manifest.json', import.meta.url),
  'utf8',
));

async function hash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifiedFixture() {
  const manifest = structuredClone(approvedManifest);
  const assets = new Map();
  let index = 0;
  for (const record of Object.values(manifest.assets)) {
    index += 1;
    const bytes = new TextEncoder().encode(`approved-model-asset-${index}`);
    record.bytes = bytes.byteLength;
    record.sha256 = await hash(bytes);
    assets.set(record.file, bytes);
  }
  return { manifest, assets };
}

test('approved bundled model pack publishes updating then installed after byte verification', async () => {
  const { manifest, assets } = await verifiedFixture();
  let releaseManifest;
  const manifestReady = new Promise((resolve) => { releaseManifest = resolve; });
  const observed = [];
  const state = new OcrModelPackState({
    loadManifest: async () => {
      await manifestReady;
      return structuredClone(manifest);
    },
    loadAsset: async (_base, record) => structuredClone(assets.get(record.file)),
    architecture: 'arm64',
    applicationVersion: '1.85.0',
  });
  state.subscribe((value) => observed.push(value.status));

  const refresh = state.refresh();
  assert.equal(state.getState().status, 'updating');
  releaseManifest();
  const installed = await refresh;

  assert.equal(installed.status, 'installed');
  assert.deepEqual(observed, ['updating', 'installed']);
  assert.deepEqual(installed.supportedLanguages, manifest.recognitionSupport.languages);
  assert.deepEqual(installed.supportedScripts, manifest.recognitionSupport.scripts);
  assert.deepEqual(installed.languageChoices, []);
  assert.equal(installed.optionalDownloads.enabled, false);
  assert.equal(installed.identity.packId, manifest.packId);
});

test('model state distinguishes missing, incompatible, and corrupt packs', async () => {
  const { manifest, assets } = await verifiedFixture();
  const missing = new OcrModelPackState({
    loadManifest: async () => { throw Object.assign(new Error('not found'), { kind: 'missing' }); },
  });
  const incompatible = new OcrModelPackState({
    loadManifest: async () => structuredClone(manifest),
    loadAsset: async (_base, record) => structuredClone(assets.get(record.file)),
    applicationVersion: '1.84.0',
  });
  const corrupt = new OcrModelPackState({
    loadManifest: async () => structuredClone(manifest),
    loadAsset: async () => new Uint8Array([0]),
    applicationVersion: '1.85.0',
  });

  assert.equal((await missing.refresh()).status, 'missing');
  assert.equal((await incompatible.refresh()).status, 'incompatible');
  assert.equal((await corrupt.refresh()).status, 'corrupt');
  assert.equal((await missing.getState()).languageChoices.length, 0);
});

test('optional model downloads have no installer path in this phase', async () => {
  const state = new OcrModelPackState();

  assert.deepEqual(OPTIONAL_OCR_MODEL_PACKS, {
    enabled: false,
    reason: 'signed-manifest-installer-not-implemented',
  });
  await assert.rejects(
    state.installOptionalPack(),
    (error) => error.code === 'OCR_OPTIONAL_MODEL_INSTALL_DISABLED' && error.retryable === false,
  );
});
