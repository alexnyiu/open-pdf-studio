import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  AUTHORITATIVE_RELEASE_BASE_REF,
  AUTHORITATIVE_RELEASE_CONTEXT_CONTRACT,
  AUTHORITATIVE_RELEASE_EVENT,
  FINDING_IDS,
  FINDING_REQUIRED_GATES,
  GATE_EVIDENCE_CONTRACTS,
  MACOS_ARTIFACT_REQUIRED_CRITERIA,
  MACOS_FILESYSTEM_ADVISORY_CRITERIA,
  MACOS_FILESYSTEM_BLOCKING_CRITERIA,
  MACOS_HARDENING_REQUIRED_ARTIFACTS,
  MACOS_OCR_PRODUCTION_REQUIRED_CRITERIA,
  PACKAGED_ADVERSARIAL_REQUIRED_CASES,
  PACKAGED_EDITOR_REQUIRED_SUITES,
  PERFORMANCE_THRESHOLDS,
  REQUIRED_BROWSER_ACCEPTANCE_SUITES,
  RELEASE_GO,
  RELEASE_NO_GO,
  REQUIRED_CHECK_NAMES,
  REQUIRED_GATE_IDS,
  REQUIRED_UPSTREAM_JOB_IDS,
  portableArtifactPath,
  validateEditorCoverageManifest,
} from './ocr-release-hardening-policy.mjs';
import {
  BROWSER_EDITOR_ACCEPTANCE_CONTRACT,
  BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION,
  validateBrowserEditorAcceptanceManifest,
} from './browser-editor-acceptance-manifest.mjs';
import { evaluateEditorPerformanceReport } from './verify-editor-performance-report.mjs';

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const DEFAULT_OUTPUT = path.join(projectDir, 'output', 'ocr-release-hardening', 'acceptance.json');

function parseArguments(argv) {
  const options = {
    evidencePaths: [],
    requiredJobResults: [],
    outputPath: DEFAULT_OUTPUT,
    expectedHead: process.env.GITHUB_SHA || '',
    expectedRepository: process.env.GITHUB_REPOSITORY || '',
    requireDistributionTrust: false,
    localDiagnostic: false,
    eventName: process.env.GITHUB_EVENT_NAME || '',
    baseRef: process.env.GITHUB_BASE_REF || '',
    headRef: process.env.GITHUB_HEAD_REF || '',
    githubRef: process.env.GITHUB_REF || '',
    eventRepository: process.env.GITHUB_REPOSITORY || '',
    eventPayloadPath: process.env.GITHUB_EVENT_PATH
      ? path.resolve(process.env.GITHUB_EVENT_PATH)
      : '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--evidence-dir' || value === '--report') options.evidencePaths.push(path.resolve(argv[++index]));
    else if (value === '--required-job-result') options.requiredJobResults.push(argv[++index] || '');
    else if (value === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (value === '--expected-head') options.expectedHead = argv[++index] || '';
    else if (value === '--expected-repository') options.expectedRepository = argv[++index] || '';
    else if (value === '--require-distribution-trust') options.requireDistributionTrust = true;
    else if (value === '--local-diagnostic') options.localDiagnostic = true;
    else if (value === '--event-name') options.eventName = argv[++index] || '';
    else if (value === '--base-ref') options.baseRef = argv[++index] || '';
    else if (value === '--head-ref') options.headRef = argv[++index] || '';
    else if (value === '--github-ref') options.githubRef = argv[++index] || '';
    else if (value === '--event-repository') options.eventRepository = argv[++index] || '';
    else if (value === '--event-payload') options.eventPayloadPath = path.resolve(argv[++index]);
    else if (value.startsWith('-')) throw new Error(`unknown argument: ${value}`);
    else options.evidencePaths.push(path.resolve(value));
  }
  if (options.evidencePaths.length === 0) throw new Error('at least one --evidence-dir or --report is required');
  return options;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function evaluateReleaseContext(context, { expectedRepository = '' } = {}) {
  const value = context && typeof context === 'object' && !Array.isArray(context)
    ? context
    : {};
  const mode = value.mode === 'local-diagnostic' ? 'local-diagnostic' : 'github-actions';
  const eventName = String(value.eventName || '');
  const baseRef = String(value.baseRef || '');
  const headRef = String(value.headRef || '');
  const githubRef = String(value.githubRef || '');
  const repository = String(value.repository || '');
  const payload = value.eventPayload && typeof value.eventPayload === 'object'
    && !Array.isArray(value.eventPayload)
    ? value.eventPayload
    : null;
  const issues = [];

  if (mode === 'local-diagnostic') {
    issues.push('local diagnostic mode is not an authoritative release context');
  } else {
    if (eventName !== AUTHORITATIVE_RELEASE_EVENT) {
      issues.push(`release event must be ${AUTHORITATIVE_RELEASE_EVENT}`);
    }
    if (baseRef !== AUTHORITATIVE_RELEASE_BASE_REF) {
      issues.push(`pull request base ref must be ${AUTHORITATIVE_RELEASE_BASE_REF}`);
    }
    if (!headRef) issues.push('pull request head ref is missing');
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
      issues.push('release event repository is missing or invalid');
    } else if (expectedRepository && repository !== expectedRepository) {
      issues.push(`release event repository ${repository} does not match ${expectedRepository}`);
    }

    const refMatch = /^refs\/pull\/(\d+)\/merge$/u.exec(githubRef);
    const refPullRequestNumber = positiveInteger(refMatch?.[1]);
    if (!refPullRequestNumber) {
      issues.push('GitHub ref must identify a pull request merge ref');
    }
    if (!payload) {
      issues.push('GitHub pull request event payload is missing or invalid');
    }

    const payloadPullRequestNumber = positiveInteger(payload?.number);
    const pullRequest = payload?.pull_request;
    const payloadRepository = payload?.repository?.full_name;
    const payloadBaseRepository = pullRequest?.base?.repo?.full_name;
    const payloadBaseRef = pullRequest?.base?.ref;
    const payloadHeadRef = pullRequest?.head?.ref;
    if (!payloadPullRequestNumber) issues.push('event payload pull request number is missing or invalid');
    if (!pullRequest || typeof pullRequest !== 'object' || Array.isArray(pullRequest)) {
      issues.push('event payload pull_request object is missing or invalid');
    } else {
      if (payloadBaseRef !== AUTHORITATIVE_RELEASE_BASE_REF) {
        issues.push(`event payload base ref must be ${AUTHORITATIVE_RELEASE_BASE_REF}`);
      }
      if (payloadBaseRef !== baseRef) issues.push('event payload base ref does not match GITHUB_BASE_REF');
      if (payloadHeadRef !== headRef) issues.push('event payload head ref does not match GITHUB_HEAD_REF');
      if (pullRequest.state && pullRequest.state !== 'open') {
        issues.push('event payload pull request must be open');
      }
    }
    if (payloadPullRequestNumber && refPullRequestNumber
        && payloadPullRequestNumber !== refPullRequestNumber) {
      issues.push('event payload pull request number does not match GITHUB_REF');
    }
    if (payloadRepository !== repository) {
      issues.push('event payload repository does not match GITHUB_REPOSITORY');
    }
    if (payloadBaseRepository !== repository) {
      issues.push('event payload base repository does not match GITHUB_REPOSITORY');
    }
  }

  const pullRequestNumber = positiveInteger(value.eventPayload?.number)
    || positiveInteger(/^refs\/pull\/(\d+)\/merge$/u.exec(githubRef)?.[1]);
  const authoritative = issues.length === 0;
  return {
    contract: AUTHORITATIVE_RELEASE_CONTEXT_CONTRACT,
    schemaVersion: 1,
    mode,
    status: authoritative ? 'PASS' : 'FAIL',
    authoritative,
    eventName: eventName || null,
    repository: repository || null,
    baseRef: baseRef || null,
    headRef: headRef || null,
    githubRef: githubRef || null,
    pullRequestNumber,
    eventPayloadValidated: Boolean(payload) && authoritative,
    issues,
  };
}

