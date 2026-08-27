import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPackagedApp } from './lib/macos-packaged-app.mjs';
import {
  EDITOR_COVERAGE_DIMENSIONS,
  EDITOR_COVERAGE_MANIFEST_CONTRACT,
  REQUIRED_EDITOR_LIFECYCLE_CASE_COUNT,
  REQUIRED_EDITOR_MATRIX_CASE_COUNT,
  validateEditorCoverageManifest,
} from './ocr-release-hardening-policy.mjs';

assert.equal(process.platform, 'darwin', 'editor coverage production harness is macOS-only');

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const defaultAppBinary = path.join(
  repoDir,
  'target',
  'aarch64-apple-darwin',
  'release',
  'bundle',
  'macos',
  'Open PDF Studio.app',
  'Contents',
  'MacOS',
  'open-pdf-studio',
);

function parseArguments(argv) {
  const artifactRoot = path.resolve(
    process.env.OPEN_PDF_STUDIO_TEST_ARTIFACT_DIR
      || path.join(projectDir, 'test-artifacts', 'browser-ui'),
  );
  const options = {
    appBinary: path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP || defaultAppBinary),
    outputPath: path.join(artifactRoot, 'editor-coverage-manifest.json'),
    startFamily: null,
    editorOpenTimeoutMs: 60_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--app') options.appBinary = path.resolve(argv[++index]);
    else if (value === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (value === '--start-family') options.startFamily = String(argv[++index] || '');
    else if (value === '--editor-open-timeout') {
      options.editorOpenTimeoutMs = Number(argv[++index]);
      if (!Number.isFinite(options.editorOpenTimeoutMs) || options.editorOpenTimeoutMs < 1_000) {
        throw new Error('--editor-open-timeout must be at least 1000 milliseconds');
      }
    }
    else throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const normalize = (value) => String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const normalizedRotation = (value) => ((Math.round(Number(value) || 0) % 360) + 360) % 360;
const observedRotation = (state) => normalizedRotation(
  state?.doc?.pageRotation ?? state?.viewport?.rotation,
);

function textAnnotationGeometry(annotation) {
  const clone = (value) => (value == null ? null : structuredClone(value));
  return {
    x: annotation.x,
    y: annotation.y,
    width: annotation.width,
    height: annotation.height,
    rotation: annotation.rotation ?? 0,
    arrowX: annotation.arrowX ?? null,
    arrowY: annotation.arrowY ?? null,
    kneeX: annotation.kneeX ?? null,
    kneeY: annotation.kneeY ?? null,
    armOriginX: annotation.armOriginX ?? null,
    armOriginY: annotation.armOriginY ?? null,
    leaders: clone(annotation.leaders),
    richTextRegion: clone(annotation.richText?.region),
  };
}

async function gitHead() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git rev-parse exited with ${code}`));
    });
  });
}

async function fileIdentity(filePath) {
  const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    path: filePath,
    bytes: metadata.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function portablePath(fromDirectory, target) {
  return path.relative(fromDirectory, target).split(path.sep).join('/');
}

function center(rect) {
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };
}

async function runCoverage(options) {
  const manifestDir = path.dirname(options.outputPath);
  const coverageDir = path.join(manifestDir, 'coverage');
  const matrixEvidencePath = path.join(coverageDir, 'matrix-evidence.json');
  const lifecycleEvidencePath = path.join(coverageDir, 'lifecycle-evidence.json');
  const consoleEvidencePath = path.join(coverageDir, 'recent-console.json');
  const appLogPath = path.join(coverageDir, 'packaged-app.log');
  const failurePath = path.join(coverageDir, 'editor-coverage-failure.json');
  const temporaryManifestPath = `${options.outputPath}.tmp`;
  const runDir = await mkdtemp(path.join(tmpdir(), 'opds-editor-coverage-'));
  const fixtureDir = path.join(projectDir, 'tests', 'fixtures');
  const nativeFixture = path.join(fixtureDir, 'text', 'native-paragraph-table.pdf');
  const ocrFixtureDir = path.join(fixtureDir, 'ocr', 'editing-foundation-v1');
  const fixturePaths = {
    nativeSource: path.join(runDir, 'native-source.pdf'),
    nativeOwned: path.join(runDir, 'native-owned.pdf'),
    annotation: path.join(runDir, 'annotation-text.pdf'),
    ocrLine: path.join(runDir, 'ocr-line.pdf'),
    ocrFixed: path.join(runDir, 'ocr-fixed.pdf'),
    ocrReflow: path.join(runDir, 'ocr-reflow.pdf'),
    secondary: path.join(runDir, 'compare-secondary.pdf'),
  };
  const head = await gitHead();
  const packagedAppIdentity = await fileIdentity(options.appBinary);
  const matrixEvidence = [];
  const lifecycleEvidence = [];
  const matrixCases = [];
  const lifecycleCases = [];
  let app = null;
  let failureDiagnostics = null;

  await mkdir(coverageDir, { recursive: true });
  // A previous successful manifest must never survive a failed or interrupted
  // run and accidentally satisfy the packaged release gate.
  await Promise.all([
    rm(options.outputPath, { force: true }),
    rm(temporaryManifestPath, { force: true }),
    rm(failurePath, { force: true }),
  ]);
  await Promise.all([
    access(options.appBinary),
    access(nativeFixture),
    access(path.join(ocrFixtureDir, 'flat-scanned-line-edited.pdf')),
    access(path.join(ocrFixtureDir, 'flat-scanned-region-edited.pdf')),
    access(path.join(ocrFixtureDir, 'flat-scanned-reflow-edited.pdf')),
    copyFile(nativeFixture, fixturePaths.nativeSource),
    copyFile(nativeFixture, fixturePaths.nativeOwned),
    copyFile(nativeFixture, fixturePaths.secondary),
    copyFile(path.join(ocrFixtureDir, 'flat-scanned-line-edited.pdf'), fixturePaths.ocrLine),
    copyFile(path.join(ocrFixtureDir, 'flat-scanned-region-edited.pdf'), fixturePaths.ocrFixed),
    copyFile(path.join(ocrFixtureDir, 'flat-scanned-reflow-edited.pdf'), fixturePaths.ocrReflow),
  ]);

  const writeEvidence = async () => Promise.all([
    writeFile(matrixEvidencePath, `${JSON.stringify({
      contract: 'open-pdf-studio.editor-matrix-evidence',
      schemaVersion: 1,
      head,
      productionUiOnly: true,
      syntheticStateSeeding: false,
      testOnlyEntryPoint: false,
      caseCount: matrixEvidence.length,
      cases: matrixEvidence,
    }, null, 2)}\n`),
    writeFile(lifecycleEvidencePath, `${JSON.stringify({
      contract: 'open-pdf-studio.editor-lifecycle-evidence',
      schemaVersion: 1,
      head,
      productionUiOnly: true,
      syntheticStateSeeding: false,
      testOnlyEntryPoint: false,
      caseCount: lifecycleEvidence.length,
      cases: lifecycleEvidence,
    }, null, 2)}\n`),
  ]);

  try {
    app = await startPackagedApp({
      appBinary: options.appBinary,
      cwd: projectDir,
      env: { OPS_TEST_SESSION_PATH: path.join(runDir, 'session.json') },
    });
    const call = (name, args = {}) => app.callTool(name, args);

    async function waitUntil(description, probe, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      let latest = null;
      let latestError = null;
      while (Date.now() < deadline) {
        try {
          latest = await probe();
          if (latest) return latest;
          latestError = null;
        } catch (error) {
          latestError = error;
        }
        await delay(100);
      }
      throw new Error(`timed out waiting for ${description}${latestError ? `: ${latestError.message}` : `: ${JSON.stringify(latest)}`}`);
    }

    const ui = (selector, searchTabs = false) => call('app_ui_state', { selector, searchTabs });

    async function waitUi(selector, predicate = (value) => value.found && value.visible, timeoutMs = 60_000) {
      return waitUntil(selector, async () => {
        const value = await ui(selector, false);
        return predicate(value) ? value : null;
      }, timeoutMs);
    }

    async function click(selector, searchTabs = false) {
      if (!searchTabs) {
        await waitUi(selector, (value) => value.found && value.visible && !value.disabled);
      }
      const result = await call('app_click_element', { selector, searchTabs });
      assert.equal(result.ok, true, result.error || `${selector} was not found`);
      assert.equal(result.clicked, true, `${selector} was not clicked`);
      return result;
    }

    async function clickAtElement(selector) {
      const state = await waitUi(
        selector,
        (value) => value.found && value.visible && value.rect.width > 2 && value.rect.height > 2,
      );
      const point = center(state.rect);
      const result = await call('app_mouse_click', point);
      assert.equal(result.ok, true, result.error);
      return { state, point, result };
    }

    async function switchVisibleTab(index) {
      const selector = `.document-tab[data-index="${index}"]`;
      const action = await click(selector, false);
      const tabs = await waitUntil(`visible tab ${index} to become active`, async () => {
        const value = await call('app_list_tabs');
        return value.ok && value.activeIndex === index ? value : null;
      });
      return { selector, action, activeIndex: tabs.activeIndex };
    }

    async function requestVisibleTabClose(index) {
      const selector = `.document-tab[data-index="${index}"] .document-tab-close`;
      return { selector, action: await click(selector, false) };
    }

    async function openPdf(pdfPath) {
      const opened = await call('app_open_pdf', { path: pdfPath });
      assert.equal(opened.ok, true, opened.error);
      return waitUntil(`active PDF ${pdfPath}`, async () => {
        const viewport = await call('app_get_viewport_state');
        return viewport.doc?.filePath === pdfPath && viewport.doc?.id ? viewport : null;
      });
    }

    async function exitCompareIfNeeded() {
      const compare = await ui('.compare-view', false);
      if (!compare.found) return;
      await click('#ribbon-compare', true);
      await waitUi('.compare-view', (value) => !value.found);
    }

    async function closeAllTabs() {
      await exitCompareIfNeeded();
      while (true) {
        const tabs = await call('app_list_tabs');
        assert.equal(tabs.ok, true, tabs.error);
        if (tabs.tabs.length === 0) return;
        const closed = await call('app_close_tab', {
          index: tabs.tabs.length - 1,
          force: true,
        });
        assert.equal(closed.ok, true, closed.error);
      }
    }

    async function activateTool(selector, expectedTool) {
      await click(selector, true);
      const tool = await call('app_get_current_tool');
      assert.equal(tool.ok, true, tool.error);
      assert.equal(tool.tool, expectedTool, `${selector} did not activate ${expectedTool}`);
      return tool;
    }

    async function approveFontIfNeeded() {
      const approval = await ui('.font-substitution-dialog .pref-btn-primary', false);
      if (!approval.found || !approval.visible || approval.disabled) return false;
      await click('.font-substitution-dialog .pref-btn-primary', false);
      return true;
    }

    function editorSnapshot(editor) {
      return {
        sample: String(editor.value ?? editor.text ?? '').slice(0, 300),
        canonicalLength: editor.valueLength ?? editor.textLength,
        rect: editor.rect,
        host: editor.pageTextEditHost,
        accessibility: editor.accessibility,
      };
    }

    async function waitForEditor(adapter) {
      return waitUntil(`${adapter.id} editor`, async () => {
        const editor = await ui('.pdf-text-editor', false);
        if (!editor.found || !editor.visible) {
          await approveFontIfNeeded();
          return null;
        }
        const viewport = await call('app_get_viewport_state');
        const sample = String(editor.value ?? editor.text ?? '');
        if (!normalize(sample).includes(normalize(adapter.expected).slice(0, 80))) return null;
        if (viewport.editorSession?.kind !== adapter.id) return null;
        assert.equal(editor.pageTextEditHost?.attached, true, `${adapter.id} editor lacks page host`);
        assert.equal(editor.pageTextEditHost?.documentId, viewport.editorSession.ownerDocumentId);
        assert.equal(viewport.editorSession.ownerDocumentId, viewport.doc.id);
        assert.equal(
          viewport.editorSession.ownerDocumentGeneration,
          viewport.doc.lifecycleGeneration,
          `${adapter.id} editor generation does not match its owner`,
        );
        return { editor, viewport };
      }, options.editorOpenTimeoutMs);
    }

    async function setViewMode(mode) {
      const selector = mode === 'single' ? '#single-page' : '#continuous';
      const action = await click(selector, true);
      const viewport = await waitUntil(`view mode ${mode}`, async () => {
        const state = await call('app_get_viewport_state');
        return state.doc?.viewMode === mode && state.doc?.bookSpread === false ? state : null;
      });
      return { selector, action, observed: viewport.doc.viewMode };
    }

    async function setRotation(rotation) {
      const target = normalizedRotation(rotation);
      const before = await call('app_get_viewport_state');
      let current = observedRotation(before);
      const clicks = [];
      for (let attempt = 0; current !== target && attempt < 4; attempt += 1) {
        clicks.push(await click('#view-rotate-right', true));
        const viewport = await waitUntil(`page rotation ${target}`, async () => {
          const state = await call('app_get_viewport_state');
          const next = observedRotation(state);
          return next !== current ? state : null;
        });
        current = observedRotation(viewport);
      }
      assert.equal(current, target, `page rotation did not reach ${target}`);
      return { control: '#view-rotate-right', clicks: clicks.length, observed: current };
    }

    async function setZoomPercent(zoomPercent) {
      await click('.status-zoom-input', false);
      await call('app_key', { key: 'a', meta: true });
      const typed = await call('app_type', { text: `${zoomPercent}%` });
      assert.equal(typed.ok, true, typed.error);
      await call('app_key', { key: 'Enter' });
      const viewport = await waitUntil(`zoom ${zoomPercent}%`, async () => {
        const state = await call('app_get_viewport_state');
        const actual = Number(state.viewport?.active ? state.viewport.zoom : state.doc?.scale);
        return Math.abs(actual - zoomPercent / 100) <= 0.01 ? state : null;
      });
      return {
        control: '.status-zoom-input',
        submitted: `${zoomPercent}%`,
        observed: Number(viewport.viewport?.active ? viewport.viewport.zoom : viewport.doc.scale),
      };
    }

    async function setTheme(theme) {
      await click('#theme-picker-toggle', true);
      await click(`.theme-picker-option[data-theme-value="${theme}"]`, false);
      const state = await waitUi(`html[data-theme="${theme}"]`, (value) => value.found && value.visible);
      return { control: '#theme-picker-toggle', option: theme, observed: state.found };
    }

    async function establishBaseViewport() {
      await setViewMode('single');
      await setRotation(0);
      await setZoomPercent(100);
      await setTheme('light');
    }

    async function canvasState() {
      await click('#fit-page-ribbon', true);
      return waitUntil('visible page canvas', async () => {
        const viewport = await call('app_get_viewport_state');
        return viewport.canvas?.cssWidth > 200 && viewport.canvas?.cssHeight > 200
          ? viewport : null;
      });
    }

    function canvasPoint(viewport, xFraction, yFraction) {
      if (viewport.viewport?.active) {
        return {
          x: Math.round(viewport.canvas.cssLeft + viewport.viewport.offsetX
            + viewport.viewport.pageW * viewport.viewport.zoom * xFraction),
          y: Math.round(viewport.canvas.cssTop + viewport.viewport.offsetY
            + viewport.viewport.pageH * viewport.viewport.zoom * yFraction),
        };
      }
      return {
        x: Math.round(viewport.canvas.cssLeft + viewport.canvas.cssWidth * xFraction),
        y: Math.round(viewport.canvas.cssTop + viewport.canvas.cssHeight * yFraction),
      };
    }

    async function focusEditor() {
      const editor = await waitUi('.pdf-text-editor');
      if (!editor.focused) await click('.pdf-text-editor', false);
      return waitUi('.pdf-text-editor', (value) => value.found && value.visible && value.focused);
    }

    async function replaceDraft(text) {
      await focusEditor();
      await call('app_key', { key: 'a', meta: true });
      const typed = await call('app_type', { text });
      assert.equal(typed.ok, true, typed.error);
      assert.equal(typed.editable, true, 'typing target was not the production editor');
      return waitUi('.pdf-text-editor', (value) => (
        value.found && value.visible
          && normalize(value.value ?? value.text).includes(normalize(text).slice(0, 80))
      ));
    }

    async function applyEditor() {
      await waitUi(
        '.pdf-text-editor-apply',
        (value) => value.found && value.visible && !value.disabled,
        90_000,
      );
      await click('.pdf-text-editor-apply', false);
      await waitUi('.pdf-text-editor', (value) => !value.found, 90_000);
      const viewport = await call('app_get_viewport_state');
      assert.equal(viewport.editorSession, null, 'Apply left an editor session registered');
    }

    async function cancelEditor() {
      await click('.pdf-text-editor-cancel', false);
      await waitUi('.pdf-text-editor', (value) => !value.found);
      const viewport = await call('app_get_viewport_state');
      assert.equal(viewport.editorSession, null, 'Cancel left an editor session registered');
    }

    async function listAnnotations() {
      const result = await call('app_list_annotations', { page: 1 });
      assert.equal(result.ok, true, result.error);
      return result.annotations;
    }

    async function getAnnotation(id) {
      const result = await call('app_get_annotation', { id });
      assert.equal(result.ok, true, result.error);
      return result.annotation;
    }

    async function createInsertedText(text) {
      await activateTool('#ep-add-text', 'addText');
      const viewport = await canvasState();
      const point = canvasPoint(viewport, 0.2, 0.66);
      const pointer = await call('app_mouse_click', point);
      assert.equal(pointer.ok, true, pointer.error);
      await waitUi('.pdf-text-editor');
      await replaceDraft(text);
      await applyEditor();
      await waitUi(
        '.textLayer span[data-synthetic="true"][data-edit-id]',
        (value) => value.found && value.visible && normalize(value.text).includes(normalize(text)),
      );
    }

    async function createAnnotationText(type, text, startFraction, endFraction) {
      const selector = type === 'textbox' ? '#tool-textbox' : '#tool-callout';
      await activateTool(selector, type);
      const viewport = await canvasState();
      const start = canvasPoint(viewport, ...startFraction);
      const end = canvasPoint(viewport, ...endFraction);
      const pointer = await call('app_mouse_drag', {
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        steps: 12,
      });
      assert.equal(pointer.ok, true, pointer.error);
      await waitUntil(`${type} editor`, async () => {
        const editor = await ui('.pdf-text-editor', false);
        if (editor.found && editor.visible) return editor;
        await approveFontIfNeeded();
        return null;
      });
      await replaceDraft(text);
      await applyEditor();
      await waitUntil(`${type} annotation`, async () => (
        (await listAnnotations()).find((annotation) => (
          annotation.type === type && annotation.text === text
        )) || null
      ));
    }

    async function buildProductionFixtures() {
      await closeAllTabs();
      await openPdf(fixturePaths.nativeOwned);
      await establishBaseViewport();
      const sourceAdapter = {
        id: 'native-source-text',
        expected: 'ARCALYST penetration',
        kind: 'span',
        selector: '.textLayer span[data-item-index="2"]',
      };
      await openSpanEditor(sourceAdapter);
      await replaceDraft('Coverage owned native text');
      await applyEditor();
      const savedOwned = await call('app_save_pdf');
      assert.equal(savedOwned.ok, true, savedOwned.error);
      await closeAllTabs();

      const blank = await call('app_new_blank_pdf', { widthPt: 612, heightPt: 792, pages: 1 });
      assert.equal(blank.ok, true, blank.error);
      await createInsertedText('Coverage inserted text');
      await createAnnotationText('textbox', 'Coverage textbox text', [0.18, 0.22], [0.48, 0.32]);
      await createAnnotationText('callout', 'Coverage callout text', [0.56, 0.42], [0.82, 0.55]);
      const savedAnnotations = await call('app_save_pdf', { path: fixturePaths.annotation });
      assert.equal(savedAnnotations.ok, true, savedAnnotations.error);
      await closeAllTabs();
    }

    async function openSpanEditor(adapter) {
      await activateTool('#ep-edit-text', 'editText');
      const hit = await waitUi(
        adapter.selector,
        (value) => value.found && value.visible
          && value.rect.width > 2 && value.rect.height > 2
          && normalize(value.accessibility?.label ?? value.text).includes(normalize(adapter.expected).slice(0, 80)),
      );
      const point = center(hit.rect);
      const pointer = await call('app_mouse_click', point);
      assert.equal(pointer.ok, true, pointer.error);
      return waitForEditor(adapter);
    }

    async function annotationPoint(annotation) {
      const viewport = await call('app_get_viewport_state');
      assert.equal(observedRotation(viewport), 0,
        'annotation editor entry must begin from unrotated production geometry');
      const scale = viewport.viewport?.active ? viewport.viewport.zoom : viewport.doc.scale;
      const offsetX = viewport.viewport?.active ? viewport.viewport.offsetX : 0;
      const offsetY = viewport.viewport?.active ? viewport.viewport.offsetY : 0;
      return {
        x: Math.round(viewport.canvas.cssLeft + offsetX + (annotation.x + annotation.width / 2) * scale),
        y: Math.round(viewport.canvas.cssTop + offsetY + (annotation.y + annotation.height / 2) * scale),
      };
    }

    async function openAnnotationEditor(adapter) {
      const annotation = (await listAnnotations()).find((candidate) => (
        candidate.type === adapter.id && normalize(candidate.text) === normalize(adapter.expected)
      ));
      assert.ok(annotation, `${adapter.id} annotation fixture is missing`);
      await activateTool('#tool-select', 'select');
      const point = await annotationPoint(annotation);
      const pointer = await call('app_mouse_click', { ...point, double: true });
      assert.equal(pointer.ok, true, pointer.error);
      return waitForEditor(adapter);
    }

    const adapters = [
      {
        id: 'native-source-text',
        path: fixturePaths.nativeSource,
        expected: 'ARCALYST penetration',
        replacement: 'Coverage native source replacement',
        selector: '.textLayer span[data-item-index="2"]',
        open: openSpanEditor,
      },
      {
        id: 'owned-native-edit',
        path: fixturePaths.nativeOwned,
        expected: 'Coverage owned native text',
        replacement: 'Coverage owned native replacement',
        selector: '.textLayer span[data-owned-text-edit-hit="true"]',
        open: openSpanEditor,
      },
      {
        id: 'inserted-text',
        path: fixturePaths.annotation,
        expected: 'Coverage inserted text',
        replacement: 'Coverage inserted replacement',
        selector: '.textLayer span[data-synthetic="true"][data-edit-id]',
        open: openSpanEditor,
      },
      {
        id: 'ocr-one-line',
        path: fixturePaths.ocrLine,
        expected: 'EDIT TEXT',
        // Keep the edit inside this intentionally fixed one-line OCR region.
        // The click-away contract must still fail closed for invalid overflow;
        // changing one glyph proves persistence without weakening that rule.
        replacement: 'EDIT TEST',
        selector: '.textLayer span[data-scanned-text-edit-hit-only="true"][aria-label="EDIT TEXT"]',
        open: openSpanEditor,
      },
      {
        id: 'ocr-fixed-multiline',
        path: fixturePaths.ocrFixed,
        expected: 'REGION ONE\nREGION TWO\nREGION THREE',
        // Keep the ordinary click-away commit inside the immutable repair
        // region. Pathological/overflow rejection is exercised separately.
        replacement: 'EDIT ONE\nEDIT TWO',
        selector: '.textLayer span[data-ocr-region-id][data-scanned-text-edit-hit-only="true"]',
        open: openSpanEditor,
      },
      {
        id: 'ocr-reflow',
        path: fixturePaths.ocrReflow,
        expected: 'Café Ελληνικά Привет reflows safely',
        replacement: 'Coverage paragraph reflows safely',
        selector: '.textLayer span[data-ocr-region-id][data-scanned-text-edit-hit-only="true"]',
        open: openSpanEditor,
      },
      {
        id: 'textbox',
        path: fixturePaths.annotation,
        expected: 'Coverage textbox text',
        replacement: 'Coverage textbox replacement',
        open: openAnnotationEditor,
      },
      {
        id: 'callout',
        path: fixturePaths.annotation,
        expected: 'Coverage callout text',
        replacement: 'Coverage callout replacement',
        open: openAnnotationEditor,
      },
    ];
    assert.deepEqual(adapters.map((adapter) => adapter.id), EDITOR_COVERAGE_DIMENSIONS.editorFamilies);
    const startFamilyIndex = options.startFamily
      ? adapters.findIndex((adapter) => adapter.id === options.startFamily) : 0;
    if (options.startFamily && startFamilyIndex < 0) {
      throw new Error(`unknown editor family: ${options.startFamily}`);
    }
    const orderedAdapters = startFamilyIndex > 0
      ? [...adapters.slice(startFamilyIndex), ...adapters.slice(0, startFamilyIndex)]
      : adapters;

    async function resetFamily(adapter) {
      await closeAllTabs();
      await openPdf(adapter.path);
      await establishBaseViewport();
    }

    async function assertPersistedText(adapter, expected, phase) {
      if (adapter.id === 'textbox' || adapter.id === 'callout') {
        return waitUntil(`${adapter.id} ${phase} text`, async () => {
          const annotation = (await listAnnotations()).find((candidate) => candidate.type === adapter.id);
          return normalize(annotation?.text) === normalize(expected) ? annotation : null;
        });
      }
      let selector = adapter.selector;
      if (adapter.id === 'native-source-text' && phase === 'replacement') {
        selector = '.textLayer span[data-owned-text-edit-hit="true"]';
      } else if (adapter.id === 'ocr-one-line' && phase === 'replacement') {
        // The accessible label is the current canonical OCR edit text, so an
        // exact source-label selector cannot locate the span after commit.
        selector = '.textLayer span[data-scanned-text-edit-hit-only="true"]';
      }
      return waitUi(selector, (value) => {
        if (!value.found || !value.visible) return false;
        const actual = value.accessibility?.label ?? value.text;
        return normalize(actual).includes(normalize(expected).slice(0, 80));
      }, 90_000);
    }

    async function assertLiveEditor(adapter, sessionId = null) {
      const editor = await waitUi('.pdf-text-editor');
      const viewport = await call('app_get_viewport_state');
      assert.equal(viewport.editorSession?.kind, adapter.id);
      if (sessionId) assert.equal(viewport.editorSession.sessionId, sessionId);
      assert.equal(viewport.editorSession.ownerDocumentId, viewport.doc.id);
      assert.equal(editor.pageTextEditHost?.documentId, viewport.doc.id);
      assert.ok(editor.rect.width > 0 && editor.rect.height > 0, 'editor has no painted bounds');
      return { editor, viewport };
    }

    async function assertViewOnlySessionClean(adapter, sessionId, transition) {
      const { viewport } = await assertLiveEditor(adapter, sessionId);
      assert.equal(
        viewport.editorSession.dirty,
        false,
        `${adapter.id} became dirty after view-only ${transition}`,
      );
      return viewport;
    }

    async function captureApplyDiagnostics(adapter, phase, requested = null) {
      const [applyState, nativeEditStatus, scannedEditStatus, liveRegion,
        editorState, actionsState, paragraphSection, leftAlignment, centerAlignment,
        rightAlignment, viewportState, recentConsole] = await Promise.all([
        ui('.pdf-text-editor-apply', false).catch(() => null),
        ui('#native-text-edit-status', false).catch(() => null),
        ui('#scanned-text-edit-status', false).catch(() => null),
        ui('.ocr-review-live-region', false).catch(() => null),
        ui('.pdf-text-editor', false).catch(() => null),
        ui('.pdf-text-editor-actions', false).catch(() => null),
        ui('#prop-paragraph-section', false).catch(() => null),
        ui('#prop-paragraph-section .text-align-btn:nth-of-type(1)', false).catch(() => null),
        ui('#prop-paragraph-section .text-align-btn:nth-of-type(2)', false).catch(() => null),
        ui('#prop-paragraph-section .text-align-btn:nth-of-type(3)', false).catch(() => null),
        call('app_get_viewport_state').catch(() => null),
        call('app_get_recent_console', { tail: 100 }).catch(() => null),
      ]);
      failureDiagnostics = {
        phase,
        requested: { editorFamily: adapter.id, ...(requested || {}) },
        apply: applyState,
        nativeEditStatus,
        scannedEditStatus,
        liveRegion,
        editor: editorState,
        actions: actionsState,
        properties: {
          paragraphSection,
          alignments: [leftAlignment, centerAlignment, rightAlignment],
        },
        viewport: viewportState,
        session: viewportState?.editorSession ?? null,
        layout: viewportState?.editorMetrics?.exactLayout ?? null,
        layoutState: viewportState?.editorMetrics?.layoutState ?? null,
        recentConsole,
      };
      return failureDiagnostics;
    }

    async function openAdapterForPhase(adapter, phase) {
      try {
        return await adapter.open(adapter);
      } catch (error) {
        await captureApplyDiagnostics(adapter, phase);
        throw error;
      }
    }

    async function runMatrixForFamily(adapter) {
      await resetFamily(adapter);
      const opened = await openAdapterForPhase(adapter, 'matrix-editor-open');
      const sessionId = opened.viewport.editorSession.sessionId;
      const ownerDocumentId = opened.viewport.editorSession.ownerDocumentId;
      const ownerGeneration = opened.viewport.editorSession.ownerDocumentGeneration;
      try {
        await waitUi(
          '.pdf-text-editor-apply',
          (value) => value.found && value.visible && !value.disabled,
          90_000,
        );
      } catch (error) {
        await captureApplyDiagnostics(adapter, 'initial-apply-validation');
        throw error;
      }
      const settledOpen = await call('app_get_viewport_state');
      assert.equal(settledOpen.editorSession?.sessionId, sessionId);
      if (settledOpen.editorSession?.dirty === true) {
        await captureApplyDiagnostics(adapter, 'initial-layout-dirty');
      }
      assert.equal(settledOpen.editorSession?.dirty, false,
        `${adapter.id} became dirty during initial exact-layout normalization`);
      let latestActions = {};
      for (const viewMode of EDITOR_COVERAGE_DIMENSIONS.viewModes) {
        latestActions.view = await setViewMode(viewMode);
        await assertViewOnlySessionClean(adapter, sessionId, `view mode ${viewMode}`);
        for (const rotation of EDITOR_COVERAGE_DIMENSIONS.rotations) {
          latestActions.rotation = await setRotation(rotation);
          await assertViewOnlySessionClean(adapter, sessionId, `rotation ${rotation}`);
          for (const zoomPercent of EDITOR_COVERAGE_DIMENSIONS.zoomPercents) {
            latestActions.zoom = await setZoomPercent(zoomPercent);
            await assertViewOnlySessionClean(adapter, sessionId, `zoom ${zoomPercent}%`);
            for (const theme of EDITOR_COVERAGE_DIMENSIONS.themes) {
              latestActions.theme = await setTheme(theme);
              const { editor, viewport } = await assertLiveEditor(adapter, sessionId);
              const themeState = await ui(`html[data-theme="${theme}"]`, false);
              const actualZoom = Number(viewport.viewport?.active ? viewport.viewport.zoom : viewport.doc.scale);
              assert.equal(viewport.doc.viewMode, viewMode);
              assert.equal(observedRotation(viewport), rotation);
              assert.ok(Math.abs(actualZoom - zoomPercent / 100) <= 0.01);
              assert.equal(themeState.found && themeState.visible, true);
              assert.equal(viewport.editorSession.ownerDocumentId, ownerDocumentId);
              assert.equal(viewport.editorSession.ownerDocumentGeneration, ownerGeneration);
              assert.equal(viewport.editorSession.dirty, false,
                `${adapter.id} became dirty from view-only matrix operations`);
              let apply;
              try {
                apply = await waitUi(
                  '.pdf-text-editor-apply',
                  (value) => value.found && value.visible && !value.disabled,
                  90_000,
                );
              } catch (error) {
                await captureApplyDiagnostics(adapter, 'matrix-apply-validation', {
                  viewMode,
                  rotation,
                  zoomPercent,
                  theme,
                });
                throw error;
              }
              const cancel = await ui('.pdf-text-editor-cancel', false);
              assert.equal(apply.found && apply.visible && !apply.disabled, true);
              assert.equal(cancel.found && cancel.visible, true);
              const evidenceId = [adapter.id, viewMode, rotation, zoomPercent, theme].join('|');
              const evidence = {
                evidenceId,
                status: 'PASS',
                assertedAt: new Date().toISOString(),
                entry: {
                  method: adapter.id === 'textbox' || adapter.id === 'callout'
                    ? 'ribbon-select-tool-and-double-pointer-click'
                    : 'ribbon-edit-text-tool-and-pointer-click',
                  expectedSourceText: adapter.expected,
                },
                requested: { editorFamily: adapter.id, viewMode, rotation, zoomPercent, theme },
                observed: {
                  editor: editorSnapshot(editor),
                  session: viewport.editorSession,
                  document: viewport.doc,
                  zoom: actualZoom,
                  rotation: observedRotation(viewport),
                  themeAttributeMatched: true,
                  applyVisible: true,
                  applyEnabledAfterExactValidation: true,
                  cancelVisible: true,
                },
                productionActions: structuredClone(latestActions),
              };
              matrixEvidence.push(evidence);
              matrixCases.push({
                editorFamily: adapter.id,
                viewMode,
                rotation,
                zoomPercent,
                theme,
                status: 'PASS',
                artifact: portablePath(manifestDir, matrixEvidencePath),
                evidenceId,
              });
            }
          }
        }
      }
      await cancelEditor();
      await writeEvidence();
    }

    async function openSecondaryAndReturnToFamily(adapter) {
      const familyTabs = await call('app_list_tabs');
      const familyIndex = familyTabs.activeIndex;
      await openPdf(fixturePaths.secondary);
      const tabs = await call('app_list_tabs');
      assert.equal(tabs.tabs.length, 2, `${adapter.id} secondary tab was not opened`);
      const switched = await switchVisibleTab(familyIndex);
      await waitUntil(`${adapter.id} family tab`, async () => {
        const viewport = await call('app_get_viewport_state');
        return viewport.doc?.filePath === adapter.path ? viewport : null;
      });
      return { familyIndex, secondaryIndex: tabs.tabs.find((tab) => tab.filePath === fixturePaths.secondary).index };
    }

    async function recordLifecycle(adapter, scenario, assertions, actions) {
      const evidenceId = `${adapter.id}|${scenario}`;
      lifecycleEvidence.push({
        evidenceId,
        status: 'PASS',
        assertedAt: new Date().toISOString(),
        editorFamily: adapter.id,
        scenario,
        entry: adapter.id === 'textbox' || adapter.id === 'callout'
          ? 'production annotation selection plus genuine double pointer click'
          : 'production edit-text ribbon tool plus genuine source pointer click',
        actions,
        assertions,
      });
      lifecycleCases.push({
        editorFamily: adapter.id,
        scenario,
        status: 'PASS',
        artifact: portablePath(manifestDir, lifecycleEvidencePath),
        evidenceId,
      });
      await writeEvidence();
    }

    async function runLifecycleForFamily(adapter) {
      // Tab switch: a dirty draft is synchronously cancelled before ownership changes.
      await resetFamily(adapter);
      const tabPair = await openSecondaryAndReturnToFamily(adapter);
      const tabSession = await openAdapterForPhase(adapter, 'tab-switch-open');
      await replaceDraft(`Tab switch draft ${adapter.id}`);
      const switched = await switchVisibleTab(tabPair.secondaryIndex);
      await waitUi('.pdf-text-editor', (value) => !value.found);
      let viewport = await call('app_get_viewport_state');
      assert.equal(viewport.editorSession, null);
      await switchVisibleTab(tabPair.familyIndex);
      await assertPersistedText(adapter, adapter.expected, 'original');
      await recordLifecycle(adapter, 'tab-switch', {
        dirtySessionId: tabSession.viewport.editorSession.sessionId,
        visibleTabSelector: switched.selector,
        editorRemoved: true,
        registryCleared: true,
        sourceRestored: true,
      }, ['type dirty draft', 'click visible production tab', 'click visible owner tab', 'inspect persisted source']);

      // Owner close: a dirty transient draft on an otherwise clean document
      // still requires explicit discard authorization. Save is unavailable
      // because only visible Apply may commit an editor draft.
      await resetFamily(adapter);
      let tabsBeforeClose = await call('app_list_tabs');
      assert.equal(tabsBeforeClose.tabs[tabsBeforeClose.activeIndex]?.modified, false,
        'owner-close setup must begin with a clean production document');
      const closeSession = await openAdapterForPhase(adapter, 'owner-close-open');
      const closeDraft = `Owner close draft ${adapter.id}`;
      await replaceDraft(closeDraft);
      const cancelCloseAction = await requestVisibleTabClose(tabsBeforeClose.activeIndex);
      await waitUi('.unsaved-close-dialog');
      const unavailableSave = await ui('.unsaved-close-save', false);
      assert.equal(unavailableSave.found, false,
        'Save must not implicitly Apply or discard a dirty transient editor');
      await click('.unsaved-close-cancel', false);
      await waitUi('.unsaved-close-dialog', (value) => !value.found);
      const afterCancelledClose = await assertLiveEditor(
        adapter,
        closeSession.viewport.editorSession.sessionId,
      );
      assert.equal(afterCancelledClose.viewport.editorSession.dirty, true);
      assert.ok(normalize(afterCancelledClose.editor.value ?? afterCancelledClose.editor.text)
        .includes(normalize(closeDraft)));
      tabsBeforeClose = await call('app_list_tabs');
      assert.equal(tabsBeforeClose.tabs.some((tab) => tab.filePath === adapter.path), true,
        'Cancel unexpectedly removed the owner tab');

      const discardCloseAction = await requestVisibleTabClose(tabsBeforeClose.activeIndex);
      await waitUi('.unsaved-close-dialog');
      await click('.unsaved-close-dont-save', false);
      await waitUi('.pdf-text-editor', (value) => !value.found);
      await waitUi('.unsaved-close-dialog', (value) => !value.found);
      const tabsAfterClose = await waitUntil(`${adapter.id} owner tab removal`, async () => {
        const value = await call('app_list_tabs');
        return value.ok && !value.tabs.some((tab) => tab.filePath === adapter.path) ? value : null;
      });
      viewport = await call('app_get_viewport_state');
      assert.equal(viewport.editorSession, null);
      await recordLifecycle(adapter, 'owner-close', {
        dirtySessionId: closeSession.viewport.editorSession.sessionId,
        documentWasModified: false,
        dirtyDraftPromptedOnCleanDocument: true,
        saveActionUnavailable: true,
        cancelCloseSelector: cancelCloseAction.selector,
        cancelPreservedDirtySession: true,
        cancelPreservedOwnerTab: true,
        discardCloseSelector: discardCloseAction.selector,
        explicitDiscardAction: true,
        editorRemoved: true,
        registryCleared: true,
        remainingTabs: tabsAfterClose.tabs.length,
      }, [
        'verify the owner document is clean',
        'type dirty draft',
        'click visible owner-tab close',
        'verify Save is unavailable',
        'press visible Cancel',
        'assert the same dirty owner session remains',
        'click visible owner-tab close again',
        'press visible localized close-without-save control',
        'inspect owner removal and editor registry',
      ]);

      // Compare entry: starting a real compare session cancels the owner draft.
      await resetFamily(adapter);
      await openSecondaryAndReturnToFamily(adapter);
      const compareSession = await openAdapterForPhase(adapter, 'compare-entry-open');
      await replaceDraft(`Compare draft ${adapter.id}`);
      await click('#ribbon-compare', true);
      await click('.cmp-dialog-footer .pref-btn-primary', false);
      await waitUi('.compare-view');
      await waitUi('.pdf-text-editor', (value) => !value.found);
      viewport = await call('app_get_viewport_state');
      assert.equal(viewport.editorSession, null);
      await recordLifecycle(adapter, 'compare-entry', {
        dirtySessionId: compareSession.viewport.editorSession.sessionId,
        compareViewVisible: true,
        editorRemoved: true,
        registryCleared: true,
      }, ['type dirty draft', 'open Compare from ribbon', 'press Start', 'inspect compare and registry']);

      // Properties formatting: the properties panel is inside the focus boundary.
      await resetFamily(adapter);
      const propertiesSession = await openAdapterForPhase(adapter, 'properties-formatting-open');
      let alignment = await ui('#prop-paragraph-section .text-align-btn:nth-of-type(1)', false);
      if (!alignment.found || !alignment.visible) {
        await click('#prop-paragraph-section > .property-section-header', false);
      }
      let alignmentSelector = null;
      let originalAlignmentSelector = null;
      for (let index = 1; index <= 3; index += 1) {
        const selector = `#prop-paragraph-section .text-align-btn:nth-of-type(${index})`;
        alignment = await ui(selector, false);
        if (alignment.found && alignment.visible && alignment.active) {
          originalAlignmentSelector = selector;
        }
        if (alignment.found && alignment.visible && !alignment.disabled && !alignment.active) {
          alignmentSelector ||= selector;
        }
      }
      assert.ok(originalAlignmentSelector, 'the source paragraph alignment is not represented');
      assert.ok(alignmentSelector, 'no alternate production paragraph-alignment control is available');
      await click(alignmentSelector, false);
      const propertiesLive = await assertLiveEditor(
        adapter,
        propertiesSession.viewport.editorSession.sessionId,
      );
      let selectedAlignment;
      try {
        selectedAlignment = await waitUi(alignmentSelector, (value) => (
          value.found && value.visible && value.active === true
        ), 5_000);
      } catch (error) {
        await captureApplyDiagnostics(adapter, 'properties-formatting', { alignmentSelector });
        throw error;
      }
      assert.equal(selectedAlignment.active, true, 'paragraph formatting control did not become active');
      const propertiesClickAway = await clickAtElement('.status-page-input');
      assert.equal(
        propertiesClickAway.result.target?.classes?.includes('status-page-input'),
        true,
        `${adapter.id} paragraph click-away did not hit the visible page-status input`,
      );
      await waitUi('.pdf-text-editor', (value) => !value.found, 90_000);
      await assertPersistedText(adapter, adapter.expected, 'original');
      const committedPropertiesHistory = await waitUntil(`${adapter.id} paragraph formatting undo`, async () => {
        const undoState = await ui('.quick-access-btn[data-action="undo"]', false);
        return undoState.found && undoState.visible && undoState.disabled === false ? undoState : null;
      });

      // Re-open the real committed record. A first edit of native source text
      // becomes an owned-native record; all other families retain their kind.
      const committedAdapter = adapter.id === 'native-source-text'
        ? { ...adapter, id: 'owned-native-edit' } : adapter;
      await openAdapterForPhase(committedAdapter, 'properties-formatting-reopen');
      const persistedAlignment = await waitUi(alignmentSelector, (value) => (
        value.found && value.visible && value.active === true
      ), 10_000);
      assert.equal(persistedAlignment.active, true,
        `${adapter.id} paragraph alignment was not retained on re-edit`);
      await cancelEditor();

      await click('.quick-access-btn[data-action="undo"]', false);
      await assertPersistedText(adapter, adapter.expected, 'original');
      await waitUntil(`${adapter.id} paragraph formatting single Undo`, async () => {
        const [undoState, redoState] = await Promise.all([
          ui('.quick-access-btn[data-action="undo"]', false),
          ui('.quick-access-btn[data-action="redo"]', false),
        ]);
        return undoState.disabled === true && redoState.disabled === false
          ? { undoState, redoState } : null;
      });
      await openAdapterForPhase(adapter, 'properties-formatting-undo-reopen');
      const restoredAlignment = await waitUi(originalAlignmentSelector, (value) => (
        value.found && value.visible && value.active === true
      ), 10_000);
      assert.equal(restoredAlignment.active, true,
        `${adapter.id} original paragraph alignment was not restored by Undo`);
      await cancelEditor();
      await assertPersistedText(adapter, adapter.expected, 'original');
      await recordLifecycle(adapter, 'properties-formatting', {
        sessionPreservedWhilePanelFocused: true,
        ownerPreserved: propertiesLive.viewport.editorSession.ownerDocumentId
          === propertiesSession.viewport.editorSession.ownerDocumentId,
        alignmentControl: alignmentSelector,
        formatControlActivated: true,
        clickAwayCommitted: true,
        committedAsOneUndoUnit: committedPropertiesHistory.disabled === false,
        persistedOnRealReEdit: true,
        originalAlignmentRestoredAfterUndo: true,
      }, [
        'choose paragraph alignment in properties panel',
        'inspect same owner session',
        'click visible page-status input',
        're-open the committed edit through production UI',
        'inspect persisted paragraph alignment',
        'Cancel re-edit',
        'Undo once',
        're-open and inspect original alignment',
        'Cancel',
      ]);

      // A genuine pointer click outside the editor portal and properties-panel
      // focus boundary commits the dirty draft. The resulting document change
      // must be exactly one undo unit, and the final Undo restores the fixture
      // before the remaining lifecycle scenarios run.
      await resetFamily(adapter);
      const clickAwaySession = await openAdapterForPhase(adapter, 'click-away-open');
      const clickAwayReplacement = adapter.replacement;
      const cleanHistory = await Promise.all([
        ui('.quick-access-btn[data-action="undo"]', false),
        ui('.quick-access-btn[data-action="redo"]', false),
      ]);
      assert.equal(cleanHistory[0].disabled, true,
        `${adapter.id} click-away setup inherited an Undo unit`);
      assert.equal(cleanHistory[1].disabled, true,
        `${adapter.id} click-away setup inherited a Redo unit`);
      await replaceDraft(clickAwayReplacement);
      const clickAway = await clickAtElement('.status-page-input');
      assert.equal(
        clickAway.result.target?.classes?.includes('status-page-input'),
        true,
        `${adapter.id} click-away pointer did not hit the visible page-status input`,
      );
      try {
        await waitUi('.pdf-text-editor', (value) => !value.found, 90_000);
      } catch (error) {
        await captureApplyDiagnostics(adapter, 'click-away-commit', {
          replacement: clickAwayReplacement,
          outsideFocusBoundarySelector: '.status-page-input',
        });
        throw error;
      }
      viewport = await call('app_get_viewport_state');
      assert.equal(viewport.editorSession, null,
        `${adapter.id} click-away left an editor session registered`);
      await assertPersistedText(adapter, clickAwayReplacement, 'replacement');
      const committedHistory = await waitUntil(`${adapter.id} click-away undo unit`, async () => {
        const [undoState, redoState] = await Promise.all([
          ui('.quick-access-btn[data-action="undo"]', false),
          ui('.quick-access-btn[data-action="redo"]', false),
        ]);
        return undoState.found && undoState.visible && undoState.disabled === false
          && redoState.found && redoState.visible && redoState.disabled === true
          ? { undoState, redoState } : null;
      });
      const clickAwayUndo = await click('.quick-access-btn[data-action="undo"]', false);
      await assertPersistedText(adapter, adapter.expected, 'original');
      const afterSingleUndo = await waitUntil(`${adapter.id} single click-away Undo`, async () => {
        const [undoState, redoState] = await Promise.all([
          ui('.quick-access-btn[data-action="undo"]', false),
          ui('.quick-access-btn[data-action="redo"]', false),
        ]);
        return undoState.disabled === true && redoState.disabled === false
          ? { undoState, redoState } : null;
      });
      const clickAwayRedo = await click('.quick-access-btn[data-action="redo"]', false);
      await assertPersistedText(adapter, clickAwayReplacement, 'replacement');
      const afterSingleRedo = await waitUntil(`${adapter.id} single click-away Redo`, async () => {
        const [undoState, redoState] = await Promise.all([
          ui('.quick-access-btn[data-action="undo"]', false),
          ui('.quick-access-btn[data-action="redo"]', false),
        ]);
        return undoState.disabled === false && redoState.disabled === true
          ? { undoState, redoState } : null;
      });
      const clickAwayRestore = await click('.quick-access-btn[data-action="undo"]', false);
      await assertPersistedText(adapter, adapter.expected, 'original');
      const restoredHistory = await waitUntil(`${adapter.id} click-away fixture restoration`, async () => {
        const [undoState, redoState] = await Promise.all([
          ui('.quick-access-btn[data-action="undo"]', false),
          ui('.quick-access-btn[data-action="redo"]', false),
        ]);
        return undoState.disabled === true && redoState.disabled === false
          ? { undoState, redoState } : null;
      });
      await recordLifecycle(adapter, 'click-away-commit', {
        sessionId: clickAwaySession.viewport.editorSession.sessionId,
        outsideFocusBoundarySelector: '.status-page-input',
        genuinePointerClick: clickAway.result.ok === true
          && clickAway.result.target?.classes?.includes('status-page-input'),
        pointerTarget: clickAway.result.target,
        outsidePoint: clickAway.point,
        editorRemoved: true,
        registryCleared: true,
        persistedReplacementObserved: true,
        oneUndoUnitAfterCommit: committedHistory.undoState.disabled === false
          && committedHistory.redoState.disabled === true,
        singleUndoRestoredOriginal: afterSingleUndo.undoState.disabled === true
          && afterSingleUndo.redoState.disabled === false,
        singleRedoRestoredReplacement: afterSingleRedo.undoState.disabled === false
          && afterSingleRedo.redoState.disabled === true,
        finalUndoRestoredFixture: restoredHistory.undoState.disabled === true
          && restoredHistory.redoState.disabled === false,
        visibleUndoClicked: clickAwayUndo.clicked,
        visibleRedoClicked: clickAwayRedo.clicked,
        visibleRestoreUndoClicked: clickAwayRestore.clicked,
      }, [
        'type dirty replacement',
        'genuine pointer click on visible page-status input outside the editor focus boundary',
        'wait for editor and owner session to close',
        'inspect persisted replacement',
        'click visible Undo once and inspect original',
        'click visible Redo once and inspect replacement',
        'click visible Undo once to restore fixture',
      ]);

      // Keyboard-only cancellation uses the editor's production Escape route.
      await resetFamily(adapter);
      const keyboardSession = await openAdapterForPhase(adapter, 'keyboard-controls-open');
      const applyControl = await ui('.pdf-text-editor-apply', false);
      const cancelControl = await ui('.pdf-text-editor-cancel', false);
      assert.equal(applyControl.found && applyControl.visible, true);
      assert.equal(cancelControl.found && cancelControl.visible, true);
      await focusEditor();
      await call('app_key', { key: 'Escape' });
      await waitUi('.pdf-text-editor', (value) => !value.found);
      viewport = await call('app_get_viewport_state');
      assert.equal(viewport.editorSession, null);
      await assertPersistedText(adapter, adapter.expected, 'original');
      await recordLifecycle(adapter, 'keyboard-only-controls', {
        sessionId: keyboardSession.viewport.editorSession.sessionId,
        applyControlVisible: true,
        cancelControlVisible: true,
        escapeCancelled: true,
        sourceRestored: true,
      }, ['focus production editor', 'press Escape', 'inspect source and registry']);

      // Pathological paste keeps the canonical payload and provides recovery.
      await resetFamily(adapter);
      const pasteSession = await openAdapterForPhase(adapter, 'large-paste-open');
      await focusEditor();
      await call('app_key', { key: 'a', meta: true });
      const pasteLines = Array.from({ length: 251 }, (_, index) => `Coverage paste line ${index + 1}`);
      const pasteText = pasteLines.join('\n');
      const paste = await call('app_paste', { text: pasteText });
      assert.equal(paste.ok, true, paste.error);
      assert.equal(paste.defaultPrevented, true, 'production paste handler did not consume the event');
      const recovery = await waitUi('.pdf-text-editor-paste-recovery');
      assert.equal(Number(recovery.dataset.lineCount), pasteLines.length);
      assert.equal(Number(recovery.dataset.graphemeCount), Array.from(pasteText).length);
      const pasteLive = await assertLiveEditor(adapter, pasteSession.viewport.editorSession.sessionId);
      assert.equal(pasteLive.viewport.editorSession.dirty, true);
      await click('.pdf-text-editor-paste-actions button:first-child', false);
      await waitUi('.pdf-text-editor-paste-recovery', (value) => !value.found);
      const restoredEditor = await waitUi('.pdf-text-editor');
      assert.ok(normalize(restoredEditor.value ?? restoredEditor.text).includes(normalize(adapter.expected).slice(0, 80)));
      await cancelEditor();
      await assertPersistedText(adapter, adapter.expected, 'original');
      await recordLifecycle(adapter, 'large-paste', {
        sessionPreserved: true,
        canonicalPasteCharacters: paste.textLength,
        canonicalGraphemes: Number(recovery.dataset.graphemeCount),
        canonicalLines: Number(recovery.dataset.lineCount),
        recoveryVisible: true,
        undoPasteRestoredDraft: true,
        cancelRestoredSource: true,
      }, ['select all', 'dispatch real paste event', 'inspect recovery counts', 'press Undo Paste', 'Cancel']);

      // Undo/redo is proved against the visible persisted source, then returned
      // to its original state so later cases cannot inherit test mutations.
      await resetFamily(adapter);
      await openAdapterForPhase(adapter, 'undo-redo-open');
      await replaceDraft(adapter.replacement);
      await applyEditor();
      await assertPersistedText(adapter, adapter.replacement, 'replacement');
      const undo = await click('.quick-access-btn[data-action="undo"]', false);
      await assertPersistedText(adapter, adapter.expected, 'original');
      const redo = await click('.quick-access-btn[data-action="redo"]', false);
      await assertPersistedText(adapter, adapter.replacement, 'replacement');
      const restore = await click('.quick-access-btn[data-action="undo"]', false);
      await assertPersistedText(adapter, adapter.expected, 'original');
      await recordLifecycle(adapter, 'undo-redo', {
        appliedReplacementObserved: true,
        visibleUndoClicked: undo.clicked,
        undoRestoredOriginal: true,
        visibleRedoClicked: redo.clicked,
        redoRestoredReplacement: true,
        visibleRestoreUndoClicked: restore.clicked,
        finalUndoRestoredOriginal: true,
      }, [
        'edit and Apply',
        'click visible Undo control',
        'inspect original',
        'click visible Redo control',
        'inspect replacement',
        'click visible Undo control',
      ]);

      // Zoom is view-only: the same clean session and canonical draft survive.
      // For annotation editors, Apply without typing must persist byte-for-byte
      // identical canonical box, rich-text region, and callout-leader geometry.
      await resetFamily(adapter);
      const textAnnotation = adapter.id === 'textbox' || adapter.id === 'callout'
        ? (await listAnnotations()).find((candidate) => (
          candidate.type === adapter.id && normalize(candidate.text) === normalize(adapter.expected)
        ))
        : null;
      if (adapter.id === 'textbox' || adapter.id === 'callout') {
        assert.ok(textAnnotation, `${adapter.id} geometry fixture is missing`);
      }
      const geometryBeforeZoom = textAnnotation
        ? textAnnotationGeometry(await getAnnotation(textAnnotation.id))
        : null;
      const zoomSession = await openAdapterForPhase(adapter, 'zoom-without-edit-open');
      const beforeZoom = await waitUi('.pdf-text-editor');
      const zoomTo250 = await setZoomPercent(250);
      const at250 = await assertLiveEditor(adapter, zoomSession.viewport.editorSession.sessionId);
      assert.equal(at250.viewport.editorSession.dirty, false);
      assert.equal(
        at250.editor.valueLength ?? at250.editor.textLength,
        beforeZoom.valueLength ?? beforeZoom.textLength,
      );
      const zoomTo100 = await setZoomPercent(100);
      const returnedTo100 = await assertLiveEditor(adapter, zoomSession.viewport.editorSession.sessionId);
      assert.equal(returnedTo100.viewport.editorSession.dirty, false);
      assert.equal(
        returnedTo100.editor.valueLength ?? returnedTo100.editor.textLength,
        beforeZoom.valueLength ?? beforeZoom.textLength,
      );
      if (textAnnotation) {
        await applyEditor();
        const geometryAfterApply = textAnnotationGeometry(await getAnnotation(textAnnotation.id));
        assert.deepEqual(
          geometryAfterApply,
          geometryBeforeZoom,
          `${adapter.id} Apply-without-typing changed canonical geometry after zoom round-trip`,
        );
      } else {
        await cancelEditor();
      }
      await assertPersistedText(adapter, adapter.expected, 'original');
      await recordLifecycle(adapter, 'zoom-without-edit', {
        sessionPreserved: true,
        ownerPreserved: true,
        canonicalLengthPreserved: true,
        draftStayedClean: true,
        observedZoomSequence: [zoomTo250.observed, zoomTo100.observed],
        canonicalGeometryPreserved: textAnnotation ? true : null,
        cleanApplyUsed: textAnnotation ? true : false,
        sourceRestored: true,
      }, [
        'open editor at 100%',
        'enter 250% in production zoom control',
        'return to 100%',
        'inspect same clean session',
        textAnnotation ? 'Apply without typing and compare canonical geometry' : 'Cancel',
      ]);
    }

    await call('app_set_window_size', { width: 1320, height: 900 });
    await buildProductionFixtures();
    for (const adapter of orderedAdapters) await runMatrixForFamily(adapter);
    assert.equal(matrixCases.length, REQUIRED_EDITOR_MATRIX_CASE_COUNT);
    for (const adapter of orderedAdapters) await runLifecycleForFamily(adapter);
    assert.equal(lifecycleCases.length, REQUIRED_EDITOR_LIFECYCLE_CASE_COUNT);
    assert.deepEqual(
      [...new Set(lifecycleCases.map((entry) => entry.scenario))],
      EDITOR_COVERAGE_DIMENSIONS.lifecycleScenarios,
    );

    const recentConsole = await call('app_get_recent_console', { tail: 500 });
    await writeFile(consoleEvidencePath, `${JSON.stringify(recentConsole, null, 2)}\n`);
    await writeFile(appLogPath, app.logs.join(''));
    await writeEvidence();

    const artifacts = [
      portablePath(manifestDir, matrixEvidencePath),
      portablePath(manifestDir, lifecycleEvidencePath),
      portablePath(manifestDir, consoleEvidencePath),
      portablePath(manifestDir, appLogPath),
    ];
    const manifest = {
      contract: EDITOR_COVERAGE_MANIFEST_CONTRACT,
      schemaVersion: 1,
      status: 'PASS',
      head,
      generatedAt: new Date().toISOString(),
      platform: { os: process.platform, architecture: process.arch },
      packagedApp: {
        ...packagedAppIdentity,
        entryPath: 'packaged Tauri WebView controlled through production ribbon, pointer, keyboard, and paste events',
      },
      productionUiOnly: true,
      syntheticStateSeeding: false,
      testOnlyEntryPoint: false,
      harness: {
        command: 'npm run test:editor-coverage:macos',
        fixturePreparation: 'production editor actions followed by Save; no direct store writes',
        matrixCaseCount: matrixCases.length,
        lifecycleCaseCount: lifecycleCases.length,
      },
      artifacts,
      matrixCases,
      lifecycleCases,
    };
    const issues = validateEditorCoverageManifest(manifest, { expectedHead: head });
    assert.deepEqual(issues, [], `coverage manifest rejected: ${issues.join('; ')}`);
    for (const artifact of artifacts) await access(path.resolve(manifestDir, artifact));
    await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporaryManifestPath, options.outputPath);
    return manifest;
  } catch (error) {
    await rm(options.outputPath, { force: true });
    await writeEvidence().catch(() => {});
    if (app) {
      const recentConsole = await app.callTool('app_get_recent_console', { tail: 500 }).catch(() => null);
      if (recentConsole) await writeFile(consoleEvidencePath, `${JSON.stringify(recentConsole, null, 2)}\n`).catch(() => {});
      await writeFile(appLogPath, app.logs.join('')).catch(() => {});
    }
    await writeFile(failurePath, `${JSON.stringify({
      contract: 'open-pdf-studio.editor-coverage-failure',
      schemaVersion: 1,
      status: 'FAIL',
      head,
      generatedAt: new Date().toISOString(),
      productionUiOnly: true,
      syntheticStateSeeding: false,
      testOnlyEntryPoint: false,
      completedMatrixCases: matrixCases.length,
      requiredMatrixCases: REQUIRED_EDITOR_MATRIX_CASE_COUNT,
      completedLifecycleCases: lifecycleCases.length,
      requiredLifecycleCases: REQUIRED_EDITOR_LIFECYCLE_CASE_COUNT,
      diagnostics: failureDiagnostics,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    }, null, 2)}\n`).catch(() => {});
    throw error;
  } finally {
    await app?.stop().catch(() => {});
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

const options = parseArguments(process.argv.slice(2));
const manifest = await runCoverage(options);
process.stdout.write(`${manifest.status} ${manifest.matrixCases.length} matrix + ${manifest.lifecycleCases.length} lifecycle cases -> ${options.outputPath}\n`);
