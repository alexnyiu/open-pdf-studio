import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_EDITOR_ACCEPTANCE_CONTRACT,
  BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION,
  validateBrowserEditorAcceptanceManifest,
} from './browser-editor-acceptance-manifest.mjs';
import { REQUIRED_BROWSER_ACCEPTANCE_SUITES } from './ocr-release-hardening-policy.mjs';

const HEAD = '1234567890abcdef1234567890abcdef12345678';

function passingManifest() {
  return {
    contract: BROWSER_EDITOR_ACCEPTANCE_CONTRACT,
    schemaVersion: BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION,
    status: 'PASS',
    head: HEAD,
    startedAt: '2026-08-30T12:00:00.000Z',
    completedAt: '2026-08-30T12:01:00.000Z',
    suites: REQUIRED_BROWSER_ACCEPTANCE_SUITES.map((name) => ({
      name,
      command: `npm run ${name}`,
      code: 0,
      signal: null,
      status: 'PASS',
      startedAt: '2026-08-30T12:00:00.000Z',
      completedAt: '2026-08-30T12:00:10.000Z',
    })),
  };
}

test('browser evidence accepts only the exact complete manifest', () => {
  assert.deepEqual(validateBrowserEditorAcceptanceManifest(
    passingManifest(), { expectedHead: HEAD },
  ), []);
});

test('browser evidence rejects missing suites and stale HEAD', () => {
  const manifest = passingManifest();
  manifest.head = 'stale';
  manifest.suites.pop();
  const issues = validateBrowserEditorAcceptanceManifest(manifest, { expectedHead: HEAD });
  assert.match(issues.join(' '), /HEAD does not match/u);
  assert.match(issues.join(' '), /suite set is not exact|required.*missing/u);
});

test('browser evidence rejects malformed status and failed commands', () => {
  const manifest = passingManifest();
  manifest.status = 'success';
  manifest.suites[0].status = 'success';
  manifest.suites[0].code = 1;
  manifest.suites[1].command = 'npm test';
  const issues = validateBrowserEditorAcceptanceManifest(manifest, { expectedHead: HEAD });
  assert.match(issues.join(' '), /status is not PASS/u);
  assert.match(issues.join(' '), /did not pass/u);
  assert.match(issues.join(' '), /command is invalid/u);
});
