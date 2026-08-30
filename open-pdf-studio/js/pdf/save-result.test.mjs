import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSaveResult,
  saveResultIsDurable,
  saveResultAllowsClose,
} from './save-result.js';

test('SaveResult preserves the complete immutable terminal contract', () => {
  const result = createSaveResult({
    status: 'saved-refresh-pending',
    documentId: 'doc-a',
    requestedRevision: 4,
    serializedRevision: 4,
    persistedRevision: 4,
    proxyRevision: 2,
    bytesPersisted: true,
    proxyAdopted: false,
    candidateBytes: 4096,
    warnings: [{ code: 'FULL_FSYNC_UNAVAILABLE', message: 'Used fsync fallback' }],
    recovery: { action: 'retry-refresh' },
  });

  assert.deepEqual(result, {
    status: 'saved-refresh-pending',
    documentId: 'doc-a',
    requestedRevision: 4,
    serializedRevision: 4,
    persistedRevision: 4,
    proxyRevision: 2,
    bytesPersisted: true,
    proxyAdopted: false,
    candidateBytes: 4096,
    warnings: [{ code: 'FULL_FSYNC_UNAVAILABLE', message: 'Used fsync fallback' }],
    recovery: { action: 'retry-refresh' },
    errorCode: null,
    errorMessage: null,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.warnings), true);
  assert.equal(Object.isFrozen(result.warnings[0]), true);
  assert.equal(saveResultIsDurable(result), true);
  assert.equal(saveResultAllowsClose(result, 4), true);
  assert.equal(saveResultAllowsClose(result, 5), false);
});

test('non-durable terminal results never authorize close', () => {
  for (const status of ['save-as-required', 'deferred', 'superseded', 'failed']) {
    const result = createSaveResult({
      status,
      documentId: 'doc-a',
      requestedRevision: 3,
      errorCode: status === 'failed' ? 'WRITE_FAILED' : null,
      errorMessage: status === 'failed' ? 'disk full' : null,
    });
    assert.equal(saveResultIsDurable(result), false, status);
    assert.equal(saveResultAllowsClose(result, 3), false, status);
  }
});

test('invalid and incomplete results fail closed', () => {
  assert.throws(() => createSaveResult({ status: 'saved', documentId: '', requestedRevision: 1 }));
  assert.throws(() => createSaveResult({ status: 'unknown', documentId: 'doc-a', requestedRevision: 1 }));
  assert.throws(() => createSaveResult({
    status: 'saved',
    documentId: 'doc-a',
    requestedRevision: 1,
    persistedRevision: 2,
  }));
});
