import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

import { promisify } from 'node:util';
const exec = promisify(execFile);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Real-clock production scrolling. No per-page waits or injected renderer state. */
export async function runSharpnessScenarios({ callTool, outputDir, pageCount, applicationPid }) {
  const scenarios = [];
  const directory = path.join(outputDir, 'sharp-motion');
  await mkdir(directory, { recursive: true });
  const { stdout } = await exec('/usr/bin/swift', ['-e', `
import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
if let window = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int) == pid && (($0[kCGWindowBounds as String] as? [String: Any])?["Width"] as? Double ?? 0) > 400 }), let id = window[kCGWindowNumber as String] { print(id) }
`, String(applicationPid)]);
  const windowId = stdout.trim();
  if (!/^\d+$/.test(windowId)) throw new Error('Cannot identify packaged app window for recording');
  for (const zoom of [1, 3]) {
    await callTool('app_set_zoom', { scale: zoom });
    for (const speed of [1, 3]) {
      await callTool('app_go_to_page', { page: Math.min(pageCount, Math.max(1, Math.floor(pageCount / 2))) });
      // Only the initial warmup may wait; motion never waits for page readiness.
      const deadline = performance.now() + 30_000;
      let ready;
      do {
        ready = await callTool('app_get_performance_metrics');
        const work = ready.resources?.scheduled;
        if (work && work.queued.length === 0 && work.running.length === 0) break;
        await delay(50);
      } while (performance.now() < deadline);
      const viewport = await callTool('app_get_viewport_state');
      const tileStyle = zoom === 3 ? await callTool('app_ui_state', {
        selector: '.page-sharp-tile', searchTabs: false,
      }) : null;
      const { width, height, left, top } = viewport.container;
      const x = left + width / 2, y = top + height / 2;
      await callTool('app_reset_performance_metrics', { observeLongTasks: true });
      const warmupComplete = ready.resources?.scheduled?.queued?.length === 0
        && ready.resources?.scheduled?.running?.length === 0;
      const label = `zoom-${zoom}-speed-${speed}`;
      const frames = [];
      let recordingError = null;
      // A screen recording preserves actual compositor output, including status overlays.
      // Record only the app window (identified independently by the caller when available).
      const videoPath = path.join(directory, `${label}.mov`);
      await rm(videoPath, { force: true });
      const recordingArgs = ['-l', windowId];
      const recorder = spawn('/usr/sbin/screencapture', ['-x', '-v', '-V', '18', ...recordingArgs, videoPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      recorder.stderr.on('data', (data) => { recordingError = (recordingError || '') + data.toString(); });
      recorder.on('error', (error) => { recordingError = error.message; });
      const recording = new Promise((resolve) => recorder.on('close', (code) => resolve(code)));
      const captureFrame = async () => {
        const at = performance.now();
        const result = await callTool('app_screenshot_view', { width: 1600 });
        if (result?.ok && result.png_base64) {
          const file = `${label}-${String(frames.length).padStart(4, '0')}.png`;
          await writeFile(path.join(directory, file), Buffer.from(result.png_base64, 'base64'));
          frames.push({ at, file });
        }
      };
      await captureFrame();
      await callTool('app_reset_performance_metrics', { observeLongTasks: true });
      const legs = [];
      const scroll = async (direction, duration = 3000) => {
        const start = performance.now();
        let previous = start;
        let distance = 0;
        while (performance.now() - start < duration) {
          await delay(16);
          const now = performance.now();
          const dy = direction * speed * height * (now - previous) / 1000;
          previous = now;
          const result = await callTool('app_scroll', { x, y, dy });
          if (!result.ok || !result.defaultScrollApplied) throw new Error('production scroll did not execute');
          distance += dy;
        }
        legs.push({ direction, durationMs: performance.now() - start, distance });
      };
      try {
        await scroll(1);
        await scroll(-1); // no pause before reversal
        await delay(5000);
        await scroll(1);
      } finally {
        // PNG encoding is outside the timed motion; the native video captures every frame.
        await delay(150);
        await captureFrame();
      }
      const metrics = await callTool('app_get_performance_metrics');
      const recordingExit = await recording;
      const counters = metrics.metrics?.counters || {};
      const sample = metrics.metrics?.measurements || {};
      const result = { label, zoom, speed, devicePixelRatio: viewport.devicePixelRatio,
        tileShadowFree: zoom !== 3 || (tileStyle?.found === true && tileStyle.computedStyle?.boxShadow === 'none'),
        warmupComplete,
        frames: counters.sharpMotionFrames || 0, missedFrames: counters.sharpMotionMissFrames || 0,
        entries: counters.sharpViewportEntries || 0, missedEntries: counters.sharpPreparationMisses || 0,
        frameIntervals: sample.motionFrameIntervalMs || null,
        handlerMs: sample.scrollHandlerMs || null,
        legs, captures: frames, video: recordingExit === 0 ? path.basename(videoPath) : null,
        recordingError, metrics };
      scenarios.push(result);
      await writeFile(path.join(directory, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
    }
  }
  await callTool('app_set_zoom', { scale: 1 });
  return scenarios;
}
