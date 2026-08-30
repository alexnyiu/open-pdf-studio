import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

import { readOwnedTextEditManifest } from '../js/text/owned-edit-manifest.js';
import { startPackagedApp } from './lib/macos-packaged-app.mjs';
import { saveRenderCoherenceScenarioMatrix } from './save-render-coherence-scenarios.mjs';

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
const fixturePath = path.join(
  projectDir,
  'tests',
  'fixtures',
  'text',
  'native-paragraph-table.pdf',
);
const EDIT_A = 'Coherence Edit A';
const EDIT_B = `${EDIT_A}\nCoherence Edit B`;
const EDIT_C = `${EDIT_B}\nCoherence Edit C`;

export const SAVE_CONTINUE_EDITING_SCENARIO = Object.freeze([
  'launch-packaged-app',
  'open-native-editable-pdf',
  'a23-type-without-resize-and-bind-final-layout-to-draft',
  'edit-a',
  'click-away-and-await-automatic-save',
  'assert-persisted-live-render-semantic-revisions-match',
  'manual-save-while-disk-clean',
  'edit-b-without-reopen',
  'save-again',
  'edit-c-without-reopen',
  'verify-all-edits-in-bytes-live-semantics-and-reopen',
  'a23-impossible-auto-fit-keeps-complete-draft-and-exposes-recovery',
]);

