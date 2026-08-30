export const RELEASE_GO = 'MACOS OCR RELEASE HARDENING GO';
export const RELEASE_NO_GO = 'MACOS OCR RELEASE HARDENING NO-GO';
export const AUTHORITATIVE_RELEASE_CONTEXT_CONTRACT =
  'open-pdf-studio.authoritative-release-context';
export const AUTHORITATIVE_RELEASE_EVENT = 'pull_request';
export const AUTHORITATIVE_RELEASE_BASE_REF = 'main';

export const REQUIRED_CHECK_NAMES = Object.freeze([
  'Static verification',
  'Desktop build (ubuntu-22.04)',
  'Desktop build (windows-latest)',
  'Desktop build (macos-26)',
  'macOS packaged editor acceptance',
  'save/render coherence report verification',
  'macOS editor and OCR performance',
  'macOS OCR release-hardening decision',
]);

export const REQUIRED_UPSTREAM_JOB_IDS = Object.freeze([
  'static-verification',
  'build',
  'packaged-macos-editor-acceptance',
  'save-render-coherence-report-verification',
  'macos-editor-ocr-performance',
]);

export const REQUIRED_GATE_IDS = Object.freeze([
  'static-verification',
  'desktop-build-ubuntu-22.04',
  'desktop-build-windows-latest',
  'desktop-build-macos-26',
  'packaged-macos-editor-acceptance',
  'save-render-coherence-report-verification',
  'macos-editor-ocr-performance',
  'macos-ocr-release-hardening',
]);

export const GATE_EVIDENCE_CONTRACTS = Object.freeze({
  'static-verification': 'open-pdf-studio.release-gate-evidence',
  'desktop-build-ubuntu-22.04': 'open-pdf-studio.release-gate-evidence',
  'desktop-build-windows-latest': 'open-pdf-studio.release-gate-evidence',
  'desktop-build-macos-26': 'open-pdf-studio.release-gate-evidence',
  'packaged-macos-editor-acceptance': 'open-pdf-studio.editor-packaged-acceptance',
  'save-render-coherence-report-verification': 'open-pdf-studio.release-gate-evidence',
  'macos-editor-ocr-performance': 'open-pdf-studio.editor-performance',
  'macos-ocr-release-hardening': 'open-pdf-studio.release-gate-evidence',
  'repository-controls': 'open-pdf-studio.repository-controls',
});

export const PACKAGED_EDITOR_REQUIRED_SUITES = Object.freeze([
  'test:save-render-coherence:macos',
  'test:native-text-editing:macos',
  'test:annotation-text-editing:macos',
  'test:ocr-workflow:macos',
  'test:ocr-save:macos',
  'test:ocr-edit-single-line:macos',
  'test:ocr-edit-regions:macos',
  'test:ocr-reflow:macos',
]);

export const REQUIRED_BROWSER_ACCEPTANCE_SUITES = Object.freeze([
  'test:native-text-editing:ui',
  'test:metadata-editing:ui',
  'test:modal-hardening:ui',
  'test:ocr-ui:browser:macos',
]);

export const MACOS_HARDENING_REQUIRED_ARTIFACTS = Object.freeze([
  'release-hardening/macos-artifact.json',
  'release-hardening/macos-filesystem.json',
  'ocr/macos-production-decision.json',
  'ocr/adversarial-packaged.json',
]);

export const PACKAGED_ADVERSARIAL_REQUIRED_CASES = Object.freeze([
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
  'repeated-malformed-pages',
  'pathological-input-cancellation',
]);

export const MACOS_ARTIFACT_REQUIRED_CRITERIA = Object.freeze([
  'arm64AppPackaging',
  'universalSidecarAndPdfiumProbes',
  'bundledModelAssetsAndChecksums',
  'hardenedRuntimeCompatibility',
  'codeSigningValidation',
  'entitlementsIntentionalAndMinimal',
  'cacheApplicationDataCleanup',
  'installerSizeMeasurement',
  'temporaryArtifactCleanup',
]);