async function resolveReleaseContext(options) {
  if (options.localDiagnostic) {
    return {
      mode: 'local-diagnostic',
      eventName: options.eventName,
      baseRef: options.baseRef,
      headRef: options.headRef,
      githubRef: options.githubRef,
      repository: options.eventRepository,
      eventPayload: null,
    };
  }
  let eventPayload = null;
  if (options.eventPayloadPath) {
    try {
      eventPayload = JSON.parse(await readFile(options.eventPayloadPath, 'utf8'));
    } catch {
      // The pure release-context validator records missing/invalid payload evidence.
    }
  }
  return {
    mode: 'github-actions',
    eventName: options.eventName,
    baseRef: options.baseRef,
    headRef: options.headRef,
    githubRef: options.githubRef,
    repository: options.eventRepository,
    eventPayload,
  };
}

export function validateRequiredJobResults(entries, expectedNames = REQUIRED_UPSTREAM_JOB_IDS) {
  const errors = [];
  const names = new Set();
  for (const entry of entries) {
    const match = /^([a-z0-9][a-z0-9-]*)=(success|failure|cancelled|skipped)$/u.exec(entry);
    if (!match) {
      errors.push({ path: 'github-actions-needs', error: `invalid required job result: ${entry || '<missing>'}` });
      continue;
    }
    const [, name, result] = match;
    if (!expectedNames.includes(name)) {
      errors.push({ path: 'github-actions-needs', error: `unexpected required job result: ${name}` });
      continue;
    }
    if (names.has(name)) {
      errors.push({ path: 'github-actions-needs', error: `duplicate required job result: ${name}` });
      continue;
    }
    names.add(name);
    if (result !== 'success') {
      errors.push({ path: 'github-actions-needs', error: `required job ${name} completed with ${result}` });
    }
  }
  for (const name of expectedNames) {
    if (!names.has(name)) {
      errors.push({ path: 'github-actions-needs', error: `required job result is missing: ${name}` });
    }
  }
  return errors;
}

export function validatedExpectedHead(explicitHead, actualHead) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(actualHead)) {
    throw new Error(`checked-out HEAD is not a full Git object ID: ${actualHead || '<missing>'}`);
  }
  if (explicitHead && explicitHead !== actualHead) {
    throw new Error(`expected HEAD ${explicitHead} does not match checked-out HEAD ${actualHead}`);
  }
  return actualHead;
}

async function resolveHead(explicitHead) {
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' });
  return validatedExpectedHead(explicitHead, result.stdout.trim());
}

async function resolveWorktreeState() {
  const result = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: repoDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const dirtyPaths = result.stdout.split('\n').filter(Boolean);
  return { clean: dirtyPaths.length === 0, dirtyPathCount: dirtyPaths.length };
}

export function validateWorktreeState(state) {
  if (!state || typeof state !== 'object') {
    return [{ path: 'git-worktree', error: 'release worktree state is unavailable' }];
  }
  if (state?.clean === true && state?.dirtyPathCount === 0) return [];
  return [{
    path: 'git-worktree',
    error: `release evidence was evaluated from a dirty worktree (${state?.dirtyPathCount ?? 'unknown'} paths)`,
  }];
}

async function evidenceFilePaths(inputPath) {
  const information = await stat(inputPath);
  if (information.isFile()) return [inputPath];
  if (!information.isDirectory()) return [];
  const results = [];
  for (const entry of await readdir(inputPath, { withFileTypes: true })) {
    const entryPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) results.push(...await evidenceFilePaths(entryPath));
    else if (entry.isFile()) results.push(entryPath);
  }
  return results;
}

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['PASS', 'PASSED', 'GO', RELEASE_GO].includes(normalized)) return 'PASS';
  if (['UNVERIFIED', 'PENDING', 'RUNNING'].includes(normalized)) return 'UNVERIFIED';
  return 'FAIL';
}

