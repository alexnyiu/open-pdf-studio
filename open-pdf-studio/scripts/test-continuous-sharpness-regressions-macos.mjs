import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { startPackagedApp } from './lib/macos-packaged-app.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(project, 'test-artifacts/sharp-scrolling-accepted/regressions');
const bundle = path.resolve(project, '../target/aarch64-apple-darwin/release/bundle/macos/Open PDF Studio.app');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });
const primary = path.join(output, 'text-500.pdf');
const secondary = path.join(output, 'secondary.pdf');
await copyFile(path.join(project, 'test-artifacts/generated-large-pdf-fixtures/lightweight-500.pdf'), primary);
await copyFile(path.join(project, 'test-artifacts/generated-large-pdf-fixtures/small-text-sharpness-4.pdf'), secondary);
const report = { status: 'UNVERIFIED', cases: [], packagedSha256: createHash('sha256').update(
  await readFile(path.join(bundle, 'Contents/MacOS/open-pdf-studio'))).digest('hex') };
const app = await startPackagedApp({ appBundle: bundle, cwd: project,
  artifactDir: path.join(output, 'launch-logs'), launchLabel: 'sharpness-regressions' });
const call = (name, args = {}) => app.callTool(name, args);
const wait = async (description, probe) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
};
const idle = () => wait('render idle', async () => {
  const value = await call('app_get_performance_metrics');
  const work = value.resources?.scheduled;
  return work && !work.queued.length && !work.running.length && !work.retired.length && value;
});
const capture = async (name) => {
  const image = await call('app_screenshot_view', { width: 4096 });
  assert.equal(image.ok, true, image.error);
  const bytes = Buffer.from(image.png_base64, 'base64');
  await writeFile(path.join(output, `${name}.png`), bytes);
  return sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
};
try {
  await call('app_set_window_size', { width: 1440, height: 960, keepVisible: true });
  assert.equal((await call('app_open_pdf', { path: primary })).ok, true);
  await call('app_set_view_mode', { mode: 'continuous' });
  await call('app_set_zoom', { scale: 3 });
  await call('app_go_to_page', { page: 250 });
  await idle();
  const view = await call('app_get_viewport_state');
  report.devicePixelRatio = view.devicePixelRatio;
  const { left, top, width, height } = view.container;
  for (const [label, dy] of [['forward', height], ['reverse', -height], ['small', 18]]) {
    await call('app_scroll', { x: left + width / 2, y: top + height / 2, dy });
    // Capture at the first available painted frames, then compare the same
    // viewport after settling. This runs separately from cadence measurements.
    const entered = await capture(`${label}-entry`);
    await idle();
    await delay(700);
    const settled = await capture(`${label}-settled`);
    assert.deepEqual(entered.info, settled.info);
    let different = 0;
    for (let offset = 0; offset < entered.data.length; offset += 4) {
      if ([0, 1, 2].some((channel) => Math.abs(entered.data[offset + channel] - settled.data[offset + channel]) > 2)) different++;
    }
    const differencePercent = different / (entered.info.width * entered.info.height) * 100;
    report.cases.push({ name: `retina-tiled-${label}-pixels`, status: differencePercent <= 0.1 ? 'PASS' : 'FAIL',
      differencePercent, width: entered.info.width, height: entered.info.height });
    assert.ok(differencePercent <= 0.1, `${label} sharpened after entry: ${differencePercent}%`);
  }
  for (const expectedRotation of [90, 180, 270, 0]) {
    assert.equal((await call('app_click_element', { selector: '#view-rotate-right', searchTabs: true })).ok, true);
    const state = await wait('rotation', async () => {
      const value = await call('app_get_viewport_state');
      return ((Number(value.doc?.pageRotation) % 360 + 360) % 360) === expectedRotation && value;
    });
    await wait('rotated sharp surfaces', async () => {
      const resources = await call('app_get_performance_metrics');
      const visible = resources.resources.sharpWindow.filter((page) => page.visible);
      report.rotationDiagnostics = { expectedRotation, doc: state.doc, resources: resources.resources };
      return visible.length > 0 && visible.every((page) => page.sharp && !page.status);
    });
    await idle();
    report.cases.push({ name: `rotation-${expectedRotation}`, status: 'PASS', page: state.doc.currentPage });
  }
  assert.equal((await call('app_open_pdf', { path: secondary })).ok, true);
  const tabs = await call('app_list_tabs');
  const primaryIndex = tabs.tabs.findIndex((tab) => tab.filePath === primary);
  assert.ok(primaryIndex >= 0);
  assert.equal((await call('app_click_element', { selector: `.document-tab[data-index="${primaryIndex}"]`, searchTabs: false })).ok, true);
  await wait('primary tab restored', async () => (await call('app_get_viewport_state')).doc.filePath === primary);
  await idle();
  const restored = await call('app_get_viewport_state');
  assert.equal(restored.doc.filePath, primary);
  assert.equal(restored.doc.scale, 3);
  assert.equal(restored.doc.currentPage, 250);
  report.cases.push({ name: 'tab-switch-restores-owner-and-sharp-pages', status: 'PASS' });
  assert.equal((await call('app_click_element', {
    selector: `.document-tab[data-index="${primaryIndex}"] .document-tab-close`, searchTabs: false,
  })).ok, true);
  const discard = await call('app_ui_state', { selector: '.unsaved-close-dont-save', searchTabs: false });
  if (discard.found) await call('app_click_element', { selector: '.unsaved-close-dont-save', searchTabs: false });
  await wait('owner closed', async () => !(await call('app_list_tabs')).tabs.some((tab) => tab.filePath === primary));
  await idle();
  assert.equal((await call('app_get_viewport_state')).doc.filePath, secondary);
  report.cases.push({ name: 'owner-close-preserves-other-tab', status: 'PASS' });
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = error.stack;
  report.console = await call('app_get_recent_console', { tail: 100 }).catch(() => null);
  report.viewport = await call('app_get_viewport_state').catch(() => null);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await app.stop();
}
console.log(JSON.stringify(report, null, 2));
