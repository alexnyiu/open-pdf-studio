import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  MAX_OCR_CORRECTION_CODE_UNITS,
  validateOcrCorrectionText,
} from '../js/ocr/document-state.js';
import {
  SCANNED_TEXT_EDIT_MAX_STATE_BYTES,
  validateScannedTextEditStateV1,
} from '../js/ocr/contracts/scanned-text-edit-state.v1.js';
import { OCR_CONTRACT_LIMITS } from '../js/ocr/contracts/validation.js';
import { validateOcrResultV2 } from '../js/ocr/contracts/v2.js';
import { OcrResultCache, createOcrCacheKey } from '../js/ocr/cache.js';
import { createScannedTextEditStateV1 } from '../js/ocr/editing/edit-state.js';
import {
  PADDLE_DB_POSTPROCESS,
  detectionMapToQuadrilaterals,
} from '../js/ocr/paddleocr/postprocess.js';
import { makeOcrFixture } from '../js/ocr/searchable-layer.test-fixtures.mjs';

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(
  projectDir, 'tests', 'fixtures', 'ocr', 'release-qualification-v1', 'corpus.v1.json',
), 'utf8'));
const requiredIds = [
  'extreme-declared-page-dimensions',
  'excessive-raster-pixel-count',
  'oversized-page-side',
  'excessive-declared-page-count',
  'malformed-xref',
  'truncated-pdf',
  'invalid-object-reference',
  'malformed-stream',
  'oversized-compressed-content',
  'high-decompression-expansion',
  'very-large-embedded-image',
  'excessive-detector-candidates',
  'dense-text-line-budget',
  'ocr-result-size-limit',
  'oversized-unicode-text',
  'excessive-correction-payload',
  'excessive-scanned-edit-payload',
  'repeated-malformed-pages',
  'ocr-child-timeout',
  'pathological-input-cancellation',
  'invalid-cache-result',
];
let generatedDir;

