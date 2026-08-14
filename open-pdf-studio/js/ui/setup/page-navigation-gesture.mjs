// Roughly one small trackpad scroll should be enough to turn the next page,
// while still preventing one burst of inertia from skipping several pages.
export const PAGE_NAV_SCROLL_THRESHOLD = 80;

/**
 * Gate repeated page turns by accumulated wheel movement. The first page
 * turn is immediate; subsequent turns in the same direction require another
 * threshold's worth of scrolling, so continuous scrolling can keep paging
 * without requiring a pause between pages.
 */
export function createPageNavigationGestureGate({
  threshold = PAGE_NAV_SCROLL_THRESHOLD,
} = {}) {
  let blockedDirection = 0;
  let accumulated = 0;

  return {
    isBlocked: direction => blockedDirection === Math.sign(direction),
    noteWheel: deltaY => {
      const direction = Math.sign(deltaY);
      if (!direction) return;

      // Reversing direction starts a new navigation opportunity immediately.
      if (blockedDirection !== direction) {
        blockedDirection = 0;
        accumulated = 0;
        return;
      }

      accumulated += Math.abs(deltaY);
      if (accumulated >= threshold) {
        blockedDirection = 0;
        accumulated = 0;
      }
    },
    block: direction => {
      blockedDirection = Math.sign(direction);
      accumulated = 0;
    },
  };
}

/**
 * Return the page step for an edge-triggered wheel event.
 *  1  = next page, -1 = previous page, 0 = stay on the current page.
 */
export function getPageNavigationDirection({
  viewMode,
  gestureLocked = false,
  dx = 0,
  dy = 0,
  atTop = false,
  atBottom = false,
  currentPage,
  pageCount,
}) {
  if (viewMode !== 'single' || gestureLocked || Math.abs(dy) <= Math.abs(dx)) return 0;
  if (dy > 0 && atBottom && currentPage < pageCount) return 1;
  if (dy < 0 && atTop && currentPage > 1) return -1;
  return 0;
}
