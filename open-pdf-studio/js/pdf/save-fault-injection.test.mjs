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

test('all four required save fault stages fail deterministically for the armed count', () => {
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
  const [saver, transition] = await Promise.all([
    readFile(new URL('./saver.js', import.meta.url), 'utf8'),
    readFile(new URL('./saved-document-transition.js', import.meta.url), 'utf8'),
  ]);
  assert.match(saver, /throwIfSaveFaultInjected\('serialization'\)/u);
  assert.match(saver, /throwIfSaveFaultInjected\('persistence'\)/u);
  assert.match(transition, /throwIfSaveFaultInjected\('proxy-install'\)/u);
  assert.match(transition, /throwIfSaveFaultInjected\('render-readiness'\)/u);
});
