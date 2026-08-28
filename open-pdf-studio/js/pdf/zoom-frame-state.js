/**
 * Small dependency-free latest-frame accumulator used by document zoom.
 * Cancellation invalidates an already-delivered callback as well as removing
 * a queued RAF, so lifecycle teardown cannot apply a stale accumulated delta.
 */
export function createZoomFrameState({ requestFrame, cancelFrame }) {
  if (typeof requestFrame !== 'function' || typeof cancelFrame !== 'function') {
    throw new TypeError('Zoom frame state requires request/cancel frame functions');
  }
  let scheduledFrame = 0;
  let pending = null;
  let generation = 0;

  const cancel = () => {
    generation += 1;
    if (scheduledFrame) cancelFrame(scheduledFrame);
    scheduledFrame = 0;
    pending = null;
  };

  const enqueue = (request, perform) => {
    if (!request?.key || typeof perform !== 'function') return false;
    if (pending && pending.key !== request.key) cancel();
    if (!pending) {
      pending = {
        ...request,
        firstInputAt: request.firstInputAt ?? request.inputAt,
      };
    } else {
      pending.accumulatedDelta += request.accumulatedDelta;
      if (request.accumulatedFactor != null) {
        pending.accumulatedFactor = (pending.accumulatedFactor ?? 1) * request.accumulatedFactor;
      }
      if (request.source) pending.source = request.source;
      if (request.screenPoint) pending.screenPoint = request.screenPoint;
      if (request.clientPoint) pending.clientPoint = request.clientPoint;
      if (request.anchor) pending.anchor = request.anchor;
      if (request.anchorY != null) pending.anchorY = request.anchorY;
      if (request.inputAt != null) pending.inputAt = request.inputAt;
    }
    if (scheduledFrame) return true;
    const scheduledGeneration = generation;
    scheduledFrame = requestFrame(async () => {
      scheduledFrame = 0;
      const current = pending;
      pending = null;
      if (!current || scheduledGeneration !== generation) return;
      await perform(current, {
        isCurrent: () => scheduledGeneration === generation,
      });
    });
    return true;
  };

  return {
    enqueue,
    cancel,
    snapshot: () => pending ? { ...pending, scheduled: Boolean(scheduledFrame) } : null,
  };
}

/**
 * Prefer a compositor-aligned animation frame, but guarantee delivery when
 * WebKit throttles RAF for an unfocused or temporarily occluded window. The
 * timeout is only a liveness fallback; whichever source fires first cancels
 * the other, so a zoom revision can never publish twice.
 */
export function createAnimationFrameScheduler({
  requestAnimationFrameFn = (callback) => requestAnimationFrame(callback),
  cancelAnimationFrameFn = (frame) => cancelAnimationFrame(frame),
  setTimeoutFn = (callback, delay) => setTimeout(callback, delay),
  clearTimeoutFn = (timer) => clearTimeout(timer),
  fallbackMs = 40,
} = {}) {
  let sequence = 0;
  const scheduled = new Map();

  const finish = (id, source, callback, timestamp) => {
    const pending = scheduled.get(id);
    if (!pending) return;
    scheduled.delete(id);
    if (source === 'frame') clearTimeoutFn(pending.timer);
    else cancelAnimationFrameFn(pending.frame);
    callback(timestamp);
  };

  return Object.freeze({
    requestFrame(callback) {
      const id = ++sequence;
      const pending = { frame: 0, timer: 0 };
      scheduled.set(id, pending);
      pending.frame = requestAnimationFrameFn((timestamp) =>
        finish(id, 'frame', callback, timestamp));
      pending.timer = setTimeoutFn(() =>
        finish(id, 'timeout', callback, globalThis.performance?.now?.() ?? Date.now()),
      Math.max(1, Number(fallbackMs) || 40));
      return id;
    },
    cancelFrame(id) {
      const pending = scheduled.get(id);
      if (!pending) return;
      scheduled.delete(id);
      cancelAnimationFrameFn(pending.frame);
      clearTimeoutFn(pending.timer);
    },
  });
}