function entry(id) {
  const value = manifest.adversarialCases.find((candidate) => candidate.id === id);
  assert.ok(value, `missing adversarial manifest entry ${id}`);
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

before(async () => {
  generatedDir = await mkdtemp(path.join(tmpdir(), 'opds-ocr-adversarial-unit-'));
  await execFileAsync(process.execPath, [
    path.join(projectDir, 'scripts', 'generate-ocr-release-qualification-fixtures.mjs'),
    '--output-dir', generatedDir,
    '--mode', 'adversarial',
  ], { cwd: projectDir, maxBuffer: 4 * 1024 * 1024 });
});

after(async () => {
  await rm(generatedDir, { recursive: true, force: true });
});

test('bounded corpus declares every required case, resource ceiling, outcome, and cleanup contract', () => {
  assert.deepEqual(manifest.adversarialCases.map((value) => value.id), requiredIds);
  assert.equal(new Set(requiredIds).size, requiredIds.length);
  assert.equal(manifest.generatedArtifactsCommitted, false);
  assert.equal(manifest.license, 'CC0-1.0');
  for (const value of manifest.adversarialCases) {
    assert.ok(['rejected', 'failed-safely', 'unsupported', 'bounded-completion'].includes(value.expectedResult),
      `${value.id} has no bounded expected result`);
    assert.deepEqual(Object.keys(value.bounds).sort(),
      ['maxInputBytes', 'maxObjects', 'maxPages', 'maxPixels', 'timeoutMs'].sort());
    for (const bound of Object.values(value.bounds)) {
      assert.ok(Number.isSafeInteger(bound) && bound >= 0, `${value.id} has an invalid resource bound`);
    }
    assert.ok(value.bounds.timeoutMs > 0 && value.bounds.timeoutMs <= 120_000,
      `${value.id} timeout is not bounded`);
    assert.ok(Array.isArray(value.expectedCleanup) && value.expectedCleanup.length > 0,
      `${value.id} has no cleanup contract`);
  }
});

test('generated PDF fixtures stay within their byte and authored object-complexity bounds', async () => {
  for (const value of manifest.adversarialCases.filter((candidate) => candidate.file)) {
    const bytes = await readFile(path.join(generatedDir, value.file));
    assert.ok(bytes.byteLength <= value.bounds.maxInputBytes,
      `${value.id} exceeds maximum input bytes: ${bytes.byteLength}`);
    const visibleObjectHeaders = (bytes.toString('latin1').match(/\d+\s+\d+\s+obj\b/gu) || []).length;
    assert.ok(visibleObjectHeaders <= value.bounds.maxObjects,
      `${value.id} exceeds authored object complexity: ${visibleObjectHeaders}`);
  }
});

test('isolated PDF.js probes terminate under fixed heap/time ceilings without modifying originals', async (t) => {
  const cases = manifest.adversarialCases.filter((candidate) => candidate.kind === 'pdf-parser');
  for (const value of cases) {
    await t.test(value.id, async () => {
      const filePath = path.join(generatedDir, value.file);
      const beforeBytes = await readFile(filePath);
      const beforeHash = sha256(beforeBytes);
      let result;
      try {
        const completed = await execFileAsync(process.execPath, [
          '--max-old-space-size=256',
          path.join(projectDir, 'scripts', 'lib', 'ocr-adversarial-pdf-probe.mjs'),
          '--input', filePath,
          '--maximum-pages', String(value.bounds.maxPages),
          '--maximum-input-bytes', String(value.bounds.maxInputBytes),
        ], {
          cwd: projectDir,
          timeout: value.bounds.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 4 * 1024 * 1024,
        });
        result = JSON.parse(completed.stdout.trim().split('\n').at(-1));
      } catch (error) {
        assert.fail(`${value.id} probe exceeded its bound or crashed: ${error.message}`);
      }
      assert.equal(result.outcome, value.expectedResult,
        `${value.id} outcome differed from its measured expectation: ${JSON.stringify(result)}`);
      assert.ok(result.elapsedMs <= value.bounds.timeoutMs, `${value.id} exceeded its timeout`);
      assert.ok(result.finalRssBytes < 384 * 1024 * 1024, `${value.id} escaped the isolated memory ceiling`);
      assert.equal(sha256(await readFile(filePath)), beforeHash, `${value.id} modified its original PDF`);
    });
  }
});

test('detector candidate explosion is rejected at the 1000-line postprocess boundary', () => {
  const width = 165;
  const height = 155;
  const data = new Float32Array(width * height);
  for (let component = 0; component < 1_001; component += 1) {
    const left = (component % 33) * 5;
    const top = Math.floor(component / 33) * 5;
    for (let y = top; y < top + 4; y += 1) {
      for (let x = left; x < left + 4; x += 1) data[y * width + x] = 0.95;
    }
  }
  assert.throws(() => detectionMapToQuadrilaterals(
    { data, dims: [1, 1, height, width] },
    width,
    height,
  ), (error) => error?.code === 'OCR_PAGE_COMPLEXITY_LIMIT');
  assert.equal(PADDLE_DB_POSTPROCESS.maximumDetectorCandidates, 1_000);
});

test('dense lines, result bytes, and oversized Unicode are rejected before application or caching', () => {
  const fixture = makeOcrFixture({
    documentId: 'adversarial-result-document',
    documentGeneration: 'adversarial-result-generation',
    pageId: 'adversarial-result-page',
    pageRevision: 0,
  });

  const dense = structuredClone(fixture.result);
  dense.lines = new Array(OCR_CONTRACT_LIMITS.maxLinesPerPage + 1);
  dense.text = '';
  const denseValidation = validateOcrResultV2(dense);
  assert.equal(denseValidation.ok, false);
  assert.ok(denseValidation.issues.some((issue) => /lines exceeds 100000 items/u.test(issue)));

  const oversizedResult = structuredClone(fixture.result);
  oversizedResult.text = 'x'.repeat(OCR_CONTRACT_LIMITS.maxResultBytes);
  const resultValidation = validateOcrResultV2(oversizedResult);
  assert.equal(resultValidation.ok, false);
  assert.ok(resultValidation.issues.some((issue) => /serialized UTF-8 bytes/u.test(issue)));

  const oversizedUnicode = structuredClone(fixture.result);
  oversizedUnicode.text = 'x'.repeat(OCR_CONTRACT_LIMITS.maxTextCodeUnits + 1);
  oversizedUnicode.lines[0].text = oversizedUnicode.text;
  oversizedUnicode.lines = oversizedUnicode.lines.slice(0, 1);
  const unicodeValidation = validateOcrResultV2(oversizedUnicode);
  assert.equal(unicodeValidation.ok, false);
  assert.ok(unicodeValidation.issues.some((issue) => /text exceeds 4194304 UTF-16 code units/u.test(issue)));
});

test('excessive correction and scanned-edit payloads fail before document state changes', () => {
  const correction = validateOcrCorrectionText('x'.repeat(MAX_OCR_CORRECTION_CODE_UNITS + 1));
  assert.equal(correction.ok, false);
  assert.ok(correction.issues.some((issue) => /exceeds 16384 UTF-16 code units/u.test(issue)));

  const fixture = makeOcrFixture({
    documentId: 'adversarial-edit-document',
    documentGeneration: 'adversarial-edit-generation',
    pageId: 'adversarial-edit-page',
    pageRevision: 0,
  });
  const state = createScannedTextEditStateV1({
    document: fixture.result.document,
    stateId: 'adversarial-edit-state',
    instanceId: 'adversarial-edit-instance',
    createdAt: '2026-08-24T00:00:00.000Z',
  });
  state.stateId = 'x'.repeat(SCANNED_TEXT_EDIT_MAX_STATE_BYTES + 1);
  const validation = validateScannedTextEditStateV1(state);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some((issue) => /serialized UTF-8 bytes/u.test(issue)));
  assert.equal(SCANNED_TEXT_EDIT_MAX_STATE_BYTES, 64 * 1024 * 1024);
});

