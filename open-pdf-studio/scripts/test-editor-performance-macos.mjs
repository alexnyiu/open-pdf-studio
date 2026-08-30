import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { evaluateEditorPerformanceReport } from './verify-editor-performance-report.mjs';
import { startPackagedApp } from './lib/macos-packaged-app.mjs';

assert.equal(process.platform, 'darwin', 'editor performance acceptance is macOS-only');

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const defaultBundle = path.join(
  repoDir,
  'target',
  'aarch64-apple-darwin',
  'release',
  'bundle',
  'macos',
  'Open PDF Studio.app',
);

function parseArguments(argv) {
  const options = {
    appBundle: path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || defaultBundle),
    outputPath: path.resolve(
      process.env.OPEN_PDF_STUDIO_EDITOR_PERFORMANCE_REPORT
        || path.join(projectDir, 'test-artifacts', 'editor-performance', 'performance.json'),
    ),
    ocrReportPath: path.resolve(
      process.env.OPEN_PDF_STUDIO_OCR_100_PAGE_REPORT
        || path.join(projectDir, 'output', 'ocr-release-hardening', 'production-100-page-latest.json'),
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--app') options.appBundle = path.resolve(argv[++index]);
    else if (value === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (value === '--ocr-report') options.ocrReportPath = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function gitHead() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
  return stdout.trim();
}

async function bundleIdentity(appBundle) {
  const executablePath = path.join(appBundle, 'Contents', 'MacOS', 'open-pdf-studio');
  const plistPath = path.join(appBundle, 'Contents', 'Info.plist');
  const executable = await stat(executablePath);
  const plistValue = async (key) => {
    try {
      const { stdout } = await execFileAsync('/usr/bin/plutil', [
        '-extract', key, 'raw', '-o', '-', plistPath,
      ]);
      return stdout.trim();
    } catch {
      return null;
    }
  };
  return {
    bundlePath: appBundle,
    executablePath,
    bundleIdentifier: await plistValue('CFBundleIdentifier'),
    shortVersion: await plistValue('CFBundleShortVersionString'),
    bundleVersion: await plistValue('CFBundleVersion'),
    executableBytes: executable.size,
    signingScope: 'CI usability and hardened-runtime compatibility; not Developer ID or notarization evidence',
  };
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function runPerformance(options) {
  const fixture = path.join(projectDir, 'tests', 'fixtures', 'text', 'native-paragraph-table.pdf');
  const outputDir = path.dirname(options.outputPath);
  const runDir = await mkdtemp(path.join(tmpdir(), 'opds-editor-performance-'));
  const workingPdf = path.join(runDir, 'native-paragraph-performance.pdf');
  const sessionPath = path.join(runDir, 'session.json');
  const stdoutPath = path.join(outputDir, 'app.stdout.log');
  const stderrPath = path.join(outputDir, 'app.stderr.log');
  const executablePath = path.join(options.appBundle, 'Contents', 'MacOS', 'open-pdf-studio');
  const head = await gitHead();
  const ocrProduction100Page = await readJsonOrNull(options.ocrReportPath);
  const workflowPublication = ocrProduction100Page?.performance?.workflowPublication ?? null;
  const ocrProductionPath = ocrProduction100Page?.automation?.genericPackagedUiAutomation === true
    && ocrProduction100Page?.automation?.ocrStateInjectionUsed === false
    && ocrProduction100Page?.automation?.unitControllerUsed === false
    && ocrProduction100Page?.automation?.adapterDirectlyUsed === false
    ? 'packaged-production-ui-native-ocr'
    : null;
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    access(options.appBundle),
    access(executablePath),
    access(fixture),
    copyFile(fixture, workingPdf),
  ]);

  const reportBase = {
    contract: 'open-pdf-studio.editor-performance',
    schemaVersion: 1,
    gateId: 'macos-editor-ocr-performance',
    status: 'RUNNING',
    head,
    generatedAt: new Date().toISOString(),
    platform: { os: process.platform, architecture: process.arch },
    packagedApp: await bundleIdentity(options.appBundle),
    fixture: {
      editor: path.relative(projectDir, fixture),
      editorCharacters: 500,
      ocr: ocrProduction100Page?.fixture?.complete ?? null,
    },
    provenance: {
      editor: {
        execution: 'packaged-production-ui',
        realClock: true,
        virtualTime: false,
        serviceOnly: false,
        stateSeeding: false,
      },
      ocr: {
        sourceContract: ocrProduction100Page?.contract ?? null,
        sourceHead: ocrProduction100Page?.head ?? null,
        execution: ocrProductionPath,
        instrumentationAvailable: workflowPublication?.instrumentationAvailable ?? null,
        uiSubscriberMounted: workflowPublication?.uiSubscriberMounted ?? null,
        realClock: workflowPublication?.realClock ?? null,
        syntheticEvents: workflowPublication?.syntheticEvents ?? null,
        virtualTime: workflowPublication?.virtualTime ?? null,
        serviceOnly: workflowPublication?.serviceOnly ?? null,
        failedOpen: workflowPublication?.failedOpen ?? null,
      },
    },
    instrumentation: { editor: null },
    testCommands: [
      'npm run test:ocr-production-100-page:macos',
      'npm run test:editor-performance:macos',
    ],
    artifacts: [
      path.relative(outputDir, options.outputPath),
      path.basename(stdoutPath),
      path.basename(stderrPath),
    ],
  };
  await writeFile(options.outputPath, `${JSON.stringify(reportBase, null, 2)}\n`);

  let application = null;

  async function callTool(name, arguments_ = {}) {
    if (!application) throw new Error('packaged application is not ready');
    return application.callTool(name, arguments_);
  }

  async function waitUntil(description, probe, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await probe().catch(() => null);
      if (latest) return latest;
      await delay(100);
    }
    throw new Error(`timed out waiting for ${description}: ${JSON.stringify(latest)}`);
  }

  async function ui(selector) {
    return callTool('app_ui_state', { selector, searchTabs: false });
  }

  try {
    application = await startPackagedApp({
      appBundle: options.appBundle,
      cwd: projectDir,
      env: { OPS_TEST_SESSION_PATH: sessionPath },
      artifactDir: path.join(outputDir, 'launch-logs'),
      launchLabel: 'editor-performance',
      startupTimeoutMs: 90_000,
    });
    await callTool('app_set_window_size', { width: 1320, height: 900 });
    const opened = await callTool('app_open_pdf', { path: workingPdf });
    assert.equal(opened.ok, true, opened.error);
    await waitUntil('performance fixture', async () => {
      const viewport = await callTool('app_get_viewport_state');
      return viewport.doc?.filePath === workingPdf ? viewport : null;
    }, 60_000);
    const toolClick = await callTool('app_click_element', {
      selector: '#ep-edit-text',
      searchTabs: true,
    });
    assert.equal(toolClick.clicked, true, toolClick.error);
    const tool = await callTool('app_get_current_tool');
    assert.equal(tool.tool, 'editText');
    const sourceSelector = '.textLayer span[data-item-index="2"]';
    await waitUntil('native paragraph source', async () => {
      const source = await ui(sourceSelector);
      return source.found && source.visible && source.rect.width > 5 ? source : null;
    }, 60_000);
    const clicked = await callTool('app_click_element', { selector: sourceSelector, searchTabs: false });
    assert.equal(clicked.clicked, true, clicked.error);

    await waitUntil('automatically substituted native paragraph editor', async () => {
      const editor = await ui('.pdf-text-editor');
      if (editor.found && editor.visible) return editor;
      return null;
    }, 30_000);
    assert.equal((await ui('.font-substitution-dialog')).found, false);
    assert.equal((await ui('.pdf-text-editor-apply')).found, false);
    assert.equal((await ui('.pdf-text-editor-cancel')).found, false);
    const editor = await waitUntil('focused native paragraph editor', async () => {
      const value = await ui('.pdf-text-editor');
      return value.found && value.visible && value.focused && value.pageTextEditHost?.attached
        ? value : null;
    }, 30_000);
    assert.equal(editor.pageTextEditHost.page, '1');

    await callTool('app_key', { key: 'a', meta: true });
    const typedText = 'Performance typing sample 0123456789 '.repeat(20).slice(0, 500);
    assert.equal([...typedText].length, 500);
    const typing = await callTool('app_type', {
      text: typedText,
      framePaced: true,
      measurePerformance: true,
    });
    assert.equal(typing.ok, true, typing.error);
    assert.equal(typing.typed, 500);
    assert.equal(typing.performance?.samples, 500);

    const activeMetrics = await waitUntil('settled exact layout', async () => {
      const viewport = await callTool('app_get_viewport_state');
      const layout = viewport.editorMetrics?.layoutState;
      return layout
        && layout.pending === false
        && typeof layout.valid === 'boolean'
        && typeof layout.requestedFingerprint === 'string'
        && layout.requestedFingerprint === layout.validatedFingerprint
        && viewport.editorMetrics?.exactLayout?.activeTasks === 0
        ? viewport
        : null;
    }, 30_000);
    assert.ok(activeMetrics.editorMetrics?.history, 'history metrics were unavailable');

    const placementDelta = (start, end, field) => {
      const startValue = Number(start.editorMetrics?.placement?.[field]);
      const endValue = Number(end.editorMetrics?.placement?.[field]);
      return Number.isFinite(startValue) && Number.isFinite(endValue)
        ? Math.max(0, endValue - startValue)
        : null;
    };
    const waitForPlacementIdle = async (description, timeoutMs = 10_000) => {
      let previous = await callTool('app_get_viewport_state');
      let quietWindows = 0;
      return waitUntil(description, async () => {
        await delay(150);
        const current = await callTool('app_get_viewport_state');
        const reads = placementDelta(previous, current, 'reads');
        const writes = placementDelta(previous, current, 'writes');
        previous = current;
        quietWindows = reads === 0 && writes === 0 ? quietWindows + 1 : 0;
        return quietWindows >= 2 ? current : null;
      }, timeoutMs);
    };

    // Keep the exact-layout-settled editor open while sampling. The 500-byte
    // stress draft may validly exceed its page/column clamp, which disables
    // Apply, but a permanent placement RAF would still remain hidden in that
    // state. Performance acceptance requires a current exact result, not that
    // an intentionally oversized draft be committable.
    const activeEditorIdleStart = await waitForPlacementIdle('active editor placement to become idle');
    await delay(500);
    const activeEditorIdleEnd = await callTool('app_get_viewport_state');
    const activeEditorIdleReads = placementDelta(activeEditorIdleStart, activeEditorIdleEnd, 'reads');
    const activeEditorIdleWrites = placementDelta(activeEditorIdleStart, activeEditorIdleEnd, 'writes');

    await callTool('app_key', { key: 'Escape' });
    await waitUntil('editor cancellation', async () => {
      const value = await ui('.pdf-text-editor');
      return !value.found ? true : null;
    });
    const noEditorIdleStart = await waitForPlacementIdle('closed editor placement to become idle');
    await delay(500);
    const noEditorIdleEnd = await callTool('app_get_viewport_state');
    const noEditorIdleReads = placementDelta(noEditorIdleStart, noEditorIdleEnd, 'reads');
    const noEditorIdleWrites = placementDelta(noEditorIdleStart, noEditorIdleEnd, 'writes');
    const idlePlacementReads = [activeEditorIdleReads, noEditorIdleReads]
      .every(Number.isFinite)
      ? Math.max(activeEditorIdleReads, noEditorIdleReads)
      : null;
    const idlePlacementWrites = [activeEditorIdleWrites, noEditorIdleWrites]
      .every(Number.isFinite)
      ? Math.max(activeEditorIdleWrites, noEditorIdleWrites)
      : null;

    const raw = {
      ...reportBase,
      completedAt: new Date().toISOString(),
      instrumentation: {
        editor: typing.performance.instrumentation ?? null,
      },
      metrics: {
        typingToPaintP95Ms: typing.performance.typingToPaintP95Ms,
        warmExactValidationMs: typing.performance.warmExactValidationMs,
        maxOrdinaryTypingTaskMs: typing.performance.maxOrdinaryTypingTaskMs,
        activeExactLayoutTasks: typing.performance.activeExactLayoutTasks,
        idlePlacementReads,
        idlePlacementWrites,
        historyEntries: activeMetrics.editorMetrics.history.entries,
        historyApproxBytes: activeMetrics.editorMetrics.history.approximateBytes,
        ocrUiPublicationHz: workflowPublication?.maximumOrdinaryDeliveryHz,
        ocrBookkeepingCpuPercent: workflowPublication?.bookkeepingCpuPercent,
        ocrProgressMonotonic: ocrProduction100Page?.completion?.progress?.monotonic,
        lateOcrPublicationAfterCancel: workflowPublication?.latePublicationAfterCancel,
      },
      measurements: {
        editor: {
          ...typing.performance,
          history: activeMetrics.editorMetrics.history,
          activeEditorIdle: {
            start: activeEditorIdleStart.editorMetrics?.placement || null,
            end: activeEditorIdleEnd.editorMetrics?.placement || null,
            reads: activeEditorIdleReads,
            writes: activeEditorIdleWrites,
          },
          noEditorIdle: {
            start: noEditorIdleStart.editorMetrics?.placement || null,
            end: noEditorIdleEnd.editorMetrics?.placement || null,
            reads: noEditorIdleReads,
            writes: noEditorIdleWrites,
          },
        },
        ocrProduction100Page,
      },
    };
    const report = evaluateEditorPerformanceReport(raw);
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    const report = evaluateEditorPerformanceReport({
      ...reportBase,
      completedAt: new Date().toISOString(),
      error: error.stack || error.message || String(error),
      metrics: {},
    });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally {
    if (application) {
      await Promise.all([
        copyFile(application.appStdoutPath, stdoutPath).catch(() => {}),
        copyFile(application.appStderrPath, stderrPath).catch(() => {}),
      ]);
    }
    await application?.stop?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  runPerformance(options).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'PASS') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