function performanceResult(report) {
  if (report?.contract !== 'open-pdf-studio.editor-performance'
      || report?.gateId !== 'macos-editor-ocr-performance') return null;
  const evaluated = evaluateEditorPerformanceReport(report);
  return {
    status: normalizeStatus(report?.status) === 'PASS' && evaluated.status === 'PASS' ? 'PASS' : 'FAIL',
    criteria: evaluated.criteria,
    evidenceIssues: evaluated.evidenceIssues,
  };
}

function gateStatus(report) {
  const measuredPerformance = performanceResult(report);
  if (measuredPerformance) return measuredPerformance.status;
  return normalizeStatus(report?.status ?? report?.overallStatus ?? report?.classification);
}

function combineStatuses(statuses) {
  if (statuses.length === 0) return 'FAIL';
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('UNVERIFIED')) return 'UNVERIFIED';
  return 'PASS';
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return left.length === right.length
    && [...new Set(left)].sort().join('\n') === [...new Set(right)].sort().join('\n');
}

function evidencePath(source) {
  if (portableArtifactPath(source?.artifactPath)) return source.artifactPath;
  if (portableArtifactPath(source?.path)) return source.path;
  return typeof source?.path === 'string' && source.path ? path.basename(source.path) : '<unknown-evidence>';
}

function validateArtifactDeclarations(artifacts, label, required = []) {
  const issues = [];
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return [`${label} artifacts are missing`];
  }
  const portable = artifacts.filter(portableArtifactPath);
  if (portable.length !== artifacts.length || new Set(portable).size !== artifacts.length) {
    issues.push(`${label} artifacts must be unique, portable relative paths`);
  }
  const declared = new Set(portable);
  for (const artifact of required) {
    if (!declared.has(artifact)) issues.push(`${label} required artifact is missing: ${artifact}`);
  }
  return issues;
}

function namedEntries(entries, expectedNames, label, issues) {
  if (!Array.isArray(entries)) {
    issues.push(`${label} list is missing`);
    return new Map();
  }
  const byName = new Map();
  for (const entry of entries) {
    const name = entry?.name;
    if (typeof name !== 'string' || !expectedNames.includes(name)) {
      issues.push(`${label} contains an unexpected entry: ${name || '<missing>'}`);
      continue;
    }
    if (byName.has(name)) issues.push(`${label} contains a duplicate entry: ${name}`);
    byName.set(name, entry);
  }
  if (entries.length !== expectedNames.length) {
    issues.push(`${label} must contain exactly ${expectedNames.length} entries`);
  }
  return byName;
}

function validateRepositoryControls(report, expectedRepository) {
  const issues = [];
  if (report?.branch !== 'main') issues.push('repository controls must describe main');
  if (typeof report?.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/u.test(report.repository)) {
    issues.push('repository controls must identify an owner/repository');
  } else if (expectedRepository && report.repository !== expectedRepository) {
    issues.push(`repository controls describe ${report.repository}, not ${expectedRepository}`);
  }
  for (const name of [
    'repositoryIdentified',
    'mainBranchProtected',
    'upToDateBranchRequired',
    'approvingReviewRequired',
    'exactRequiredChecksConfigured',
  ]) {
    if (report?.criteria?.[name] !== true) issues.push(`repository control did not pass: ${name}`);
  }
  if (!sameStringSet(report?.requiredChecks, REQUIRED_CHECK_NAMES)) {
    issues.push('repository controls do not declare the exact required check set');
  }
  if (!sameStringSet(report?.configuredChecks, REQUIRED_CHECK_NAMES)) {
    issues.push('repository controls do not configure exactly the required check set');
  }
  if (!Array.isArray(report?.missingChecks) || report.missingChecks.length !== 0) {
    issues.push('repository controls report missing required checks');
  }
  if (!Array.isArray(report?.unexpectedChecks) || report.unexpectedChecks.length !== 0) {
    issues.push('repository controls report unexpected required checks');
  }
  return issues;
}

