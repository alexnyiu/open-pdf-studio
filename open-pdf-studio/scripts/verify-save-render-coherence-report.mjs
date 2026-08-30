import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SAVE_RENDER_COHERENCE_SCENARIO_IDS } from './save-render-coherence-scenarios.mjs';

export const SAVE_RENDER_COHERENCE_REPORT_CONTRACT =
  'open-pdf-studio.save-render-coherence';

function finiteRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function portableArtifact(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/u).includes('..');
}

export function saveRenderCoherenceReportIssues(report, {
  expectedCommit = null,
} = {}) {
  const issues = [];
  if (report?.contract !== SAVE_RENDER_COHERENCE_REPORT_CONTRACT) {
    issues.push('report contract is invalid');
  }
  if (report?.schemaVersion !== 1) issues.push('report schemaVersion must be 1');
  if (report?.status !== 'PASS' || report?.pass !== true) issues.push('report did not pass');
  if (report?.productionUiOnly !== true
      || report?.syntheticStateSeeding !== false
      || report?.testOnlyEntryPoint !== false) {
    issues.push('report did not preserve the production packaged-app contract');
  }
  if (typeof report?.commit !== 'string' || report.commit.length < 7) {
    issues.push('report commit is missing');
  } else if (expectedCommit && report.commit !== expectedCommit) {
    issues.push('report commit does not match the expected release commit');
  }
  if (!report?.platform || !report?.documentId || report?.scenario !== 'A1') {
    issues.push('platform, documentId, or authoritative A1 scenario identity is missing');
  }
  const revisions = report?.revisions || {};
  const revisionFields = [
    'content', 'serialized', 'persisted', 'livePdf', 'visibleRender', 'visibleSemantic',
  ];
  for (const field of revisionFields) {
    if (!finiteRevision(revisions[field])) issues.push(`revision ${field} is invalid`);
  }
  if (revisionFields.some((field) => revisions[field] !== revisions.content)) {
    issues.push('final content, serialization, persistence, live, render, and semantic revisions differ');
  }
  if (report?.stalePublicationCount !== 0) {
    issues.push('a stale surface publication was observed');
  }
  if (!Array.isArray(report?.saveStates)
      || !report.saveStates.some((entry) => entry?.saveState === 'saved')) {
    issues.push('saved-state transition evidence is missing');
  }
  const textAssertions = report?.textAssertions || {};
  for (const name of [
    'editAExtractedBeforeEditB',
    'editBExtractedBeforeEditC',
    'threeConsecutiveEditsExtracted',
    'reopenedTextMatches',
    'manualCleanSavePreservedBytes',
  ]) {
    if (textAssertions[name] !== true) issues.push(`text assertion failed: ${name}`);
  }
  const a23Layout = textAssertions.a23FinalLayoutBoundToTypedDraft || {};
  if (!Number.isSafeInteger(a23Layout.draftRevision)
      || !a23Layout.requestedFingerprint
      || a23Layout.requestedFingerprint !== a23Layout.validatedFingerprint
      || a23Layout.resizeHandleEventCount !== 0) {
    issues.push('A23 final layout was not bound to the exact typed draft without resize events');
  }
  const a23Blocked = textAssertions.a23ImpossibleAutoFit || {};
  if (a23Blocked.draftRetained !== true
      || a23Blocked.editorRemainedOpen !== true
      || a23Blocked.revisionUnchanged !== true
      || a23Blocked.persistedBytesUnchanged !== true
      || a23Blocked.resizeHandleEventCount !== 0
      || ![
        'TEXT_LAYOUT_PAGE_BOUNDARY',
        'TEXT_LAYOUT_COLUMN_BOUNDARY',
        'TEXT_LAYOUT_NEIGHBOR_OVERLAP',
      ].includes(a23Blocked.rejectionCode)
      || typeof a23Blocked.recoveryMessage !== 'string'
      || a23Blocked.recoveryMessage.trim() === '') {
    issues.push('A23 impossible auto-fit evidence is incomplete');
  }
  const visual = report?.visualAssertions || {};
  if (visual.geometryPreserved !== true) issues.push('reopen geometry was not preserved');
  if (visual.renderMatchesPersistedPdf !== true
      || !Number.isFinite(visual.pixelDifferencePercent)
      || visual.pixelDifferencePercent > 0.1) {
    issues.push('mounted render did not match the persisted PDF within the 0.1% threshold');
  }
  const matrix = Array.isArray(report?.scenarioMatrix) ? report.scenarioMatrix : [];
  const byId = new Map();
  for (const entry of matrix) {
    if (byId.has(entry?.id)) issues.push(`scenario matrix duplicates ${entry?.id}`);
    byId.set(entry?.id, entry);
  }
  for (const id of SAVE_RENDER_COHERENCE_SCENARIO_IDS) {
    const entry = byId.get(id);
    if (!entry) issues.push(`scenario matrix is missing ${id}`);
    else if (!['PASS', 'COVERED'].includes(entry.status)) {
      issues.push(`scenario matrix entry ${id} is not covered`);
    } else if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      issues.push(`scenario matrix entry ${id} lacks evidence`);
    }
  }
  for (const id of ['A1', 'A22', 'A23']) {
    if (byId.get(id)?.status !== 'PASS'
        || byId.get(id)?.evidenceKind !== 'packaged-production-ui') {
      issues.push(`${id} is not packaged production-UI evidence`);
    }
  }
  if (!Array.isArray(report?.failures) || report.failures.length !== 0) {
    issues.push('report contains failures');
  }
  for (const artifact of report?.artifacts || []) {
    if (!portableArtifact(artifact)) issues.push(`artifact path is invalid: ${artifact}`);
  }
  return issues;
}

export async function verifySaveRenderCoherenceReport(reportPath, options = {}) {
  const absolutePath = path.resolve(reportPath);
  const report = JSON.parse(await readFile(absolutePath, 'utf8'));
  const issues = saveRenderCoherenceReportIssues(report, options);
  const reportDirectory = path.dirname(absolutePath);
  for (const artifact of report?.artifacts || []) {
    if (!portableArtifact(artifact)) continue;
    try { await access(path.resolve(reportDirectory, artifact)); } catch {
      issues.push(`artifact is missing: ${artifact}`);
    }
  }
  return { report, issues, pass: issues.length === 0 };
}

function parseArguments(argv) {
  const options = { inputPath: null, expectedCommit: process.env.GITHUB_SHA || null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input') options.inputPath = path.resolve(argv[++index]);
    else if (argv[index] === '--commit') options.expectedCommit = argv[++index] || null;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.inputPath) throw new Error('--input is required');
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  verifySaveRenderCoherenceReport(options.inputPath, {
    expectedCommit: options.expectedCommit,
  }).then((result) => {
    process.stdout.write(`${JSON.stringify({
      input: options.inputPath,
      pass: result.pass,
      issues: result.issues,
    }, null, 2)}\n`);
    if (!result.pass) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