export const MACOS_FILESYSTEM_BLOCKING_CRITERIA = Object.freeze([
  'localApfsCoordinatedTransaction',
  'destinationChangeProtection',
  'permissionsLockedDestination',
  'finderLockedDestination',
  'advisoryFileLock',
  'apfsCrossVolumeBehavior',
  'diskFullBehavior',
  'temporaryImageAndApplicationDataCleanup',
]);

export const MACOS_FILESYSTEM_ADVISORY_CRITERIA = Object.freeze([
  'exfatCrossVolumeBehavior',
  'externalVolumeFallbackAndOriginalPreservation',
  'icloudDriveProviderTransaction',
  'icloudCloudOnlyBeforeOpen',
  'icloudUploadInProgress',
  'dropboxFileProviderTransaction',
  'oneDriveFileProviderTransaction',
  'providerNetworkLoss',
  'providerEviction',
]);

export const MACOS_OCR_PRODUCTION_REQUIRED_CRITERIA = Object.freeze([
  'packagedReleaseApp',
  'macosArm64LiveExecution',
  'tenRecognitionCycles',
  'tenCancellationCycles',
  'uniqueDisposableChildPerJob',
  'noSurvivingChild',
  'settledRetainedRssWithin32MiB',
  'growthWithin2MiBPerCycle',
  'exactGoldenFixtureText',
  'offlineEnforcement',
  'staleResultRejection',
  'viewerResponsiveness',
  'resourceCleanup',
  'modelAndDependencyChecksumVerification',
  'validMacosSidecarArchitecture',
  'universalPackagingArchitectureChecked',
  'pdfiumInitialization',
  'paddleOcrPrimaryEngine',
  'basePlatformContract',
]);

export const EDITOR_COVERAGE_MANIFEST_CONTRACT = 'open-pdf-studio.editor-coverage-manifest';

export const EDITOR_COVERAGE_DIMENSIONS = Object.freeze({
  editorFamilies: Object.freeze([
    'native-source-text',
    'owned-native-edit',
    'inserted-text',
    'ocr-one-line',
    'ocr-fixed-multiline',
    'ocr-reflow',
    'textbox',
    'callout',
  ]),
  viewModes: Object.freeze(['single', 'continuous']),
  rotations: Object.freeze([0, 90, 180, 270]),
  zoomPercents: Object.freeze([100, 150, 250]),
  themes: Object.freeze(['light', 'dark']),
  lifecycleScenarios: Object.freeze([
    'tab-switch',
    'owner-close',
    'compare-entry',
    'properties-formatting',
    'click-away-commit',
    'keyboard-only-controls',
    'large-paste',
    'undo-redo',
    'zoom-without-edit',
  ]),
});

export const REQUIRED_EDITOR_MATRIX_CASE_COUNT =
  EDITOR_COVERAGE_DIMENSIONS.editorFamilies.length
  * EDITOR_COVERAGE_DIMENSIONS.viewModes.length
  * EDITOR_COVERAGE_DIMENSIONS.rotations.length
  * EDITOR_COVERAGE_DIMENSIONS.zoomPercents.length
  * EDITOR_COVERAGE_DIMENSIONS.themes.length;

export const REQUIRED_EDITOR_LIFECYCLE_CASE_COUNT =
  EDITOR_COVERAGE_DIMENSIONS.editorFamilies.length
  * EDITOR_COVERAGE_DIMENSIONS.lifecycleScenarios.length;

export function portableArtifactPath(value) {
  return typeof value === 'string' && value.length > 0
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.split(/[\\/]/u).includes('..');
}

function coverageCaseKey(entry) {
  return [entry?.editorFamily, entry?.viewMode, entry?.rotation, entry?.zoomPercent, entry?.theme].join('|');
}

function lifecycleCaseKey(entry) {
  return [entry?.editorFamily, entry?.scenario].join('|');
}

