import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { createRenderFixture } from './create-render-fixture.mjs';
import {
  EDITOR_COVERAGE_DIMENSIONS,
  PACKAGED_EDITOR_REQUIRED_SUITES,
  REQUIRED_CHECK_NAMES,
  REQUIRED_EDITOR_LIFECYCLE_CASE_COUNT,
  REQUIRED_GATE_IDS,
  REQUIRED_UPSTREAM_JOB_IDS,
} from './ocr-release-hardening-policy.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectDir, relativePath), 'utf8'));
}

test('the primary window is visible from native creation', async () => {
  const config = await readJson('src-tauri/tauri.conf.json');
  assert.equal(config.app.windows[0].visible, true);
});

test('macOS native runtime preparation is wired into local and release builds', async () => {
  const pkg = await readJson('package.json');
  assert.match(pkg.scripts.predev, /prepare:native-runtime/);
  assert.match(pkg.scripts.prebuild, /prepare:native-runtime/);
  assert.equal(pkg.scripts['prepare:native-runtime'], 'node scripts/native-runtime.mjs');
});

test('quality tests do not depend on shell glob expansion', async () => {
  const pkg = await readJson('package.json');
  assert.doesNotMatch(pkg.scripts['test:quality'], /\*/);
  for (const name of [
    'native-runtime.test.mjs',
    'release-config.test.mjs',
    'evaluate-ocr-release-hardening.test.mjs',
    'square-image-annotation.test.mjs',
  ]) {
    assert.match(pkg.scripts['test:quality'], new RegExp(name.replaceAll('.', '\\.')));
  }
});

test('render regression caches the workspace target and prebuilds cold CI jobs', async () => {
  const workflow = await readFile(path.join(repoDir, '.github', 'workflows', 'render-regression.yml'), 'utf8');
  const runner = await readFile(path.join(repoDir, 'scripts', 'run-render-regression.mjs'), 'utf8');
  assert.match(workflow, /^\s+target\s*$/m);
  assert.match(workflow, /uses: actions\/cache\/restore@v4/);
  assert.match(workflow, /uses: actions\/cache\/save@v4/);
  assert.match(workflow, /id: cargo-cache/);
  assert.match(workflow, /key: render-regression-v2-/);
  assert.match(workflow, /name: Prebuild desktop app/);
  assert.match(workflow, /cargo build -p open-pdf-studio/);
  assert.match(workflow, /name: Save cargo registry \+ target\s+if: steps\.cargo-cache\.outputs\.cache-hit != 'true'/);
  assert.doesNotMatch(workflow, /open-pdf-studio\/src-tauri\/target/);
  assert.doesNotMatch(workflow, /open-pdf-render\/target/);
  assert.match(workflow, /timeout-minutes: 45/);
  assert.match(runner, /const MAX_WAIT_MS = 600_000/);
});

test('render regression uses the bundled deterministic PDF fixture', async () => {
  const workflow = await readFile(path.join(repoDir, '.github', 'workflows', 'render-regression.yml'), 'utf8');
  const app = await readFile(path.join(projectDir, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const mcpServer = await readFile(path.join(projectDir, 'src-tauri', 'src', 'mcp_server.rs'), 'utf8');
  assert.match(workflow, /OPS_TEST_PDFS_DIR: \$\{\{ github\.workspace \}\}\/open-pdf-studio\/src-tauri\/resources\/kaders/);
  assert.match(workflow, /--pdf grootformaat_a1_liggend\.pdf/);
  assert.doesNotMatch(workflow, /Prepare deterministic render corpus/);
  assert.match(app, /mcp_server::resolve_test_pdfs_dir/);
  assert.match(mcpServer, /env!\("CARGO_MANIFEST_DIR"\)/);
  assert.doesNotMatch(mcpServer, /std::env::current_dir\(\)/);
});

test('generated render fixture is a complete one-page PDF', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'open-pdf-studio-render-'));
  const output = path.join(dir, 'render-fixture.pdf');
  try {
    await createRenderFixture(output);
    const bytes = await readFile(output);
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 1);
    assert.match(Buffer.from(bytes).subarray(-32).toString('latin1'), /%%EOF/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows installers retain the embedded WebView2 bootstrapper and loader', async () => {
  const config = await readJson('src-tauri/tauri.conf.json');
  const windows = await readJson('src-tauri/tauri.windows.conf.json');
  const resources = { ...config.bundle.resources, ...windows.bundle.resources };
  assert.deepEqual(config.bundle.windows.webviewInstallMode, {
    type: 'embedBootstrapper',
    silent: true,
  });
  assert.equal(resources['WebView2Loader.dll'], 'WebView2Loader.dll');
  assert.equal(resources['binaries/win-x64/pdfium.dll'], 'pdfium.dll');
});

