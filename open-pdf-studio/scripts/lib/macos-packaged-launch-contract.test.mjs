import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

test('packaged launcher uses Launch Services and retains structured failure logs', async () => {
  const launcher = await source('./macos-packaged-app.mjs');
  assert.match(launcher, /spawn\('\/usr\/bin\/open', openArguments/u);
  assert.match(launcher, /const openArguments = \['-n', '-W'/u);
  assert.match(launcher, /status: readiness\.status,[\s\S]*code:[\s\S]*signal:/u);
  assert.match(launcher, /stdoutPath: appStdoutPath,[\s\S]*stderrPath: appStderrPath/u);
  assert.match(launcher, /writeFile\(failureEvidencePath/u);
  const failureBranch = launcher.slice(
    launcher.indexOf("if (readiness.status !== 'ready')"),
    launcher.indexOf('\n  let requestId = 1;'),
  );
  assert.doesNotMatch(failureBranch, /rm\(launchRoot/u);
});

test('all packaged matrix producers share the packaged-app launcher', async () => {
  const producers = [
    '../test-native-paragraph-editing-macos.mjs',
    '../test-annotation-text-editing-macos.mjs',
    '../test-editor-coverage-macos.mjs',
    '../test-save-continue-editing-macos.mjs',
    '../test-editor-performance-macos.mjs',
    '../test-large-pdf-performance-macos.mjs',
    '../test-macos-safe-ocr-save-packaged.mjs',
    '../test-ocr-edit-single-line-macos.mjs',
    '../test-ocr-edit-regions-macos.mjs',
    '../test-macos-release-hardening.mjs',
  ];
  for (const producer of producers) {
    const value = await source(producer);
    assert.match(value, /startPackagedApp/u, `${producer} does not use the shared launcher`);
    assert.doesNotMatch(
      value,
      /spawn\((?:appPath|appExecutable|executablePath),\s*\[[\s\S]{0,100}--mcp-server/u,
      `${producer} directly executes the Tauri binary`,
    );
  }
});

test('trusted insertion re-queries, clicks, verifies focus ownership, then emits keys', async () => {
  const [producer, swiftHelper, tauriConfiguration] = await Promise.all([
    source('../test-native-paragraph-editing-macos.mjs'),
    source('../macos-real-text-edit.swift'),
    source('../../src-tauri/tauri.conf.json'),
  ]);
  const interaction = producer.slice(
    producer.indexOf('async function realTextEditorInteraction'),
    producer.indexOf('\nasync function openPdf'),
  );
  const positioning = producer.slice(
    producer.indexOf('async function positionEditorForPhysicalInput'),
    producer.indexOf('\nasync function realTextEditorInteraction'),
  );
  assert.match(interaction, /await waitUi\('\.pdf-text-editor'/u);
  assert.match(interaction, /pageTextEditHost\?\.editorMountGeneration/u);
  assert.match(interaction, /afterText === beforeText/u);
  assert.match(interaction, /trusted input delivery failed/u);

  const insertion = swiftHelper.slice(swiftHelper.indexOf('if mode == "insert"'));
  assert.ok(insertion.indexOf('postMouseClick(point)') < insertion.indexOf('postKey(pid, 0, flags: .maskCommand)'));
  assert.match(insertion, /frontmostApplication\?\.processIdentifier == pid/u);
  assert.match(swiftHelper, /frontmostApplication\?\.processIdentifier == targetPid/u);
  assert.match(swiftHelper, /\.post\(tap: \.cghidEventTap\)/u);
  assert.doesNotMatch(swiftHelper, /\.postToPid\(/u);
  assert.match(swiftHelper, /focusedAccessibilityRole/u);
  assert.match(swiftHelper, /eventSequence/u);
  assert.equal(JSON.parse(tauriConfiguration).app.windows[0].decorations, false);
  assert.match(interaction, /\.pdf-text-editor \[data-rich-line-index=/u);
  assert.match(interaction, /focusTarget\.rect\.x \+ focusTarget\.rect\.width \/ 2/u);
  assert.match(swiftHelper, /outerOrigin\.y \+ 28/u);
  assert.match(producer, /expandRibbonForPhysicalInput/u);
  assert.match(producer, /app_set_zoom', \{ scale: 3 \}/u);
  assert.match(positioning, /app_mouse_drag/u);
  assert.match(positioning, /button: 'middle'/u);
  assert.match(positioning, /occluder\.rect\.bottom \+ 12/u);
  assert.match(producer, /physicalInputOccluder\.rect\.bottom \+ 12/u);
});
