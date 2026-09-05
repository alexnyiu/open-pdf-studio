export function loadContinuousRasterImage(lease, {
  signal = null,
  createImage = () => document.createElement('img'),
} = {}) {
  return new Promise((resolve, reject) => {
    const image = createImage();
    image.className = 'pdf-page-raster';
    image.alt = '';
    image.draggable = false;
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.loading = 'eager';

    let settled = false;
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener?.('abort', abort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const abort = () => {
      try { image.removeAttribute('src'); } catch {}
      finish(reject, new DOMException('Raster stream lease was cancelled', 'AbortError'));
    };

    if (!lease?.attach?.(image)) {
      finish(reject, new DOMException('Raster stream lease is no longer current', 'AbortError'));
      return;
    }
    image.onload = async () => {
      try { await image.decode?.(); } catch (error) { finish(reject, error); return; }
      if (settled || signal?.aborted) return;
      if (image.naturalWidth !== lease.width || image.naturalHeight !== lease.height) {
        try { image.removeAttribute('src'); } catch {}
        finish(reject, new Error('direct raster image dimensions do not match its stream descriptor'));
        return;
      }
      finish(resolve, image);
    };
    image.onerror = () => {
      try { image.removeAttribute('src'); } catch {}
      finish(reject, new Error('direct raster image stream failed to decode'));
    };
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    image.src = lease.url;
  });
}
