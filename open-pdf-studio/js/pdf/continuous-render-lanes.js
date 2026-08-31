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
 * Decide whether a mounted continuous-view page is already the exact surface
 * the current document owner needs. The renderer's in-memory page set is only
 * a scheduling hint: resource accounting and lifecycle adoption may rebuild
 * that set independently of a still-connected, current raster. Reusing the
 * validated surface prevents a same-page scroll from scheduling fresh preview
 * or full-raster work and flashing a "Rendering page" status.
 */
export function continuousMountedRasterCanReuse({
  documentId = '',
  ownerDocumentId = '',
  lifecycleGeneration = 0,
  ownerLifecycleGeneration = 0,
  rasterSourceRevision = null,
  expectedSourceRevision = null,
  rasterRotation = null,
  expectedRotation = null,
  renderState = '',
  rasterQuality = '',
  targetRasterScale = 0,
  expectedRasterScale = 0,
  hasRasterSurface = false,
} = {}) {
  const targetScale = Number(targetRasterScale);
  const expectedScale = Number(expectedRasterScale);
  const sourceRevision = Number(rasterSourceRevision);
  const currentSourceRevision = Number(expectedSourceRevision);
  const rotation = Number(rasterRotation);
  const currentRotation = Number(expectedRotation);
  return Boolean(
    documentId
    && documentId === ownerDocumentId
    && (Number(lifecycleGeneration) || 0) === (Number(ownerLifecycleGeneration) || 0)
    && rasterSourceRevision !== null && rasterSourceRevision !== undefined
    && expectedSourceRevision !== null && expectedSourceRevision !== undefined
    && Number.isSafeInteger(sourceRevision) && sourceRevision >= 0
    && sourceRevision === currentSourceRevision
    && rasterRotation !== null && rasterRotation !== undefined
    && expectedRotation !== null && expectedRotation !== undefined
    && Number.isFinite(rotation) && rotation === currentRotation
    && renderState === 'ready'
    && rasterQuality === 'final'
    && Number.isFinite(targetScale)
    && Number.isFinite(expectedScale)
    && Math.abs(targetScale - expectedScale) <= 0.0001
    && hasRasterSurface
  );
}

/**
 * A PDF-proxy render can only acknowledge the live serialized revision. When
 * model-owned edits or page rotation are newer, the freshly mounted surface
 * must be republished through the model coordinator after every required
 * visual/semantic layer has succeeded.
 */
export function continuousModelReadinessReconciliationRequired({
  pageRevision = 0,
  livePdfRevision = 0,
  readinessSatisfied = false,
  completedLayers = [],
  requiredLayers = [],
} = {}) {
  const completed = new Set(completedLayers || []);
  return Number(pageRevision) > Number(livePdfRevision)
    && readinessSatisfied !== true
    && [...(requiredLayers || [])].every((layer) => completed.has(layer));
}

/**
 * Restamp diagnostic metadata for a retained raster only after the mounted
 * page registry proves that the current model-owned base and semantic layers
 * are both published. This is metadata reconciliation, not a raster
 * publication: callers must preserve the original publication identity.
 */
export function continuousRenderedSurfaceRevisionUpdate({
  surfaceState = null,
  documentId = '',
  lifecycleGeneration = 0,
  pageNum = 0,
  contentRevision = 0,
  livePdfRevision = 0,
  pageRevision = 0,
  registryPageRevision = null,
  basePublishedRevision = null,
  semanticPublishedRevision = null,
  readinessSatisfied = false,
} = {}) {
  const normalizedPage = Number(pageNum);
  const normalizedPageRevision = Number(pageRevision);
  const normalizedRegistryRevision = Number(registryPageRevision);
  const normalizedBaseRevision = Number(basePublishedRevision);
  const normalizedSemanticRevision = Number(semanticPublishedRevision);
  if (!surfaceState
      || readinessSatisfied !== true
      || !documentId
      || surfaceState.documentId !== String(documentId)
      || Number(surfaceState.ownerGeneration) !== (Number(lifecycleGeneration) || 0)
      || !Number.isSafeInteger(normalizedPage) || normalizedPage <= 0
      || Number(surfaceState.pageNum) !== normalizedPage
      || !Number.isSafeInteger(normalizedPageRevision) || normalizedPageRevision < 0
      || registryPageRevision === null || registryPageRevision === undefined
      || basePublishedRevision === null || basePublishedRevision === undefined
      || semanticPublishedRevision === null || semanticPublishedRevision === undefined
      || normalizedRegistryRevision !== normalizedPageRevision
      || normalizedBaseRevision < normalizedPageRevision
      || normalizedSemanticRevision < normalizedPageRevision) return null;
  return Object.freeze({
    contentRevision: Math.max(0, Number(contentRevision) || 0),
    livePdfRevision: Math.max(0, Number(livePdfRevision) || 0),
    pageRevision: normalizedPageRevision,
  });
}

export function continuousMountedRenderCanReuse(input = {}) {
  return Boolean(
    continuousMountedRasterCanReuse(input)
    && input.semanticLayoutKey
    && input.semanticLayoutKey === input.expectedSemanticLayoutKey
    && input.readinessSatisfied
  );
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
