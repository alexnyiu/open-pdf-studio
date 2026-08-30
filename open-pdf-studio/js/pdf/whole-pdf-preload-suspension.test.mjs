import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireWholePdfPreloadSuspension,
  registerWholePdfPreloadSuspensionListener,
  wholePdfPreloadIsSuspended,
  wholePdfPreloadSuspensionSnapshotForTests,
} from './whole-pdf-preload-suspension.js';

test('preload suspensions coalesce owners and notify the loaded coordinator immediately', () => {
  const documentState = {};
  const notifications = [];
  const unregister = registerWholePdfPreloadSuspensionListener((doc, reason) => {
    notifications.push({ doc, reason });
  });
  const releaseOcr = acquireWholePdfPreloadSuspension(documentState, { reason: 'ocr-active' });
  const releaseSave = acquireWholePdfPreloadSuspension(documentState, { reason: 'save-active' });

  assert.equal(wholePdfPreloadIsSuspended(documentState), true);
  assert.deepEqual(wholePdfPreloadSuspensionSnapshotForTests(documentState), { owners: 2 });
  assert.deepEqual(notifications, [
    { doc: documentState, reason: 'ocr-active' },
    { doc: documentState, reason: 'save-active' },
  ]);

  assert.equal(releaseOcr(), true);
  assert.equal(releaseOcr(), false);
  assert.equal(wholePdfPreloadIsSuspended(documentState), true);
  assert.equal(releaseSave(), true);
  assert.equal(wholePdfPreloadIsSuspended(documentState), false);
  assert.deepEqual(wholePdfPreloadSuspensionSnapshotForTests(documentState), { owners: 0 });
  unregister();
});