test('Linux resources exclude Windows-only runtime files', async () => {
  const config = await readJson('src-tauri/tauri.conf.json');
  const linux = await readJson('src-tauri/tauri.linux.conf.json');
  const resources = { ...config.bundle.resources, ...linux.bundle.resources };

  assert.equal(resources['WebView2Loader.dll'], undefined);
  assert.equal(resources['binaries/win-x64/pdfium.dll'], undefined);
  assert.deepEqual(config.bundle.externalBin, ['binaries/pdfium-worker']);
  assert.equal(Object.hasOwn(linux.bundle, 'externalBin'), false);
});

test('CI exercises macOS 26 startup and frontend readiness', async () => {
  const workflow = await readFile(path.join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  const smoke = await readFile(path.join(projectDir, 'scripts', 'macos-startup-smoke.sh'), 'utf8');
  assert.match(workflow, /macos-26/);
  assert.match(workflow, /npm run prepare:native-runtime/);
  assert.match(workflow, /macos-startup-smoke\.sh/);
  assert.match(
    workflow,
    /Open PDF Studio\.app\/Contents\/MacOS\/open-pdf-studio/,
    'the OCR gate must launch the CFBundleExecutable, not the display name',
  );
  assert.match(workflow, /createUpdaterArtifacts\\?"?:false/);
  assert.match(smoke, /survival_seconds=10/);
  assert.match(smoke, /kill -0 "\$pid"/);
  assert.match(smoke, /new_crash_report/);
  assert.doesNotMatch(smoke, /CFDictionary/);
});

test('release workflows verify macOS signatures and notarization', async () => {
  for (const name of ['release.yml', 'nightly.yml']) {
    const workflow = await readFile(path.join(repoDir, '.github', 'workflows', name), 'utf8');
    assert.match(workflow, /codesign --verify --deep --strict/);
    assert.match(workflow, /spctl --assess --type execute/);
    assert.match(workflow, /xcrun stapler validate/);
    assert.match(workflow, /macos-startup-smoke\.sh/);
    assert.match(workflow, /APPLE_SIGNING_IDENTITY/);
  }
});

test('macOS release signing includes the hardened PDFium sidecars', async () => {
  const workerEntitlements = await readFile(
    path.join(projectDir, 'src-tauri', 'pdfium-worker.entitlements.plist'),
    'utf8',
  );
  assert.match(workerEntitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.doesNotMatch(workerEntitlements, /network\.client|files\.user-selected|allow-jit/);

  for (const name of ['release.yml', 'nightly.yml']) {
    const workflow = await readFile(path.join(repoDir, '.github', 'workflows', name), 'utf8');
    assert.match(workflow, /Sign macOS PDFium runtime and sidecars/);
    assert.match(workflow, /pdfium-worker-aarch64-apple-darwin/);
    assert.match(workflow, /pdfium-worker-x86_64-apple-darwin/);
    assert.match(workflow, /pdfium-worker-universal-apple-darwin/);
    assert.match(workflow, /pdfium-worker\.entitlements\.plist/);
    assert.match(workflow, /--options runtime --timestamp/);
    assert.match(workflow, /test-macos-release-hardening\.mjs/);
    assert.match(workflow, /--require-distribution-trust/);
  }
});

test('macOS production CI packages arm64 and runs live release-hardening gates', async () => {
  const workflow = await readFile(path.join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /Build ad-hoc signed arm64 macOS app/);
  assert.match(workflow, /--target aarch64-apple-darwin --bundles app/);
  assert.match(workflow, /test-macos-release-hardening\.mjs/);
  assert.match(workflow, /test-macos-filesystem-edge-cases\.mjs/);
  assert.match(workflow, /test-artifacts\/release-hardening\/macos-artifact\.json/);
  assert.match(workflow, /test-artifacts\/release-hardening\/macos-filesystem\.json/);
  for (const scriptName of [
    'test-macos-release-hardening.mjs',
    'test-macos-filesystem-edge-cases.mjs',
    'evaluate-ocr-phase-a-macos-report.mjs',
    'test-ocr-adversarial-macos.mjs',
  ]) {
    const producer = await readFile(path.join(projectDir, 'scripts', scriptName), 'utf8');
    assert.match(producer, /head: await gitHead\(\)/);
  }
});

test('CI makes every hardening branch and protected-main gate explicit', async () => {
  const workflow = await readFile(path.join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /push:[\s\S]*?branches:[\s\S]*?- main[\s\S]*?- ocr-release-hardening/);
  assert.match(workflow, /pull_request:[\s\S]*?branches:[\s\S]*?- main/);
  for (const checkName of REQUIRED_CHECK_NAMES.filter((name) => !name.startsWith('Desktop build ('))) {
    assert.match(workflow, new RegExp(`name: ${checkName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
  }
  assert.match(workflow, /name: Desktop build \(\$\{\{ matrix\.platform \}\}\)/);
  for (const platform of ['ubuntu-22.04', 'windows-latest', 'macos-26']) {
    assert.ok(workflow.includes(`platform: '${platform}'`));
  }
  for (const command of [
    'npm ci',
    'npm run typecheck',
    'npm run test',
    'npm run test:large-pdf-performance:unit',
    'npm run build',
    'git diff --check',
    'cargo test -p open-pdf-studio',
    'cargo test -p pdfium-worker',
    'npm run test:native-text-editing:ui',
    'npm run test:metadata-editing:ui',
    'npm run test:modal-hardening:ui',
    'npm run test:editor-coverage:macos',
    'npm run test:editor-acceptance:macos',
    'node scripts/verify-save-render-coherence-report.mjs',
    'npm run test:ocr-production-100-page:macos',
    'npm run test:editor-performance:macos',
  ]) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  }
  for (const gateId of REQUIRED_GATE_IDS.filter((id) => !id.startsWith('desktop-build-'))) {
    assert.match(workflow, new RegExp(gateId));
  }
  assert.match(workflow, /pattern: ocr-release-hardening-evidence-\*/);
  assert.match(workflow, /OPEN_PDF_STUDIO_BROWSER_ACCEPTANCE_OUTCOME:.*browser_acceptance\.outcome/);
  assert.match(workflow, /OPEN_PDF_STUDIO_EDITOR_COVERAGE_MANIFEST:.*editor-coverage-manifest\.json/);
  assert.match(workflow, /OPEN_PDF_STUDIO_OCR_100_PAGE_REPORT:.*ocr-production-100-page\.json/);
  assert.match(
    workflow,
    /verify-save-render-coherence-report\.mjs[\s\S]*?--commit "\$GITHUB_SHA"/,
  );
  assert.match(workflow, /name: ocr-release-hardening-evidence-save-render-coherence/);
  assert.match(workflow, /if: always\(\)[\s\S]*?Upload final release decision/);
  for (const dependency of REQUIRED_UPSTREAM_JOB_IDS) {
    assert.match(
      workflow,
      new RegExp(`--required-job-result "${dependency}=\\$\\{\\{ needs\\.${dependency}\\.result \\}\\}"`),
    );
  }
  assert.match(workflow, /--expected-repository "\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/rules\/branches\/main\?per_page=100/);
  assert.match(
    workflow,
    /if node -e '[^']*Array\.isArray\(rules\) && rules\.length === 0[^']*' "\$ACTIVE_RULES_PATH"; then[\s\S]*?repos\/\$GITHUB_REPOSITORY\/branches\/main\/protection/,
  );
  assert.match(workflow, /FALLBACK_ARGS=\(\)/);
  assert.match(workflow, /FALLBACK_ARGS=\(--classic-fallback-input "\$CLASSIC_PROTECTION_PATH"\)/);
  assert.match(workflow, /ACTIVE_RULES_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /CLASSIC_PROTECTION_TOKEN: \$\{\{ secrets\.REPOSITORY_CONTROLS_TOKEN \}\}/);
  assert.match(workflow, /Authorization: Bearer \$ACTIVE_RULES_TOKEN/);
  assert.match(workflow, /Authorization: Bearer \$CLASSIC_PROTECTION_TOKEN/);
  assert.match(workflow, /--active-rules-input "\$ACTIVE_RULES_PATH"/);
  assert.match(workflow, /"\$\{FALLBACK_ARGS\[@\]\}"/);
  assert.match(workflow, /id: ocr_adversarial[\s\S]*?test:ocr-adversarial:macos/);
  assert.match(workflow, /adversarial-latest\.json[\s\S]*?adversarial-packaged\.json/);
  assert.match(workflow, /ADVERSARIAL_OUTCOME:.*steps\.ocr_adversarial\.outcome/);
  assert.match(workflow, /OCR_100_PAGE_OUTCOME:.*steps\.ocr_100_page_performance\.outcome/);
  assert.match(workflow, /test "\$ADVERSARIAL_OUTCOME" = success/);
  assert.match(workflow, /test "\$OCR_100_PAGE_OUTCOME" = success/);
  assert.match(
    workflow,
    /cp -R "\$RUNNER_TEMP\/release-hardening-evidence\/\." "\$RUNNER_TEMP\/test-artifacts\/"/,
  );
  assert.match(workflow, /output\/ocr-release-hardening\/acceptance\.json/);
});

test('release reports preserve editor coverage and 100-page producer command provenance', async () => {
  const [editorAcceptance, editorPerformance] = await Promise.all([
    readFile(path.join(projectDir, 'scripts', 'run-editor-acceptance-macos.mjs'), 'utf8'),
    readFile(path.join(projectDir, 'scripts', 'test-editor-performance-macos.mjs'), 'utf8'),
  ]);
  assert.match(editorAcceptance, /testCommands:[\s\S]*npm run test:editor-coverage:macos/u);
  assert.match(editorPerformance, /testCommands:[\s\S]*npm run test:ocr-production-100-page:macos/u);
});

test('editor lifecycle policy requires click-away commit for every editor family', () => {
  assert.equal(EDITOR_COVERAGE_DIMENSIONS.editorFamilies.length, 8);
  assert.equal(EDITOR_COVERAGE_DIMENSIONS.lifecycleScenarios.length, 9);
  assert.ok(EDITOR_COVERAGE_DIMENSIONS.lifecycleScenarios.includes('click-away-commit'));
  assert.equal(REQUIRED_EDITOR_LIFECYCLE_CASE_COUNT, 72);
});

test('every visible Save control is commit-aware while a text draft is active', async () => {
  const [titleBar, appMenu] = await Promise.all([
    readFile(path.join(projectDir, 'js', 'solid', 'components', 'TitleBar.jsx'), 'utf8'),
    readFile(path.join(projectDir, 'js', 'solid', 'components', 'app-menu', 'AppMenu.jsx'), 'utf8'),
  ]);
  assert.match(titleBar, /data-action="save" data-text-edit-commit-action="true"/u);
  assert.match(titleBar, /data-action="save-as" data-text-edit-commit-action="true"/u);
  assert.match(appMenu, /data-text-edit-commit-action=\{props\.commitAction/u);
  assert.match(appMenu, /label=\{t\('save'\)\}[^\n]+commitAction/u);
  assert.match(appMenu, /label=\{t\('saveAs'\)\}[^\n]+commitAction/u);
});

test('branch-protection policy is documented as external repository state', async () => {
  const guide = await readFile(path.join(projectDir, 'docs', 'ocr', 'OCR_RELEASE_HARDENING_GATE.md'), 'utf8');
  for (const checkName of REQUIRED_CHECK_NAMES) assert.match(guide, new RegExp(checkName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(guide, /cannot\s+enable or prove that setting/);
  assert.match(guide, /evaluate-github-branch-protection\.mjs/);
  assert.match(guide, /ad-hoc signed/);
  assert.match(guide, /not evidence of Developer ID signing, Apple notarization/);
  assert.match(guide, /exactly 384 view cases and 72\s+lifecycle cases/);
  assert.match(guide, /outside the editor portal and properties-panel focus boundary/);
  assert.match(guide, /MACOS OCR RELEASE HARDENING NO-GO/);
});

test('release-hardening filesystem infrastructure uses disposable real volumes and fail-closed iCloud evidence', async () => {
  const script = await readFile(
    path.join(projectDir, 'scripts', 'test-macos-filesystem-edge-cases.mjs'),
    'utf8',
  );
  assert.match(script, /createArgs = \['create'/);
  assert.match(script, /\/usr\/bin\/hdiutil/);
  assert.match(script, /fileSystem: 'APFS'/);
  assert.match(script, /fileSystem: 'ExFAT'/);
  assert.match(script, /ENOSPC/);
  assert.match(script, /chflags/);
  assert.match(script, /macos-hold-file-lock\.swift/);
  assert.match(script, /isUbiquitous/);
  assert.match(script, /liveProviderTransactionPerformed: false/);
  assert.match(script, /status\('UNVERIFIED'/);
  assert.match(script, /hdiutil', \['detach'/);
  assert.match(script, /rm\(tempRoot, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(script, /mock.*icloud|fake.*icloud/iu);
});

test('release-hardening scripts and machine evidence are wired without committing images', async () => {
  const pkg = await readJson('package.json');
  assert.equal(pkg.scripts['package:ocr-release-hardening:arm64'], 'node scripts/package-macos-release-arm64.mjs');
  assert.match(pkg.scripts['test:ocr-release-hardening:macos'], /artifact.*filesystem/);
  assert.match(pkg.scripts['test:ocr-packaged:macos:stages'], /test:ocr-release-hardening:macos/);
  assert.match(pkg.scripts['test:ocr-packaged:macos'], /test:ocr-packaged:macos:stages/);
  assert.match(pkg.scripts['test:ocr-packaged:macos'], /OPEN_PDF_STUDIO_PACKAGED_APP=.*aarch64-apple-darwin/);
  assert.match(pkg.scripts['test:ocr-packaged:macos'], /OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE=.*aarch64-apple-darwin/);
  assert.equal(pkg.scripts['test:editor-acceptance:macos'], 'node scripts/run-editor-acceptance-macos.mjs');
  assert.equal(pkg.scripts['test:editor-coverage:macos'], 'node scripts/test-editor-coverage-macos.mjs');
  assert.equal(
    pkg.scripts['test:annotation-text-editing:macos'],
    'node scripts/test-annotation-text-editing-macos.mjs',
  );
  assert.equal(PACKAGED_EDITOR_REQUIRED_SUITES.includes('test:annotation-text-editing:macos'), true);
  assert.equal(PACKAGED_EDITOR_REQUIRED_SUITES.includes('test:save-render-coherence:macos'), true);
  assert.equal(PACKAGED_EDITOR_REQUIRED_SUITES.includes('test:ocr-workflow:macos'), true);
  assert.equal(PACKAGED_EDITOR_REQUIRED_SUITES.includes('test:ocr-ui:macos'), false);
  const packagedAggregate = await readFile(
    path.join(projectDir, 'scripts', 'run-editor-acceptance-macos.mjs'),
    'utf8',
  );
  assert.match(packagedAggregate, /const failedSuites = report\.suites\.filter/);
  assert.match(packagedAggregate, /report\.failures = \[[\s\S]*failedSuites\.map/);
  assert.match(packagedAggregate, /browserAcceptance\.status === 'PASS'/);
  assert.match(packagedAggregate, /validateEditorCoverageManifest/);
  assert.match(packagedAggregate, /validateAnnotationEvidence\(outputDir, report\.head\)/);
  assert.match(packagedAggregate, /validateCoherenceEvidence\(outputDir, report\.head\)/);
  assert.match(packagedAggregate, /annotation evidence HEAD does not match the aggregate/);
  const coverageProducer = await readFile(
    path.join(projectDir, 'scripts', 'test-editor-coverage-macos.mjs'),
    'utf8',
  );
  assert.match(coverageProducer, /startPackagedApp/);
  assert.match(coverageProducer, /activateTool\('#ep-edit-text', 'editText'\)/);
  assert.match(coverageProducer, /call\('app_mouse_click', point\)/);
  assert.match(coverageProducer, /call\('app_paste', \{ text: pasteText \}\)/);
  assert.match(coverageProducer, /\.document-tab\[data-index=/);
  assert.match(coverageProducer, /\.unsaved-close-cancel/);
  assert.match(coverageProducer, /\.unsaved-close-dont-save/);
  assert.match(coverageProducer, /\.quick-access-btn\[data-action="undo"\]/);
  assert.match(coverageProducer, /\.quick-access-btn\[data-action="redo"\]/);
  assert.match(coverageProducer, /clickAtElement\('\.status-page-input'\)/);
  assert.match(coverageProducer, /recordLifecycle\(adapter, 'click-away-commit'/);
  assert.match(coverageProducer, /EDITOR_COVERAGE_DIMENSIONS\.editorFamilies/);
  assert.match(coverageProducer, /EDITOR_COVERAGE_DIMENSIONS\.lifecycleScenarios/);
  assert.match(coverageProducer, /assert\.equal\(matrixCases\.length, REQUIRED_EDITOR_MATRIX_CASE_COUNT\)/);
  assert.match(coverageProducer, /assert\.equal\(lifecycleCases\.length, REQUIRED_EDITOR_LIFECYCLE_CASE_COUNT\)/);
  assert.match(coverageProducer, /rm\(options\.outputPath, \{ force: true \}\)/);
  assert.match(coverageProducer, /rename\(temporaryManifestPath, options\.outputPath\)/);
  assert.doesNotMatch(coverageProducer, /app_create_annotation|state\.documents|activeDocumentIndex/);
  assert.doesNotMatch(coverageProducer, /call\('app_(?:switch_tab|undo|redo)'/);
  const annotationTextAcceptance = await readFile(
    path.join(projectDir, 'scripts', 'test-annotation-text-editing-macos.mjs'),
    'utf8',
  );
  for (const productionAction of [
    "callTool('app_new_blank_pdf'",
    "callTool('app_set_tool', { tool: 'addText' })",
    "createAnnotationText('textbox'",
    "createAnnotationText('callout'",
    "callTool('app_mouse_click'",
    "callTool('app_mouse_drag'",
    "clickAway.target?.classes?.includes('status-page-input')",
    "callTool('app_key', { key: 'Escape' })",
    "callTool('app_save_pdf'",
    "callTool('app_open_pdf'",
  ]) {
    assert.match(
      annotationTextAcceptance,
      new RegExp(productionAction.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
      `packaged annotation acceptance must use ${productionAction}`,
    );
  }
  assert.match(annotationTextAcceptance, /assert\.equal\(apply\.found, false/);
  assert.match(annotationTextAcceptance, /assert\.equal\(cancel\.found, false/);
  assert.match(annotationTextAcceptance, /assert\.equal\(substitutionDialog\.found, false/);
  assert.match(annotationTextAcceptance, /double: true/);
  assert.match(annotationTextAcceptance, /productionUiOnly: true/);
  assert.match(annotationTextAcceptance, /syntheticStateSeeding: false/);
  assert.match(annotationTextAcceptance, /testOnlyEntryPoint: false/);
  assert.doesNotMatch(annotationTextAcceptance, /app_create_annotation/);
  assert.doesNotMatch(annotationTextAcceptance, /core\/state|state\.documents|activeDocumentIndex/);
  assert.match(pkg.scripts['test:ocr-ui:macos'], /test:ocr-ui:browser:macos.*test:ocr-workflow:macos/);
  const workflow = await readFile(path.join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(
    workflow.indexOf('Run genuine packaged editor coverage matrix')
      < workflow.indexOf('Run production packaged editor acceptance'),
    'real editor coverage must run before packaged acceptance consumes its manifest',
  );
  assert.match(workflow, /test:editor-coverage:macos[\s\S]*editor-coverage-manifest\.json/);
  assert.match(workflow, /OPEN_PDF_STUDIO_TEST_ARTIFACT_DIR:.*test-artifacts\/browser-ui/);
  assert.match(workflow, /test:ocr-ui:browser:macos.*tee.*test-artifacts\/browser-ui\/ocr-ui\.log/);
  assert.match(workflow, /id: browser_acceptance\s+continue-on-error: true/);
  assert.match(workflow, /browser_status=0[\s\S]*exit "\$browser_status"/);
  assert.match(workflow, /Run production packaged editor acceptance\s+if: always\(\)/);
  assert.match(workflow, /steps\.browser_acceptance\.outcome != 'success'/);
  assert.match(workflow, /test:ocr-production-100-page:macos/);
  assert.match(workflow, /test:editor-performance:macos[\s\S]*test-artifacts\/editor-performance\/console\.log/);
  assert.match(workflow, /Evaluate authoritative PR or fail-closed diagnostic decision/);
  assert.match(
    workflow,
    /continue-on-error: \$\{\{ github\.event_name != 'pull_request' \|\| github\.base_ref != 'main' \}\}/,
  );
  for (const releaseContextArgument of [
    '--event-name', '--base-ref', '--head-ref', '--github-ref',
    '--event-repository', '--event-payload', '--local-diagnostic',
  ]) {
    assert.match(workflow, new RegExp(releaseContextArgument));
  }
  assert.match(workflow, /GITHUB_EVENT_PATH/);
  const hardeningGateDocumentation = await readFile(
    path.join(projectDir, 'docs', 'ocr', 'OCR_RELEASE_HARDENING_GATE.md'),
    'utf8',
  );
  assert.match(hardeningGateDocumentation, /authoritative-release-context/);
  assert.match(hardeningGateDocumentation, /--local-diagnostic/);
  assert.match(hardeningGateDocumentation, /open `pull_request` targeting `main`/);
  const playwrightArtifacts = await readFile(
    path.join(projectDir, 'scripts', 'playwright-failure-artifacts.mjs'),
    'utf8',
  );
  assert.match(playwrightArtifacts, /failure\.png/);
  assert.match(playwrightArtifacts, /failure-trace\.zip/);
  for (const scriptName of [
    'test-native-paragraph-editing.mjs',
    'test-inline-document-metadata.mjs',
    'test-modal-hardening.mjs',
    'test-ocr-searchable-layer-macos.mjs',
    'test-ocr-recognition-dialog-macos.mjs',
    'test-ocr-progress-macos.mjs',
    'test-ocr-review-macos.mjs',
  ]) {
    const browserScript = await readFile(path.join(projectDir, 'scripts', scriptName), 'utf8');
    assert.match(browserScript, /startPlaywrightFailureArtifacts/);
  }
  assert.match(pkg.scripts['test:editor-performance:macos'], /test-editor-performance-macos\.mjs/);
  assert.match(pkg.scripts['test:editor-performance:macos'], /verify-editor-performance-report\.mjs/);
  const performanceProducer = await readFile(
    path.join(projectDir, 'scripts', 'test-editor-performance-macos.mjs'),
    'utf8',
  );
  assert.match(performanceProducer, /contract: 'open-pdf-studio\.editor-performance'/);
  assert.match(performanceProducer, /gateId: 'macos-editor-ocr-performance'/);
  assert.match(performanceProducer, /framePaced: true/);
  assert.match(performanceProducer, /measurePerformance: true/);
  assert.match(performanceProducer, /OPEN_PDF_STUDIO_OCR_100_PAGE_REPORT/);
  assert.match(performanceProducer, /ocrProduction100Page/);
  assert.doesNotMatch(performanceProducer, /workflow-performance\.js/);
  assert.match(pkg.scripts['test:editor-lifecycle:unit'], /document-lifecycle\.test\.mjs/);
  assert.match(pkg.scripts['test:editor-lifecycle:unit'], /text-edit-session\.test\.mjs/);
  assert.equal(pkg.scripts['evaluate:ocr-release-hardening'], 'node scripts/evaluate-ocr-release-hardening.mjs');
  const packager = await readFile(path.join(projectDir, 'scripts', 'package-macos-release-arm64.mjs'), 'utf8');
  assert.match(packager, /aarch64-apple-darwin/);
  assert.match(packager, /x86_64-apple-darwin/);
  assert.match(packager, /lipo/);
  assert.match(packager, /\/usr\/bin\/codesign/);
  assert.match(packager, /pdfium-worker\.entitlements\.plist/);
  assert.match(packager, /--options', 'runtime/);
  assert.match(packager, /createUpdaterArtifacts/);
  const ignore = await readFile(path.join(repoDir, '.gitignore'), 'utf8');
  assert.match(ignore, /open-pdf-studio\/output\/ocr-release-hardening\//);
  assert.match(ignore, /open-pdf-studio\/test-artifacts\//);
  assert.match(ignore, /\*\*\/binaries\/macos-universal\//);
  assert.match(ignore, /\*\*\/binaries\/pdfium-worker-\*/);
});

test('100-page and adversarial release qualification stay on the visible production path', async () => {
  const pkg = await readJson('package.json');
  assert.equal(
    pkg.scripts['generate:ocr-release-qualification-fixtures'],
    'node scripts/generate-ocr-release-qualification-fixtures.mjs',
  );
  assert.equal(
    pkg.scripts['test:ocr-production-100-page:macos'],
    'node scripts/test-ocr-production-100-page-macos.mjs',
  );
  assert.equal(
    pkg.scripts['test:ocr-adversarial:macos'],
    'node scripts/test-ocr-adversarial-macos.mjs',
  );
  assert.match(pkg.scripts['test:ocr-release-qualification:macos'], /test:ocr-adversarial:unit/);
  assert.match(pkg.scripts['test:ocr-release-qualification:macos'], /test:ocr-adversarial:macos/);
  assert.match(pkg.scripts['test:ocr-release-qualification:macos'], /test:ocr-production-100-page:macos/);
  assert.match(pkg.scripts['test:ocr-packaged:macos:stages'], /test:ocr-release-qualification:macos/);

  const longRun = await readFile(
    path.join(projectDir, 'scripts', 'test-ocr-production-100-page-macos.mjs'),
    'utf8',
  );
  assert.match(longRun, /#ep-recognize-text/);
  assert.match(longRun, /#ocr-recognition-form/);
  assert.match(longRun, /entire-document/);
  assert.match(longRun, /testOnlyOcrEntryPointUsed: false/);
  assert.match(longRun, /ocrStateInjectionUsed: false/);
  assert.doesNotMatch(longRun, /app_ocr_phase_a_spike/);

  const adversarial = await readFile(
    path.join(projectDir, 'scripts', 'test-ocr-adversarial-macos.mjs'),
    'utf8',
  );
  assert.match(adversarial, /#ep-recognize-text/);
  assert.match(adversarial, /head: await gitHead\(\)/);
  assert.match(adversarial, /platform: \{ operatingSystem: process\.platform, architecture: process\.arch \}/);
  assert.match(adversarial, /testOnlyOcrEntryPointUsed: false/);
  assert.doesNotMatch(adversarial, /app_ocr_phase_a_spike/);

  const corpus = await readJson('tests/fixtures/ocr/release-qualification-v1/corpus.v1.json');
  assert.equal(corpus.license, 'CC0-1.0');
  assert.equal(corpus.generatedArtifactsCommitted, false);
  assert.equal(corpus.longRun.pageCount, 100);
  assert.equal(corpus.adversarialCases.length, 21);
  assert.ok(corpus.adversarialCases.every((value) => value.bounds && value.expectedCleanup.length > 0));
});

test('macOS OCR notices include the PDFium 7834 ICU license addition', async () => {
  const notices = await readFile(path.join(projectDir, 'docs', 'ocr', 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const supplement = await readFile(
    path.join(projectDir, 'docs', 'ocr', 'licenses', 'pdfium-7834-icu4j-sorttable-MIT.txt'),
    'utf8',
  );
  assert.match(notices, /PDFium 7834 archive adds an ICU4J/);
  assert.match(notices, /pdfium-7834-icu4j-sorttable-MIT\.txt/);
  assert.match(supplement, /Copyright \(c\) 1997-date Stuart Langridge/);
  assert.match(supplement, /Permission is hereby granted, free of charge/);
});

test('macOS bundling retries transient notarization service failures', async () => {
  let retryModule;
  try {
    retryModule = await import('./macos-notarization-retry.mjs');
  } catch {
    retryModule = null;
  }
  assert.equal(typeof retryModule?.bundleMacOSWithRetry, 'function');

  const results = [
    { code: 1, output: 'failed to notarize app: HTTP status code: 500. Please try again later.' },
    { code: 0, output: 'bundle complete' },
  ];
  const attempts = [];
  const cleanups = [];
  const waits = [];
  const result = await retryModule.bundleMacOSWithRetry({
    runBundle: async (attempt) => {
      attempts.push(attempt);
      return results.shift();
    },
    cleanBundleOutput: async () => cleanups.push('clean'),
    wait: async (milliseconds) => waits.push(milliseconds),
    logger: { error() {}, log() {} },
    retryDelayMs: 25,
  });

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(cleanups, ['clean', 'clean']);
  assert.deepEqual(waits, [25]);
  assert.deepEqual(result, { attempts: 2 });
});

test('macOS bundling does not retry non-transient failures', async () => {
  const { bundleMacOSWithRetry } = await import('./macos-notarization-retry.mjs');
  let attempts = 0;
  await assert.rejects(
    bundleMacOSWithRetry({
      runBundle: async () => {
        attempts += 1;
        return { code: 2, output: 'configuration file is invalid' };
      },
      cleanBundleOutput: async () => {},
      wait: async () => {},
      logger: { error() {}, log() {} },
    }),
    /configuration file is invalid/,
  );
  assert.equal(attempts, 1);
});

test('macOS bundling rejects invalid retry configuration', async () => {
  const { bundleMacOSWithRetry } = await import('./macos-notarization-retry.mjs');
  const options = {
    runBundle: async () => ({ code: 0, output: '' }),
    cleanBundleOutput: async () => {},
    wait: async () => {},
    logger: { error() {}, log() {} },
  };

  await assert.rejects(
    bundleMacOSWithRetry({ ...options, maxAttempts: 0 }),
    /maxAttempts must be a positive integer/,
  );
  await assert.rejects(
    bundleMacOSWithRetry({ ...options, retryDelayMs: Number.NaN }),
    /retryDelayMs must be a non-negative integer/,
  );
});

test('release workflows compile macOS once and retry only the bundle phase', async () => {
  for (const name of ['release.yml', 'nightly.yml']) {
    const workflow = await readFile(path.join(repoDir, '.github', 'workflows', name), 'utf8');
    assert.match(workflow, /Build macOS app without bundles/);
    assert.match(workflow, /--target universal-apple-darwin --no-bundle/);
    assert.match(workflow, /node scripts\/macos-notarization-retry\.mjs/);
    assert.match(workflow, /Upload macOS release assets/);
    assert.doesNotMatch(workflow, /retryAttempts:/);
  }
});

test('release metadata is versie-consistent met package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const cargo = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  const cargoLock = await readFile(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8');
  // Geen hardgecodeerde versie: elke bump brak deze test terwijl er niets mis
  // was. Het contract is CONSISTENTIE — alle metadata volgt package.json.
  const v = pkg.version;
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(packageLock.version, v);
  assert.equal(packageLock.packages[''].version, v);
  assert.equal(config.version, v);
  assert.match(cargo, new RegExp(`^version = "${v.replaceAll('.', '\.')}"$`, 'm'));
  assert.match(cargoLock, new RegExp(`name = "open-pdf-studio"\r?\nversion = "${v.replaceAll('.', '\.')}"`));
});

test('development optimization profiles live at the workspace root', async () => {
  const workspaceCargo = await readFile(path.join(repoDir, 'Cargo.toml'), 'utf8');
  const appCargo = await readFile(path.join(projectDir, 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.match(workspaceCargo, /\[profile\.dev\.package\.open-pdf-render\]/);
  assert.match(workspaceCargo, /\[profile\.dev\.package\.pdfium-render\]/);
  assert.doesNotMatch(appCargo, /\[profile\./);
});