test('invalid cached OCR payload is invalidated and never returned for application', async () => {
  const fixture = makeOcrFixture({
    documentId: 'adversarial-cache-document',
    documentGeneration: 'adversarial-cache-generation',
    pageId: 'adversarial-cache-page',
    pageRevision: 0,
  });
  const key = createOcrCacheKey({
    documentFingerprint: fixture.result.document.fingerprint,
    pageIdentity: fixture.result.page.id,
    pageRevision: fixture.result.page.revision,
    modelPackIdentity: fixture.result.engine.modelPack,
    recognitionConfigurationHash: fixture.result.recognitionConfigurationHash,
  });
  const commands = [];
  const cache = new OcrResultCache({
    invokeCommand: async (command) => {
      commands.push(command);
      if (command === 'ocr_cache_get') return { status: 'hit', payload: '{"invalid":true}' };
      if (command === 'ocr_cache_invalidate_page') return { status: 'ok' };
      throw new Error(`unexpected cache command ${command}`);
    },
  });
  const result = await cache.get(key, { documentId: fixture.result.document.id });
  assert.deepEqual(result, { status: 'rejected', envelope: null, reason: 'corrupt' });
  assert.deepEqual(commands, ['ocr_cache_get', 'ocr_cache_invalidate_page']);
});

test('native timeout/cancellation/private-file coverage remains declared for the focused Rust gate', () => {
  assert.equal(entry('ocr-child-timeout').expectedResult, 'failed-safely');
  assert.ok(entry('ocr-child-timeout').expectedCleanup.includes('child-reaped'));
  assert.ok(entry('pathological-input-cancellation').expectedCleanup.includes('temporary-job-files-removed'));
  assert.ok(entry('invalid-cache-result').expectedCleanup.includes('invalid-entry-removed'));
});