function validateGateSource(gateId, report, expectedHead, expectedRepository = '') {
  const issues = [];
  const expectedContract = GATE_EVIDENCE_CONTRACTS[gateId];
  if (!expectedContract || report?.contract !== expectedContract) {
    issues.push(`contract must be ${expectedContract || 'a registered gate contract'}`);
  }
  if (report?.schemaVersion !== 1) issues.push('schemaVersion must be 1');
  if (report?.gateId !== gateId) issues.push(`gateId must be ${gateId}`);

  if (gateId === 'repository-controls') {
    issues.push(...validateRepositoryControls(report, expectedRepository));
  } else if (!expectedHead) {
    issues.push('expected HEAD is unavailable');
  } else if (!report?.head) {
    issues.push('evidence HEAD is missing');
  } else if (report.head !== expectedHead) {
    issues.push(`evidence HEAD ${report.head} does not match ${expectedHead}`);
  }

  if (expectedContract === 'open-pdf-studio.release-gate-evidence') {
    const commands = Array.isArray(report?.testCommands) ? report.testCommands : [];
    if (commands.length === 0 || commands.some((command) => typeof command !== 'string' || !command.trim())
        || new Set(commands).size !== commands.length) {
      issues.push('gate testCommands must be a non-empty unique string list');
    }
    if (gateId === 'macos-ocr-release-hardening') {
      issues.push(...validateArtifactDeclarations(
        report?.artifacts,
        'macOS release-hardening gate',
        MACOS_HARDENING_REQUIRED_ARTIFACTS,
      ));
    }
  }

  if (gateId === 'packaged-macos-editor-acceptance') {
    if (report?.productionUiOnly !== true) issues.push('productionUiOnly must be true');
    if (report?.syntheticStateSeeding !== false) issues.push('syntheticStateSeeding must be false');
    if (report?.testOnlyEntryPoint !== false) issues.push('testOnlyEntryPoint must be false');
    if (!report?.packagedApp?.bundlePath || !report?.packagedApp?.executablePath) {
      issues.push('packaged app bundle and executable identity are required');
    }
    const suiteResults = namedEntries(
      report?.suites,
      PACKAGED_EDITOR_REQUIRED_SUITES,
      'packaged suite',
      issues,
    );
    for (const suiteName of PACKAGED_EDITOR_REQUIRED_SUITES) {
      const suite = suiteResults.get(suiteName);
      if (!suite || !Number.isInteger(suite.code) || suite.code !== 0
          || ('status' in suite && normalizeStatus(suite.status) !== 'PASS')) {
        issues.push(`${suiteName} did not pass in the packaged aggregate`);
      }
    }
    issues.push(...validateArtifactDeclarations(
      report?.artifacts,
      'packaged editor',
      PACKAGED_EDITOR_REQUIRED_SUITES.map(
        (name) => `logs/${name.replaceAll(':', '-')}.log`,
      ),
    ));
    const browser = report?.browserAcceptance;
    if (browser?.contract !== BROWSER_EDITOR_ACCEPTANCE_CONTRACT
        || browser?.schemaVersion !== BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION
        || browser?.required !== true) {
      issues.push('required supplemental browser acceptance contract is missing or invalid');
    }
    if (browser?.status !== 'PASS') {
      issues.push('required supplemental browser acceptance did not pass');
    }
    issues.push(...validateBrowserEditorAcceptanceManifest(
      browser?.manifest,
      { expectedHead },
    ));
    const browserSuites = namedEntries(
      browser?.suites,
      REQUIRED_BROWSER_ACCEPTANCE_SUITES,
      'browser acceptance suite',
      issues,
    );
    for (const suiteName of REQUIRED_BROWSER_ACCEPTANCE_SUITES) {
      if (browserSuites.get(suiteName)?.status !== 'PASS') {
        issues.push(`${suiteName} did not pass in supplemental browser acceptance`);
      }
    }
    if (report?.editorCoverage?.status !== 'PASS'
        || report?.editorCoverage?.artifactEvidenceValidated !== true
        || !Array.isArray(report?.editorCoverage?.issues)
        || report.editorCoverage.issues.length !== 0) {
      issues.push('required editor coverage artifact evidence was not validated');
    }
    issues.push(...validateEditorCoverageManifest(report?.editorCoverage?.manifest, { expectedHead }));
  }

  if (gateId === 'macos-editor-ocr-performance') {
    const result = performanceResult(report);
    if (!result) issues.push('editor performance evidence could not be evaluated');
    else issues.push(...result.evidenceIssues);
    issues.push(...validateArtifactDeclarations(report?.artifacts, 'editor performance'));
  }

  return issues;
}

