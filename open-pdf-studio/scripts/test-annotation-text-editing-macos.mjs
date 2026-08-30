import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'annotation text packaged acceptance is macOS-only');

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

function parseArguments(argv) {
  const artifactRoot = path.resolve(
    process.env.OPEN_PDF_STUDIO_TEST_ARTIFACT_DIR
      || path.join(projectDir, 'test-artifacts', 'packaged-editor'),
  );
  const options = {
    appBundle: path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || defaultAppBundle),
    outputPath: path.join(artifactRoot, 'reports', 'annotation-text-editing.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--app') options.appBundle = path.resolve(argv[++index]);
    else if (value === '--output') options.outputPath = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
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

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function packagedIdentity(appBundle) {
  const executablePath = path.join(appBundle, 'Contents', 'MacOS', 'open-pdf-studio');
  const executable = await stat(executablePath);
  return {
    bundlePath: appBundle,
    executablePath,
    executableBytes: executable.size,
    signingScope: 'CI usability and hardened-runtime compatibility; not Developer ID or notarization evidence',
  };
}

function center(rect) {
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };
}

async function runAcceptance(options) {
  const outputDir = path.dirname(options.outputPath);
  const runDir = await mkdtemp(path.join(tmpdir(), 'opds-annotation-text-acceptance-'));
  const sessionPath = path.join(runDir, 'session.json');
  const savedPdf = path.join(outputDir, 'annotation-text-editing.pdf');
  const initialSavePdf = path.join(outputDir, 'annotation-text-editing-initial-save.pdf');
  const finalSavePdf = path.join(outputDir, 'annotation-text-editing-final-save.pdf');
  const screenshotPath = path.join(outputDir, 'annotation-text-editing.png');
  const consolePath = path.join(outputDir, 'annotation-console.json');
  const stdoutPath = path.join(outputDir, 'annotation-app.stdout.log');
  const stderrPath = path.join(outputDir, 'annotation-app.stderr.log');
  const artifactCandidates = [
    savedPdf,
    initialSavePdf,
    finalSavePdf,
    screenshotPath,
    consolePath,
    stdoutPath,
    stderrPath,
  ];
  const executablePath = path.join(options.appBundle, 'Contents', 'MacOS', 'open-pdf-studio');
  await mkdir(outputDir, { recursive: true });

  const report = {
    contract: 'open-pdf-studio.annotation-text-packaged-acceptance',
    schemaVersion: 1,
    status: 'RUNNING',
    head: await gitHead(),
    generatedAt: new Date().toISOString(),
    platform: { os: process.platform, architecture: process.arch },
    packagedApp: {
      bundlePath: options.appBundle,
      executablePath,
      executableBytes: null,
      signingScope: 'CI usability and hardened-runtime compatibility; not Developer ID or notarization evidence',
    },
    productionUiOnly: true,
    syntheticStateSeeding: false,
    testOnlyEntryPoint: false,
    fixture: {
      kind: 'blank-document-created-through-production-action',
      widthPt: 612,
      heightPt: 792,
      pages: 1,
    },
    checks: {
      insertedText: 'PENDING',
      textbox: 'PENDING',
      callout: 'PENDING',
      clickAwayCommit: 'PENDING',
      escapeDiscard: 'PENDING',
      noApplyCancelControls: 'PENDING',
      noSubstitutionDialog: 'PENDING',
      saveReopen: 'PENDING',
      repeatSaveIdempotence: 'PENDING',
      genuineReeditPointerAction: 'PENDING',
    },
    families: {},
    testCommands: ['npm run test:annotation-text-editing:macos'],
    artifacts: [],
  };
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);

  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  let requestId = 0;
  let applicationPid = null;
  let exited = false;
  const application = spawn('/usr/bin/open', [
    '-n', '-W', '--stdout', stdoutPath, '--stderr', stderrPath,
    '--env', 'OPS_ENABLE_MCP=1', '--env', 'OPDS_DETACHED=1',
    '--env', `OPS_TEST_SESSION_PATH=${sessionPath}`,
    options.appBundle, '--args', '--mcp-server', '--mcp-port', String(port),
  ], { cwd: projectDir, env: process.env, stdio: 'ignore' });
  application.once('exit', () => { exited = true; });

  async function rpc(method, params = {}) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`MCP ${body.error.code}: ${body.error.message}`);
    return body.result;
  }

  async function callTool(name, arguments_ = {}) {
    const result = await rpc('tools/call', { name, arguments: arguments_ });
    const payload = result?.content?.find((entry) => entry.type === 'text')?.text;
    if (typeof payload !== 'string') throw new Error(`${name} returned no JSON payload`);
    return JSON.parse(payload);
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

  async function waitUi(selector, predicate = (value) => value.found && value.visible, timeoutMs = 30_000) {
    return waitUntil(selector, async () => {
      const value = await ui(selector);
      return predicate(value) ? value : null;
    }, timeoutMs);
  }

  async function clickVisible(selector) {
    await waitUi(selector, (value) => value.found && value.visible && !value.disabled, 60_000);
    const result = await callTool('app_click_element', { selector, searchTabs: false });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.clicked, true, `${selector} was not clicked`);
    return result;
  }

  async function waitEditor() {
    return waitUntil('visible annotation text editor', async () => {
      const editor = await ui('.pdf-text-editor');
      if (editor.found && editor.visible) {
        if (!editor.focused) {
          await clickVisible('.pdf-text-editor');
          return null;
        }
        const [apply, cancel, substitutionDialog] = await Promise.all([
          ui('.pdf-text-editor-apply'),
          ui('.pdf-text-editor-cancel'),
          ui('.font-substitution-dialog'),
        ]);
        assert.equal(apply.found, false, 'Apply control must not be rendered');
        assert.equal(cancel.found, false, 'Cancel control must not be rendered');
        assert.equal(substitutionDialog.found, false, 'font substitution must be automatic');
        report.checks.noApplyCancelControls = 'PASS';
        report.checks.noSubstitutionDialog = 'PASS';
        return ui('.pdf-text-editor');
      }
      return null;
    }, 60_000);
  }

  async function replaceEditorText(text) {
    await waitEditor();
    const selected = await callTool('app_key', { key: 'a', meta: true });
    assert.equal(selected.ok, true, selected.error);
    const typed = await callTool('app_type', { text });
    assert.equal(typed.ok, true, typed.error);
    return typed;
  }

  async function applyEditor() {
    const statusInput = await waitUi(
      '.status-page-input',
      (value) => value.found && value.visible && !value.disabled,
      60_000,
    );
    const clickPoint = center(statusInput.rect);
    const clickAway = await callTool('app_mouse_click', clickPoint);
    assert.equal(clickAway.ok, true, clickAway.error);
    assert.equal(
      clickAway.target?.classes?.includes('status-page-input'),
      true,
      'annotation click-away did not hit the visible page-status input',
    );
    report.lastClickAwayPointer = { point: clickPoint, target: clickAway.target };
    try {
      await waitUntil('editor click-away cleanup', async () => {
        const editor = await ui('.pdf-text-editor');
        return !editor.found ? true : null;
      }, 60_000);
    } catch (error) {
      const [viewport, editor] = await Promise.all([
        callTool('app_get_viewport_state').catch(() => null),
        ui('.pdf-text-editor').catch(() => null),
      ]);
      report.lastClickAwayFailure = {
        editor,
        editorSession: viewport?.editorSession ?? null,
        lastTextApplyResult: viewport?.lastTextApplyResult ?? null,
        lastTextPublicationResult: viewport?.lastTextPublicationResult ?? null,
        documentSaveState: viewport?.documentSaveState ?? null,
        pageEditReadiness: viewport?.pageEditReadiness ?? null,
      };
      error.message += `; click-away=${JSON.stringify(report.lastClickAwayFailure)}`;
      throw error;
    }
    report.checks.clickAwayCommit = 'PASS';
  }

  async function cancelEditor() {
    await waitEditor();
    const beforeEscape = await callTool('app_get_viewport_state');
    report.lastEscapeBefore = {
      editorSession: beforeEscape.editorSession,
      currentTool: beforeEscape.currentTool,
    };
    const escaped = await callTool('app_key', { key: 'Escape' });
    report.lastEscape = escaped;
    assert.equal(escaped.ok, true, escaped.error);
    await waitUntil('editor Escape cleanup', async () => {
      const editor = await ui('.pdf-text-editor');
      if (editor.found) {
        const viewport = await callTool('app_get_viewport_state');
        report.lastEscapeAfter = {
          editor,
          editorSession: viewport.editorSession,
          currentTool: viewport.currentTool,
        };
      }
      return !editor.found ? true : null;
    }, 30_000);
    report.checks.escapeDiscard = 'PASS';
  }

  async function canvasState() {
    await callTool('app_fit_page');
    return waitUntil('blank document page canvas', async () => {
      const viewport = await callTool('app_get_viewport_state');
      report.pageReadinessDiagnostics = {
        doc: viewport.doc,
        documentSaveState: viewport.documentSaveState,
        pageEditReadiness: viewport.pageEditReadiness,
        renderPublicationDiagnostics: viewport.renderPublicationDiagnostics,
      };
      return viewport.canvas?.cssWidth > 200 && viewport.canvas?.cssHeight > 200
        && viewport.pageEditReadiness?.ready === true
        && viewport.renderPublicationDiagnostics?.activePdfJsTasks === 0
        ? viewport : null;
    }, 60_000);
  }

  async function waitForAutomaticSave(label) {
    const viewport = await waitUntil(`${label} automatic save`, async () => {
      const current = await callTool('app_get_viewport_state');
      const revisions = current.documentSaveState;
      const page = String(current.doc?.currentPage || 1);
      return ['saved', 'saved-refresh-pending'].includes(revisions?.saveState)
        && revisions.activeSaveRequestId == null
        && revisions.serializedRevision === revisions.contentRevision
        && revisions.contentRevision === revisions.persistedRevision
        && revisions.pageRenderReadyRevisions?.[page] === revisions.contentRevision
        && revisions.pageSemanticReadyRevisions?.[page] === revisions.contentRevision
        && current.pageEditReadiness?.ready === true
        && current.renderPublicationDiagnostics?.activePdfJsTasks === 0
        ? current : null;
    }, 60_000);
    report.automaticSaveEvidence ||= [];
    report.automaticSaveEvidence.push({
      label,
      documentSaveState: viewport.documentSaveState,
      pageEditReadiness: viewport.pageEditReadiness,
    });
    return viewport;
  }

  function canvasPoint(viewport, fractionX, fractionY) {
    if (viewport.viewport?.active) {
      return {
        x: Math.round(viewport.canvas.cssLeft + viewport.viewport.offsetX
          + viewport.viewport.pageW * viewport.viewport.zoom * fractionX),
        y: Math.round(viewport.canvas.cssTop + viewport.viewport.offsetY
          + viewport.viewport.pageH * viewport.viewport.zoom * fractionY),
      };
    }
    return {
      x: Math.round(viewport.canvas.cssLeft + viewport.canvas.cssWidth * fractionX),
      y: Math.round(viewport.canvas.cssTop + viewport.canvas.cssHeight * fractionY),
    };
  }

  async function listAnnotations() {
    const result = await callTool('app_list_annotations', { page: 1 });
    assert.equal(result.ok, true, result.error);
    return result.annotations;
  }

  async function createAnnotationText(type, text, startFraction, endFraction) {
    const beforeIds = new Set((await listAnnotations()).map((annotation) => annotation.id));
    const selected = await callTool('app_set_tool', { tool: type });
    assert.equal(selected.ok, true, selected.error);
    assert.equal(selected.current, type);
    const viewport = await canvasState();
    const start = canvasPoint(viewport, ...startFraction);
    const end = canvasPoint(viewport, ...endFraction);
    const drag = await callTool('app_mouse_drag', {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      steps: 12,
    });
    assert.equal(drag.ok, true, drag.error);
    await replaceEditorText(text);
    await applyEditor();
    const annotation = await waitUntil(`${type} committed annotation`, async () => {
      const annotations = await listAnnotations();
      return annotations.find((candidate) => (
        candidate.type === type && !beforeIds.has(candidate.id) && candidate.text === text
      )) || null;
    }, 30_000);
    return { annotation, creationPointer: { start, end, endTarget: drag.end_target } };
  }

  async function createInsertedText(text) {
    const selected = await callTool('app_set_tool', { tool: 'addText' });
    assert.equal(selected.ok, true, selected.error);
    assert.equal(selected.current, 'addText');
    const viewport = await canvasState();
    const point = canvasPoint(viewport, 0.18, 0.68);
    const click = await callTool('app_mouse_click', point);
    assert.equal(click.ok, true, click.error);
    await replaceEditorText(text);
    await applyEditor();
    const span = await waitUi(
      '.textLayer span[data-synthetic="true"][data-edit-id]',
      (value) => value.found && value.visible && value.text.includes(text),
      30_000,
    );
    return { editId: span.dataset.editId, creationPointer: { ...point, target: click.target } };
  }

  async function activeAnnotationByText(type, text) {
    let latestAnnotations = [];
    try {
      return await waitUntil(`${type} annotation ${text}`, async () => {
        latestAnnotations = await listAnnotations();
        return latestAnnotations.find((annotation) => (
          annotation.type === type && annotation.text === text
        )) || null;
      });
    } catch (error) {
      error.message += `; latest annotations: ${JSON.stringify(latestAnnotations)}`;
      throw error;
    }
  }

  async function annotationScreenPoint(annotation) {
    const viewport = await canvasState();
    const scale = viewport.viewport?.active ? viewport.viewport.zoom : viewport.doc.scale;
    const offsetX = viewport.viewport?.active ? viewport.viewport.offsetX : 0;
    const offsetY = viewport.viewport?.active ? viewport.viewport.offsetY : 0;
    return {
      x: Math.round(viewport.canvas.cssLeft + offsetX + (annotation.x + annotation.width / 2) * scale),
      y: Math.round(viewport.canvas.cssTop + offsetY + (annotation.y + annotation.height / 2) * scale),
    };
  }

  async function openAnnotationEditorByPointer(annotation) {
    const selected = await callTool('app_set_tool', { tool: 'select' });
    assert.equal(selected.current, 'select');
    const point = await annotationScreenPoint(annotation);
    const pointer = await callTool('app_mouse_click', { ...point, double: true });
    assert.equal(pointer.ok, true, pointer.error);
    report.lastAnnotationPointer = {
      annotationId: annotation.id,
      annotationType: annotation.type,
      point,
      target: pointer.target,
    };
    await waitEditor();
    return { point, target: pointer.target };
  }

  async function reopenAnnotationFamily(type, originalText, finalText) {
    let annotation = await activeAnnotationByText(type, originalText);
    const cancelPointer = await openAnnotationEditorByPointer(annotation);
    await replaceEditorText(`${originalText} cancelled draft`);
    await cancelEditor();
    annotation = await activeAnnotationByText(type, originalText);
    assert.equal(annotation.text, originalText, `${type} Cancel changed persisted text`);

    const applyPointer = await openAnnotationEditorByPointer(annotation);
    await replaceEditorText(finalText);
    await applyEditor();
    await waitForAutomaticSave(`${type} re-edit`);
    const changed = await activeAnnotationByText(type, finalText);
    return { annotation: changed, cancelPointer, applyPointer };
  }

  async function insertedSpan(text) {
    return waitUi(
      '.textLayer span[data-synthetic="true"][data-edit-id]',
      (value) => value.found && value.visible && value.text.includes(text),
      60_000,
    );
  }

  async function openInsertedEditorByPointer(text) {
    const span = await insertedSpan(text);
    const selected = await callTool('app_set_tool', { tool: 'editText' });
    assert.equal(selected.current, 'editText');
    const point = center(span.rect);
    const pointer = await callTool('app_mouse_click', point);
    assert.equal(pointer.ok, true, pointer.error);
    await waitEditor();
    return { point, target: pointer.target, editId: span.dataset.editId };
  }

  async function reopenInsertedFamily(originalText, finalText) {
    const cancelPointer = await openInsertedEditorByPointer(originalText);
    await replaceEditorText(`${originalText} cancelled draft`);
    await cancelEditor();
    await insertedSpan(originalText);
    const applyPointer = await openInsertedEditorByPointer(originalText);
    await replaceEditorText(finalText);
    await applyEditor();
    await waitForAutomaticSave('inserted-text re-edit');
    const span = await insertedSpan(finalText);
    return { editId: span.dataset.editId, cancelPointer, applyPointer };
  }

  async function save(pathname = null) {
    const result = await callTool('app_save_pdf', pathname ? { path: pathname } : {});
    if (!result.ok) {
      const message = await ui('.message-dialog-body p').catch(() => null);
      const detail = message?.found ? `: ${message.text || message.innerText || ''}` : '';
      assert.fail(`${result.error || 'save failed'}${detail}`);
    }
    return result;
  }

  async function closeActiveTab() {
    const tabs = await callTool('app_list_tabs');
    assert.equal(tabs.ok, true, tabs.error);
    const result = await callTool('app_close_tab', { index: tabs.activeIndex, force: false });
    assert.equal(result.ok, true, result.error);
  }

  async function captureArtifacts() {
    try {
      const screenshot = await callTool('app_screenshot_view', { width: 1800 });
      if (screenshot.png_base64) {
        await writeFile(screenshotPath, Buffer.from(screenshot.png_base64, 'base64'));
      }
    } catch { /* the fail-closed JSON and process logs remain available */ }
    try {
      const recentConsole = await callTool('app_get_recent_console', { tail: 500 });
      await writeFile(consolePath, `${JSON.stringify(recentConsole, null, 2)}\n`);
    } catch { /* the packaged process may already have exited */ }
  }

  async function refreshArtifactManifest() {
    const artifacts = [];
    for (const artifactPath of artifactCandidates) {
      try {
        await access(artifactPath);
        artifacts.push(path.basename(artifactPath));
      } catch { /* do not claim artifacts that were never produced */ }
    }
    report.artifacts = artifacts;
  }

  try {
    await Promise.all([access(options.appBundle), access(executablePath)]);
    report.packagedApp = await packagedIdentity(options.appBundle);
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    const initialized = await waitUntil('packaged app MCP', async () => {
      if (exited) throw new Error('packaged app exited before MCP initialization');
      const value = await rpc('initialize');
      applicationPid = value?._meta?.openPdfStudio?.processId || applicationPid;
      return value?._meta?.openPdfStudio?.webviewReady ? value : null;
    }, 90_000);
    assert.ok(initialized);
    await callTool('app_set_window_size', { width: 1400, height: 1000 });
    const blank = await callTool('app_new_blank_pdf', { widthPt: 612, heightPt: 792, pages: 1 });
    assert.equal(blank.ok, true, blank.error);
    assert.equal(blank.pageCount, 1);
    await canvasState();

    const insertedText = 'Inserted text production acceptance';
    const textboxText = 'Textbox production acceptance';
    const calloutText = 'Callout production acceptance';
    report.currentStage = 'create-inserted-text';
    const inserted = await createInsertedText(insertedText);
    report.currentStage = 'create-textbox';
    const textbox = await createAnnotationText('textbox', textboxText, [0.12, 0.16], [0.42, 0.26]);
    report.currentStage = 'create-callout';
    const callout = await createAnnotationText('callout', calloutText, [0.56, 0.58], [0.76, 0.42]);
    report.families.insertedText = { initialText: insertedText, ...inserted };
    report.families.textbox = { initialText: textboxText, ...textbox };
    report.families.callout = { initialText: calloutText, ...callout };

    report.currentStage = 'initial-save-and-reopen';
    await save(savedPdf);
    await copyFile(savedPdf, initialSavePdf);
    const firstSaveHash = await sha256(savedPdf);
    await save();
    const repeatedInitialHash = await sha256(savedPdf);
    assert.equal(repeatedInitialHash, firstSaveHash, 'initial repeat save changed PDF bytes');
    await closeActiveTab();
    const reopened = await callTool('app_open_pdf', { path: savedPdf });
    assert.equal(reopened.ok, true, reopened.error);
    await canvasState();
    report.reopenEvidence = {
      annotations: await waitUntil('reopened annotation inventory', async () => {
        const annotations = await listAnnotations();
        return annotations.length >= 2 ? annotations : null;
      }),
    };
    await insertedSpan(insertedText);
    await activeAnnotationByText('textbox', textboxText);
    await activeAnnotationByText('callout', calloutText);
    report.checks.saveReopen = 'PASS';

    const insertedFinal = `${insertedText} reapplied`;
    const textboxFinal = `${textboxText} reapplied`;
    const calloutFinal = `${calloutText} reapplied`;
    report.currentStage = 'reedit-inserted-text';
    report.families.insertedText.reedit = await reopenInsertedFamily(insertedText, insertedFinal);
    report.currentStage = 'reedit-textbox';
    report.families.textbox.reedit = await reopenAnnotationFamily('textbox', textboxText, textboxFinal);
    report.currentStage = 'reedit-callout';
    report.families.callout.reedit = await reopenAnnotationFamily('callout', calloutText, calloutFinal);
    report.families.insertedText.finalText = insertedFinal;
    report.families.textbox.finalText = textboxFinal;
    report.families.callout.finalText = calloutFinal;
    report.checks.insertedText = 'PASS';
    report.checks.textbox = 'PASS';
    report.checks.callout = 'PASS';
    report.checks.genuineReeditPointerAction = 'PASS';

    report.currentStage = 'final-repeat-save';
    await save();
    await copyFile(savedPdf, finalSavePdf);
    const finalSaveHash = await sha256(savedPdf);
    await save();
    const repeatedFinalHash = await sha256(savedPdf);
    assert.equal(repeatedFinalHash, finalSaveHash, 'final repeat save changed PDF bytes');
    report.checks.repeatSaveIdempotence = 'PASS';
    report.saveEvidence = {
      firstSaveSha256: firstSaveHash,
      repeatedInitialSaveSha256: repeatedInitialHash,
      finalSaveSha256: finalSaveHash,
      repeatedFinalSaveSha256: repeatedFinalHash,
    };

    await captureArtifacts();
    await refreshArtifactManifest();
    delete report.currentStage;
    report.status = Object.values(report.checks).every((status) => status === 'PASS') ? 'PASS' : 'FAIL';
    report.completedAt = new Date().toISOString();
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    await captureArtifacts();
    await refreshArtifactManifest();
    report.failureStage = report.currentStage || 'initialization';
    delete report.currentStage;
    for (const [name, status] of Object.entries(report.checks)) {
      if (status === 'PENDING') report.checks[name] = 'NOT_RUN';
    }
    const failureCheck = {
      'create-inserted-text': 'insertedText',
      'create-textbox': 'textbox',
      'create-callout': 'callout',
      'initial-save-and-reopen': 'saveReopen',
      'reedit-inserted-text': 'insertedText',
      'reedit-textbox': 'textbox',
      'reedit-callout': 'callout',
      'final-repeat-save': 'repeatSaveIdempotence',
    }[report.failureStage];
    if (failureCheck) report.checks[failureCheck] = 'FAIL';
    report.status = 'FAIL';
    report.completedAt = new Date().toISOString();
    report.error = error.stack || error.message || String(error);
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally {
    if (applicationPid) {
      try { process.kill(applicationPid, 'SIGTERM'); } catch {}
    } else if (!exited) {
      try { application.kill('SIGTERM'); } catch {}
    }
    await delay(250);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  runAcceptance(options).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'PASS') process.exitCode = 1;
  }).catch(async (error) => {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    let report;
    try {
      report = JSON.parse(await readFile(options.outputPath, 'utf8'));
    } catch {
      report = {
        contract: 'open-pdf-studio.annotation-text-packaged-acceptance',
        schemaVersion: 1,
        head: await gitHead().catch(() => process.env.GITHUB_SHA || 'UNKNOWN'),
        generatedAt: new Date().toISOString(),
        platform: { os: process.platform, architecture: process.arch },
        packagedApp: { bundlePath: options.appBundle },
        productionUiOnly: true,
        syntheticStateSeeding: false,
        testOnlyEntryPoint: false,
        checks: {},
        families: {},
        testCommands: ['npm run test:annotation-text-editing:macos'],
        artifacts: [],
      };
    }
    report.status = 'FAIL';
    report.completedAt ||= new Date().toISOString();
    report.error ||= error.stack || error.message || String(error);
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
