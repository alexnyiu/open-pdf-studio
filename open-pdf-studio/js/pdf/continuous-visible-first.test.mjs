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
  assert.match(scroll, /preserveVisible/u);
});
