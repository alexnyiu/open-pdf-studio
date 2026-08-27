import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_CHECK_NAMES } from './ocr-release-hardening-policy.mjs';

function parseArguments(argv) {
  const options = {
    inputPath: '',
    activeRulesInputPath: '',
    classicFallbackInputPath: '',
    outputPath: '',
    repository: process.env.GITHUB_REPOSITORY || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--input') options.inputPath = path.resolve(argv[++index]);
    else if (value === '--active-rules-input') {
      options.activeRulesInputPath = path.resolve(argv[++index]);
    } else if (value === '--classic-fallback-input') {
      options.classicFallbackInputPath = path.resolve(argv[++index]);
    } else if (value === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (value === '--repository') options.repository = argv[++index] || null;
    else throw new Error(`unknown argument: ${value}`);
  }
  const primaryInputCount = Number(Boolean(options.inputPath))
    + Number(Boolean(options.activeRulesInputPath));
  if (primaryInputCount !== 1) {
    throw new Error('exactly one of --input or --active-rules-input is required');
  }
  if (options.classicFallbackInputPath && !options.activeRulesInputPath) {
    throw new Error('--classic-fallback-input requires --active-rules-input');
  }
  if (!options.outputPath) throw new Error('--output is required');
  return options;
}

function configuredChecks(protection) {
  if (Array.isArray(protection)) {
    return new Set(protection
      .filter((rule) => rule?.type === 'required_status_checks')
      .flatMap((rule) => rule?.parameters?.required_status_checks || [])
      .map((item) => item?.context)
      .filter(Boolean));
  }
  const statusChecks = protection?.required_status_checks;
  return new Set([
    ...(Array.isArray(statusChecks?.contexts) ? statusChecks.contexts : []),
    ...(Array.isArray(statusChecks?.checks) ? statusChecks.checks.map((item) => item?.context) : []),
  ].filter(Boolean));
}

export function evaluateBranchProtection(protection, { repository = null, source = null } = {}) {
  const checks = configuredChecks(protection);
  const missingChecks = REQUIRED_CHECK_NAMES.filter((name) => !checks.has(name));
  const unexpectedChecks = [...checks].filter((name) => !REQUIRED_CHECK_NAMES.includes(name)).sort();
  const rulesetStatuses = Array.isArray(protection)
    ? protection.filter((rule) => rule?.type === 'required_status_checks')
    : [];
  const rulesetPullRequests = Array.isArray(protection)
    ? protection.filter((rule) => rule?.type === 'pull_request')
    : [];
  const strictRulesetChecks = Array.isArray(protection)
    ? configuredChecks(rulesetStatuses.filter(
      (rule) => rule?.parameters?.strict_required_status_checks_policy === true,
    ))
    : new Set();
  const criteria = {
    repositoryIdentified: typeof repository === 'string'
      && /^[^/\s]+\/[^/\s]+$/u.test(repository),
    mainBranchProtected: Array.isArray(protection)
      ? rulesetStatuses.length > 0 && rulesetPullRequests.length > 0
      : Boolean(protection?.required_status_checks || protection?.required_pull_request_reviews),
    upToDateBranchRequired: Array.isArray(protection)
      ? REQUIRED_CHECK_NAMES.every((name) => strictRulesetChecks.has(name))
      : protection?.required_status_checks?.strict === true,
    approvingReviewRequired: Array.isArray(protection)
      ? rulesetPullRequests.some((rule) => (
        Number(rule?.parameters?.required_approving_review_count || 0) >= 1
      ))
      : Number(protection?.required_pull_request_reviews?.required_approving_review_count || 0) >= 1,
    exactRequiredChecksConfigured: missingChecks.length === 0 && unexpectedChecks.length === 0,
  };
  return {
    contract: 'open-pdf-studio.repository-controls',
    schemaVersion: 1,
    gateId: 'repository-controls',
    status: Object.values(criteria).every(Boolean) ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(),
    repository,
    branch: 'main',
    criteria,
    requiredChecks: REQUIRED_CHECK_NAMES,
    configuredChecks: [...checks].sort(),
    missingChecks,
    unexpectedChecks,
    source: source || (Array.isArray(protection)
      ? 'GitHub active-rules-for-branch API response supplied to the evaluator'
      : 'GitHub branch-protection API response supplied to the evaluator'),
  };
}

function withFallbackEvidence(report, fallback, inputIssues = []) {
  return {
    ...report,
    fallback,
    ...(inputIssues.length > 0 ? { inputIssues } : {}),
  };
}

export function evaluateBranchProtectionWithFallback(activeRules, {
  classicProtection,
  repository = null,
} = {}) {
  if (!Array.isArray(activeRules)) {
    return withFallbackEvidence(
      evaluateBranchProtection([], {
        repository,
        source: 'Invalid GitHub active-rules-for-branch API response supplied to the evaluator',
      }),
      {
        eligible: false,
        supplied: classicProtection !== undefined,
        used: false,
        reason: 'active-rules-response-was-not-an-array',
      },
      ['active-rules response must be an array'],
    );
  }

  if (activeRules.length > 0) {
    return withFallbackEvidence(
      evaluateBranchProtection(activeRules, { repository }),
      {
        eligible: false,
        supplied: classicProtection !== undefined,
        used: false,
        reason: 'active-rules-govern-main',
      },
    );
  }

  if (classicProtection === undefined) {
    return withFallbackEvidence(
      evaluateBranchProtection(activeRules, { repository }),
      {
        eligible: true,
        supplied: false,
        used: false,
        reason: 'classic-protection-fallback-not-supplied',
      },
      ['empty active-rules response requires an explicit classic branch-protection fallback'],
    );
  }

  if (classicProtection === null
    || typeof classicProtection !== 'object'
    || Array.isArray(classicProtection)) {
    return withFallbackEvidence(
      evaluateBranchProtection(activeRules, {
        repository,
        source: 'Malformed classic branch-protection fallback after empty active-rules response',
      }),
      {
        eligible: true,
        supplied: true,
        used: false,
        reason: 'classic-protection-fallback-was-not-an-object',
      },
      ['classic branch-protection fallback must be a JSON object'],
    );
  }

  return withFallbackEvidence(
    evaluateBranchProtection(classicProtection, {
      repository,
      source: 'GitHub classic branch-protection API fallback after empty active-rules response',
    }),
    {
      eligible: true,
      supplied: true,
      used: true,
      reason: 'empty-active-rules-response',
    },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const primaryPath = options.inputPath || options.activeRulesInputPath;
  readFile(primaryPath, 'utf8').then(async (contents) => {
    const primary = JSON.parse(contents);
    if (options.inputPath) return evaluateBranchProtection(primary, options);
    const classicProtection = Array.isArray(primary)
      && primary.length === 0
      && options.classicFallbackInputPath
      ? JSON.parse(await readFile(options.classicFallbackInputPath, 'utf8'))
      : undefined;
    return evaluateBranchProtectionWithFallback(primary, {
      classicProtection,
      repository: options.repository,
    });
  }).then((report) => {
    return mkdir(path.dirname(options.outputPath), { recursive: true })
      .then(() => writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`))
      .then(() => report);
  }).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'PASS') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
