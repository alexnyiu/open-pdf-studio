import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeFontSubstitutionSources,
  resolveAutomaticFontSubstitution,
} from './font-substitution-policy.js';

const fixedNow = () => new Date('2026-08-27T12:00:00.000Z');

test('automatic substitution normalizes duplicate source faces and selects a packaged family', () => {
  assert.deepEqual(
    normalizeFontSubstitutionSources(['Helvetica', 'Helvetica', 'Times-Roman']),
    ['Helvetica', 'Times-Roman'],
  );
  assert.deepEqual(resolveAutomaticFontSubstitution({
    sourceFonts: ['Helvetica'],
    now: fixedNow,
  }), {
    sourceFont: 'Helvetica',
    faceId: 'liberation-sans-regular',
    approved: true,
    approvedAt: '2026-08-27T12:00:00.000Z',
  });
});

test('automatic substitution preserves bold and italic face selection without approval state', () => {
  const substitution = resolveAutomaticFontSubstitution({
    sourceFonts: ['Helvetica-BoldOblique'],
    bold: true,
    italic: true,
    now: fixedNow,
  });
  assert.equal(substitution.faceId, 'liberation-sans-bold-italic');
  assert.equal(substitution.approved, true);
  assert.equal(Object.hasOwn(substitution, 'remember'), false);
  assert.equal(resolveAutomaticFontSubstitution({
    sourceFonts: ['Helvetica-BoldOblique'],
    now: fixedNow,
  }).faceId, 'liberation-sans-bold-italic');
});

test('automatic substitution uses the deterministic Unknown fallback', () => {
  const substitution = resolveAutomaticFontSubstitution({ sourceFonts: [], now: fixedNow });
  assert.equal(substitution.sourceFont, 'Unknown');
  assert.equal(substitution.faceId, 'liberation-sans-regular');
});

test('native, combined, annotation, and native find/replace entry points use automatic policy', async () => {
  const [nativeTool, annotationTool, findController, dialogHost] = await Promise.all([
    readFile(new URL('../tools/text-edit-tool.js', import.meta.url), 'utf8'),
    readFile(new URL('../tools/text-editing.js', import.meta.url), 'utf8'),
    readFile(new URL('../search/find-controller.js', import.meta.url), 'utf8'),
    readFile(new URL('../solid/components/DialogHost.jsx', import.meta.url), 'utf8'),
  ]);
  assert.ok((nativeTool.match(/resolveAutomaticFontSubstitution\(/gu) || []).length >= 2,
    'native paragraph and combined-selection entry points must use automatic substitution');
  assert.match(annotationTool, /resolveAutomaticFontSubstitution\(/u);
  assert.match(findController, /resolveAutomaticFontSubstitution\(/u);
  assert.doesNotMatch(dialogHost, /FontSubstitutionDialog|font-substitution/u);
  for (const source of [nativeTool, annotationTool, findController]) {
    assert.doesNotMatch(source, /requestFontSubstitutionApproval|fontSubstitutionApprovals/u);
  }
});
