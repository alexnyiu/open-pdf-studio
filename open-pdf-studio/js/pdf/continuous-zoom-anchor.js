const numberOrZero = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Resolve the horizontal part of a continuous-view zoom anchor.
 *
 * Native scrolling alone cannot preserve a cursor point while a page is
 * narrower than its viewport because negative scrollLeft is unavailable.
 * The residual is represented as a page-layout offset instead. */
export function resolveContinuousHorizontalAnchor({
  basePageX,
  currentPageOffsetX = 0,
  pdfX,
  scale,
  localX,
  maximumScrollLeft = 0,
} = {}) {
  const base = numberOrZero(basePageX);
  const currentOffset = numberOrZero(currentPageOffsetX);
  const point = numberOrZero(pdfX);
  const nextScale = numberOrZero(scale);
  const client = numberOrZero(localX);
  const maximum = Math.max(0, numberOrZero(maximumScrollLeft));
  const desiredScrollLeft = base + currentOffset + point * nextScale - client;
  const scrollLeft = Math.max(0, Math.min(maximum, desiredScrollLeft));
  const pageOffsetX = client + scrollLeft - base - point * nextScale;
  const projectedClientX = base + pageOffsetX + point * nextScale - scrollLeft;
  return Object.freeze({
    scrollLeft,
    pageOffsetX,
    projectedClientX,
    driftPx: Math.abs(projectedClientX - client),
  });
}

/** Give a residual horizontal zoom offset real scrollable space.
 *
 * A negative residual would otherwise place the page to the left of the
 * scroll origin, making those pixels permanently unreachable. Leading and
 * trailing padding carry the residual into native scroll geometry while the
 * translated page point remains at the exact same client coordinate. */
export function resolveContinuousHorizontalScrollSpace({
  baseContentWidth,
  viewportWidth,
  pageOffsetX = 0,
  logicalScrollLeft = 0,
} = {}) {
  const viewport = Math.max(0, numberOrZero(viewportWidth));
  const baseWidth = Math.max(viewport, numberOrZero(baseContentWidth));
  const offset = numberOrZero(pageOffsetX);
  const leadingPaddingPx = Math.max(0, -offset);
  const trailingPaddingPx = Math.max(0, offset);
  const contentWidth = baseWidth + leadingPaddingPx + trailingPaddingPx;
  const maximumLogicalScrollLeft = Math.max(0, baseWidth - viewport);
  const logical = Math.max(
    0,
    Math.min(maximumLogicalScrollLeft, numberOrZero(logicalScrollLeft)),
  );
  const maximumScrollLeft = Math.max(0, contentWidth - viewport);
  const scrollLeft = Math.max(
    0,
    Math.min(maximumScrollLeft, logical + leadingPaddingPx),
  );
  return Object.freeze({
    leadingPaddingPx,
    trailingPaddingPx,
    contentWidth,
    scrollLeft,
    pageTranslationX: offset + leadingPaddingPx,
    maximumScrollLeft,
  });
}

/** Resolve the vertical part of a continuous-view zoom anchor.
 *
 * WebKit may quantize scrollTop even when the requested value is fractional.
 * Carrying that residual in page-layout space keeps the canonical PDF point
 * under the fingers without changing page geometry. */
export function resolveContinuousVerticalAnchor({
  basePageY,
  currentPageOffsetY = 0,
  pdfY,
  scale,
  localY,
  maximumScrollTop = 0,
  appliedScrollTop = null,
} = {}) {
  const base = numberOrZero(basePageY);
  const currentOffset = numberOrZero(currentPageOffsetY);
  const point = numberOrZero(pdfY);
  const nextScale = numberOrZero(scale);
  const client = numberOrZero(localY);
  const maximum = Math.max(0, numberOrZero(maximumScrollTop));
  const desiredScrollTop = base + currentOffset + point * nextScale - client;
  const requestedScrollTop = Math.max(0, Math.min(maximum, desiredScrollTop));
  const scrollTop = appliedScrollTop == null
    ? requestedScrollTop
    : Math.max(0, Math.min(maximum, numberOrZero(appliedScrollTop)));
  const pageOffsetY = client + scrollTop - base - point * nextScale;
  const projectedClientY = base + pageOffsetY + point * nextScale - scrollTop;
  return Object.freeze({
    requestedScrollTop,
    scrollTop,
    pageOffsetY,
    projectedClientY,
    driftPx: Math.abs(projectedClientY - client),
  });
}
