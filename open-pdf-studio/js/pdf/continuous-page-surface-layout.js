/**
 * A continuous page wrapper owns its CSS geometry. Raster publications own
 * only the backing pixels, so their native scale must never become a second
 * layout authority on the mounted page surface.
 */
export function applyContinuousPageSurfaceLayout(surface, owner = 'continuous-page') {
  if (!surface?.style) return false;
  surface.style.width = '100%';
  surface.style.height = '100%';
  if (surface.dataset) surface.dataset.layoutSizeOwner = String(owner);
  return true;
}
