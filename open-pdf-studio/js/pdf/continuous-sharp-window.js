/** Planning is independent of DOM and semantic readiness. Distances are CSS pixels. */
export function planSharpWindow({ visiblePages, candidates = [], protectedPages = [], pageCount,
  direction = 1, allowPrefetch = true, maxPages = 9 }) {
  const visible = [...new Set(visiblePages)].sort((a, b) => a - b);
  const required = [...new Set([...visible, ...protectedPages])];
  if (!allowPrefetch || !visible.length) return required;
  const forward = direction < 0 ? -1 : 1;
  const edge = forward > 0 ? visible.at(-1) : visible[0];
  const back = forward > 0 ? visible[0] : visible.at(-1);
  const lead = [edge + forward, edge + 2 * forward, back - forward];
  const ordered = candidates.slice().sort((a, b) => {
    const aheadA = (a - edge) * forward > 0;
    const aheadB = (b - edge) * forward > 0;
    return Number(aheadB) - Number(aheadA) || Math.abs(a - edge) - Math.abs(b - edge);
  });
  return [...new Set([...required, ...lead, ...ordered])]
    .filter((page) => Number.isInteger(page) && page > 0 && page <= pageCount)
    .slice(0, Math.max(maxPages, required.length));
}

export function sharpLeadDistance({ viewportHeight, velocity = 0, latencyMs = 150 }) {
  return Math.min(viewportHeight * 6,
    Math.max(viewportHeight * 2, Math.abs(velocity) * (Math.max(0, latencyMs) + 100)));
}

export function sharpRenderPriority(page, visible, direction = 1) {
  const center = visible.length ? (visible[0] + visible.at(-1)) / 2 : page;
  return (visible.includes(page) ? 4000 : (page - center) * direction > 0 ? 2000 : 1000)
    - Math.abs(page - center);
}

/** A covering rectangle is sufficient because tiles use a stable contiguous grid. */
export function sharpCoverageContains(coverage, required, scale, identity) {
  return Boolean(coverage && required && coverage.identity === identity
    && Math.abs(coverage.scale - scale) <= 0.0001
    && coverage.left <= required.left + 0.01 && coverage.top <= required.top + 0.01
    && coverage.right >= required.right - 0.01 && coverage.bottom >= required.bottom - 0.01);
}
