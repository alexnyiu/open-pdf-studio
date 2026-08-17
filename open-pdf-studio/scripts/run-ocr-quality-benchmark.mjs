import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ort from 'onnxruntime-web/wasm';
import sharp from 'sharp';

import { modelPackIdentity } from '../js/ocr/contracts/model-pack.v1.js';
import { OCR_CONTRACT_LIMITS } from '../js/ocr/contracts/validation.js';
import {
  PaddleOcrV6SmallAdapter,
  createPaddleOcrEngineDescriptor,
} from '../js/ocr/paddleocr/adapter.js';
import {
  aggregateOcrMetrics,
  evaluateOcrAcceptance,
  measureOcrFixture,
  polygonArea,
} from './ocr-quality-metrics.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCorpusDir = path.join(projectDir, 'tests', 'fixtures', 'ocr', 'quality-v1');
const defaultOutputDir = path.join(projectDir, 'docs', 'ocr', 'quality-benchmark');
const defaultPolicyPath = path.join(defaultOutputDir, 'thresholds.v1.json');
const defaultComparisonPath = path.join(defaultOutputDir, 'baseline.macos.v1.json');
const modelDir = path.join(projectDir, 'public', 'ocr', 'pp-ocrv6-small');
const manifestPath = path.join(modelDir, 'manifest.json');
const wasmDistDir = path.join(projectDir, 'node_modules', 'onnxruntime-web', 'dist');
const MAX_CORPUS_BYTES = 2 * 1024 * 1024;
const MAX_FIXTURE_PIXELS = 4_000_000;
const MAX_FIXTURE_BYTES = 16 * 1024 * 1024;
const FIXED_JOB_TIME = '2026-08-16T00:00:00.000Z';

