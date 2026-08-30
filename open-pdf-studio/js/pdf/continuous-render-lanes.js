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
