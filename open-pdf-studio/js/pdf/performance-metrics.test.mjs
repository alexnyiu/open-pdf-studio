import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MACOS_HARDENING_COUNTER_METRICS,
  MACOS_HARDENING_SAMPLE_METRICS,
  incrementPerformanceCounter,
  notePerformanceInteraction,
  performanceMetricsSnapshot,
  recordLatencySinceInteraction,
  recordPerformancePeak,
  recordPerformanceEvent,
  recordPerformanceSample,
  resetPerformanceMetricsForTests,
} from './performance-metrics.js';

test.afterEach(resetPerformanceMetricsForTests);

test('performance metrics report bounded percentiles, counters, and peaks', () => {
  for (let value = 1; value <= 100; value += 1) recordPerformanceSample('frameMs', value);
  incrementPerformanceCounter('cancelled', 2);
  recordPerformancePeak('mounted', 9);
  recordPerformancePeak('mounted', 4);
  const snapshot = performanceMetricsSnapshot();
  assert.equal(snapshot.measurements.frameMs.p50, 50);
  assert.equal(snapshot.measurements.frameMs.p95, 95);
  assert.equal(snapshot.measurements.frameMs.max, 100);
  assert.equal(snapshot.counters.cancelled, 2);
  assert.equal(snapshot.peaks.mounted, 9);
});

test('structured events retain primitive evidence without retaining objects', () => {
  recordPerformanceEvent('raster:completed', {
    bytes: 4096,
    quality: 'final',
    ignored: { bitmap: true },
  });
  const snapshot = performanceMetricsSnapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].type, 'raster:completed');
  assert.equal(snapshot.events[0].bytes, 4096);
  assert.equal(snapshot.events[0].ignored, undefined);
});

test('interaction-relative latency ignores unrelated interaction kinds', () => {
  notePerformanceInteraction('scroll', 100);
  assert.equal(recordLatencySinceInteraction('previewMs', ['zoom'], 120), null);
  assert.equal(recordLatencySinceInteraction('previewMs', ['scroll'], 125), 25);
  assert.equal(performanceMetricsSnapshot().measurements.previewMs.max, 25);
});

test('macOS hardening counters are exposed at zero before the first event', () => {
  const snapshot = performanceMetricsSnapshot();
  for (const name of MACOS_HARDENING_COUNTER_METRICS) {
    assert.equal(snapshot.counters[name], 0, `${name} must be available to packaged gates`);
  }
  assert.ok(MACOS_HARDENING_SAMPLE_METRICS.includes('visiblePagePreviewLatencyMs'));
  assert.ok(MACOS_HARDENING_SAMPLE_METRICS.includes('textEditCommitToVisibleMs'));
});
