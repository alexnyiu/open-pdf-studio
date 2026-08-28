import {
  recordRejectedRenderPublication,
  renderPublicationTokenIsCurrent,
} from './render-publication-token.js';

const clock = () => globalThis.performance?.now?.() ?? Date.now();

export function createRenderWorkScheduler({ concurrency = 1, idleDelayMs = 250 } = {}) {
  const queued = new Map();
  const running = new Map();
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

  const wake = () => {
    if (wakeTimer) clearTimeout(wakeTimer);
    const delay = Math.max(0, interactionUntil - clock());
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      pump();
    }, delay);
  };

  const settleCancelled = (entry, reason = 'cancelled') => {
    entry.valid = false;
    statistics.cancelled += 1;
    entry.resolve({ status: 'cancelled', reason });
  };

  const nextEntry = () => [...queued.values()]
    .filter((entry) => entry.kind !== 'background' || !isBackgroundPaused())
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
      }))
        .then((value) => {
          if (entryIsCurrent(entry)) {
            statistics.completed += 1;
            entry.resolve({ status: 'complete', value });
          } else {
            recordRejectedRenderPublication(entry.publicationToken, 'scheduler-after-run');
            statistics.cancelled += 1;
            entry.resolve({ status: 'cancelled', reason: 'stale' });
          }
        }, (error) => {
          statistics.failed += 1;
          entry.reject(error);
        })
        .finally(() => {
          if (running.get(entry.key) === entry) running.delete(entry.key);
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
      run,
    }) {
      if (!key || typeof run !== 'function') throw new TypeError('Render work requires a key and run callback');
      const existing = queued.get(key) || running.get(key);
      if (existing) return existing.promise;
      let resolve;
      let reject;
      const promise = new Promise((resolveValue, rejectValue) => {
        resolve = resolveValue;
        reject = rejectValue;
      });
      queued.set(key, {
        key, ownerKey, priority: Number(priority) || 0, kind, run,
        publicationToken, publicationDocument,
        sequence: ++sequence, valid: true, resolve, reject, promise,
      });
      statistics.scheduled += 1;
      statistics.maxQueued = Math.max(statistics.maxQueued, queued.size);
      pump();
      return promise;
    },
    noteInteraction(durationMs = idleDelayMs) {
      interactionUntil = Math.max(interactionUntil, clock() + Math.max(0, durationMs));
      for (const [key, entry] of queued) {
        if (entry.kind !== 'background') continue;
        queued.delete(key);
        settleCancelled(entry, 'foreground-resumed');
      }
      // A native render may not be interruptible at the FFI boundary, but it
      // can be invalidated immediately so its completion never publishes.
      for (const entry of running.values()) {
        if (entry.kind === 'background') entry.valid = false;
      }
      wake();
    },
    cancelOwner(ownerKey, reason = 'owner-cancelled') {
      for (const [key, entry] of queued) {
        if (entry.ownerKey !== ownerKey) continue;
        queued.delete(key);
        settleCancelled(entry, reason);
      }
      for (const entry of running.values()) if (entry.ownerKey === ownerKey) entry.valid = false;
    },
    cancelWhere(predicate, reason = 'cancelled') {
      for (const [key, entry] of queued) {
        if (!predicate(entry)) continue;
        queued.delete(key);
        settleCancelled(entry, reason);
      }
      for (const entry of running.values()) if (predicate(entry)) entry.valid = false;
    },
    snapshot() {
      return {
        queued: [...queued.values()].map(({ key, ownerKey, priority, kind }) => ({ key, ownerKey, priority, kind })),
        running: [...running.values()].map(({ key, ownerKey, priority, kind }) => ({ key, ownerKey, priority, kind })),
        backgroundPaused: isBackgroundPaused(),
        statistics: { ...statistics },
      };
    },
  };
}