function validateSupportingSource(report, expectedHead) {
  const issues = [];
  if (report?.schemaVersion !== 1) issues.push('schemaVersion must be 1');
  if (!expectedHead) issues.push('expected HEAD is unavailable');
  else if (!report?.head) issues.push('evidence HEAD is missing');
  else if (report.head !== expectedHead) {
    issues.push(`evidence HEAD ${report.head} does not match ${expectedHead}`);
  }
  if (report?.contract === 'open-pdf-studio.macos-release-hardening') {
    if (report?.platform?.os !== 'darwin' || report?.platform?.architecture !== 'arm64') {
      issues.push('artifact hardening must report a macOS arm64 execution');
    }
    if (typeof report?.appPath !== 'string' || !report.appPath.endsWith('.app')) {
      issues.push('artifact hardening packaged app identity is missing');
    }
    for (const name of MACOS_ARTIFACT_REQUIRED_CRITERIA) {
      if (!['PASS', 'FAIL', 'UNVERIFIED'].includes(report?.criteria?.[name]?.status)) {
        issues.push(`artifact hardening criterion is missing or invalid: ${name}`);
      }
    }
  } else if (report?.contract === 'open-pdf-studio.macos-filesystem-edge-cases') {
    if (report?.platform?.os !== 'darwin' || report?.platform?.architecture !== 'arm64') {
      issues.push('filesystem evidence must report a macOS arm64 execution');
    }
    if (typeof report?.appPath !== 'string' || !report.appPath.endsWith('.app')) {
      issues.push('filesystem packaged app identity is missing');
    }
    for (const name of MACOS_FILESYSTEM_BLOCKING_CRITERIA) {
      if (!['PASS', 'FAIL', 'UNVERIFIED'].includes(report?.criteria?.[name]?.status)) {
        issues.push(`filesystem blocking criterion is missing or invalid: ${name}`);
      }
    }
    for (const name of MACOS_FILESYSTEM_ADVISORY_CRITERIA) {
      if (!['PASS', 'UNVERIFIED'].includes(report?.criteria?.[name]?.status)) {
        issues.push(`filesystem advisory criterion is missing or failed: ${name}`);
      }
    }
    const criterionStatuses = [
      ...MACOS_FILESYSTEM_BLOCKING_CRITERIA,
      ...MACOS_FILESYSTEM_ADVISORY_CRITERIA,
    ].map((name) => normalizeStatus(report?.criteria?.[name]?.status));
    if (normalizeStatus(report?.overallStatus) !== combineStatuses(criterionStatuses)) {
      issues.push('filesystem overallStatus does not match its required criteria');
    }
  } else if (report?.contract === 'open-pdf-studio.ocr-macos-production-decision') {
    if (report?.scope !== 'macos-arm64'
        || report?.productionTarget?.platform !== 'darwin'
        || report?.productionTarget?.architecture !== 'arm64') {
      issues.push('OCR production decision target must be macOS arm64');
    }
    const claimsGo = report?.classification === 'MACOS PRODUCTION GO';
    if (!claimsGo && report?.classification !== 'MACOS PRODUCTION NO-GO') {
      issues.push('OCR production classification is invalid');
    }
    for (const name of MACOS_OCR_PRODUCTION_REQUIRED_CRITERIA) {
      if (typeof report?.criteria?.[name] !== 'boolean') {
        issues.push(`OCR production criterion is missing or invalid: ${name}`);
      } else if (claimsGo && report.criteria[name] !== true) {
        issues.push(`OCR production GO contradicts criterion: ${name}`);
      }
    }
    if (!Array.isArray(report?.failures)) {
      issues.push('OCR production failures list is missing');
    } else if (claimsGo && report.failures.length !== 0) {
      issues.push('OCR production GO contains failures');
    }
    const evidence = report?.evidence;
    if (claimsGo && (evidence?.platform !== 'darwin' || evidence?.architecture !== 'arm64'
        || evidence?.buildKind !== 'packaged-release'
        || evidence?.recognitionCycles < 10 || evidence?.cancellationCycles < 10
        || evidence?.uniqueChildProcesses < 20 || evidence?.engine !== 'PaddleOCR')) {
      issues.push('OCR production execution evidence is incomplete');
    }
    const artifacts = evidence?.artifacts;
    if (claimsGo && (!artifacts || artifacts.verificationError
        || !Array.isArray(artifacts.applicationArchitectures)
        || !artifacts.applicationArchitectures.includes('arm64')
        || !Array.isArray(artifacts.packagedSidecarArchitectures)
        || !artifacts.packagedSidecarArchitectures.includes('arm64')
        || artifacts?.checksumVerification?.models !== 3
        || artifacts?.checksumVerification?.runtimeAssets !== 2
        || typeof artifacts?.checksumVerification?.dependency?.integrity !== 'string'
        || artifacts.checksumVerification.dependency.integrity.length === 0)) {
      issues.push('OCR production packaged artifact provenance is incomplete');
    }
  } else if (report?.contract === 'open-pdf-studio.ocr.adversarial-packaged-qualification') {
    if (report?.status !== 'PASS') issues.push('packaged adversarial OCR qualification did not pass');
    if (report?.platform?.operatingSystem !== 'darwin'
        || report?.platform?.architecture !== 'arm64'
        || typeof report?.appBinary !== 'string'
        || path.basename(report.appBinary) !== 'open-pdf-studio') {
      issues.push('packaged adversarial OCR evidence must identify the macOS arm64 app binary');
    }
    if (report?.automation?.visibleProductionAction !== '#ep-recognize-text'
        || report?.automation?.genericPackagedUiAutomation !== true
        || report?.automation?.developmentOnlyOcrMcpEntryPointUsed !== false
        || report?.automation?.testOnlyOcrEntryPointUsed !== false) {
      issues.push('packaged adversarial OCR did not preserve the visible production UI path');
    }
    const startedAt = Date.parse(report?.startedAt);
    const finishedAt = Date.parse(report?.finishedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
      issues.push('packaged adversarial OCR timestamps are missing or invalid');
    }
    const caseNames = report?.cases && typeof report.cases === 'object' && !Array.isArray(report.cases)
      ? Object.keys(report.cases)
      : [];
    if (!sameStringSet(caseNames, PACKAGED_ADVERSARIAL_REQUIRED_CASES)) {
      issues.push('packaged adversarial OCR does not contain the exact required case set');
    }
    for (const name of PACKAGED_ADVERSARIAL_REQUIRED_CASES) {
      const result = report?.cases?.[name];
      if (result?.status !== 'PASS' || typeof result?.expectedResult !== 'string'
          || typeof result?.actualResult !== 'string' || result?.originalPreserved !== true
          || result?.partialOwnedStream !== false || result?.childProcessesSurviving !== 0
          || !Array.isArray(result?.nativeJobTemp?.files) || result.nativeJobTemp.files.length !== 0
          || result?.cache?.payloads !== 0 || result?.cache?.metadata !== 0
          || !Array.isArray(result?.cache?.temporary) || result.cache.temporary.length !== 0) {
        issues.push(`packaged adversarial OCR case evidence is incomplete: ${name}`);
      }
    }
    if (report?.error !== null) issues.push('packaged adversarial OCR PASS report contains an error');
  }
  return issues;
}

function releaseHardeningCoreStatus(report) {
  if (report?.contract !== 'open-pdf-studio.macos-release-hardening') return null;
  const statuses = MACOS_ARTIFACT_REQUIRED_CRITERIA
    .map((name) => normalizeStatus(report?.criteria?.[name]?.status));
  return combineStatuses(statuses);
}

function packagedIdentity(reports, expectedHead) {
  const artifact = reports.find(({ value }) => (
    value?.contract === 'open-pdf-studio.macos-release-hardening' && value?.head === expectedHead
  ))?.value;
  const packaged = reports.find(({ value }) => (
    value?.contract === 'open-pdf-studio.editor-packaged-acceptance' && value?.head === expectedHead
  ))?.value;
  const packaging = artifact?.criteria?.arm64AppPackaging || {};
  const signing = artifact?.criteria?.codeSigningValidation || {};
  const reportedBundlePath = packaged?.packagedApp?.bundlePath ?? artifact?.appPath ?? null;
  return {
    bundleIdentifier: packaging.bundleIdentifier ?? null,
    version: packaging.version ?? null,
    appArchitectures: packaging.appArchitectures ?? null,
    bundlePath: typeof reportedBundlePath === 'string' && reportedBundlePath
      ? (portableArtifactPath(reportedBundlePath) ? reportedBundlePath : path.basename(reportedBundlePath))
      : null,
    signatureKind: signing.signatureKind ?? null,
    hardenedRuntime: signing.hardenedRuntime ?? null,
    evidenceAvailable: Boolean(artifact || packaged),
  };
}

