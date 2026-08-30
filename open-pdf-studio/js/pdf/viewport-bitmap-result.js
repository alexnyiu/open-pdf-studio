const VIEWPORT_BITMAP_STATUSES = Object.freeze([
  'published',
  'superseded',
  'failed',
]);

export function createViewportBitmapResult(status, {
  reason = null,
  error = null,
} = {}) {
  if (!VIEWPORT_BITMAP_STATUSES.includes(status)) {
    throw new TypeError(`Unsupported viewport bitmap status: ${status}`);
  }
  return Object.freeze({
    status,
    reason: reason == null ? null : String(reason),
    error: error instanceof Error ? error : null,
  });
}

export function viewportBitmapResultFailsCurrentReadiness(result, ownerIsCurrent) {
  return ownerIsCurrent === true && result?.status === 'failed';
}

export function viewportBitmapResultPublished(result) {
  return result?.status === 'published';
}
