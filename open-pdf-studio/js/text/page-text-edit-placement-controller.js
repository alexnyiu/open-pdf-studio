/**
 * Latest-only dirty-frame scheduler for page-local text-editor placement.
 *
 * View and draft changes may mark placement dirty many times in one turn. The
 * controller performs at most one measurement/write callback in the next
 * animation frame and can be synchronously cancelled during editor teardown.
 */
export function createPageTextEditPlacementController({
  isActive,
  update,
  afterUpdate = null,
  retryLimit = 6,
  fallbackDelayMs = 0,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (frameId) => globalThis.cancelAnimationFrame(frameId),
  requestFallback = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancelFallback = (timerId) => globalThis.clearTimeout(timerId),
} = {}) {
  if (typeof isActive !== 'function' || typeof update !== 'function') {
    throw new TypeError('Placement controller requires active-state and update callbacks');
  }
  if (typeof requestFrame !== 'function' || typeof cancelFrame !== 'function') {
    throw new TypeError('Placement controller requires animation-frame callbacks');
  }

  let frameId = null;
  let fallbackTimerId = null;
  let disposed = false;
  let retryCount = 0;

  const runUpdate = () => {
    if (disposed || !isActive()) return;
    const settled = update();
    afterUpdate?.();
    if (settled === false && !disposed && isActive()
        && retryCount < Math.max(0, Number(retryLimit) || 0)) {
      retryCount += 1;
      schedule(true);
    } else {
      retryCount = 0;
    }
  };

  const schedule = (retry = false) => {
    if (disposed || !isActive() || frameId !== null) return false;
    if (!retry) retryCount = 0;
    frameId = requestFrame(() => {
      if (frameId === null) return;
      frameId = null;
      if (fallbackTimerId !== null) {
        cancelFallback(fallbackTimerId);
        fallbackTimerId = null;
      }
      runUpdate();
    });
    const fallbackDelay = Number(fallbackDelayMs);
    if (Number.isFinite(fallbackDelay) && fallbackDelay > 0) {
      fallbackTimerId = requestFallback(() => {
        fallbackTimerId = null;
        if (frameId === null) return;
        const dormantFrameId = frameId;
        frameId = null;
        cancelFrame(dormantFrameId);
        runUpdate();
      }, fallbackDelay);
    }
    return true;
  };

  const markDirty = () => schedule(false);

  const cancel = () => {
    retryCount = 0;
    let cancelled = false;
    if (frameId !== null) {
      cancelFrame(frameId);
      frameId = null;
      cancelled = true;
    }
    if (fallbackTimerId !== null) {
      cancelFallback(fallbackTimerId);
      fallbackTimerId = null;
      cancelled = true;
    }
    return cancelled;
  };

  return {
    markDirty,
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
    get pending() {
      return frameId !== null;
    },
  };
}

/**
 * Decide whether a reactive listener cleanup still owns the controller work it
 * is about to cancel. Solid runs the previous effect cleanup after signals may
 * already identify the next keyed editor mount, so an unconditional cancel can
 * otherwise discard the new session's portal-attachment frame.
 */
export function shouldCancelPageTextEditPlacement({
  active,
  observedMountGeneration,
  currentMountGeneration,
  observedSessionGeneration,
  currentSessionGeneration,
} = {}) {
  if (!active) return true;
  return Object.is(observedMountGeneration, currentMountGeneration)
    && Object.is(observedSessionGeneration, currentSessionGeneration);
}
