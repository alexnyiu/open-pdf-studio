import assert from 'node:assert/strict';
import test from 'node:test';

import { saveRenderCoherenceScenarioMatrix } from './save-render-coherence-scenarios.mjs';
import { saveRenderCoherenceReportIssues } from './verify-save-render-coherence-report.mjs';

function passingReport() {
  return {
    contract: 'open-pdf-studio.save-render-coherence',
    schemaVersion: 1,
    status: 'PASS',
    pass: true,
    commit: '1234567890abcdef',
    platform: { os: 'darwin', architecture: 'arm64' },
    documentId: 'doc-a',
    scenario: 'A1',
    productionUiOnly: true,
    syntheticStateSeeding: false,
    testOnlyEntryPoint: false,
    revisions: {
      content: 3,
      serialized: 3,
      persisted: 3,
      livePdf: 3,
      visibleRender: 3,
      visibleSemantic: 3,
    },
    stalePublicationCount: 0,
    saveStates: [{ saveState: 'saved' }],
    textAssertions: {
      editAExtractedBeforeEditB: true,
      editBExtractedBeforeEditC: true,
      threeConsecutiveEditsExtracted: true,
      reopenedTextMatches: true,
      manualCleanSavePreservedBytes: true,
    },
    visualAssertions: {
      geometryPreserved: true,
      renderMatchesPersistedPdf: true,
      pixelDifferencePercent: 0.01,
    },
    scenarioMatrix: saveRenderCoherenceScenarioMatrix(['A1', 'A22']),
    failures: [],
    artifacts: [],
  };
}

test('a complete packaged A1/A22 coherence report passes', () => {
  assert.deepEqual(saveRenderCoherenceReportIssues(passingReport(), {
    expectedCommit: '1234567890abcdef',
  }), []);
});

test('revision divergence, stale publication, or missing matrix evidence fails closed', () => {
  const report = passingReport();
  report.revisions.livePdf = 2;
  report.stalePublicationCount = 1;
  report.scenarioMatrix = report.scenarioMatrix.filter(({ id }) => id !== 'A18');
  const issues = saveRenderCoherenceReportIssues(report);
  assert.ok(issues.some((issue) => issue.includes('revisions differ')));
  assert.ok(issues.some((issue) => issue.includes('stale surface')));
  assert.ok(issues.some((issue) => issue.includes('missing A18')));
});

test('browser-only or synthetic evidence cannot satisfy the packaged gate', () => {
  const report = passingReport();
  report.productionUiOnly = false;
  report.syntheticStateSeeding = true;
  report.scenarioMatrix = report.scenarioMatrix.map((entry) => (
    entry.id === 'A1' ? { ...entry, evidenceKind: 'browser' } : entry
  ));
  const issues = saveRenderCoherenceReportIssues(report);
  assert.ok(issues.some((issue) => issue.includes('production packaged-app contract')));
  assert.ok(issues.some((issue) => issue.includes('A1 is not packaged')));
});
