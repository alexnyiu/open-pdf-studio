import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PACKAGED_EDITOR_REQUIRED_SUITES,
  REQUIRED_BROWSER_ACCEPTANCE_SUITES,
  portableArtifactPath,
  validateEditorCoverageManifest,
} from './ocr-release-hardening-policy.mjs';
import { verifySaveRenderCoherenceReport } from './verify-save-render-coherence-report.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const defaultAppBundle = path.join(
  repoDir,
  'target',
  'aarch64-apple-darwin',
  'release',
  'bundle',
  'macos',
  'Open PDF Studio.app',
);

const suites = PACKAGED_EDITOR_REQUIRED_SUITES;

const generatedEvidence = Object.freeze([
  ['ocr-production-workflow', 'output/ocr-production-workflow/latest.json'],
  ['ocr-edit-single-line', 'output/ocr-edit-single-line/acceptance.json'],
  ['ocr-edit-regions', 'output/ocr-edit-regions/acceptance.json'],
  ['ocr-reflow', 'output/ocr-reflow/acceptance.json'],
]);

function parseArguments(argv) {
  const options = {
    appBundle: path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || defaultAppBundle),
    outputPath: path.resolve(
      process.env.OPEN_PDF_STUDIO_EDITOR_ACCEPTANCE_REPORT
        || path.join(projectDir, 'test-artifacts', 'packaged-editor', 'acceptance.json'),
    ),
    browserOutcome: process.env.OPEN_PDF_STUDIO_BROWSER_ACCEPTANCE_OUTCOME || 'unavailable',
    coverageManifestPath: process.env.OPEN_PDF_STUDIO_EDITOR_COVERAGE_MANIFEST
      ? path.resolve(process.env.OPEN_PDF_STUDIO_EDITOR_COVERAGE_MANIFEST)
      : null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--app') options.appBundle = path.resolve(argv[++index]);
    else if (value === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (value === '--browser-outcome') options.browserOutcome = argv[++index] || 'unavailable';
    else if (value === '--coverage-manifest') options.coverageManifestPath = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.coverageManifestPath) {
    options.coverageManifestPath = path.resolve(
      path.dirname(options.outputPath),
      '..',
      'browser-ui',
      'editor-coverage-manifest.json',
    );
  }
  return options;
}

async function gitHead() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim())));
  });
}

async function runSuite(name, logPath, environment) {
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'w' });
  const startedAt = new Date().toISOString();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', name], {
        cwd: projectDir,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk);
        log.write(chunk);
      });
      child.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
        log.write(chunk);
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
    });
    return { name, command: `npm run ${name}`, startedAt, completedAt: new Date().toISOString(), ...result };
  } finally {
    await new Promise((resolve, reject) => {
      log.once('error', reject);
      log.end(resolve);
    });
  }
}

async function copyEvidence(outputDir) {
  const copied = [];
  for (const [name, relativePath] of generatedEvidence) {
    const source = path.join(projectDir, relativePath);
    try {
      await access(source);
      const destination = path.join(outputDir, 'reports', `${name}.json`);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      copied.push(path.relative(outputDir, destination));
    } catch {
      // Not every successful suite emits a standalone report. The aggregate
      // command result remains evidence; expected JSON is copied when present.
    }
  }
  return copied;
}