function distributionTrust(reports, required, expectedHead) {
  const artifact = reports.find(({ value }) => (
    value?.contract === 'open-pdf-studio.macos-release-hardening' && value?.head === expectedHead
  ))?.value;
  const names = ['developerIdSigning', 'notarization', 'gatekeeperAssessment', 'quarantineDownloadStyleLaunch'];
  const criteria = Object.fromEntries(names.map((name) => [
    name,
    normalizeStatus(artifact?.criteria?.[name]?.status),
  ]));
  const passed = Object.values(criteria).every((status) => status === 'PASS');
  return {
    required,
    status: required ? (passed ? 'PASS' : 'FAIL') : 'NOT_CLAIMED',
    criteria,
    note: required
      ? 'Developer ID signing, notarization, Gatekeeper, and quarantine launch are mandatory.'
      : 'Ad-hoc CI app usability is not Developer ID signing or notarization evidence; distribution is gated by release.yml.',
  };
}

export function evaluateReleaseHardening(reports, {
  expectedHead,
  expectedRepository = '',
  requireDistributionTrust = false,
  evidenceErrors = [],
  worktreeState = null,
  evidenceArtifacts = [],
  releaseContext = null,
} = {}) {
  const authoritativeReleaseContext = evaluateReleaseContext(releaseContext, { expectedRepository });
  const gateReports = new Map();
  for (const source of reports) {
    const gateId = source.value?.gateId;
    if (!gateId) continue;
    if (!gateReports.has(gateId)) gateReports.set(gateId, []);
    gateReports.get(gateId).push(source);
  }

  const performanceReport = reports.find(({ value }) => performanceResult(value));
  const measuredPerformance = performanceReport ? performanceResult(performanceReport.value) : null;
  const performanceEvidenceIssues = performanceReport
    ? validateGateSource(
      'macos-editor-ocr-performance',
      performanceReport.value,
      expectedHead,
      expectedRepository,
    )
    : ['required evidence is missing'];
  const performance = performanceReport
    ? {
      ...measuredPerformance,
      status: measuredPerformance.status === 'PASS' && performanceEvidenceIssues.length === 0 ? 'PASS' : 'FAIL',
      source: evidencePath(performanceReport),
      evidenceHead: performanceReport.value.head ?? null,
      expectedHead: expectedHead || null,
      evidenceIssues: performanceEvidenceIssues,
    }
    : {
      status: 'FAIL',
      criteria: Object.fromEntries(Object.entries(PERFORMANCE_THRESHOLDS).map(([name, threshold]) => [
        name,
        { status: 'FAIL', measured: null, ...threshold },
      ])),
      source: null,
      evidenceHead: null,
      expectedHead: expectedHead || null,
      evidenceIssues: performanceEvidenceIssues,
    };

  const allGateIds = [...new Set([
    ...REQUIRED_GATE_IDS,
    ...Object.values(FINDING_REQUIRED_GATES).flat(),
  ])];
  const gates = {};
  for (const gateId of allGateIds) {
    const sources = gateReports.get(gateId) || [];
    const validatedSources = sources.map((source) => ({
      ...source,
      issues: validateGateSource(gateId, source.value, expectedHead, expectedRepository),
    }));
    const validSources = validatedSources.filter(({ issues }) => issues.length === 0);
    const statuses = validSources.map(({ value }) => gateId === 'macos-ocr-release-hardening'
      ? (releaseHardeningCoreStatus(value) || gateStatus(value))
      : gateStatus(value));
    const invalidSources = validatedSources
      .filter(({ issues }) => issues.length > 0)
      .map((source) => ({ path: evidencePath(source), issues: source.issues }));
    const staleSources = validatedSources
      .filter(({ value }) => value?.head && expectedHead && value.head !== expectedHead)
      .map(evidencePath);
    const status = invalidSources.length > 0 ? 'FAIL' : combineStatuses(statuses);
    gates[gateId] = {
      status,
      sources: sources.map(evidencePath),
      staleSources,
      invalidSources,
      reason: sources.length === 0
        ? 'required evidence is missing'
        : invalidSources.length > 0
          ? 'required evidence did not satisfy its gate-specific contract'
          : null,
    };
  }
  const hardeningArtifactCandidates = reports.filter(
    ({ value }) => value?.contract === 'open-pdf-studio.macos-release-hardening',
  );
  const filesystemArtifactCandidates = reports.filter(
    ({ value }) => value?.contract === 'open-pdf-studio.macos-filesystem-edge-cases',
  );
  const ocrProductionDecisionCandidates = reports.filter(
    ({ value }) => value?.contract === 'open-pdf-studio.ocr-macos-production-decision',
  );
  const adversarialCandidates = reports.filter(
    ({ value }) => value?.contract === 'open-pdf-studio.ocr.adversarial-packaged-qualification',
  );
  const supportingCandidates = [
    ...hardeningArtifactCandidates,
    ...filesystemArtifactCandidates,
    ...ocrProductionDecisionCandidates,
    ...adversarialCandidates,
  ].map((source) => ({
    ...source,
    issues: validateSupportingSource(source.value, expectedHead),
  }));
  const invalidSupportingSources = supportingCandidates
    .filter(({ issues }) => issues.length > 0)
    .map((source) => ({ path: evidencePath(source), issues: source.issues }));
  const validSupportingPaths = new Set(supportingCandidates
    .filter(({ issues }) => issues.length === 0)
    .map(({ path: sourcePath }) => sourcePath));
  const hardeningArtifacts = hardeningArtifactCandidates
    .filter(({ path: sourcePath }) => validSupportingPaths.has(sourcePath));
  const filesystemArtifacts = filesystemArtifactCandidates
    .filter(({ path: sourcePath }) => validSupportingPaths.has(sourcePath));
  const ocrProductionDecisions = ocrProductionDecisionCandidates
    .filter(({ path: sourcePath }) => validSupportingPaths.has(sourcePath));
  const adversarialReports = adversarialCandidates
    .filter(({ path: sourcePath }) => validSupportingPaths.has(sourcePath));
  const hardeningCoreStatuses = hardeningArtifacts.map(({ value }) => releaseHardeningCoreStatus(value));
  const hardeningGate = gates['macos-ocr-release-hardening'];
  const filesystemReportedStatuses = filesystemArtifacts.map(
    ({ value }) => normalizeStatus(value?.overallStatus),
  );
  const filesystemBlockingStatuses = filesystemArtifacts.map(({ value }) => (
    MACOS_FILESYSTEM_BLOCKING_CRITERIA.every(
      (name) => value?.criteria?.[name]?.status === 'PASS',
    ) && MACOS_FILESYSTEM_ADVISORY_CRITERIA.every(
      (name) => ['PASS', 'UNVERIFIED'].includes(value?.criteria?.[name]?.status),
    ) ? 'PASS' : 'FAIL'
  ));
  const ocrProductionStatuses = ocrProductionDecisions.map(({ value }) => (
    value?.classification === 'MACOS PRODUCTION GO' ? 'PASS' : 'FAIL'
  ));
  const adversarialStatuses = adversarialReports.map(({ value }) => (
    value?.status === 'PASS' ? 'PASS' : 'FAIL'
  ));
  hardeningGate.supportingSources = supportingCandidates.map(evidencePath);
  hardeningGate.invalidSupportingSources = invalidSupportingSources;
  hardeningGate.supportingCriteria = {
    artifactHardening: {
      reportedStatus: combineStatuses(hardeningCoreStatuses),
      blockingStatus: combineStatuses(hardeningCoreStatuses),
    },
    filesystemEdgeCases: {
      reportedStatus: combineStatuses(filesystemReportedStatuses),
      blockingStatus: combineStatuses(filesystemBlockingStatuses),
      advisoryUnverifiedAllowed: true,
    },
    ocrProduction: {
      reportedStatus: combineStatuses(ocrProductionStatuses),
      blockingStatus: combineStatuses(ocrProductionStatuses),
    },
    adversarialOcr: {
      reportedStatus: combineStatuses(adversarialStatuses),
      blockingStatus: combineStatuses(adversarialStatuses),
    },
  };
  hardeningGate.status = combineStatuses([
    hardeningGate.status,
    ...Object.values(hardeningGate.supportingCriteria).map((criterion) => criterion.blockingStatus),
  ]);
  if (invalidSupportingSources.length > 0) {
    hardeningGate.status = 'FAIL';
    hardeningGate.reason = 'macOS supporting evidence did not satisfy schema and HEAD validation';
  } else if (hardeningArtifacts.length === 0) {
    hardeningGate.status = 'FAIL';
    hardeningGate.reason = 'macOS artifact hardening evidence is missing';
  } else if (hardeningCoreStatuses.some((status) => status !== 'PASS')) {
    hardeningGate.reason = 'non-distribution macOS artifact criteria did not all pass';
  } else if (filesystemArtifacts.length === 0) {
    hardeningGate.status = 'FAIL';
    hardeningGate.reason = 'macOS filesystem edge-case evidence is missing';
  } else if (filesystemBlockingStatuses.some((status) => status !== 'PASS')) {
    hardeningGate.reason = 'macOS filesystem edge-case evidence failed';
  } else if (ocrProductionDecisions.length === 0) {
    hardeningGate.status = 'FAIL';
    hardeningGate.reason = 'macOS OCR production decision evidence is missing';
  } else if (ocrProductionStatuses.some((status) => status !== 'PASS')) {
    hardeningGate.reason = 'macOS OCR production decision is not GO';
  } else if (adversarialReports.length === 0) {
    hardeningGate.status = 'FAIL';
    hardeningGate.reason = 'packaged adversarial OCR evidence is missing';
  } else if (adversarialStatuses.some((status) => status !== 'PASS')) {
    hardeningGate.reason = 'packaged adversarial OCR qualification did not pass';
  }
  if (performance.status !== 'PASS') gates['macos-editor-ocr-performance'].status = 'FAIL';

  const findings = Object.fromEntries(FINDING_IDS.map((findingId) => {
    const requiredGates = FINDING_REQUIRED_GATES[findingId];
    const failedGates = requiredGates.filter((gateId) => gates[gateId]?.status !== 'PASS');
    return [findingId, {
      status: failedGates.length === 0 ? 'PASS' : 'FAIL',
      requiredGates,
      failedGates,
      evidence: [...new Set(requiredGates.flatMap((gateId) => [
        ...(gates[gateId]?.sources || []),
        ...(gates[gateId]?.supportingSources || []),
      ]))],
    }];
  }));

  const distribution = distributionTrust(reports, requireDistributionTrust, expectedHead);
  const provenanceErrors = validateWorktreeState(worktreeState);
  const artifactErrors = evidenceArtifacts.length > 0
    && (evidenceArtifacts.some((artifact) => !portableArtifactPath(artifact))
      || new Set(evidenceArtifacts).size !== evidenceArtifacts.length)
    ? [{ path: 'evidence-artifacts', error: 'evidence artifact paths must be unique and portable' }]
    : [];
  const releaseContextErrors = authoritativeReleaseContext.issues.map((error) => ({
    path: 'release-context',
    error,
  }));
  const combinedEvidenceErrors = [
    ...evidenceErrors,
    ...provenanceErrors,
    ...artifactErrors,
    ...releaseContextErrors,
  ]
    .filter((entry, index, entries) => entries.findIndex(
      (candidate) => candidate?.path === entry?.path && candidate?.error === entry?.error,
    ) === index);
  const allRequiredGatesPass = REQUIRED_GATE_IDS.every((gateId) => gates[gateId]?.status === 'PASS');
  const allFindingsPass = Object.values(findings).every((finding) => finding.status === 'PASS');
  const decisionPasses = combinedEvidenceErrors.length === 0
    && authoritativeReleaseContext.status === 'PASS'
    && allRequiredGatesPass
    && allFindingsPass
    && performance.status === 'PASS'
    && (!requireDistributionTrust || distribution.status === 'PASS');
  const testCommands = [...new Set(reports.flatMap(({ value }) => value.testCommands || []))];
  const inputArtifacts = reports.map(evidencePath);
  const declaredArtifacts = reports.flatMap(({ value }) => value.artifacts || [])
    .filter(portableArtifactPath);
  const durableArtifacts = evidenceArtifacts.length > 0
    ? evidenceArtifacts
    : [...inputArtifacts, ...declaredArtifacts].filter(portableArtifactPath);

  return {
    contract: 'open-pdf-studio.ocr-release-hardening-acceptance',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    head: expectedHead,
    scope: 'macos-ocr-release-hardening',
    releaseContext: authoritativeReleaseContext,
    packagedApp: packagedIdentity(reports, expectedHead),
    findings,
    performance,
    gates,
    repositoryControls: {
      status: gates['repository-controls'].status,
      branch: 'main',
      requiredChecks: REQUIRED_CHECK_NAMES,
      externalConfiguration: true,
      note: 'Branch protection is a GitHub repository setting and cannot be established by this checkout.',
    },
    distributionTrust: distribution,
    testCommands,
    artifacts: [...new Set(durableArtifacts)],
    evidenceErrors: combinedEvidenceErrors,
    sourceProvenance: {
      head: expectedHead || null,
      worktreeClean: worktreeState?.clean ?? null,
      dirtyPathCount: worktreeState?.dirtyPathCount ?? null,
    },
    decision: decisionPasses ? RELEASE_GO : RELEASE_NO_GO,
  };
}

