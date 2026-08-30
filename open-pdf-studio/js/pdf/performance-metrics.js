const MAX_SAMPLES_PER_METRIC = 2_048;
const MAX_EVENTS = 1_024;

export const MACOS_HARDENING_COUNTER_METRICS = Object.freeze([
  'textEditVisiblePublicationFailures',
  'textEditCommitVisibleMismatchCount',
  'textEditNoopCount',
  'textEditNoopSaveAttemptCount',
  'textEditTargetReplayFailures',
  'textEditOcrRefreshDeferred',
  'textEditCancelledBySaveInstallCount',
  'textEditIntentSynchronizationFailureCount',
  'textEditReadinessTimeoutCount',
  'textEditResizeGestureRequiredToCommitCount',
  'textEditSafeAutoFitCount',
  'textEditFinalLayoutBarrierTimeoutCount',
  'textEditFinalLayoutStaleOrDroppedResultCount',
  'textEditFinalDraftRevisionMismatchCount',
  'automaticSaveWriteCount',
  'automaticSaveFalseTerminalStateCount',
  'saveOwnerActiveTabEscapeCount',
  'savedProxyViewportFitResetCount',
  'savedViewRestoreConflictCount',
  'savedViewRestoreSkippedFieldCount',
  'proxyAdoptionDeferredForEditorCount',
  'macosSafeSaveRecoveryFileCount',
  'visibleColdRenderSuppressedCount',
  'previewUsefulCancellationCount',
  'retiredNativeWorkCount',
  'retiredNativeStalePublicationCount',
  'pageRenderFailureBlockedLaterPagesCount',
]);

export const MACOS_HARDENING_SAMPLE_METRICS = Object.freeze([
  'textEditOwnerCommitMs',
  'textEditCommitToVisibleMs',
  'textEditSafeAutoFitDeltaWidthPt',
  'pendingProxyRevisionAgeMs',
  'visiblePagePreviewLatencyMs',
  'visiblePageFullRasterLatencyMs',
  'visibleBlankDurationMs',
  'renderQueueAgeMs',
  'retiredNativeWorkDurationMs',
  'observerLeadDistancePx',
  'scrollVelocityPxPerMs',
  'lookAheadCoverageMs',
]);
const samples = new Map();
const counters = new Map();
const peaks = new Map();
const events = [];
let captureStartedAt = null;
let latestInteraction = null;
let longTaskObserver = null;
let longTaskSupported = false;
const frameCadenceCaptures = new Map();

const clock = () => globalThis.performance?.now?.() ?? Date.now();

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function recordPerformanceSample(name, value) {
  const numeric = Number(value);
  if (!name || !Number.isFinite(numeric) || numeric < 0) return false;
  const values = samples.get(name) || [];
  values.push(numeric);
  if (values.length > MAX_SAMPLES_PER_METRIC) values.splice(0, values.length - MAX_SAMPLES_PER_METRIC);
  samples.set(name, values);
  return true;
}

export function incrementPerformanceCounter(name, amount = 1) {
  const numeric = Number(amount);
  if (!name || !Number.isFinite(numeric)) return 0;
  const value = (counters.get(name) || 0) + numeric;
  counters.set(name, value);
  return value;
}

export function recordPerformancePeak(name, value) {
  const numeric = Number(value);
  if (!name || !Number.isFinite(numeric)) return null;
  const next = Math.max(peaks.get(name) || 0, numeric);
  peaks.set(name, next);
  return next;
}

/**
 * Record a bounded structured event for acceptance evidence. Event payloads
 * must remain small primitives so telemetry cannot retain render objects.
 */
export function recordPerformanceEvent(type, detail = {}) {
  if (!type) return false;
  const safeDetail = {};
  for (const [key, value] of Object.entries(detail || {})) {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
      safeDetail[key] = value;
    }
  }
  events.push(Object.freeze({ type: String(type), at: clock(), ...safeDetail }));
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return true;
}

export function notePerformanceInteraction(kind, at = clock()) {
  latestInteraction = { kind: String(kind || 'interaction'), at: Number(at) || clock() };
  return latestInteraction;
}