async function acceptanceArtifacts(outputDir, suiteResults) {
  const artifacts = suiteResults.map(({ name }) => (
    path.join('logs', `${name.replaceAll(':', '-')}.log`)
  ));
  artifacts.push(...await copyEvidence(outputDir));
  const annotationReport = path.join('reports', 'annotation-text-editing.json');
  try {
    await access(path.join(outputDir, annotationReport));
    artifacts.push(annotationReport);
  } catch { /* a missing report remains a failed annotation suite */ }
  const nativeReport = path.join('reports', 'native-text-editing.json');
  try {
    const value = JSON.parse(await readFile(path.join(outputDir, nativeReport), 'utf8'));
    artifacts.push(nativeReport);
    for (const artifact of Array.isArray(value?.artifacts) ? value.artifacts : []) {
      if (!portableArtifactPath(artifact)) continue;
      const relativePath = path.join('reports', artifact);
      await access(path.join(outputDir, relativePath));
      artifacts.push(relativePath);
    }
  } catch { /* validator reports missing or malformed native evidence */ }
  const coherenceReport = path.join('reports', 'save-render-coherence.json');
  try {
    const value = JSON.parse(await readFile(path.join(outputDir, coherenceReport), 'utf8'));
    artifacts.push(coherenceReport);
    for (const artifact of Array.isArray(value?.artifacts) ? value.artifacts : []) {
      if (!portableArtifactPath(artifact)) continue;
      const relativePath = path.join('reports', artifact);
      await access(path.join(outputDir, relativePath));
      artifacts.push(relativePath);
    }
  } catch { /* validator reports missing or malformed coherence evidence */ }
  return [...new Set(artifacts)];
}

async function validateCoherenceEvidence(outputDir, expectedHead) {
  const relativePath = path.join('reports', 'save-render-coherence.json');
  try {
    const result = await verifySaveRenderCoherenceReport(path.join(outputDir, relativePath), {
      expectedCommit: expectedHead,
    });
    return {
      path: relativePath,
      status: result.pass ? 'PASS' : 'FAIL',
      issues: result.issues,
    };
  } catch (error) {
    return {
      path: relativePath,
      status: 'FAIL',
      issues: [`save/render coherence evidence could not be read: ${error.message || error}`],
    };
  }
}

async function validateNativeEvidence(outputDir, expectedHead) {
  const relativePath = path.join('reports', 'native-text-editing.json');
  const evidencePath = path.join(outputDir, relativePath);
  const issues = [];
  let value = null;
  try {
    value = JSON.parse(await readFile(evidencePath, 'utf8'));
  } catch (error) {
    issues.push(`native text evidence could not be read: ${error.message || error}`);
    return { path: relativePath, status: 'FAIL', issues };
  }
  if (value?.contract !== 'open-pdf-studio.native-text-packaged-acceptance') {
    issues.push('native text evidence contract is invalid');
  }
  if (value?.schemaVersion !== 1) issues.push('native text evidence schemaVersion must be 1');
  if (value?.head !== expectedHead) issues.push('native text evidence HEAD does not match the aggregate');
  if (value?.status !== 'PASS') issues.push('native text evidence status is not PASS');
  if (value?.productionUiOnly !== true
      || value?.syntheticStateSeeding !== false
      || value?.testOnlyEntryPoint !== false) {
    issues.push('native text evidence did not preserve the production-only contract');
  }
  if (!value?.checks || Object.values(value.checks).some((status) => status !== 'PASS')) {
    issues.push('native text evidence did not pass every required interaction check');
  }
  const saves = value?.saveEvidence || {};
  if (!saves.firstSaveSha256 || saves.firstSaveSha256 !== saves.repeatedSaveSha256
      || saves.byteIdentity !== true) {
    issues.push('native repeat-save byte identity was not proven');
  }
  if (!saves.firstOwnedManifest?.sha256
      || saves.firstOwnedManifest.sha256 !== saves.repeatedOwnedManifest?.sha256
      || saves.ownedObjectStructureIdentity !== true) {
    issues.push('native repeat-save owned-object structure identity was not proven');
  }
  for (const artifact of Array.isArray(value?.artifacts) ? value.artifacts : []) {
    if (!portableArtifactPath(artifact)) {
      issues.push(`native text evidence artifact path is invalid: ${artifact}`);
      continue;
    }
    try {
      await access(path.resolve(path.dirname(evidencePath), artifact));
    } catch {
      issues.push(`native text evidence artifact is missing: ${artifact}`);
    }
  }
  return { path: relativePath, status: issues.length === 0 ? 'PASS' : 'FAIL', issues };
}

