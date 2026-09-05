/** One pending frame at most, and no wakeups while clean or inactive. */
export function createDemandFrameLoop({ requestFrame, cancelFrame, active, dirty, render }) {
  let pending = null;
  const wake = () => {
    if (pending !== null || !active()) return;
    pending = requestFrame(() => {
      pending = null;
      if (!active()) return;
      render();
      if (dirty()) wake();
    });
  };
  return { wake, stop() { if (pending !== null) cancelFrame(pending); pending = null; } };
}
