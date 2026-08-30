export const CONTINUOUS_RENDER_LANES = Object.freeze({
  VISIBLE_PREVIEW: 'visible-preview',
  VISIBLE_FULL: 'visible-full',
  DIRECTIONAL_OVERSCAN: 'directional-overscan',
  SEMANTIC: 'semantic',
});

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function planContinuousRenderOverscan({
  direction = 1,
  scrollVelocityPxPerMs = 0,
  recentPreviewLatencyMs = 150,
  targetLeadMs = 150,
  viewportHeight = 0,
  pageExtentPx = 0,
  budgetAllowsOverscan = true,
  maxLookAheadViewports = 3,
} = {}) {
  if (!budgetAllowsOverscan) {
    return Object.freeze({
      direction: direction < 0 ? -1 : 1,
      lookAheadPx: 0,
      trailingPx: 0,
      overscanBeforePx: 0,
      overscanAfterPx: 0,
    });
  }
  const normalizedDirection = direction < 0 ? -1 : 1;
  const viewport = positive(viewportHeight, 1);
  const pageExtent = positive(pageExtentPx, viewport);
  const leadMs = Math.max(
    positive(targetLeadMs, 150),
    positive(recentPreviewLatencyMs, 150),
  );
  const kineticLead = Math.abs(Number(scrollVelocityPxPerMs) || 0) * leadMs;
  const maximum = viewport * Math.max(1, Number(maxLookAheadViewports) || 3);
  const lookAheadPx = Math.min(maximum, Math.max(pageExtent, kineticLead));
  const trailingPx = Math.min(pageExtent * 0.5, viewport * 0.25);
  return Object.freeze({
    direction: normalizedDirection,
    lookAheadPx,
    trailingPx,
    overscanBeforePx: normalizedDirection < 0 ? lookAheadPx : trailingPx,
    overscanAfterPx: normalizedDirection < 0 ? trailingPx : lookAheadPx,
  });
}

function normalizedPages(pages) {
  return [...new Set((pages || [])
    .map(Number)
    .filter((pageNum) => Number.isSafeInteger(pageNum) && pageNum > 0))];
}

/**
 * Keep a bounded hysteresis window around the pages selected by the current
 * overscan calculation. Only already-mounted pages are retained, so this does
 * not create speculative DOM or raster work; it prevents a one-frame shift in
 * the virtual window from throwing away pixels that a small reverse scroll is
 * likely to need again.
 */
export function planContinuousMountRetention({
  wantedPages = [],
  mountedPages = [],
  centerPage = 1,
  maxPages = 9,
  retainMounted = true,
} = {}) {
  const wanted = normalizedPages(wantedPages);
  if (!retainMounted) return Object.freeze(wanted);
  const capacity = Math.max(wanted.length, Math.max(1, Number(maxPages) || 9));
  const kept = new Set(wanted);
  if (kept.size >= capacity) return Object.freeze([...kept]);

  const lower = wanted.length ? Math.min(...wanted) : Number(centerPage) || 1;
  const upper = wanted.length ? Math.max(...wanted) : lower;
  const center = Number(centerPage) || lower;
  const distanceFromWanted = (pageNum) => (
    pageNum < lower ? lower - pageNum : pageNum > upper ? pageNum - upper : 0
  );
  const candidates = normalizedPages(mountedPages)
    .filter((pageNum) => !kept.has(pageNum))
    .sort((left, right) => (
      distanceFromWanted(left) - distanceFromWanted(right)
      || Math.abs(left - center) - Math.abs(right - center)
      || left - right
    ));
  for (const pageNum of candidates) {
    if (kept.size >= capacity) break;
    kept.add(pageNum);
  }
  return Object.freeze([...kept]);
}

/**
 * A scroll should promote the visible render plus one already-mounted page in
 * the direction of travel. Promoting that look-ahead job prevents generic
 * foreground-activity cancellation from discarding the exact raster the next
 * scroll frame is about to expose.
 */
export function continuousScrollRenderRetentionPages({
  strictlyVisiblePages = [],
  mountedPages = [],
  direction = 1,
} = {}) {
  const visible = normalizedPages(strictlyVisiblePages).sort((left, right) => left - right);
  const retained = new Set(visible);
  if (!visible.length) return Object.freeze([]);
  const mounted = normalizedPages(mountedPages).filter((pageNum) => !retained.has(pageNum));
  const forward = direction < 0 ? -1 : 1;
  const edge = forward > 0 ? visible.at(-1) : visible[0];
  const lookAhead = mounted
    .filter((pageNum) => forward > 0 ? pageNum > edge : pageNum < edge)
    .sort((left, right) => Math.abs(left - edge) - Math.abs(right - edge))[0];
  if (lookAhead) retained.add(lookAhead);
  return Object.freeze([...retained]);
}

export function continuousRenderJobKey({
  documentId,
  lifecycleGeneration,
  pageNum,
  pageRevision,
  quality,
  scaleRevision = 0,
} = {}) {
  const page = Number(pageNum);
  if (!documentId || !Number.isSafeInteger(page) || page < 1 || !quality) {
    throw new TypeError('Continuous render jobs require document, page, and quality identity');
  }
  return [
    String(documentId),
    Number(lifecycleGeneration) || 0,
    page,
    Number(pageRevision) || 0,
    String(quality),
    Number(scaleRevision) || 0,
  ].join(':');
}
