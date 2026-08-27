import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureFontSubstitutionApprovalMap,
  fontSubstitutionApprovalKey,
  normalizeFontSubstitutionSources,
} from './font-substitution-approval-state.js';

test('font approval keys are deterministic across source-font ordering', () => {
  const left = fontSubstitutionApprovalKey({
    sourceFonts: ['Helvetica Neue', 'Times New Roman', 'Helvetica Neue'],
    faceId: 'liberation-sans-regular',
  });
  const right = fontSubstitutionApprovalKey({
    sourceFonts: ['Times New Roman', 'Helvetica Neue'],
    faceId: 'liberation-sans-regular',
  });
  assert.equal(left, right);
  assert.notEqual(left, fontSubstitutionApprovalKey({
    sourceFonts: ['Times New Roman', 'Helvetica Neue'],
    faceId: 'liberation-sans-bold',
  }));
});

test('font approval state remains runtime-only on its owning document', () => {
  const first = {};
  const second = {};
  const key = fontSubstitutionApprovalKey({
    sourceFonts: normalizeFontSubstitutionSources([]),
    faceId: 'liberation-sans-regular',
  });
  ensureFontSubstitutionApprovalMap(first).set(key, true);
  assert.equal(ensureFontSubstitutionApprovalMap(first).get(key), true);
  assert.equal(ensureFontSubstitutionApprovalMap(second).has(key), false);
  assert.deepEqual(Object.keys(first), ['fontSubstitutionApprovals']);
});
