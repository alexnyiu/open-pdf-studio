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
      pending = { ...request };
    } else {
      pending.accumulatedDelta += request.accumulatedDelta;
      if (request.screenPoint) pending.screenPoint = request.screenPoint;
      if (request.clientPoint) pending.clientPoint = request.clientPoint;
      if (request.anchorY != null) pending.anchorY = request.anchorY;
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
