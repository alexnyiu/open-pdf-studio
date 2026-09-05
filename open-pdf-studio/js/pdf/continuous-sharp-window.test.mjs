import assert from 'node:assert/strict';
import test from 'node:test';
import { planSharpWindow, sharpLeadDistance, sharpRenderPriority, sharpCoverageContains } from './continuous-sharp-window.js';
import { planVisiblePageTiles } from './page-tile-plan.js';
import { createRenderWorkScheduler } from './render-work-scheduler.js';

const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
test('sharp window prepares two ahead and one behind and reverses immediately', () => {
  assert.deepEqual(planSharpWindow({ visiblePages: [20], pageCount: 100 }), [20, 21, 22, 19]);
  assert.deepEqual(planSharpWindow({ visiblePages: [20], pageCount: 100, direction: -1 }), [20, 19, 18, 21]);
  assert.deepEqual(planSharpWindow({ visiblePages: [1], pageCount: 2 }), [1, 2]);
});
test('sharp window has nine surfaces, retains editor leases, and contracts under pressure', () => {
  const input = { visiblePages: [40], candidates: Array.from({ length: 30 }, (_, i) => i + 30),
    protectedPages: [2], pageCount: 100 };
  const pages = planSharpWindow(input);
  assert.equal(pages.length, 9);
  assert.ok(pages.includes(2) && pages.includes(42) && pages.includes(39));
  assert.deepEqual(planSharpWindow({ ...input, allowPrefetch: false }), [40, 2]);
});
test('sharp lead includes render and decode time plus margin within six viewports', () => {
  assert.equal(sharpLeadDistance({ viewportHeight: 800, velocity: 10, latencyMs: 300 }), 4000);
  assert.equal(sharpLeadDistance({ viewportHeight: 800, velocity: 100, latencyMs: 300 }), 4800);
  assert.equal(sharpLeadDistance({ viewportHeight: 800 }), 1600);
});
test('nearby scheduling continues throughout scrolling and reserves a visible slot', async () => {
  const scheduler = createRenderWorkScheduler({ concurrency: 2, maxDirectionalRunning: 1, maxActualRunning: 2 });
  const releases = [];
  const start = (page, kind) => scheduler.schedule({ key: String(page), pageNum: page, kind,
    priority: sharpRenderPriority(page, [1]),
    run: () => new Promise((resolve) => releases.push({ page, resolve })) });
  scheduler.noteInteraction(1);
  const a = start(2, 'directional');
  const b = start(3, 'directional');
  scheduler.noteInteraction(1);
  const c = start(1, 'foreground');
  assert.deepEqual(releases.map(({ page }) => page), [2, 1]);
  releases[0].resolve(); await tick();
  assert.deepEqual(releases.map(({ page }) => page), [2, 1, 3]);
  releases[1].resolve(); releases[2].resolve();
  assert.ok((await Promise.all([a, b, c])).every((r) => r.status === 'complete'));
});
test('promotion deduplicates work and retired callbacks stay inside the actual native cap', async () => {
  const scheduler = createRenderWorkScheduler({ concurrency: 2, maxDirectionalRunning: 1, maxActualRunning: 2 });
  let releaseA, releaseB;
  const a = scheduler.schedule({ key: 'a', kind: 'directional', pageNum: 2, run: () => new Promise((r) => { releaseA = r; }) });
  const promoted = scheduler.schedule({ key: 'a', kind: 'foreground', priority: 4000, run: () => assert.fail('duplicate') });
  assert.equal(a, promoted);
  const b = scheduler.schedule({ key: 'b', kind: 'foreground', run: () => new Promise((r) => { releaseB = r; }) });
  scheduler.cancelWhere((entry) => entry.key === 'a');
  let started = false;
  const c = scheduler.schedule({ key: 'c', run: () => { started = true; } });
  assert.equal(started, false);
  assert.equal(scheduler.snapshot().actualRunning, 2);
  releaseA(); await tick();
  assert.equal(started, true);
  releaseB(); await Promise.all([a, b, c]);
});
test('reprioritizing a reversal runs newly visible work before trailing preparation', async () => {
  const scheduler = createRenderWorkScheduler({ concurrency: 1 });
  let release;
  const first = scheduler.schedule({ key: 'first', run: () => new Promise((r) => { release = r; }) });
  const order = [];
  const a = scheduler.schedule({ key: 'ahead', pageNum: 12, kind: 'directional', priority: 2000, run: () => order.push(12) });
  const b = scheduler.schedule({ key: 'behind', pageNum: 9, kind: 'directional', priority: 1000, run: () => order.push(9) });
  scheduler.reprioritize((entry) => ({ priority: sharpRenderPriority(entry.pageNum, [9], -1) }));
  release(); await Promise.all([first, a, b]);
  assert.deepEqual(order, [9, 12]);
});
test('coverage is invalidated by revision, rotation identity, density, and newly exposed regions', () => {
  const coverage = { identity: 'doc:revision:rotation', scale: 2, left: 0, top: 0, right: 600, bottom: 1200 };
  const required = { left: 0, top: 800, right: 600, bottom: 1100 };
  assert.equal(sharpCoverageContains(coverage, required, 2, coverage.identity), true);
  assert.equal(sharpCoverageContains(coverage, { ...required, bottom: 1400 }, 2, coverage.identity), false);
  assert.equal(sharpCoverageContains(coverage, required, 3, coverage.identity), false);
  assert.equal(sharpCoverageContains(coverage, required, 2, 'edited-or-rotated'), false);
});
test('predicted tiles are stable across slight scrolling and cover offscreen page regions', () => {
  const input = { pageRect: { left: 0, top: 0, right: 600, bottom: 5000 },
    viewportRect: { left: 0, top: 100, right: 600, bottom: 900 },
    predictedRect: { left: 0, top: 0, right: 600, bottom: 2400 },
    cssScale: 1, devicePixelRatio: 2, pageWidthPt: 600, pageHeightPt: 5000 };
  const initial = planVisiblePageTiles(input);
  const shifted = planVisiblePageTiles({ ...input, viewportRect: { ...input.viewportRect, top: 118, bottom: 918 } });
  assert.deepEqual(initial, shifted);
  assert.ok(initial.at(-1).regionYpt + initial.at(-1).regionHpt >= 2400);
});
