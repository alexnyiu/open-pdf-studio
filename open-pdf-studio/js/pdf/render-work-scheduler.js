import {
  recordRejectedRenderPublication,
  renderPublicationTokenIsCurrent,
} from './render-publication-token.js';

const clock = () => globalThis.performance?.now?.() ?? Date.now();

export function createRenderWorkScheduler({
  concurrency = 1,
  idleDelayMs = 250,
  maxRetiredPerOwner = Number.POSITIVE_INFINITY,
} = {}) {
  const queued = new Map();
  const running = new Map();
  const retired = new Map();
  let sequence = 0;
  let interactionUntil = 0;
  let wakeTimer = null;
  const statistics = {
    scheduled: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    maxQueued: 0,
    maxRunning: 0,
  };

  const isBackgroundPaused = () => clock() < interactionUntil;
  const retiredForOwner = (ownerKey) => [...retired.values()]
    .filter((entry) => entry.ownerKey === ownerKey).length;

  const wake = () => {
    if (wakeTimer) clearTimeout(wakeTimer);
    const delay = Math.max(0, interactionUntil - clock());
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      pump();
    }, delay);
  };

  const settleCancelled = (entry, reason = 'cancelled') => {
    if (entry.settled) return false;
    entry.valid = false;
    if (!entry.abortController.signal.aborted) entry.abortController.abort(reason);
    entry.settled = true;
    statistics.cancelled += 1;
    try { entry.onCancel?.(reason, entry); } catch { /* cancellation must still settle */ }
    entry.resolve({ status: 'cancelled', reason });
    return true;
  };

  const retireRunning = (key, entry, reason) => {
    if (running.get(key) !== entry) return false;
    running.delete(key);
    retired.set(`${key}:${entry.sequence}`, entry);
    try { entry.onRetire?.(reason); } catch { /* retirement must still settle */ }
    settleCancelled(entry, reason);
    return true;
  };

  const nextEntry = () => [...queued.values()]
    .filter((entry) => entry.kind !== 'background' || !isBackgroundPaused())
    .filter((entry) => !Number.isFinite(maxRetiredPerOwner)
      || retiredForOwner(entry.ownerKey) < maxRetiredPerOwner)
    .sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)[0] || null;

  const entryIsCurrent = (entry) => entry.valid
    && (!entry.publicationToken
      || renderPublicationTokenIsCurrent(entry.publicationToken, entry.publicationDocument));

  const pump = () => {
    while (running.size < concurrency) {
      const entry = nextEntry();
      if (!entry) {
        if (queued.size && isBackgroundPaused()) wake();
        return;
      }
      queued.delete(entry.key);
      if (!entryIsCurrent(entry)) {
        recordRejectedRenderPublication(entry.publicationToken, 'scheduler-before-run');
        settleCancelled(entry, 'stale-publication-token');
        continue;
      }
      running.set(entry.key, entry);
      statistics.maxRunning = Math.max(statistics.maxRunning, running.size);
      void Promise.resolve(entry.run({
        isCurrent: () => entryIsCurrent(entry) && running.get(entry.key) === entry,
        signal: entry.abortController.signal,
      }))
        .then((value) => {
          if (entryIsCurrent(entry) && !entry.settled) {
            entry.settled = true;
            statistics.completed += 1;
            entry.resolve({ status: 'complete', value });
          } else {
            recordRejectedRenderPublication(entry.publicationToken, 'scheduler-after-run');
            settleCancelled(entry, 'stale');
          }
        }, (error) => {
          if (entry.settled) return;
          entry.settled = true;
          statistics.failed += 1;
          entry.reject(error);
        })
        .finally(() => {
          if (running.get(entry.key) === entry) running.delete(entry.key);
          retired.delete(`${entry.key}:${entry.sequence}`);
          pump();
        });
    }
  };

  return {
    schedule({
      key,
      ownerKey = '',
      priority = 0,
      kind = 'foreground',
      publicationToken = null,
      publicationDocument = null,
      onRetire = null,
      onCancel = null,
      pageNum = null,
      lane = null,
      quality = null,
      run,
    }) {
      if (!key || typeof run !== 'function') throw new TypeError('Render work requires a key and run callback');
      const existing = queued.get(key) || running.get(key);
      if (existing) {
        existing.priority = Math.max(existing.priority, Number(priority) || 0);
        if (kind !== 'background') existing.kind = kind;
        if (lane != null) existing.lane = lane;
        if (quality != null) existing.quality = quality;
        if (queued.has(key)) pump();
        return existing.promise;
      }
      let resolve;
      let reject;
      const promise = new Promise((resolveValue, rejectValue) => {
        resolve = resolveValue;
        reject = rejectValue;
      });
      const abortController = new AbortController();
      queued.set(key, {
        key, ownerKey, priority: Number(priority) || 0, kind, run,
        publicationToken, publicationDocument, onRetire, onCancel,
        pageNum: Number(pageNum) || null, lane, quality, abortController,
        sequence: ++sequence, valid: true, settled: false, resolve, reject, promise,
      });
      statistics.scheduled += 1;
      statistics.maxQueued = Math.max(statistics.maxQueued, queued.size);
      pump();
      return promise;
    },
    noteInteraction(durationMs = idleDelayMs, { preserve = null } = {}) {
      interactionUntil = Math.max(interactionUntil, clock() + Math.max(0, durationMs));
      for (const [key, entry] of queued) {
        if (entry.kind !== 'background') continue;
        if (preserve?.(entry)) {
          entry.kind = 'foreground';
          continue;
        }
        queued.delete(key);
        settleCancelled(entry, 'foreground-resumed');
      }
      // A native render may not be interruptible at the FFI boundary, but it
      // can be retired immediately so it neither publishes nor occupies the
      // foreground slot while its underlying callback unwinds.
      for (const [key, entry] of [...running]) {
        if (entry.kind !== 'background') continue;
        if (preserve?.(entry)) {
          entry.kind = 'foreground';
          continue;
        }
        retireRunning(key, entry, 'foreground-resumed');
      }
      wake();
    },
    cancelOwner(ownerKey, reason = 'owner-cancelled') {
      for (const [key, entry] of queued) {
        if (entry.ownerKey !== ownerKey) continue;
        queued.delete(key);
        settleCancelled(entry, reason);
      }
      for (const [key, entry] of [...running]) {
        if (entry.ownerKey === ownerKey) retireRunning(key, entry, reason);
      }
      pump();
    },
    cancelWhere(predicate, reason = 'cancelled') {
      for (const [key, entry] of queued) {
        if (!predicate(entry)) continue;
        queued.delete(key);
        settleCancelled(entry, reason);
      }
      for (const [key, entry] of [...running]) {
        if (predicate(entry)) retireRunning(key, entry, reason);
      }
      pump();
    },
    snapshot() {
      return {
        queued: [...queued.values()].map(({ key, ownerKey, priority, kind, pageNum, lane, quality }) => (
          { key, ownerKey, priority, kind, pageNum, lane, quality }
        )),
        running: [...running.values()].map(({ key, ownerKey, priority, kind, pageNum, lane, quality }) => (
          { key, ownerKey, priority, kind, pageNum, lane, quality }
        )),
        retired: [...retired.values()].map(({ key, ownerKey, priority, kind, pageNum, lane, quality }) => (
          { key, ownerKey, priority, kind, pageNum, lane, quality }
        )),
        actualRunning: running.size + retired.size,
        maxRetiredPerOwner,
        backgroundPaused: isBackgroundPaused(),
        statistics: { ...statistics },
      };
    },
  };
}