const REQUIRED_CATEGORIES = new Set([
  'clean-300-dpi-latin',
  'lower-resolution-text',
  'low-contrast',
  'mild-skew',
  'page-rotation-90',
  'page-rotation-180',
  'page-rotation-270',
  'mixed-image-native-text',
  'multiple-columns',
  'forms-and-numeric-content',
  'punctuation-and-supported-unicode',
  'dense-more-than-64-lines',
  'blank-page',
  'no-text-image',
  'table-layout',
  'unsupported-script',
  'malformed-input',
  'resource-limit-enforcement',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fingerprint(value) {
  return { algorithm: 'sha256', value };
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertSafeRelativeFile(value, label) {
  if (typeof value !== 'string' || value.length === 0 || path.basename(value) !== value) {
    throw new TypeError(`${label} must be a plain relative filename`);
  }
}

function assertFinitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive`);
}

function validateExpectedLines(fixture) {
  if (!Array.isArray(fixture.expected?.lines)) {
    throw new TypeError(`${fixture.id}.expected.lines must be an array`);
  }
  const identifiers = new Set();
  for (const [index, line] of fixture.expected.lines.entries()) {
    assertPlainObject(line, `${fixture.id}.expected.lines[${index}]`);
    if (typeof line.id !== 'string' || identifiers.has(line.id)) {
      throw new TypeError(`${fixture.id} expected line identifiers must be unique strings`);
    }
    identifiers.add(line.id);
    if (typeof line.text !== 'string' || line.text.length === 0) {
      throw new TypeError(`${fixture.id}.${line.id}.text must be non-empty`);
    }
    if (line.polygon?.coordinateSpace !== 'source-raster-pixels' ||
        !Array.isArray(line.polygon.points) || line.polygon.points.length !== 4 ||
        line.polygon.points.some((point) => !Array.isArray(point) || point.length !== 2 ||
          point.some((coordinate) => !Number.isFinite(coordinate))) ||
        polygonArea(line.polygon.points) <= 0) {
      throw new TypeError(`${fixture.id}.${line.id}.polygon must be a non-zero source-raster quadrilateral`);
    }
  }
  if (!Array.isArray(fixture.expected.readingOrder) ||
      JSON.stringify(fixture.expected.readingOrder) !== JSON.stringify([...identifiers])) {
    throw new TypeError(`${fixture.id}.expected.readingOrder must list every line exactly once`);
  }
  if (fixture.expected.text !== fixture.expected.lines.map((line) => line.text).join('\n')) {
    throw new TypeError(`${fixture.id}.expected.text must match its ordered line text`);
  }
}

export function validateOcrQualityCorpus(corpus, serializedBytes = encodedBytes(corpus)) {
  assertPlainObject(corpus, 'OCR quality corpus');
  if (serializedBytes > MAX_CORPUS_BYTES) throw new RangeError('OCR quality corpus metadata is oversized');
  if (corpus.contract !== 'open-pdf-studio.ocr.quality-corpus' || corpus.schemaVersion !== 1) {
    throw new TypeError('OCR quality corpus contract is incompatible');
  }
  if (corpus.corpusId !== 'macos-searchable-ocr-v1' ||
      !Array.isArray(corpus.platformScope) || !corpus.platformScope.includes('macos')) {
    throw new TypeError('OCR quality corpus platform scope is incompatible');
  }
  if (corpus.geometrySpace?.id !== 'source-raster-pixels' ||
      corpus.geometrySpace?.origin !== 'top-left-pixel-edge') {
    throw new TypeError('OCR quality corpus geometry space is incompatible');
  }
  if (!Array.isArray(corpus.fixtures) || corpus.fixtures.length === 0) {
    throw new TypeError('OCR quality corpus fixtures must be non-empty');
  }
  const fixtureIds = new Set();
  const categories = new Set();
  for (const fixture of corpus.fixtures) {
    assertPlainObject(fixture, 'OCR quality fixture');
    if (typeof fixture.id !== 'string' || fixtureIds.has(fixture.id)) {
      throw new TypeError('OCR quality fixture identifiers must be unique strings');
    }
    fixtureIds.add(fixture.id);
    if (!REQUIRED_CATEGORIES.has(fixture.category) || categories.has(fixture.category)) {
      throw new TypeError(`${fixture.id} has a missing, unknown, or duplicate category`);
    }
    categories.add(fixture.category);
    if (!['supported', 'unsupported', 'rejected'].includes(fixture.classification)) {
      throw new TypeError(`${fixture.id}.classification is invalid`);
    }
    if (fixture.classification === 'rejected') {
      if (!['malformed-rgba', 'resource-heavy-job'].includes(fixture.input?.kind) ||
          fixture.expected?.disposition !== 'rejected') {
        throw new TypeError(`${fixture.id} has an invalid rejected-input definition`);
      }
      validateExpectedLines(fixture);
      continue;
    }
    assertSafeRelativeFile(fixture.input?.file, `${fixture.id}.input.file`);
    if (fixture.input.kind !== 'rgba-page-raster') {
      throw new TypeError(`${fixture.id}.input.kind must be rgba-page-raster`);
    }
    for (const [key, value] of [
      ['widthPx', fixture.input.widthPx],
      ['heightPx', fixture.input.heightPx],
      ['dpi', fixture.input.dpi],
      ['bytes', fixture.input.bytes],
    ]) assertFinitePositive(value, `${fixture.id}.input.${key}`);
    if (!Number.isSafeInteger(fixture.input.widthPx) || !Number.isSafeInteger(fixture.input.heightPx) ||
        fixture.input.widthPx * fixture.input.heightPx > MAX_FIXTURE_PIXELS ||
        fixture.input.bytes > MAX_FIXTURE_BYTES || !/^[a-f0-9]{64}$/.test(fixture.input.sha256)) {
      throw new RangeError(`${fixture.id} exceeds fixture size limits or has an invalid digest`);
    }
    const expectedDisposition = fixture.classification === 'supported' ? 'completed' : 'unsupported';
    if (fixture.expected?.disposition !== expectedDisposition) {
      throw new TypeError(`${fixture.id}.expected.disposition contradicts its classification`);
    }
    validateExpectedLines(fixture);
  }
  if (categories.size !== REQUIRED_CATEGORIES.size ||
      [...REQUIRED_CATEGORIES].some((category) => !categories.has(category))) {
    throw new TypeError('OCR quality corpus does not cover every required category');
  }
  const dense = corpus.fixtures.find((fixture) => fixture.category === 'dense-more-than-64-lines');
  if (dense.expected.lines.length <= 64) throw new TypeError('Dense OCR fixture must contain more than 64 lines');
  return corpus;
}

async function assertDocumentedLicense(corpusDir, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new TypeError(`${label} is missing`);
  }
  const resolved = path.resolve(corpusDir, relativePath);
  const root = `${projectDir}${path.sep}`;
  if (!resolved.startsWith(root)) throw new TypeError(`${label} escapes the project`);
  const bytes = await readFile(resolved);
  if (bytes.byteLength === 0) throw new TypeError(`${label} is empty`);
}

async function readAndVerifyCorpus(corpusDir) {
  const manifestFile = path.join(corpusDir, 'corpus.v1.json');
  const bytes = await readFile(manifestFile);
  const corpus = validateOcrQualityCorpus(JSON.parse(bytes.toString('utf8')), bytes.byteLength);
  await Promise.all([
    assertDocumentedLicense(corpusDir, corpus.license?.fixtureLicenseFile, 'fixture license'),
    assertDocumentedLicense(corpusDir, corpus.license?.renderingFontLicenseFile, 'font license'),
    readFile(path.join(corpusDir, 'README.md')),
    readFile(path.join(corpusDir, 'PROVENANCE.md')),
    readFile(path.join(corpusDir, 'LICENSES.md')),
  ]);
  return { corpus, manifestSha256: sha256(bytes) };
}

async function readFixtureImage(corpusDir, fixture) {
  const fixturePath = path.join(corpusDir, fixture.input.file);
  const [metadata, fileInfo, resolvedPath, corpusPath, bytes] = await Promise.all([
    sharp(fixturePath).metadata(),
    lstat(fixturePath),
    realpath(fixturePath),
    realpath(corpusDir),
    readFile(fixturePath),
  ]);
  if (fileInfo.isSymbolicLink() || path.dirname(resolvedPath) !== corpusPath) {
    throw new TypeError(`${fixture.id} must be a regular file inside the corpus directory`);
  }
  if (!fileInfo.isFile() || bytes.byteLength !== fixture.input.bytes || sha256(bytes) !== fixture.input.sha256) {
    throw new TypeError(`${fixture.id} does not match its recorded size and digest`);
  }
  if (metadata.format !== 'png' || metadata.width !== fixture.input.widthPx ||
      metadata.height !== fixture.input.heightPx || metadata.density !== fixture.input.dpi) {
    throw new TypeError(`${fixture.id} image metadata does not match the corpus`);
  }
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== fixture.input.widthPx || decoded.info.height !== fixture.input.heightPx ||
      decoded.info.channels !== 4) {
    throw new TypeError(`${fixture.id} did not decode to the declared RGBA raster`);
  }
  return {
    width: decoded.info.width,
    height: decoded.info.height,
    rgba: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
  };
}

function configureNodeWasmRuntime() {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    wasm: pathToFileURL(path.join(wasmDistDir, 'ort-wasm-simd-threaded.wasm')).href,
    mjs: pathToFileURL(path.join(wasmDistDir, 'ort-wasm-simd-threaded.mjs')).href,
  };
}

async function loadFileBinary(input) {
  const bytes = await readFile(fileURLToPath(input));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function createBenchmarkJob(fixture, image, manifest, overrides = null) {
  const rasterDigest = sha256(image.rgba);
  const documentDigest = sha256(`ocr-quality:${fixture.id}`);
  const packIdentity = modelPackIdentity(manifest);
  const configurationDigest = sha256(JSON.stringify({
    pack: packIdentity,
    dpi: fixture.input.dpi,
    languagePolicy: 'automatic',
    includeWords: false,
    orientation: 'none',
    deskew: false,
    preprocessing: 'none',
  }));
  const job = {
    contract: 'open-pdf-studio.ocr.job',
    schemaVersion: 1,
    jobId: `quality-${fixture.id}`,
    requestId: `quality-request-${fixture.id}`,
    engineId: manifest.engineCompatibility.engineId,
    modelPack: packIdentity,
    document: {
      id: `quality-document-${documentDigest.slice(0, 24)}`,
      fingerprint: fingerprint(documentDigest),
      revision: 0,
      generation: `quality-generation-${documentDigest.slice(0, 24)}`,
      pageCount: 1,
    },
    page: {
      id: `quality-page-${fixture.id}`,
      index: 0,
      revision: 0,
      sourceRaster: {
        id: `quality-raster-${rasterDigest.slice(0, 24)}`,
        fingerprint: fingerprint(rasterDigest),
        coordinateSpace: 'source-raster-pixels',
        widthPx: image.width,
        heightPx: image.height,
        dpi: fixture.input.dpi,
      },
    },
    recognitionConfigurationHash: fingerprint(configurationDigest),
    recognitionOptions: {
      languagePolicy: { mode: 'automatic', languages: [], scripts: [] },
      includeWords: false,
      orientation: { mode: 'none', degrees: null },
      deskew: false,
      preprocessing: { mode: 'none', operations: [] },
      rasterDpi: fixture.input.dpi,
      maximumPixels: image.width * image.height,
      maximumSide: Math.max(image.width, image.height),
      timeoutMs: 30_000,
    },
    documentPolicy: {
      skipMeaningfulExistingText: false,
      forceRerun: true,
      replaceApplicationOwnedOcrOnly: true,
      keepCompletedPages: true,
    },
    scheduler: { priority: 'background', execution: 'one-page-child' },
    createdAt: FIXED_JOB_TIME,
  };
  if (overrides) overrides(job);
  return job;
}

function failedMeasurement(fixture, error, resultBytes = 0) {
  const result = {
    page: { status: 'failed' },
    text: '',
    lines: [],
    unsupportedContentReasons: [],
  };
  return {
    result: null,
    metrics: measureOcrFixture(fixture, result, resultBytes),
    error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) },
  };
}

function accuracyResult(result) {
  const clone = structuredClone(result);
  delete clone.metrics;
  return clone;
}

function canonicalResultBytes(result) {
  const clone = structuredClone(result);
  for (const key of Object.keys(clone.metrics)) clone.metrics[key] = 0;
  return encodedBytes(clone);
}

async function runRasterFixture({ corpusDir, fixture, manifest, assetBaseUrl }) {
  const decodeStarted = performance.now();
  const image = await readFixtureImage(corpusDir, fixture);
  const decodeMs = round(performance.now() - decodeStarted);
  const job = await createBenchmarkJob(fixture, image, manifest);
  const adapter = new PaddleOcrV6SmallAdapter({
    ort,
    manifest,
    assetBaseUrl,
    loadBinary: loadFileBinary,
  });
  const started = performance.now();
  let outcome;
  let engineMetrics = null;
  try {
    const result = await adapter.recognize({ job, image, workerStartupMs: 0, rasterMs: 0 });
    const serializedProductionResultBytes = encodedBytes(result);
    if (serializedProductionResultBytes > OCR_CONTRACT_LIMITS.maxResultBytes) {
      throw new RangeError(`${fixture.id} result exceeds the production result limit`);
    }
    const resultBytes = canonicalResultBytes(result);
    engineMetrics = structuredClone(result.metrics);
    outcome = {
      result: accuracyResult(result),
      metrics: measureOcrFixture(fixture, result, resultBytes),
      error: null,
    };
  } catch (error) {
    outcome = failedMeasurement(fixture, error);
  } finally {
    try {
      await adapter.dispose();
    } catch (error) {
      outcome.error ??= { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
      outcome.metrics.dispositionCorrect = false;
    }
  }
  return {
    ...outcome,
    timing: {
      fixtureId: fixture.id,
      imageDecodeMs: decodeMs,
      pageRecognitionWallMs: round(performance.now() - started),
      serializedProductionResultBytes: outcome.result ? encodedBytes({
        ...outcome.result,
        metrics: engineMetrics,
      }) : 0,
      engine: engineMetrics,
    },
  };
}

function rejectedMetrics(fixture, dispositionCorrect, resultBytes = 0) {
  return {
    fixtureId: fixture.id,
    category: fixture.category,
    classification: fixture.classification,
    expectedDisposition: 'rejected',
    observedDisposition: dispositionCorrect ? 'rejected' : 'accepted-or-wrong-error',
    expectedCharacters: 0,
    actualCharacters: 0,
    characterEdits: 0,
    characterErrorRate: 0,
    expectedWords: 0,
    actualWords: 0,
    wordEdits: 0,
    wordErrorRate: 0,
    readingOrderError: 0,
    lineDetectionPrecision: 1,
    lineDetectionRecall: 1,
    meanPolygonIntersectionOverUnion: 1,
    meanPolygonCoverage: 1,
    missedLineCount: 0,
    duplicateLineCount: 0,
    expectedLineCount: 0,
    actualLineCount: 0,
    resultBytes,
    dispositionCorrect,
    matchedLines: [],
  };
}

async function runRejectedFixture({ fixture, manifest, assetBaseUrl }) {
  const width = fixture.input.kind === 'malformed-rgba' ? fixture.input.width : 128;
  const height = fixture.input.kind === 'malformed-rgba' ? fixture.input.height : 64;
  const fullRgba = new Uint8Array(width * height * 4).fill(255);
  const jobFixture = { ...fixture, input: { ...fixture.input, dpi: 300 } };
  const job = await createBenchmarkJob(jobFixture, { width, height, rgba: fullRgba }, manifest,
    fixture.input.kind === 'resource-heavy-job'
      ? (value) => {
        value.page.sourceRaster.widthPx = fixture.input.width;
        value.page.sourceRaster.heightPx = fixture.input.height;
        value.recognitionOptions.maximumPixels = fixture.input.maximumPixels;
        value.recognitionOptions.maximumSide = fixture.input.maximumSide;
      }
      : null);
  const image = {
    width,
    height,
    rgba: fixture.input.kind === 'malformed-rgba' ? fullRgba.subarray(0, fullRgba.length - 1) : fullRgba,
  };
  const adapter = new PaddleOcrV6SmallAdapter({
    ort,
    manifest,
    assetBaseUrl,
    loadBinary: loadFileBinary,
  });
  const started = performance.now();
  let caught = null;
  let unexpectedlyReturned = null;
  try {
    unexpectedlyReturned = await adapter.recognize({ job, image });
  } catch (error) {
    caught = error;
  } finally {
    await adapter.dispose();
  }
  const resultBytes = unexpectedlyReturned ? encodedBytes(unexpectedlyReturned) : 0;
  const dispositionCorrect = Boolean(caught?.message?.includes(fixture.input.expectedError));
  return {
    result: unexpectedlyReturned ? accuracyResult(unexpectedlyReturned) : null,
    metrics: rejectedMetrics(fixture, dispositionCorrect, resultBytes),
    error: caught ? { name: caught.name, message: caught.message } : null,
    timing: {
      fixtureId: fixture.id,
      imageDecodeMs: 0,
      pageRecognitionWallMs: round(performance.now() - started),
      serializedProductionResultBytes: resultBytes,
      engine: null,
    },
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function timingSummary(records) {
  const recognition = records
    .filter((record) => record.engine !== null)
    .map((record) => record.pageRecognitionWallMs);
  const engine = records
    .map((record) => record.engine?.totalOcrMs)
    .filter(Number.isFinite);
  return {
    measuredRecognitionPages: recognition.length,
    recognitionWallMs: {
      median: round(percentile(recognition, 0.5)),
      p95: round(percentile(recognition, 0.95)),
      maximum: round(Math.max(0, ...recognition)),
      total: round(recognition.reduce((sum, value) => sum + value, 0)),
    },
    engineTotalOcrMs: {
      median: round(percentile(engine, 0.5)),
      p95: round(percentile(engine, 0.95)),
      maximum: round(Math.max(0, ...engine)),
    },
    peakSerializedProductionResultBytes: records.reduce(
      (maximum, record) => Math.max(maximum, record.serializedProductionResultBytes),
      0,
    ),
  };
}

function parseArguments(argv) {
  const options = {
    corpusDir: defaultCorpusDir,
    outputDir: defaultOutputDir,
    policyPath: defaultPolicyPath,
    comparisonPath: defaultComparisonPath,
    enforceProposed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--enforce-proposed') {
      options.enforceProposed = true;
      continue;
    }
    const key = {
      '--corpus-dir': 'corpusDir',
      '--output-dir': 'outputDir',
      '--policy': 'policyPath',
      '--comparison-baseline': 'comparisonPath',
    }[argument];
    if (!key || !argv[index + 1]) throw new TypeError(`Unknown or incomplete benchmark argument: ${argument}`);
    options[key] = path.resolve(argv[index + 1]);
    index += 1;
  }
  return options;
}

export function shouldFailOcrQualityGate(acceptance, { enforceProposed = false } = {}) {
  return !acceptance.passesThresholds &&
    (acceptance.approvalStatus === 'approved' || enforceProposed);
}

function formatRate(value) {
  return Number.isFinite(value) ? `${round(value * 100, 1).toFixed(1)}%` : 'n/a';
}

function formatCount(value) {
  return Number.isFinite(value) ? String(value) : 'n/a';
}

function formatDelta(value, { rate = false } = {}) {
  if (!Number.isFinite(value)) return 'n/a';
  const rendered = rate ? `${Math.abs(value * 100).toFixed(1)} pp` : String(Math.abs(round(value, 4)));
  return `${value > 0 ? '+' : value < 0 ? '−' : '±'}${rendered}`;
}

const DELTA_METRICS = Object.freeze([
  'characterErrorRate',
  'wordErrorRate',
  'readingOrderError',
  'lineDetectionPrecision',
  'lineDetectionRecall',
  'meanPolygonIntersectionOverUnion',
  'meanPolygonCoverage',
  'missedLineCount',
  'duplicateLineCount',
  'unsupportedPageAccuracy',
  'rejectedInputAccuracy',
  'peakResultBytes',
]);

function metricDelta(previous, current) {
  const values = {};
  for (const key of DELTA_METRICS) {
    if (Number.isFinite(previous?.[key]) && Number.isFinite(current?.[key])) {
      values[key] = {
        previous: previous[key],
        current: current[key],
        delta: current[key] - previous[key],
      };
    }
  }
  return values;
}

function createBenchmarkDelta(previous, current) {
  const previousCases = new Map(previous.accuracy.cases.map((item) => [item.category, item]));
  const previousDecisions = new Map(previous.acceptance.categories.map((item) => [item.category, item]));
  const currentDecisions = new Map(current.acceptance.categories.map((item) => [item.category, item]));
  const body = {
    fromBaselineId: previous.baselineId,
    toBaselineId: current.baselineId,
    aggregate: metricDelta(previous.accuracy.aggregate, current.accuracy.aggregate),
    categories: current.accuracy.cases.map((item) => {
      const prior = previousCases.get(item.category);
      return {
        category: item.category,
        classification: item.classification,
        previousStatus: previousDecisions.get(item.category)?.status ?? null,
        currentStatus: currentDecisions.get(item.category)?.status ?? null,
        previousDisposition: prior?.metrics?.observedDisposition ?? null,
        currentDisposition: item.metrics.observedDisposition,
        metrics: metricDelta(prior?.metrics, item.metrics),
      };
    }),
  };
  return {
    contract: 'open-pdf-studio.ocr.quality-delta',
    schemaVersion: 1,
    deltaId: `macos-ocr-quality-delta-${sha256(JSON.stringify(body)).slice(0, 24)}`,
    ...body,
  };
}

function markdownReport(baseline, timing, corpus, delta) {
  const aggregate = baseline.accuracy.aggregate;
  const decisions = baseline.acceptance.categories;
  const decisionByFixture = new Map(decisions.map((decision) => [decision.fixtureId, decision]));
  const rows = baseline.accuracy.cases.map((record) => {
    const metrics = record.metrics;
    const status = decisionByFixture.get(record.fixtureId)?.status ?? 'FAIL';
    return `| ${record.category} | ${status} | ${formatRate(metrics.characterErrorRate)} | ${formatRate(metrics.wordErrorRate)} | ${formatRate(metrics.readingOrderError)} | ${formatRate(metrics.lineDetectionPrecision)} / ${formatRate(metrics.lineDetectionRecall)} | ${formatRate(metrics.meanPolygonIntersectionOverUnion)} / ${formatRate(metrics.meanPolygonCoverage)} | ${metrics.missedLineCount} / ${metrics.duplicateLineCount} | ${metrics.observedDisposition} |`;
  });
  const failures = [
    ...baseline.acceptance.aggregateFailures,
    ...decisions.flatMap((decision) => decision.failures.map((failure) => `${decision.category}: ${failure}`)),
  ];
  const timingInfo = timing.summary.recognitionWallMs;
  const deltaRows = delta.categories.map((category) => {
    const metric = category.metrics;
    return `| ${category.category} | ${category.previousStatus} → ${category.currentStatus} | ${formatDelta(metric.characterErrorRate?.delta, { rate: true })} | ${formatDelta(metric.wordErrorRate?.delta, { rate: true })} | ${formatDelta(metric.readingOrderError?.delta, { rate: true })} | ${formatDelta(metric.lineDetectionPrecision?.delta, { rate: true })} / ${formatDelta(metric.lineDetectionRecall?.delta, { rate: true })} | ${formatDelta(metric.meanPolygonIntersectionOverUnion?.delta, { rate: true })} / ${formatDelta(metric.meanPolygonCoverage?.delta, { rate: true })} | ${formatDelta(metric.missedLineCount?.delta)} / ${formatDelta(metric.duplicateLineCount?.delta)} | ${category.previousDisposition} → ${category.currentDisposition} |`;
  });
  return `# macOS OCR quality post-processing baseline v2

This benchmark measures the production PaddleOCR detection and layout
post-processing path against the first-release searchable-OCR corpus. It is not a
replacement for the Phase A process-isolation, cleanup, cancellation, offline,
or memory gates.

Policy ${baseline.acceptance.policyVersion} is **${baseline.acceptance.approvalStatus.toUpperCase()}**.
The measured corpus ${baseline.acceptance.passesThresholds ? 'meets' : 'does not meet'} its approved
thresholds. No threshold was changed from the prior baseline.

## Accuracy and result size

Accuracy values and serialized result sizes are stored in
\`baseline.macos.v2.json\`; timing is deliberately excluded from that baseline.

| Measure | Result |
| --- | ---: |
| Character error rate | ${formatRate(aggregate.characterErrorRate)} |
| Word error rate | ${formatRate(aggregate.wordErrorRate)} |
| Reading-order error | ${formatRate(aggregate.readingOrderError)} |
| Line detection precision | ${formatRate(aggregate.lineDetectionPrecision)} |
| Line detection recall | ${formatRate(aggregate.lineDetectionRecall)} |
| Mean polygon IoU | ${formatRate(aggregate.meanPolygonIntersectionOverUnion)} |
| Mean expected-polygon coverage | ${formatRate(aggregate.meanPolygonCoverage)} |
| Missed / duplicate lines | ${aggregate.missedLineCount} / ${aggregate.duplicateLineCount} |
| Unsupported-page classification accuracy | ${formatRate(aggregate.unsupportedPageAccuracy)} |
| Rejected-input accuracy | ${formatRate(aggregate.rejectedInputAccuracy)} |
| Peak canonical serialized result size | ${formatCount(aggregate.peakResultBytes)} bytes |

## Category decisions

Unsupported cases are reported but cannot satisfy a passing production
category. Geometry columns show precision/recall and mean IoU/coverage.

| Category | Status | CER | WER | Order error | Geometry P/R | Polygon IoU/coverage | Missed/duplicate | Engine disposition |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows.join('\n')}

## Category deltas from the approved-policy input baseline

Delta values compare ${delta.fromBaselineId} with ${delta.toBaselineId}. For
error, missed-line, and duplicate-line values, a negative delta is an
improvement. For precision, recall, overlap, and coverage, a positive delta is
an improvement. The machine-readable comparison is in
\`delta.macos.v1-to-v2.json\`.

| Category | Decision | CER Δ | WER Δ | Order Δ | Geometry P/R Δ | Polygon IoU/coverage Δ | Missed/duplicate Δ | Disposition |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${deltaRows.join('\n')}

## Threshold findings

${failures.length ? failures.map((failure) => `- ${failure}`).join('\n') : '- No threshold failures.'}

## Machine-dependent timing

Timing is stored separately in \`timing.macos-${timing.environment.architecture}.v2.json\`. This observation
used ${timing.environment.architecture} macOS with Darwin kernel ${timing.environment.kernelVersion},
Node ${timing.environment.nodeVersion}, one WASM thread, and a disposable adapter
instance per page. It is informational and is not part of the accuracy gate.

- Median page recognition wall time: ${timingInfo.median} ms
- p95 page recognition wall time: ${timingInfo.p95} ms
- Maximum page recognition wall time: ${timingInfo.maximum} ms
- Measured recognition pages: ${timing.summary.measuredRecognitionPages}
- Peak full serialized production result: ${timing.summary.peakSerializedProductionResultBytes} bytes

## Scope and provenance

The corpus contains ${corpus.fixtures.length} cases. Machine-printed supported-script
pages are eligible to pass. Rotation without orientation support, table
structure, and an unlisted script are explicit unsupported cases. Handwriting,
curved text, and severe perspective correction are excluded from passing scope.
Fixture provenance and license records are in
\`../../../tests/fixtures/ocr/quality-v1/\`.
`;
}

async function writeBenchmarkOutputs(outputDir, baseline, timing, corpus, delta) {
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'baseline.macos.v2.json'), `${JSON.stringify(baseline, null, 2)}\n`),
    writeFile(
      path.join(outputDir, `timing.macos-${timing.environment.architecture}.v2.json`),
      `${JSON.stringify(timing, null, 2)}\n`,
    ),
    writeFile(path.join(outputDir, 'delta.macos.v1-to-v2.json'), `${JSON.stringify(delta, null, 2)}\n`),
    writeFile(path.join(outputDir, 'REPORT.md'), markdownReport(baseline, timing, corpus, delta)),
  ]);
}