/** Validate exact, production-only evidence for the required editor matrix. */
export function validateEditorCoverageManifest(manifest, { expectedHead = '' } = {}) {
  const issues = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['required editor coverage manifest is missing'];
  }
  if (manifest?.contract !== EDITOR_COVERAGE_MANIFEST_CONTRACT) {
    issues.push(`coverage contract must be ${EDITOR_COVERAGE_MANIFEST_CONTRACT}`);
  }
  if (manifest?.schemaVersion !== 1) issues.push('coverage schemaVersion must be 1');
  if (manifest?.status !== 'PASS') issues.push('coverage status must be PASS');
  if (!expectedHead) issues.push('coverage expected HEAD is unavailable');
  else if (!manifest?.head) issues.push('coverage HEAD is missing');
  else if (manifest.head !== expectedHead) issues.push(`coverage HEAD ${manifest.head} does not match ${expectedHead}`);
  if (manifest?.productionUiOnly !== true) issues.push('coverage productionUiOnly must be true');
  if (manifest?.syntheticStateSeeding !== false) issues.push('coverage syntheticStateSeeding must be false');
  if (manifest?.testOnlyEntryPoint !== false) issues.push('coverage testOnlyEntryPoint must be false');

  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  const artifactSet = new Set(artifacts.filter(portableArtifactPath));
  if (artifacts.length === 0 || artifactSet.size !== artifacts.length) {
    issues.push('coverage artifacts must be unique, portable relative paths');
  }

  const matrixCases = Array.isArray(manifest?.matrixCases) ? manifest.matrixCases : [];
  const matrixByKey = new Map();
  for (const entry of matrixCases) {
    const key = coverageCaseKey(entry);
    if (matrixByKey.has(key)) issues.push(`coverage matrix case is duplicated: ${key}`);
    matrixByKey.set(key, entry);
  }
  for (const editorFamily of EDITOR_COVERAGE_DIMENSIONS.editorFamilies) {
    for (const viewMode of EDITOR_COVERAGE_DIMENSIONS.viewModes) {
      for (const rotation of EDITOR_COVERAGE_DIMENSIONS.rotations) {
        for (const zoomPercent of EDITOR_COVERAGE_DIMENSIONS.zoomPercents) {
          for (const theme of EDITOR_COVERAGE_DIMENSIONS.themes) {
            const key = coverageCaseKey({ editorFamily, viewMode, rotation, zoomPercent, theme });
            const entry = matrixByKey.get(key);
            if (!entry) issues.push(`coverage matrix case is missing: ${key}`);
            else if (entry.status !== 'PASS') issues.push(`coverage matrix case did not pass: ${key}`);
            else if (!artifactSet.has(entry.artifact)) issues.push(`coverage matrix case lacks declared artifact evidence: ${key}`);
          }
        }
      }
    }
  }
  if (matrixCases.length !== REQUIRED_EDITOR_MATRIX_CASE_COUNT) {
    issues.push(`coverage matrix must contain exactly ${REQUIRED_EDITOR_MATRIX_CASE_COUNT} cases`);
  }

  const lifecycleCases = Array.isArray(manifest?.lifecycleCases) ? manifest.lifecycleCases : [];
  const lifecycleByKey = new Map();
  for (const entry of lifecycleCases) {
    const key = lifecycleCaseKey(entry);
    if (lifecycleByKey.has(key)) issues.push(`coverage lifecycle case is duplicated: ${key}`);
    lifecycleByKey.set(key, entry);
  }
  for (const editorFamily of EDITOR_COVERAGE_DIMENSIONS.editorFamilies) {
    for (const scenario of EDITOR_COVERAGE_DIMENSIONS.lifecycleScenarios) {
      const key = lifecycleCaseKey({ editorFamily, scenario });
      const entry = lifecycleByKey.get(key);
      if (!entry) issues.push(`coverage lifecycle case is missing: ${key}`);
      else if (entry.status !== 'PASS') issues.push(`coverage lifecycle case did not pass: ${key}`);
      else if (!artifactSet.has(entry.artifact)) issues.push(`coverage lifecycle case lacks declared artifact evidence: ${key}`);
    }
  }
  if (lifecycleCases.length !== REQUIRED_EDITOR_LIFECYCLE_CASE_COUNT) {
    issues.push(`coverage lifecycle matrix must contain exactly ${REQUIRED_EDITOR_LIFECYCLE_CASE_COUNT} cases`);
  }
  return issues;
}

const range = (prefix, first, last, width = 2) => Array.from(
  { length: last - first + 1 },
  (_, offset) => `${prefix}${String(first + offset).padStart(width, '0')}`,
);