async function validateAnnotationEvidence(outputDir, expectedHead) {
  const relativePath = path.join('reports', 'annotation-text-editing.json');
  const evidencePath = path.join(outputDir, relativePath);
  const issues = [];
  let value = null;
  try {
    value = JSON.parse(await readFile(evidencePath, 'utf8'));
  } catch (error) {
    issues.push(`annotation evidence could not be read: ${error.message || error}`);
    return { path: relativePath, status: 'FAIL', issues };
  }
  if (value?.contract !== 'open-pdf-studio.annotation-text-packaged-acceptance') {
    issues.push('annotation evidence contract is invalid');
  }
  if (value?.schemaVersion !== 1) issues.push('annotation evidence schemaVersion must be 1');
  if (value?.head !== expectedHead) issues.push('annotation evidence HEAD does not match the aggregate');
  if (value?.status !== 'PASS') issues.push('annotation evidence status is not PASS');
  if (value?.productionUiOnly !== true
      || value?.syntheticStateSeeding !== false
      || value?.testOnlyEntryPoint !== false) {
    issues.push('annotation evidence did not preserve the production-only contract');
  }
  if (!value?.checks || Object.values(value.checks).some((status) => status !== 'PASS')) {
    issues.push('annotation evidence did not pass every required interaction check');
  }
  for (const family of ['insertedText', 'textbox', 'callout']) {
    if (!value?.families?.[family]?.finalText || !value.families[family]?.reedit) {
      issues.push(`${family} save/re-edit evidence is incomplete`);
    }
  }
  const saves = value?.saveEvidence || {};
  if (!saves.firstSaveSha256 || saves.firstSaveSha256 !== saves.repeatedInitialSaveSha256) {
    issues.push('initial repeat-save identity was not proven');
  }
  if (!saves.finalSaveSha256 || saves.finalSaveSha256 !== saves.repeatedFinalSaveSha256) {
    issues.push('final repeat-save identity was not proven');
  }
  return { path: relativePath, status: issues.length === 0 ? 'PASS' : 'FAIL', issues };
}

function browserAcceptanceEvidence(outcome) {
  const status = outcome === 'success' ? 'PASS' : 'FAIL';
  return {
    contract: 'open-pdf-studio.browser-editor-acceptance',
    schemaVersion: 1,
    required: true,
    status,
    outcome,
    suites: REQUIRED_BROWSER_ACCEPTANCE_SUITES.map((name) => ({
      name,
      status: status === 'PASS' ? 'PASS' : 'UNVERIFIED',
    })),
  };
}

async function editorCoverageEvidence(manifestPath, expectedHead) {
  let manifest = null;
  const issues = [];
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    issues.push(`required editor coverage manifest could not be read: ${error.message || error}`);
  }
  if (manifest) {
    issues.push(...validateEditorCoverageManifest(manifest, { expectedHead }));
    const manifestDirectory = path.dirname(manifestPath);
    for (const artifact of Array.isArray(manifest.artifacts) ? manifest.artifacts : []) {
      try {
        await access(path.resolve(manifestDirectory, artifact));
      } catch {
        issues.push(`coverage artifact is missing: ${artifact}`);
      }
    }
  }
  return {
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    manifestPath,
    artifactEvidenceValidated: issues.length === 0,
    issues,
    manifest,
  };
}