export function latestPerformanceInteraction(kind = null) {
  if (!latestInteraction || (kind && latestInteraction.kind !== kind)) return null;
  return { ...latestInteraction };
}

export function recordLatencySinceInteraction(name, kinds = null, at = clock()) {
  if (!latestInteraction) return null;
  if (Array.isArray(kinds) && !kinds.includes(latestInteraction.kind)) return null;
  const elapsed = Math.max(0, (Number(at) || clock()) - latestInteraction.at);
  recordPerformanceSample(name, elapsed);
  return elapsed;
}

function stopLongTaskObserver() {
  try { longTaskObserver?.disconnect?.(); } catch {}
  longTaskObserver = null;
}

export function startPerformanceFrameCadence(name) {
  if (!name || frameCadenceCaptures.has(name)
      || typeof globalThis.requestAnimationFrame !== 'function') return false;
  const capture = { frame: 0, previousAt: null };
  const sampleFrame = (timestamp) => {
    if (!frameCadenceCaptures.has(name)) return;
    if (capture.previousAt != null) recordPerformanceSample(name, timestamp - capture.previousAt);
    capture.previousAt = timestamp;
    capture.frame = globalThis.requestAnimationFrame(sampleFrame);
  };
  frameCadenceCaptures.set(name, capture);
  capture.frame = globalThis.requestAnimationFrame(sampleFrame);
  return true;
}

export function stopPerformanceFrameCadence(name) {
  const capture = frameCadenceCaptures.get(name);
  if (!capture) return false;
  frameCadenceCaptures.delete(name);
  if (capture.frame && typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(capture.frame);
  }
  return true;
}

function stopAllFrameCadenceCaptures() {
  for (const name of [...frameCadenceCaptures.keys()]) stopPerformanceFrameCadence(name);
}

export function resetPerformanceMetrics({ observeLongTasks = false } = {}) {
  stopLongTaskObserver();
  stopAllFrameCadenceCaptures();
  samples.clear();
  counters.clear();
  peaks.clear();
  events.length = 0;
  latestInteraction = null;
  captureStartedAt = clock();
  longTaskSupported = false;
  if (observeLongTasks && typeof PerformanceObserver === 'function') {
    try {
      const supported = PerformanceObserver.supportedEntryTypes || [];
      if (supported.includes('longtask')) {
        longTaskSupported = true;
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) recordPerformanceSample('longTaskMs', entry.duration);
        });
        longTaskObserver.observe({ type: 'longtask', buffered: false });
      }
    } catch {
      longTaskSupported = false;
      stopLongTaskObserver();
    }
  }
  return performanceMetricsSnapshot();
}

export function stopPerformanceMetricsCapture() {
  stopLongTaskObserver();
  stopAllFrameCadenceCaptures();
  return performanceMetricsSnapshot();
}

export function performanceMetricsSnapshot() {
  const measurement = {};
  for (const [name, values] of samples) {
    const ordered = [...values].sort((left, right) => left - right);
    measurement[name] = Object.freeze({
      count: ordered.length,
      p50: percentile(ordered, 0.5),
      p95: percentile(ordered, 0.95),
      max: ordered.at(-1) ?? null,
      below20MsPercent: ordered.length
        ? (ordered.filter((value) => value < 20).length / ordered.length) * 100
        : null,
    });
  }
  return Object.freeze({
    captureStartedAt,
    captureElapsedMs: captureStartedAt == null ? null : Math.max(0, clock() - captureStartedAt),
    longTaskSupported,
    measurements: Object.freeze(measurement),
    counters: Object.freeze({
      ...Object.fromEntries(MACOS_HARDENING_COUNTER_METRICS.map((name) => [name, 0])),
      ...Object.fromEntries(counters),
    }),
    peaks: Object.freeze(Object.fromEntries(peaks)),
    events: Object.freeze(events.map((event) => Object.freeze({ ...event }))),
    latestInteraction: latestInteraction ? Object.freeze({ ...latestInteraction }) : null,
  });
}

export function resetPerformanceMetricsForTests() {
  resetPerformanceMetrics();
  captureStartedAt = null;
}