export async function runOcrQualityBenchmark(options = {}) {
  const settings = {
    corpusDir: options.corpusDir ?? defaultCorpusDir,
    outputDir: options.outputDir ?? defaultOutputDir,
    policyPath: options.policyPath ?? defaultPolicyPath,
    comparisonPath: options.comparisonPath ?? defaultComparisonPath,
    enforceProposed: options.enforceProposed ?? false,
  };
  if (process.platform !== 'darwin') throw new Error('The OCR quality benchmark is macOS-only');
  configureNodeWasmRuntime();
  const [{ corpus, manifestSha256 }, manifest, policy, comparison] = await Promise.all([
    readAndVerifyCorpus(settings.corpusDir),
    readFile(manifestPath, 'utf8').then(JSON.parse),
    readFile(settings.policyPath, 'utf8').then(JSON.parse),
    readFile(settings.comparisonPath, 'utf8').then(JSON.parse),
  ]);
  const engine = createPaddleOcrEngineDescriptor(manifest);
  const assetBaseUrl = pathToFileURL(`${modelDir}${path.sep}`).href;
  const outcomes = [];
  for (const fixture of corpus.fixtures) {
    process.stdout.write(`OCR quality: ${fixture.id}\n`);
    outcomes.push(fixture.classification === 'rejected'
      ? await runRejectedFixture({ fixture, manifest, assetBaseUrl })
      : await runRasterFixture({ corpusDir: settings.corpusDir, fixture, manifest, assetBaseUrl }));
  }
  const records = outcomes.map((outcome) => outcome.metrics);
  const aggregate = aggregateOcrMetrics(records);
  const acceptance = evaluateOcrAcceptance(records, policy);
  const accuracyCases = corpus.fixtures.map((fixture, index) => ({
    fixtureId: fixture.id,
    category: fixture.category,
    classification: fixture.classification,
    result: outcomes[index].result,
    error: outcomes[index].error,
    metrics: outcomes[index].metrics,
  }));
  const baselineIdentityBody = {
    corpus: { corpusId: corpus.corpusId, manifestSha256 },
    engine,
    normalization: corpus.normalization,
    accuracy: { cases: accuracyCases, aggregate },
  };
  const baselineId = `macos-ocr-quality-${sha256(JSON.stringify(baselineIdentityBody)).slice(0, 24)}`;
  const baseline = {
    contract: 'open-pdf-studio.ocr.quality-baseline',
    schemaVersion: 1,
    baselineId,
    platformScope: ['macos'],
    ...baselineIdentityBody,
    acceptance: {
      policyVersion: acceptance.policyVersion,
      approvalStatus: acceptance.approvalStatus,
      passesThresholds: acceptance.passesThresholds,
      releaseAccepted: acceptance.releaseAccepted,
      aggregateFailures: acceptance.aggregateFailures,
      categories: acceptance.categories,
    },
  };
  const measuredAt = new Date().toISOString();
  const timingBody = {
    accuracyBaselineId: baselineId,
    measuredAt,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      kernelVersion: os.release(),
      nodeVersion: process.version,
      logicalCpuCount: os.cpus().length,
      wasmThreads: 1,
    },
    method: {
      adapterLifecycle: 'one-disposable-adapter-per-page',
      includesModelInitialization: true,
      includesPngDecodeInRecognitionWallTime: false,
      informationalOnly: true,
    },
    cases: outcomes.map((outcome) => outcome.timing),
    summary: timingSummary(outcomes.map((outcome) => outcome.timing)),
  };
  const timing = {
    contract: 'open-pdf-studio.ocr.quality-timing',
    schemaVersion: 1,
    observationId: `macos-ocr-timing-${sha256(JSON.stringify(timingBody)).slice(0, 24)}`,
    ...timingBody,
  };
  const delta = createBenchmarkDelta(comparison, baseline);
  await writeBenchmarkOutputs(settings.outputDir, baseline, timing, corpus, delta);
  const executionErrors = accuracyCases.filter((record) =>
    record.error && record.classification !== 'rejected');
  return {
    baseline,
    timing,
    delta,
    executionErrors,
    shouldFail: executionErrors.length > 0 ||
      shouldFailOcrQualityGate(acceptance, { enforceProposed: settings.enforceProposed }),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await runOcrQualityBenchmark(options);
  process.stdout.write(
    `OCR quality baseline ${result.baseline.baselineId}: ` +
    `${result.baseline.acceptance.passesThresholds ? 'meets' : 'does not meet'} ` +
    `${result.baseline.acceptance.approvalStatus} thresholds\n`,
  );
  if (result.shouldFail) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