const REQUIRED_BROWSER_LOG_ARTIFACTS = Object.freeze([
  'browser-ui/native-text-editing.log',
  'browser-ui/metadata-editing.log',
  'browser-ui/modal-hardening.log',
  'browser-ui/ocr-ui.log',
]);

function artifactChecksForReport(report) {
  const checks = [];
  if (report?.contract === 'open-pdf-studio.editor-packaged-acceptance'
      || report?.contract === 'open-pdf-studio.editor-performance'
      || report?.contract === 'open-pdf-studio.editor-coverage-manifest'
      || (report?.contract === 'open-pdf-studio.release-gate-evidence'
        && report?.gateId === 'macos-ocr-release-hardening')) {
    for (const artifact of Array.isArray(report?.artifacts) ? report.artifacts : []) {
      checks.push({ artifact, relativeToReport: true });
    }
  }
  if (report?.contract === 'open-pdf-studio.editor-packaged-acceptance') {
    for (const artifact of REQUIRED_BROWSER_LOG_ARTIFACTS) {
      checks.push({ artifact, relativeToReport: false });
    }
  }
  return checks;
}

async function validateLoadedArtifacts(reports, evidenceRoots) {
  const errors = [];
  for (const { path: sourcePath, value } of reports) {
    for (const { artifact, relativeToReport } of artifactChecksForReport(value)) {
      if (!portableArtifactPath(artifact)) continue;
      const bases = relativeToReport
        ? [path.dirname(sourcePath), ...evidenceRoots]
        : evidenceRoots;
      let found = false;
      for (const base of [...new Set(bases)]) {
        try {
          const information = await stat(path.resolve(base, artifact));
          if (information.isFile() || information.isDirectory()) {
            found = true;
            break;
          }
        } catch { /* try the next explicitly supplied evidence root */ }
      }
      if (!found) {
        errors.push({ path: sourcePath, error: `declared artifact is missing: ${artifact}` });
      }
    }
  }
  return errors;
}

