export const PAGE_NAV_SCROLL_THRESHOLD = 80;

export function createPageNavigationGestureGate({ threshold = PAGE_NAV_SCROLL_THRESHOLD } = {}) {
  let direction = 0;
  let accumulated = 0;
  let primed = false;

  return {
    shouldNavigate(delta, { atEdge = true } = {}) {
      const amount = Number(delta) || 0;
      const nextDirection = Math.sign(amount);
      if (!atEdge || !nextDirection) {
        if (!atEdge) {
          direction = 0;
          accumulated = 0;
          primed = false;
        }
        return false;
      }
      if (!primed || nextDirection !== direction) {
        direction = nextDirection;
        accumulated = 0;
        primed = true;
        return true;
      }
      accumulated += Math.abs(amount);
      if (accumulated < threshold) return false;
      accumulated %= threshold;
      return true;
    },
    reset() {
      direction = 0;
      accumulated = 0;
      primed = false;
    },
    snapshot() {
      return { direction, accumulated, primed };
    },
  };
}
