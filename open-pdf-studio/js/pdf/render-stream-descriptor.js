const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_STREAM_DIMENSION = 32_768;
const MAX_STREAM_PIXELS = 64 * 1024 * 1024;
const MAX_STREAM_BYTES = 256 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 1_000;
const MAX_DESCRIPTOR_LIFETIME_MS = 31_000;

/**
 * Validate the capability URL returned by the native loopback renderer before
 * handing it to an image element. The token is both unguessable and one-use;
 * accepting only the literal IPv4 loopback host prevents redirects or a
 * compromised descriptor from turning the image loader into a network fetch.
 */
export function validateRenderStreamDescriptor(descriptor, { now = Date.now() } = {}) {
  const token = String(descriptor?.token || '');
  const width = Number(descriptor?.width) || 0;
  const height = Number(descriptor?.height) || 0;
  const bytes = Number(descriptor?.bytes) || 0;
  const expiresAt = Number(descriptor?.expiresAt) || 0;
  const currentTime = Number(now) || Date.now();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('render stream descriptor has an invalid capability token');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width <= 0 || height <= 0
      || width > MAX_STREAM_DIMENSION || height > MAX_STREAM_DIMENSION
      || width * height > MAX_STREAM_PIXELS) {
    throw new Error('render stream descriptor exceeds the bounded raster dimensions');
  }
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_STREAM_BYTES) {
    throw new Error('render stream descriptor exceeds the bounded payload size');
  }
  if (expiresAt < currentTime - MAX_CLOCK_SKEW_MS
      || expiresAt > currentTime + MAX_DESCRIPTOR_LIFETIME_MS) {
    throw new Error('render stream descriptor has an invalid expiry');
  }
  let url;
  try {
    url = new URL(String(descriptor?.url || ''));
  } catch {
    throw new Error('render stream descriptor has an invalid URL');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.search || url.hash
      || url.pathname !== `/raster/${token}`) {
    throw new Error('render stream descriptor is not a bounded loopback capability');
  }
  return Object.freeze({
    token,
    url: url.href,
    width,
    height,
    bytes,
    expiresAt,
  });
}

