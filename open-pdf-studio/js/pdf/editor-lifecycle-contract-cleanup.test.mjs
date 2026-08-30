import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

test('editor and save boundaries no longer normalize legacy boolean results', async () => {
  const [saveCoordinator, clickAway, textTool] = await Promise.all([
    source('./save-coordinator.js'),
    source('../text/text-edit-click-away-intent.js'),
    source('../tools/text-edit-tool.js'),
  ]);
  assert.doesNotMatch(saveCoordinator, /normalizeExecutionResult|rawResult\s*===\s*true|\.saved\s*===\s*true/u);
  assert.match(saveCoordinator, /assertExecutionResult\(await request\.execute/u);
  assert.doesNotMatch(clickAway, /commitSucceeded/u);
  assert.match(clickAway, /textApplyResultCompletesInteraction\(applyResult\)/u);
  assert.match(clickAway, /opened\?\.activated\s*!==\s*true/u);
  assert.match(textTool, /textEditActivationResult/u);
});

test('page consumers resolve owned surfaces without arbitrary text-layer fallbacks', async () => {
  const [undo, findBar, renderer, tabs, textLayer] = await Promise.all([
    source('../core/undo-manager.js'),
    source('../search/find-bar.js'),
    source('./renderer.js'),
    source('../ui/chrome/tabs.js'),
    source('../text/text-layer.js'),
  ]);
  assert.doesNotMatch(undo, /document\.querySelector\([^\n]*\.textLayer|document\.getElementById\?\.\('pdf-canvas'\)/u);
  assert.doesNotMatch(findBar, /document\.querySelector\([^\n]*\.textLayer|wrapper\?\.querySelector\('\.textLayer'\)/u);
  assert.doesNotMatch(renderer, /document\.querySelector\('\.textLayer'\)/u);
  assert.doesNotMatch(tabs, /document\.querySelector\('\.textLayer'\)/u);
  assert.match(undo, /resolvePageSurface\(doc, pageNum\)/u);
  assert.match(findBar, /resolvePageSurface\(doc, pageNum\)/u);
  assert.match(renderer, /resolvePageSurface\(doc, pageNum\)\?\.textLayer/u);
  assert.match(tabs, /clearActiveDocumentTextLayers\(\)/u);
  assert.match(textLayer, /if \(baseSurface\) input\.baseSurface = baseSurface/u);
  assert.match(textLayer, /if \(geometryCanvas\) input\.geometryCanvas = geometryCanvas/u);
  assert.doesNotMatch(
    textLayer,
    /baseSurface:\s*authoritativePreview\s*\|\|\s*rasterImage\s*\|\|\s*baseCanvas/u,
  );
});

test('retired publication, lifecycle, anchor, and preview compatibility paths stay absent', async () => {
  const [publication, lifecycle, lifecycleFacade, viewState, renderer] = await Promise.all([
    source('../text/text-edit-publication.js'),
    source('../core/document-lifecycle-state.js'),
    source('../core/document-lifecycle.js'),
    source('./view-state-transaction.js'),
    source('./renderer.js'),
  ]);
  assert.doesNotMatch(publication, /coverNativeSourceForLivePreview|dominantBackgroundColor/u);
  assert.match(lifecycle, /LIFECYCLE_TRANSITION_POLICIES/u);
  assert.doesNotMatch(lifecycle, /reason\s*===\s*['"][^'"]+['"]/u);
  assert.match(lifecycleFacade, /cancelCommittedTextPublicationsForDocument\(documentId\)/u);
  assert.doesNotMatch(viewState, /rawPixel|raw-pixel|restoreRaw/u);
  assert.doesNotMatch(renderer, /_lowResPreloadGeneration/u);
  assert.match(renderer, /continuousRenderJobKey/u);
});