export const FINDING_IDS = Object.freeze([
  ...range('RB-', 1, 5),
  ...range('H-', 1, 12),
  ...range('M-', 1, 26),
  ...range('P', 1, 9, 1),
  ...range('UX-', 1, 10),
]);

const STATIC = 'static-verification';
const PACKAGED = 'packaged-macos-editor-acceptance';
const PERFORMANCE = 'macos-editor-ocr-performance';
const HARDENING = 'macos-ocr-release-hardening';
const DESKTOPS = [
  'desktop-build-ubuntu-22.04',
  'desktop-build-windows-latest',
  'desktop-build-macos-26',
];

const findingGateMap = new Map();
const assign = (ids, gates) => {
  for (const id of ids) findingGateMap.set(id, Object.freeze([...new Set(gates)]));
};

assign(['RB-01', 'RB-02', 'M-10', 'UX-01', 'UX-02'], [STATIC, PACKAGED]);
assign(['RB-03', 'RB-04', 'H-02', 'H-03', 'M-09', 'P1', 'P4', 'UX-04'], [
  STATIC,
  PACKAGED,
  PERFORMANCE,
]);
assign(['H-01', 'H-05', 'H-07', 'H-08', 'H-12', ...range('M-', 21, 25), 'P2', 'P8', 'UX-05'], [
  STATIC,
  PACKAGED,
  PERFORMANCE,
]);
assign(['H-04', 'H-06', ...range('M-', 1, 8), ...range('M-', 11, 13), 'P3', 'P7', 'P9', 'UX-03', 'UX-06'], [
  STATIC,
  PACKAGED,
  PERFORMANCE,
]);
assign(['H-09', 'M-12', ...range('M-', 14, 19), 'M-26', ...range('UX-', 8, 10)], [STATIC, PACKAGED]);
assign(['H-10', 'H-11', 'M-20', 'P5', 'P6', 'UX-07'], [STATIC, PACKAGED, PERFORMANCE, HARDENING]);
assign(['RB-05'], [STATIC, ...DESKTOPS, PACKAGED, PERFORMANCE, HARDENING, 'repository-controls']);

for (const findingId of FINDING_IDS) {
  if (!findingGateMap.has(findingId)) {
    throw new Error(`release-hardening finding ${findingId} has no required gate mapping`);
  }
}

export const FINDING_REQUIRED_GATES = Object.freeze(Object.fromEntries(findingGateMap));

export const PERFORMANCE_THRESHOLDS = Object.freeze({
  typingToPaintP95Ms: Object.freeze({ comparison: 'lt', limit: 16, unit: 'ms' }),
  warmExactValidationMs: Object.freeze({ comparison: 'lt', limit: 100, unit: 'ms' }),
  maxOrdinaryTypingTaskMs: Object.freeze({ comparison: 'lt', limit: 50, unit: 'ms' }),
  activeExactLayoutTasks: Object.freeze({ comparison: 'lte', limit: 1, unit: 'count' }),
  idlePlacementReads: Object.freeze({ comparison: 'eq', limit: 0, unit: 'count' }),
  idlePlacementWrites: Object.freeze({ comparison: 'eq', limit: 0, unit: 'count' }),
  historyEntries: Object.freeze({ comparison: 'lte', limit: 100, unit: 'count' }),
  historyApproxBytes: Object.freeze({ comparison: 'lte', limit: 12 * 1024 * 1024, unit: 'bytes' }),
  ocrUiPublicationHz: Object.freeze({ comparison: 'lte', limit: 10, unit: 'Hz' }),
  ocrBookkeepingCpuPercent: Object.freeze({ comparison: 'lt', limit: 1, unit: 'percent' }),
  ocrProgressMonotonic: Object.freeze({ comparison: 'eq', limit: true, unit: 'boolean' }),
  lateOcrPublicationAfterCancel: Object.freeze({ comparison: 'eq', limit: false, unit: 'boolean' }),
});

export function metricPasses(value, threshold) {
  if (threshold.comparison === 'eq') return value === threshold.limit;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (threshold.comparison === 'lt') return value < threshold.limit;
  if (threshold.comparison === 'lte') return value <= threshold.limit;
  throw new Error(`unsupported comparison: ${threshold.comparison}`);
}