function parseArguments(argv) {
  const options = {
    appBundle: path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || defaultBundle),
    outputPath: path.resolve(
      process.env.OPEN_PDF_STUDIO_SAVE_RENDER_COHERENCE_REPORT
        || path.join(projectDir, 'test-artifacts', 'save-render-coherence', 'report.json'),
    ),
    timeoutMs: Math.max(
      10_000,
      Number(process.env.OPEN_PDF_STUDIO_SAVE_RENDER_TIMEOUT_MS) || 90_000,
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--app') options.appBundle = path.resolve(argv[++index]);
    else if (argv[index] === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (argv[index] === '--timeout-ms') {
      options.timeoutMs = Math.max(10_000, Number(argv[++index]) || 90_000);
    } else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (options.appBundle.endsWith(path.join('Contents', 'MacOS', 'open-pdf-studio'))) {
    options.appBundle = path.resolve(options.appBundle, '..', '..', '..');
  }
  return options;
}

function gitHead() {
  if (process.env.GITHUB_SHA) return Promise.resolve(process.env.GITHUB_SHA);
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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256File = async (filePath) => sha256Bytes(await readFile(filePath));

async function waitUntil(description, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let latestError = null;
  while (Date.now() < deadline) {
    try {
      latest = await probe();
      latestError = null;
    } catch (error) {
      latest = null;
      latestError = error?.stack || error?.message || String(error);
    }
    if (latest) return latest;
    await delay(100);
  }
  const suffix = latestError ? `; last probe error: ${latestError}` : '';
  throw new Error(`timed out waiting for ${description}: ${JSON.stringify(latest)}${suffix}`);
}

async function extractedText(pdfPath, pageNumber = 1) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(await readFile(pdfPath)),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const text = await (await pdf.getPage(pageNumber)).getTextContent();
    return text.items.map((item) => item.str).filter(Boolean).join('\n');
  } finally {
    await pdf.destroy();
  }
}

async function manifestState(pdfPath) {
  const pdf = await PDFDocument.load(await readFile(pdfPath));
  const manifest = await readOwnedTextEditManifest(pdf);
  const page = pdf.getPages()[0];
  return { manifest, pageSize: page.getSize() };
}

async function pixelDifferencePercent(leftPng, rightPng) {
  const left = await sharp(leftPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const right = await sharp(rightPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (left.info.width !== right.info.width || left.info.height !== right.info.height
      || left.info.channels !== right.info.channels) return 100;
  let differingPixels = 0;
  for (let offset = 0; offset < left.data.length; offset += left.info.channels) {
    let differs = false;
    for (let channel = 0; channel < Math.min(3, left.info.channels); channel += 1) {
      if (Math.abs(left.data[offset + channel] - right.data[offset + channel]) > 2) {
        differs = true;
        break;
      }
    }
    if (differs) differingPixels += 1;
  }
  return (differingPixels / (left.info.width * left.info.height)) * 100;
}

function regionAnchorMatches(left, right, tolerance = 1e-6) {
  const fixedFieldsMatch = ['x', 'width', 'rotation'].every((field) => (
    Math.abs(Number(left?.[field]) - Number(right?.[field])) <= tolerance
  ));
  const leftTop = Number(left?.y) + Number(left?.height);
  const rightTop = Number(right?.y) + Number(right?.height);
  return fixedFieldsMatch && Math.abs(leftTop - rightTop) <= tolerance;
}

function rectMatches(left, right, tolerance = 0.75) {
  return ['left', 'top', 'width', 'height'].every((field) => (
    Math.abs(Number(left?.[field]) - Number(right?.[field])) <= tolerance
  ));
}

function staleSurfaceCount(viewport) {
  const revision = viewport?.documentSaveState;
  const documentState = viewport?.doc;
  if (!revision || !documentState) return 0;
  return (viewport.renderedSurfaceStates || []).filter((surface) => (
    surface.documentId !== revision.documentId
      || Number(surface.ownerGeneration) !== Number(documentState.lifecycleGeneration)
      || Number(surface.contentRevision) !== Number(revision.contentRevision)
      || Number(surface.livePdfRevision) !== Number(revision.livePdfRevision)
      || Number(surface.pageRevision)
        !== Number(revision.pageContentRevisions?.[surface.pageNum] ?? 0)
  )).length;
}

function rejectedPublicationCount(viewport) {
  return Object.values(viewport?.renderPublicationDiagnostics?.rejectedCounts || {})
    .reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function revisionFields(revision) {
  return {
    content: revision.contentRevision,
    serialized: revision.serializedRevision,
    persisted: revision.persistedRevision,
    livePdf: revision.livePdfRevision,
    visibleRender: revision.visibleRenderRevision,
    visibleSemantic: revision.visibleSemanticRevision,
  };
}

export async function runSaveContinueEditing(options) {
  if (process.platform !== 'darwin') throw new Error('save/render coherence acceptance is macOS-only');
  const outputDirectory = path.dirname(options.outputPath);
  const appBinary = path.join(options.appBundle, 'Contents', 'MacOS', 'open-pdf-studio');
  await Promise.all([
    access(options.appBundle),
    access(appBinary),
    access(fixturePath),
    mkdir(outputDirectory, { recursive: true }),
  ]);
  const runDirectory = await mkdtemp(path.join(outputDirectory, 'run-'));
  const workingPdf = path.join(runDirectory, 'native-coherence-working.pdf');
  const finalPdfArtifact = path.join(outputDirectory, 'save-render-coherence-final.pdf');
  const mountedArtifact = path.join(outputDirectory, 'mounted-page-crop.png');
  const directArtifact = path.join(outputDirectory, 'direct-page-crop.png');
  const finalViewArtifact = path.join(outputDirectory, 'final-view.png');
  const failureViewArtifact = path.join(outputDirectory, 'failure-view.png');
  const failureStateArtifact = path.join(outputDirectory, 'failure-state.json');
  const failurePdfArtifact = path.join(outputDirectory, 'failure-working.pdf');
  const commit = await gitHead();
  const report = {
    contract: 'open-pdf-studio.save-render-coherence',
    schemaVersion: 1,
    status: 'RUNNING',
    pass: false,
    commit,
    platform: { os: process.platform, architecture: process.arch },
    packagedApp: {
      bundlePath: options.appBundle,
      executablePath: appBinary,
      signingScope: 'packaged usability and coherence evidence; not notarization evidence',
    },
    fixture: {
      path: path.relative(projectDir, fixturePath),
      controlled: true,
      nativeOperatorProvenance: true,
      sourceSha256: await sha256File(fixturePath),
    },
    documentId: null,
    scenario: 'A1',
    sequence: SAVE_CONTINUE_EDITING_SCENARIO,
    productionUiOnly: true,
    syntheticStateSeeding: false,
    testOnlyEntryPoint: false,
    revisions: null,
    stalePublicationCount: null,
    rejectedStalePublicationCount: null,
    saveStates: [],
    textAssertions: {},
    visualAssertions: {},
    scenarioMatrix: saveRenderCoherenceScenarioMatrix([]),
    artifacts: [],
    failures: [],
  };
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  await copyFile(fixturePath, workingPdf);
  let app = null;
  let latestViewport = null;
  const recordedStates = new Set();
  const resizeHandleAutomationEvents = [];

  const recordViewport = (label, viewport) => {
    latestViewport = viewport;
    const revision = viewport?.documentSaveState;
    if (!revision) return;
    const key = [
      label,
      revision.saveState,
      revision.contentRevision,
      revision.serializedRevision,
      revision.persistedRevision,
      revision.livePdfRevision,
      revision.visibleRenderRevision,
      revision.visibleSemanticRevision,
      revision.activeSaveRequestId || '',
    ].join(':');
    if (recordedStates.has(key)) return;
    recordedStates.add(key);
    report.saveStates.push({
      label,
      ...revisionFields(revision),
      saveState: revision.saveState,
      activeSaveRequestId: revision.activeSaveRequestId,
      lastSaveError: revision.lastSaveError,
      lastSynchronizationError: revision.lastSynchronizationError,
    });
  };

  try {
    app = await startPackagedApp({
      appBinary,
      cwd: projectDir,
      env: { OPS_TEST_SESSION_PATH: path.join(runDirectory, 'session.json') },
      artifactDir: path.join(outputDirectory, 'launch-logs'),
      launchLabel: 'save-render-coherence',
    });
    const call = async (name, arguments_ = {}) => {
      const result = await app.callTool(name, arguments_);
      const explicitSelector = String(arguments_?.selector || '');
      const targetClasses = result?.target?.classes || [];
      if (explicitSelector.includes('.pdf-text-editor-resize-handle')
          || targetClasses.includes('pdf-text-editor-resize-handle')) {
        resizeHandleAutomationEvents.push({ name, arguments: arguments_, target: result?.target });
      }
      return result;
    };
    const ui = (selector) => call('app_ui_state', { selector, searchTabs: false });
    const waitUi = (selector, predicate = (value) => value.found && value.visible) => (
      waitUntil(selector, async () => {
        const value = await ui(selector);
        return predicate(value) ? value : null;
      }, options.timeoutMs)
    );
    const click = async (selector) => {
      await waitUi(selector, (value) => value.found && value.visible && !value.disabled);
      const result = await call('app_click_element', { selector, searchTabs: false });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.clicked, true, `${selector} was not clicked`);
      return result;
    };
    const openPdf = async (pdfPath) => {
      const opened = await call('app_open_pdf', { path: pdfPath });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      return waitUntil('controlled PDF open', async () => {
        const viewport = await call('app_get_viewport_state');
        recordViewport('opened', viewport);
        return viewport.doc?.filePath === pdfPath
          && viewport.pageEditReadiness?.ready === true
          && viewport.renderPublicationDiagnostics?.activePdfJsTasks === 0
          ? viewport : null;
      }, options.timeoutMs);
    };
    const setEditTool = async () => {
      const tool = await call('app_set_tool', { tool: 'editText' });
      assert.equal(tool.current, 'editText');
    };
    const openEditor = async (selector, expectedText) => {
      const target = await waitUi(selector, (value) => (
        value.found && value.visible && !value.disabled
          && Boolean(value.dataset?.editId || value.dataset?.nativeTextMarkerIds)
      ));
      const pointer = await call('app_mouse_click', {
        x: target.rect.x + target.rect.width / 2,
        y: target.rect.y + target.rect.height / 2,
      });
      assert.equal(pointer.ok, true, pointer.error);
      assert.equal(pointer.target?.classes?.includes('edit-text-hoverable'), true,
        `editor pointer target was intercepted: ${JSON.stringify(pointer.target)}`);
      return waitUi('.pdf-text-editor', (value) => (
        value.found && value.visible && value.focused
          && value.pageTextEditHost?.attached === true
          && String(value.value ?? value.text ?? '').includes(expectedText)
      ));
    };
    const replaceEditorText = async (text) => {
      const selected = await call('app_key', { key: 'a', meta: true });
      assert.equal(selected.ok, true, selected.error);
      const typed = await call('app_type', { text });
      assert.equal(typed.ok, true, typed.error);
    };
    const waitCoherentSaved = async (label, minimumRevision) => (
      waitUntil(`${label} coherent saved state`, async () => {
        const viewport = await call('app_get_viewport_state');
        recordViewport(label, viewport);
        const revision = viewport.documentSaveState;
        const page = String(viewport.doc?.currentPage || 1);
        if (!revision || revision.saveState === 'saved-refresh-failed') {
          if (revision?.saveState === 'saved-refresh-failed') {
            throw new Error(`saved bytes could not refresh the editor: ${JSON.stringify(revision)}`);
          }
          return null;
        }
        const ready = revision.saveState === 'saved'
          && revision.contentRevision >= minimumRevision
          && revision.serializedRevision === revision.contentRevision
          && revision.persistedRevision === revision.contentRevision
          && revision.livePdfRevision === revision.contentRevision
          && revision.visibleRenderRevision === revision.contentRevision
          && revision.visibleSemanticRevision === revision.contentRevision
          && revision.pageRenderReadyRevisions?.[page] === revision.contentRevision
          && revision.pageSemanticReadyRevisions?.[page] === revision.contentRevision
          && revision.activeSaveRequestId === null
          && viewport.renderPublicationDiagnostics?.activePdfJsTasks === 0
          && staleSurfaceCount(viewport) === 0;
        return ready ? viewport : null;
      }, options.timeoutMs)
    );
    const closeActiveTab = async () => {
      const tabs = await call('app_list_tabs');
      const closed = await call('app_close_tab', { index: tabs.activeIndex, force: true });
      assert.equal(closed.ok, true, closed.error);
    };

    await call('app_set_window_size', { width: 1320, height: 900 });
    await waitUi('#placeholder', (value) => (
      value.found && value.rect?.width > 100 && value.rect?.height > 100
    ));
    const opened = await openPdf(workingPdf);
    await setEditTool();
    const sourceSelector = '.textLayer span.edit-text-hoverable[data-item-index="2"][data-native-text-marker-ids]';
    await waitUi(sourceSelector, (value) => (
      value.found && value.visible && value.rect?.width > 5
        && String(value.accessibility?.label ?? value.text).includes('ARCALYST penetration')
    ));
    report.documentId = opened.documentSaveState?.documentId || opened.doc?.id;
    assert.ok(report.documentId, 'initial document identity is unavailable');
    const initialRevision = opened.documentSaveState?.contentRevision || 0;
    const initialSha256 = await sha256File(workingPdf);
    await openEditor(sourceSelector, 'ARCALYST penetration');
    await replaceEditorText(EDIT_A);
    const a23TypedLayout = await waitUntil('A23 exact layout for the final typed draft', async () => {
      const viewport = await call('app_get_viewport_state');
      const layout = viewport.editorMetrics?.layoutState;
      const exact = layout
        && layout.pending === false
        && layout.valid === true
        && layout.requestedFingerprint
        && layout.requestedFingerprint === layout.validatedFingerprint
        && layout.draftText === EDIT_A
        && Number(layout.validatedIdentity?.draftRevision) === Number(layout.draftRevision);
      return exact ? layout : null;
    }, options.timeoutMs);
    assert.equal(resizeHandleAutomationEvents.length, 0,
      `A23 emitted an event against the resize handle: ${JSON.stringify(resizeHandleAutomationEvents)}`);
    report.textAssertions.a23FinalLayoutBoundToTypedDraft = {
      draftRevision: a23TypedLayout.draftRevision,
      requestedFingerprint: a23TypedLayout.requestedFingerprint,
      validatedFingerprint: a23TypedLayout.validatedFingerprint,
      resizeHandleEventCount: resizeHandleAutomationEvents.length,
    };
    let globalLoadingObserved = false;
    await click('.status-page-input');
    await waitUi('.pdf-text-editor', (value) => !value.found);
    const afterA = await waitUntil('Edit A click-away automatic save', async () => {
      const [viewport, loading] = await Promise.all([
        call('app_get_viewport_state'),
        ui('.loading-overlay'),
      ]);
      if (loading.visible) globalLoadingObserved = true;
      recordViewport('edit-a-auto-save', viewport);
      const revision = viewport.documentSaveState;
      const page = String(viewport.doc?.currentPage || 1);
      return ['saved', 'saved-refresh-pending'].includes(revision?.saveState)
        && revision.contentRevision > initialRevision
        && revision.serializedRevision === revision.contentRevision
        && revision.persistedRevision === revision.contentRevision
        && revision.pageRenderReadyRevisions?.[page] === revision.contentRevision
        && revision.pageSemanticReadyRevisions?.[page] === revision.contentRevision
        && viewport.pageEditReadiness?.ready === true
        && revision.activeSaveRequestId === null
        && viewport.renderPublicationDiagnostics?.activePdfJsTasks === 0
        && staleSurfaceCount(viewport) === 0 ? viewport : null;
    }, options.timeoutMs);
    assert.equal(globalLoadingObserved, false, 'click-away automatic save used the global loading overlay');
    assert.notEqual(await sha256File(workingPdf), initialSha256, 'Edit A did not change persisted bytes');
    const textAfterA = await extractedText(workingPdf);
    assert.match(textAfterA, /Coherence Edit A/u);
    report.textAssertions.editAExtractedBeforeEditB = true;

    const cleanSaveSha256 = await sha256File(workingPdf);
    await click('.quick-access-btn[data-action="save"]');
    const afterCleanSave = await waitCoherentSaved(
      'manual-clean-save',
      afterA.documentSaveState.contentRevision,
    );
    assert.equal(await sha256File(workingPdf), cleanSaveSha256,
      'manual Save on a synchronized clean document changed bytes');
    report.textAssertions.manualCleanSavePreservedBytes = true;
    assert.equal(afterCleanSave.documentSaveState.persistedRevision,
      afterCleanSave.documentSaveState.livePdfRevision);

    const ownedSelector = '.textLayer span.edit-text-hoverable[data-owned-text-edit-hit="true"][data-edit-id]';
    await openEditor(ownedSelector, EDIT_A);
    await replaceEditorText(EDIT_B);
    await click('.quick-access-btn[data-action="save"]');
    await waitUi('.pdf-text-editor', (value) => !value.found);
    const afterB = await waitCoherentSaved(
      'edit-b-manual-save',
      afterA.documentSaveState.contentRevision + 1,
    );
    const textAfterB = await extractedText(workingPdf);
    assert.match(textAfterB, /Coherence Edit A/u);
    assert.match(textAfterB, /Coherence Edit B/u);
    report.textAssertions.editBExtractedBeforeEditC = true;

    await openEditor(ownedSelector, EDIT_A);
    await replaceEditorText(EDIT_C);
    await click('.quick-access-btn[data-action="save"]');
    await waitUi('.pdf-text-editor', (value) => !value.found);
    const afterC = await waitCoherentSaved(
      'edit-c-manual-save',
      afterB.documentSaveState.contentRevision + 1,
    );
    const finalText = await extractedText(workingPdf);
    for (const expected of ['Coherence Edit A', 'Coherence Edit B', 'Coherence Edit C']) {
      assert.match(finalText, new RegExp(expected, 'u'));
    }
    report.textAssertions.threeConsecutiveEditsExtracted = true;
    const { manifest: finalManifest, pageSize } = await manifestState(workingPdf);
    const finalEdit = finalManifest?.pages?.[0]?.edits?.[0];
    assert.ok(finalEdit?.sourceProvenance?.length > 0, 'exact native operator provenance was not retained');
    assert.equal(regionAnchorMatches(finalEdit.original?.region, finalEdit.richText?.region), true,
      'owned text anchor moved across consecutive saves');
    await call('app_set_view_mode', { mode: 'single' });
    await call('app_set_zoom', { scale: 1 });
    const editorBeforeReopen = await openEditor(ownedSelector, EDIT_A);
    assert.match(String(editorBeforeReopen.value ?? editorBeforeReopen.text), /Coherence Edit B/u);
    assert.match(String(editorBeforeReopen.value ?? editorBeforeReopen.text), /Coherence Edit C/u);
    await call('app_key', { key: 'Escape' });
    await waitUi('.pdf-text-editor', (value) => !value.found);
    const finalSameSessionViewport = afterC;

    await closeActiveTab();
    await openPdf(workingPdf);
    await call('app_set_view_mode', { mode: 'single' });
    await call('app_set_zoom', { scale: 1 });
    await setEditTool();
    const reopenedEditor = await openEditor(ownedSelector, EDIT_A);
    assert.equal(rectMatches(editorBeforeReopen.rect, reopenedEditor.rect), true,
      `owned text editor geometry changed after reopen: ${JSON.stringify({
        before: editorBeforeReopen.rect,
        after: reopenedEditor.rect,
      })}`);
    assert.match(String(reopenedEditor.value ?? reopenedEditor.text), /Coherence Edit B/u);
    assert.match(String(reopenedEditor.value ?? reopenedEditor.text), /Coherence Edit C/u);
    await call('app_key', { key: 'Escape' });
    await waitUi('.pdf-text-editor', (value) => !value.found);
    report.textAssertions.reopenedTextMatches = true;

    // A23 negative branch: a deliberately impossible one-line expansion must
    // retain the entire draft, keep the same editor session open, expose the
    // typed terminal constraint, and schedule no owner revision or save.
    const beforeBlocked = await call('app_get_viewport_state');
    const beforeBlockedRevision = beforeBlocked.documentSaveState.contentRevision;
    const beforeBlockedSha256 = await sha256File(workingPdf);
    const blockedDraft = `A23 ${'W'.repeat(240)}`;
    await openEditor(ownedSelector, EDIT_A);
    await replaceEditorText(blockedDraft);
    await click('.status-page-input');
    const blockedLayout = await waitUntil('A23 typed layout rejection retains editor', async () => {
      const [editor, viewport] = await Promise.all([
        ui('.pdf-text-editor'),
        call('app_get_viewport_state'),
      ]);
      const layout = viewport.editorMetrics?.layoutState;
      const finalDecision = layout?.finalDecision;
      const typedConstraint = [
        'TEXT_LAYOUT_PAGE_BOUNDARY',
        'TEXT_LAYOUT_COLUMN_BOUNDARY',
        'TEXT_LAYOUT_NEIGHBOR_OVERLAP',
      ].includes(finalDecision?.rejectionCode);
      return editor.found && editor.visible
        && layout?.draftText === blockedDraft
        && finalDecision?.status === 'blocked'
        && typedConstraint
        && layout.editorStatus
        && viewport.documentSaveState?.contentRevision === beforeBlockedRevision
        ? { editor, viewport, layout, finalDecision }
        : null;
    }, options.timeoutMs);
    assert.equal(await sha256File(workingPdf), beforeBlockedSha256,
      'blocked A23 draft changed persisted bytes');
    assert.equal(resizeHandleAutomationEvents.length, 0,
      `A23 emitted an event against the resize handle: ${JSON.stringify(resizeHandleAutomationEvents)}`);
    report.textAssertions.a23ImpossibleAutoFit = {
      draftRetained: blockedLayout.layout.draftText === blockedDraft,
      editorRemainedOpen: true,
      rejectionCode: blockedLayout.finalDecision.rejectionCode,
      recoveryMessage: blockedLayout.layout.editorStatus,
      revisionUnchanged: true,
      persistedBytesUnchanged: true,
      resizeHandleEventCount: resizeHandleAutomationEvents.length,
    };
    await call('app_key', { key: 'Escape' });
    await waitUi('.pdf-text-editor', (value) => !value.found);
    const finalView = await call('app_screenshot_view', { width: 1600 });
    assert.equal(finalView.ok, true, finalView.error);

    const continuous = await call('app_set_view_mode', { mode: 'continuous' });
    assert.equal(continuous.ok, true, continuous.error);
    await waitUntil('continuous page render', async () => {
      const viewport = await call('app_get_viewport_state');
      return viewport.doc?.viewMode === 'continuous'
        && viewport.renderedSurfaceStates?.some((surface) => (
          surface.pageNum === 1 && surface.quality === 'final'
        )) ? viewport : null;
    }, options.timeoutMs);
    const region = finalEdit.richText.region;
    const crop = {
      xPt: Math.max(0, region.x - 16),
      yPt: Math.max(0, pageSize.height - (region.y + region.height) - 16),
      widthPt: Math.min(pageSize.width, region.width + 32),
      heightPt: Math.min(pageSize.height, region.height + 32),
    };
    const mounted = await waitUntil('final mounted page crop', async () => {
      const value = await call('app_screenshot_rendered_page', { pageNum: 1, ...crop });
      return value.ok && value.quality === 'final' ? value : null;
    }, options.timeoutMs);
    const directResult = await call('screenshot_page', {
      path: workingPdf,
      page_index: 0,
      width: mounted.fullWidth,
    });
    const directPayload = directResult?.content?.find?.((entry) => entry.type === 'text')?.text;
    const direct = typeof directPayload === 'string' ? JSON.parse(directPayload) : directResult;
    assert.ok(direct?.png_base64, 'direct persisted-PDF raster is unavailable');
    const directCrop = await sharp(Buffer.from(direct.png_base64, 'base64'))
      .extract({
        left: mounted.cropLeft,
        top: mounted.cropTop,
        width: mounted.cropWidth,
        height: mounted.cropHeight,
      })
      .png()
      .toBuffer();
    const mountedCrop = Buffer.from(mounted.png_base64, 'base64');
    const pixelDifference = await pixelDifferencePercent(mountedCrop, directCrop);
    assert.ok(pixelDifference <= 0.1,
      `mounted raster differs from persisted PDF by ${pixelDifference}%`);
    await Promise.all([
      copyFile(workingPdf, finalPdfArtifact),
      writeFile(mountedArtifact, mountedCrop),
      writeFile(directArtifact, directCrop),
      writeFile(finalViewArtifact, Buffer.from(finalView.png_base64, 'base64')),
    ]);

    const finalRevision = finalSameSessionViewport.documentSaveState;
    const publishedStaleSurfaces = staleSurfaceCount(finalSameSessionViewport);
    assert.equal(publishedStaleSurfaces, 0);
    report.revisions = revisionFields(finalRevision);
    report.stalePublicationCount = publishedStaleSurfaces;
    report.rejectedStalePublicationCount = rejectedPublicationCount(finalSameSessionViewport);
    report.textAssertions.liveSemanticsUsedWithoutReopen = true;
    report.visualAssertions = {
      geometryPreserved: true,
      sourceRegion: finalEdit.original.region,
      persistedRegion: finalEdit.richText.region,
      editorRectBeforeReopen: editorBeforeReopen.rect,
      editorRectAfterReopen: reopenedEditor.rect,
      renderMatchesPersistedPdf: true,
      pixelDifferencePercent: pixelDifference,
      maximumPixelDifferencePercent: 0.1,
      crop,
    };
    report.scenarioMatrix = saveRenderCoherenceScenarioMatrix(['A1', 'A22', 'A23']);
    report.artifacts = [
      path.basename(finalPdfArtifact),
      path.basename(mountedArtifact),
      path.basename(directArtifact),
      path.basename(finalViewArtifact),
    ];
    report.status = 'PASS';
    report.pass = true;
    report.completedAt = new Date().toISOString();
  } catch (error) {
    report.status = 'FAIL';
    report.pass = false;
    report.failures.push(error?.stack || error?.message || String(error));
    report.completedAt = new Date().toISOString();
    if (app) {
      try {
        const screenshot = await app.callTool('app_screenshot_view', { width: 1600 });
        if (screenshot?.png_base64) {
          await writeFile(failureViewArtifact, Buffer.from(screenshot.png_base64, 'base64'));
          report.artifacts.push(path.basename(failureViewArtifact));
        }
      } catch {}
      try {
        const [consoleState, viewportState] = await Promise.all([
          app.callTool('app_get_recent_console', { tail: 500 }).catch(() => null),
          app.callTool('app_get_viewport_state').catch(() => latestViewport),
        ]);
        await writeFile(failureStateArtifact, `${JSON.stringify({
          console: consoleState,
          viewport: viewportState,
          processLogs: app.logs.join(''),
        }, null, 2)}\n`);
        report.artifacts.push(path.basename(failureStateArtifact));
      } catch {}
    }
    try {
      await copyFile(workingPdf, failurePdfArtifact);
      report.artifacts.push(path.basename(failurePdfArtifact));
    } catch {}
  } finally {
    if (app) await app.stop().catch(() => {});
    await rm(runDirectory, { recursive: true, force: true });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSaveContinueEditing(parseArguments(process.argv.slice(2))).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.pass) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
