import assert from 'node:assert/strict';
import test from 'node:test';

import { MacosSafeSaveError, nativeError } from './macos-safe-save.js';

test('native coordinated errors preserve provider kind, retryability, and recovery action', () => {
  const error = nativeError(
    'OPDS_SAFE_SAVE|FILE_PROVIDER_BUSY|Dropbox is temporarily busy|file-provider|true|retry-save',
  );
  assert.ok(error instanceof MacosSafeSaveError);
  assert.equal(error.code, 'FILE_PROVIDER_BUSY');
  assert.equal(error.message, 'Dropbox is temporarily busy');
  assert.equal(error.providerKind, 'file-provider');
  assert.equal(error.retryable, true);
  assert.equal(error.recoveryAction, 'retry-save');
  assert.deepEqual(error.recovery, {
    providerKind: 'file-provider',
    retryable: true,
    recoveryAction: 'retry-save',
  });
});

test('legacy safe-save errors gain conservative typed recovery without changing their code', () => {
  const error = nativeError(
    'OPDS_SAFE_SAVE|ICLOUD_PROVIDER_BUSY|iCloud is busy',
  );
  assert.equal(error.code, 'ICLOUD_PROVIDER_BUSY');
  assert.equal(error.providerKind, 'icloud');
  assert.equal(error.retryable, true);
  assert.equal(error.recoveryAction, 'retry-save');
});

test('destination changes are terminal and never normalized into a retryable provider error', () => {
  const error = nativeError(
    'OPDS_SAFE_SAVE|DESTINATION_CHANGED|The file changed|icloud|false|review-provider-conflict',
  );
  assert.equal(error.code, 'DESTINATION_CHANGED');
  assert.equal(error.retryable, false);
  assert.equal(error.recoveryAction, 'review-provider-conflict');
});
