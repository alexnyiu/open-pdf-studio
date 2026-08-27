import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPhaseACompatibilityNativeRequest } from './phase-a-compat.js';

const modelPack = JSON.parse(await readFile(
  new URL('../../public/ocr/pp-ocrv6-small/manifest.json', import.meta.url),
  'utf8',
));

test('native Phase A request captures the source file fingerprint from the parent boundary', async () => {
  const sourcePath = '/tmp/phase-a-source.pdf';
  const capturedFingerprint = {
    algorithm: 'sha256',
    value: 'a'.repeat(64),
  };
  const calls = [];

  const request = await createPhaseACompatibilityNativeRequest({
    source: {
      kind: 'pdf-page',
      path: sourcePath,
      pageIndex: 0,
      scale: 2,
    },
    modelPack,
    fingerprintDocument: async (path) => {
      calls.push(path);
      return capturedFingerprint;
    },
  });

  assert.deepEqual(calls, [sourcePath]);
  assert.deepEqual(request.document.fingerprint, capturedFingerprint);
  assert.notEqual(request.document.fingerprint, capturedFingerprint);
  assert.equal(JSON.stringify(request).includes(sourcePath), false);
});
