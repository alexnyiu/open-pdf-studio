import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { afterEach } from 'node:test';

import {
  SAVE_FAULT_STAGES,
  clearSaveFaultInjectionsForTests,
  configureSaveFaultInjectionForTests,
  throwIfSaveFaultInjected,
} from './save-fault-injection.js';

afterEach(() => clearSaveFaultInjectionsForTests());

test('every editing, persistence, proxy, view, and warning fault stage is deterministic', () => {
  for (const stage of SAVE_FAULT_STAGES) {
    configureSaveFaultInjectionForTests(stage, { times: 2, message: `${stage} failed` });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => throwIfSaveFaultInjected(stage),
        (error) => error.stage === stage && error.message === `${stage} failed`,
      );
    }
    assert.equal(throwIfSaveFaultInjected(stage), false);
  }
});

test('fault injection is wired at serialization, persistence, proxy, and readiness boundaries', async () => {
  const [saver, transition, scheduler, overlay] = await Promise.all([
    readFile(new URL('./saver.js', import.meta.url), 'utf8'),
    readFile(new URL('./saved-document-transition.js', import.meta.url), 'utf8'),
    readFile(new URL('../text/native-layout-scheduler.js', import.meta.url), 'utf8'),
    readFile(new URL('../solid/components/PdfTextEditOverlay.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(saver, /throwIfSaveFaultInjected\('serialization'\)/u);
  assert.match(saver, /throwIfSaveFaultInjected\('persistence'\)/u);
  assert.match(transition, /throwIfSaveFaultInjected\('proxy-install'\)/u);
  assert.match(transition, /throwIfSaveFaultInjected\('render-readiness'\)/u);
  assert.match(saver, /throwIfSaveFaultInjected\('after-serialization-before-persistence'\)/u);
  assert.match(saver, /throwIfSaveFaultInjected\('after-persistence-before-proxy-adoption'\)/u);
  assert.match(transition, /throwIfSaveFaultInjected\('before-proxy-install'\)/u);
  assert.match(transition, /throwIfSaveFaultInjected\('before-required-page-recompute'\)/u);
  assert.match(transition, /throwIfSaveFaultInjected\('before-view-restore'\)/u);
  assert.match(scheduler, /throwIfSaveFaultInjected\('drop-latest-text-layout-result'\)/u);
  assert.match(overlay, /throwIfSaveFaultInjected\('before-final-text-layout-ack'\)/u);
});

test('the macOS hardening stages remain explicit and test-only', () => {
  assert.deepEqual(SAVE_FAULT_STAGES.slice(0, 12), [
    'after-owner-commit-before-publication',
    'before-visible-publication',
    'after-serialization-before-persistence',
    'after-persistence-before-proxy-adoption',
    'before-proxy-install',
    'after-proxy-install-before-view-restore',
    'before-view-restore',
    'before-required-page-recompute',
    'before-final-text-layout-ack',
    'drop-latest-text-layout-result',
    'metadata-copy-warning',
    'old-file-cleanup-warning',
  ]);
});
