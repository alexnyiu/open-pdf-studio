import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./renderer.js', import.meta.url), 'utf8');

test('strictly visible pages bypass the foreground-idle admission gate', () => {
  const start = source.indexOf('function _updateContinuousVirtualWindow');
  const end = source.indexOf('\nexport function getContinuousRenderResourceStats', start);
  const virtualWindow = source.slice(start, end);
  const visibleBranch = virtualWindow.slice(
    virtualWindow.indexOf('if (visible || editRequired)'),
    virtualWindow.indexOf('if (!backgroundRenderAdmissionAllowed()', virtualWindow.indexOf('if (visible || editRequired)')),
  );
  assert.match(visibleBranch, /scheduleContinuousPreview/u);
  assert.match(visibleBranch, /renderContinuousPage/u);
  assert.doesNotMatch(visibleBranch, /isPdfForegroundIdle/u);
  assert.match(virtualWindow, /planContinuousRenderOverscan/u);
  assert.match(virtualWindow, /overscanBeforePx/u);
  assert.match(virtualWindow, /overscanAfterPx/u);
});

test('visible previews and full renders use explicit bounded lanes', () => {
  assert.match(source, /_continuousPreviewScheduler = createRenderWorkScheduler\(\{[\s\S]*?concurrency: 2/u);
  assert.match(source, /_continuousRenderScheduler = createRenderWorkScheduler\(\{[\s\S]*?concurrency: 1/u);
  assert.match(source, /maxRetiredPerOwner: 2/u);
  assert.match(source, /CONTINUOUS_RENDER_LANES\.VISIBLE_PREVIEW/u);
  assert.match(source, /CONTINUOUS_RENDER_LANES\.VISIBLE_FULL/u);
  assert.match(source, /CONTINUOUS_RENDER_LANES\.DIRECTIONAL_OVERSCAN/u);
  assert.match(source, /CONTINUOUS_RENDER_LANES\.SEMANTIC/u);
  assert.doesNotMatch(source, /_lowResPreloadGeneration/u);
  assert.match(source, /visiblePagePreviewLatencyMs/u);
  assert.match(source, /visiblePageFullRasterLatencyMs/u);
  assert.match(source, /visibleBlankWithSourceDurationMs/u);
});

test('an uncached shell is explicit and native failure retains retryable degraded UI', () => {
  const wrapperStart = source.indexOf('function _createContinuousWrapper');
  const wrapperEnd = source.indexOf('\nfunction _releaseContinuousWrapper', wrapperStart);
  const wrapper = source.slice(wrapperStart, wrapperEnd);
  assert.match(wrapper, /Loading page/u);
  assert.match(source, /status\.className = 'page-render-status'/u);

  const scheduledStart = source.indexOf('function renderContinuousPage');
  const scheduledEnd = source.indexOf('\nfunction _continuousRasterContext', scheduledStart);
  const scheduled = source.slice(scheduledStart, scheduledEnd);
  assert.match(scheduled, /Page render failed/u);
  assert.match(scheduled, /Retrying page/u);
  assert.match(source, /pdfCanvasEl\.style\.background = 'transparent'/u);
});

test('production scroll velocity feeds adaptive look-ahead and pauses only background work', () => {
  const scrollStart = source.indexOf('function _bindContinuousScrollSync');
  const scrollEnd = source.indexOf('\nfunction _syncCurrentPageFromScroll', scrollStart);
  const scroll = source.slice(scrollStart, scrollEnd);
  assert.match(scroll, /instantaneousVelocity/u);
  assert.match(scroll, /scrollVelocityPxPerMs/u);
  assert.match(scroll, /_continuousPreviewScheduler\.noteInteraction/u);
  assert.match(scroll, /_continuousRenderScheduler\.noteInteraction/u);
  assert.match(scroll, /continuousScrollRenderRetentionPages/u);
  assert.match(scroll, /preserveUsefulRender/u);
});

test('initial continuous readiness pages are protected before the virtual window is mounted', () => {
  const start = source.indexOf('export async function renderContinuous');
  const end = source.indexOf('\n// Setup pointer events for continuous mode pages', start);
  const render = source.slice(start, end);
  const requiredPlan = render.indexOf('const initialMountRequiredPages = planPostRestoreRequiredPages');
  const protectedOwner = render.indexOf('synchronizationPages: new Set(initialMountRequiredPages)');
  const firstWindowUpdate = render.indexOf('_updateContinuousVirtualWindow({', protectedOwner);

  assert.ok(requiredPlan >= 0);
  assert.ok(protectedOwner > requiredPlan);
  assert.ok(firstWindowUpdate > protectedOwner);
  assert.match(render, /visiblePages: \[doc\.currentPage\]/u);
  assert.match(render, /_continuousWindow\.synchronizationPages\.clear\(\)/u);
  const protectedStart = source.indexOf('function _protectedContinuousPages');
  const protectedEnd = source.indexOf('\nfunction _teardownContinuousWindow', protectedStart);
  const protectedPages = source.slice(protectedStart, protectedEnd);
  assert.match(protectedPages, /pages\.add\(currentPage\)/u);
});

test('a virtualized page retiring before its render starts is superseded, not a readiness failure', () => {
  const start = source.indexOf('async function _renderContinuousPageNow');
  const end = source.indexOf('\nfunction _continuousLayout', start);
  const renderNow = source.slice(start, end);

  assert.doesNotMatch(renderNow, /if \(!pageWrapper\) throw/u);
  assert.match(renderNow, /reason: 'page-unmounted'/u);
  assert.match(renderNow, /superseded: true/u);
});

test('saved proxy synchronization rebuilds semantic layers for every changed page', () => {
  const start = source.indexOf('function _adoptContinuousWindowForSavedProxy');
  const end = source.indexOf('\n/** Rebind stale-but-displayable mounted surfaces', start);
  const adoption = source.slice(start, end);

  assert.match(adoption, /for \(const pageNum of changed\)/u);
  assert.match(adoption, /delete wrapper\.dataset\.semanticLayoutKey/u);
  assert.ok(
    adoption.indexOf('delete wrapper.dataset.semanticLayoutKey')
      < adoption.indexOf('return true;'),
  );
});
