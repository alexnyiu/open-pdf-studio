import { classifyZoomWheel } from './zoom-gesture.js';

export function nativeGestureIncrement(previousScale, nextScale) {
  const previous = Number(previousScale) > 0 ? Number(previousScale) : 1;
  const next = Number(nextScale) > 0 ? Number(nextScale) : previous;
  return Math.max(0.72, Math.min(1.38, next / previous));
}

/** One owner-agnostic input controller; document ownership is captured by the
 * zoom scheduler at enqueue time. */
export class ZoomGestureController {
  constructor({ schedule, onStart = () => {}, onEnd = () => {}, endDelayMs = 90 } = {}) {
    if (typeof schedule !== 'function') throw new TypeError('ZoomGestureController requires schedule');
    this.schedule = schedule;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.endDelayMs = endDelayMs;
    this.endTimer = null;
    this.nativeActive = false;
    this.nativeScale = 1;
    this.cleanup = [];
  }

  wheel(event, request) {
    if (this.nativeActive) return false;
    const source = classifyZoomWheel(event);
    this.onStart(source);
    const scheduled = this.schedule({ ...request, source });
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.onEnd(source);
    }, this.endDelayMs);
    return scheduled;
  }

  attachNative(element, requestForEvent) {
    if (!element || typeof requestForEvent !== 'function') return;
    const start = (event) => {
      event.preventDefault();
      if (this.endTimer) clearTimeout(this.endTimer);
      this.endTimer = null;
      this.nativeActive = true;
      this.nativeScale = Number(event.scale) || 1;
      this.onStart('native-gesture');
    };
    const change = (event) => {
      if (!this.nativeActive) return;
      event.preventDefault();
      const scale = Number(event.scale) || this.nativeScale;
      const factor = nativeGestureIncrement(this.nativeScale, scale);
      this.nativeScale = scale;
      if (factor !== 1) this.schedule({ ...requestForEvent(event), factor, delta: 0, source: 'native-gesture' });
    };
    const end = (event) => {
      if (!this.nativeActive) return;
      event.preventDefault();
      this.nativeActive = false;
      this.nativeScale = 1;
      this.onEnd('native-gesture');
    };
    element.addEventListener('gesturestart', start, { passive: false });
    element.addEventListener('gesturechange', change, { passive: false });
    element.addEventListener('gestureend', end, { passive: false });
    this.cleanup.push(() => element.removeEventListener('gesturestart', start));
    this.cleanup.push(() => element.removeEventListener('gesturechange', change));
    this.cleanup.push(() => element.removeEventListener('gestureend', end));
  }

  destroy() {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.nativeActive = false;
  }
}