export async function loadEvidence(inputPaths) {
  const discoveredReports = [];
  const errors = [];
  const evidenceRoots = [];
  const artifacts = [];
  for (let index = 0; index < inputPaths.length; index += 1) {
    const inputPath = inputPaths[index];
    try {
      const information = await stat(inputPath);
      const root = information.isDirectory() ? inputPath : path.dirname(inputPath);
      const prefix = inputPaths.length > 1 ? `source-${index + 1}` : '';
      evidenceRoots.push(root);
      for (const filePath of await evidenceFilePaths(inputPath)) {
        const relativePath = information.isDirectory()
          ? path.relative(root, filePath)
          : path.basename(filePath);
        const portablePath = path.posix.join(prefix, ...relativePath.split(path.sep));
        if (!portableArtifactPath(portablePath)) {
          errors.push({ path: filePath, error: 'evidence file path is not portable' });
          continue;
        }
        artifacts.push(portablePath);
        if (filePath.endsWith('.json')) {
          discoveredReports.push({ path: filePath, artifactPath: portablePath });
        }
      }
    } catch (error) {
      errors.push({ path: inputPath, error: error.message || String(error) });
    }
  }
  const artifactSet = new Set(artifacts);
  if (artifactSet.size !== artifacts.length) {
    errors.push({ path: 'evidence-artifacts', error: 'duplicate portable evidence artifact path' });
  }
  const reportsByPath = new Map();
  for (const source of discoveredReports) {
    if (!reportsByPath.has(source.path)) reportsByPath.set(source.path, source);
  }
  const sources = [...reportsByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  const reports = [];
  for (const source of sources) {
    try {
      reports.push({ ...source, value: JSON.parse(await readFile(source.path, 'utf8')) });
    } catch (error) {
      errors.push({ path: source.path, error: error.message || String(error) });
    }
  }
  errors.push(...await validateLoadedArtifacts(reports, [...new Set(evidenceRoots)]));
  return { reports, errors, artifacts: [...artifactSet].sort() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  Promise.all([
    loadEvidence(options.evidencePaths),
    resolveHead(options.expectedHead),
    resolveWorktreeState(),
    resolveReleaseContext(options),
  ]).then(async ([loaded, head, worktreeState, releaseContext]) => {
    const result = evaluateReleaseHardening(loaded.reports, {
      expectedHead: head,
      expectedRepository: options.expectedRepository,
      requireDistributionTrust: options.requireDistributionTrust,
      evidenceErrors: [
        ...loaded.errors,
        ...validateRequiredJobResults(options.requiredJobResults),
      ],
      worktreeState,
      evidenceArtifacts: loaded.artifacts,
      releaseContext,
    });
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${result.decision}\n${options.outputPath}\n`);
    if (result.decision !== RELEASE_GO) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
