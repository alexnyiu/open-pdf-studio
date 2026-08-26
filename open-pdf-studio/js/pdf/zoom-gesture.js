/** Convert WheelEvent delta units into an approximate CSS-pixel delta. */
export function normalizedWheelDelta(deltaY, deltaMode = 0, viewportHeight = 800) {
  const value = Number(deltaY) || 0;
  if (deltaMode === 1) return value * 16;
  if (deltaMode === 2) return value * Math.max(1, Number(viewportHeight) || 800);
  return value;
}

/**
 * Proportional zoom factor for mouse wheels and trackpad pinch gestures.
 * The exponential curve makes equal wheel travel feel equal at every zoom,
 * while the per-frame clamp prevents high-resolution devices from jumping.
 */
export function smoothWheelZoomFactor(deltaY, options = {}) {
  const sensitivity = Math.max(0.0001, Number(options.sensitivity) || 0.0015);
  const minimum = Math.max(0.1, Number(options.minimum) || 0.78);
  const maximum = Math.max(minimum, Number(options.maximum) || 1.28);
  const factor = Math.exp(-Number(deltaY || 0) * sensitivity);
  return Math.max(minimum, Math.min(maximum, factor));
}