export async function runEditorAcceptance(options) {
  if (process.platform !== 'darwin') throw new Error('packaged editor acceptance is macOS-only');
  const appBinary = path.join(options.appBundle, 'Contents', 'MacOS', 'open-pdf-studio');
  await Promise.all([access(options.appBundle), access(appBinary)]);
  const outputDir = path.dirname(options.outputPath);
  await mkdir(path.join(outputDir, 'logs'), { recursive: true });
  const head = await gitHead();
  const browserAcceptance = browserAcceptanceEvidence(options.browserOutcome);
  const editorCoverage = await editorCoverageEvidence(options.coverageManifestPath, head);
  const environment = {
    ...process.env,
    OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE: options.appBundle,
    OPEN_PDF_STUDIO_PACKAGED_APP: appBinary,
    OPEN_PDF_STUDIO_TEST_ARTIFACT_DIR: outputDir,
    OPEN_PDF_STUDIO_SAVE_RENDER_COHERENCE_REPORT: path.join(
      outputDir,
      'reports',
      'save-render-coherence.json',
    ),
  };
  const report = {
    contract: 'open-pdf-studio.editor-packaged-acceptance',
    schemaVersion: 1,
    gateId: 'packaged-macos-editor-acceptance',
    status: 'RUNNING',
    head,
    generatedAt: new Date().toISOString(),
    platform: { os: process.platform, architecture: process.arch },
    packagedApp: {
      bundlePath: options.appBundle,
      executablePath: appBinary,
      bundleName: path.basename(options.appBundle),
      executableName: path.basename(appBinary),
      signingScope: 'CI usability and hardened-runtime compatibility; not Developer ID or notarization evidence',
    },
    productionUiOnly: true,
    syntheticStateSeeding: false,
    testOnlyEntryPoint: false,
    browserAcceptance,
    editorCoverage,
    testCommands: [
      'npm run test:editor-coverage:macos',
      ...REQUIRED_BROWSER_ACCEPTANCE_SUITES.map((name) => `npm run ${name}`),
      ...suites.map((name) => `npm run ${name}`),
    ],
    suites: [],
    artifacts: [],
  };
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const name of suites) {
    const result = await runSuite(name, path.join(outputDir, 'logs', `${name.replaceAll(':', '-')}.log`), environment);
    report.suites.push(result);
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const nativeEvidence = await validateNativeEvidence(outputDir, report.head);
  const nativeSuite = report.suites.find(({ name }) => name === 'test:native-text-editing:macos');
  if (nativeSuite) {
    nativeSuite.evidence = nativeEvidence;
    if (nativeEvidence.status !== 'PASS' && nativeSuite.code === 0) {
      nativeSuite.commandCode = nativeSuite.code;
      nativeSuite.code = 1;
    }
  }
  const coherenceEvidence = await validateCoherenceEvidence(outputDir, report.head);
  const coherenceSuite = report.suites.find(
    ({ name }) => name === 'test:save-render-coherence:macos',
  );
  if (coherenceSuite) {
    coherenceSuite.evidence = coherenceEvidence;
    if (coherenceEvidence.status !== 'PASS' && coherenceSuite.code === 0) {
      coherenceSuite.commandCode = coherenceSuite.code;
      coherenceSuite.code = 1;
    }
  }
  const annotationEvidence = await validateAnnotationEvidence(outputDir, report.head);
  const annotationSuite = report.suites.find(({ name }) => name === 'test:annotation-text-editing:macos');
  if (annotationSuite) {
    annotationSuite.evidence = annotationEvidence;
    if (annotationEvidence.status !== 'PASS' && annotationSuite.code === 0) {
      annotationSuite.commandCode = annotationSuite.code;
      annotationSuite.code = 1;
    }
  }
  report.artifacts = await acceptanceArtifacts(outputDir, report.suites);
  const failedSuites = report.suites.filter((suite) => suite.code !== 0);
  report.status = failedSuites.length === 0
    && browserAcceptance.status === 'PASS'
    && editorCoverage.status === 'PASS'
    ? 'PASS'
    : 'FAIL';
  report.completedAt = new Date().toISOString();
  report.failures = [
    ...failedSuites.map((suite) => (
      `${suite.command} exited with ${suite.code}${suite.signal ? ` (${suite.signal})` : ''}`
    )),
    ...(browserAcceptance.status === 'PASS'
      ? []
      : [`required supplemental browser acceptance outcome was ${browserAcceptance.outcome}`]),
    ...editorCoverage.issues,
  ];
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runEditorAcceptance(parseArguments(process.argv.slice(2))).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'PASS') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
