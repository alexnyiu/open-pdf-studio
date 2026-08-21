import { OCR_SOURCE_RASTER_SPACE } from '../contracts/geometry.js';

export class ScannedTextRasterError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ScannedTextRasterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ScannedTextRasterError(code, message);
}

export function throwIfAborted(signal, stage = 'operation') {
  if (signal?.aborted) {
    const error = new DOMException(`Scanned-text edit cancelled during ${stage}`, 'AbortError');
    Object.defineProperty(error, 'code', { value: 'EDIT_CANCELLED', enumerable: true });
    throw error;
  }
}

export function validateRgbaRaster(raster) {
  if (!raster || !Number.isSafeInteger(raster.widthPx) || raster.widthPx <= 0
      || !Number.isSafeInteger(raster.heightPx) || raster.heightPx <= 0) {
    fail('INVALID_RASTER_DIMENSIONS', 'Raster widthPx and heightPx must be positive integers');
  }
  const rowBytes = raster.rowBytes ?? raster.widthPx * 4;
  if (!Number.isSafeInteger(rowBytes) || rowBytes !== raster.widthPx * 4) {
    fail('INVALID_RASTER_STRIDE', 'RGBA raster rowBytes must equal widthPx * 4');
  }
  if (!(raster.data instanceof Uint8Array || raster.data instanceof Uint8ClampedArray)) {
    fail('INVALID_RASTER_DATA', 'Raster data must be an RGBA Uint8Array');
  }
  if (raster.data.byteLength !== rowBytes * raster.heightPx) {
    fail('INVALID_RASTER_LENGTH', 'Raster byte length must equal widthPx * heightPx * 4');
  }
  return { widthPx: raster.widthPx, heightPx: raster.heightPx, rowBytes };
}

export function validatePixelBounds(bounds, raster, name = 'bounds') {
  validateRgbaRaster(raster);
  if (!bounds || bounds.coordinateSpace !== OCR_SOURCE_RASTER_SPACE
      || !['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(bounds[key]))) {
    fail('INVALID_PIXEL_BOUNDS', `${name} must use integer source-raster pixel boundaries`);
  }
  if (bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0
      || bounds.x + bounds.width > raster.widthPx || bounds.y + bounds.height > raster.heightPx) {
    fail('PIXEL_BOUNDS_OUTSIDE_RASTER', `${name} must be non-empty and inside the source raster`);
  }
  return bounds;
}

export async function sha256Hex(bytes) {
  if (!(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray)) {
    fail('INVALID_DIGEST_INPUT', 'SHA-256 input must be a byte array');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function bytesToBase64(bytes) {
  if (!(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray)) {
    fail('INVALID_PATCH_BYTES', 'Patch bytes must be a Uint8Array');
  }
  let binary = '';
  const chunkSize = 16_384;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return globalThis.btoa(binary);
}

export function base64ToBytes(value) {
  if (typeof value !== 'string') fail('INVALID_PATCH_BASE64', 'Patch data must be base64 text');
  let binary;
  try {
    binary = globalThis.atob(value);
  } catch {
    fail('INVALID_PATCH_BASE64', 'Patch data is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function extractRgbaBytes(raster, bounds) {
  const { rowBytes } = validateRgbaRaster(raster);
  validatePixelBounds(bounds, raster, 'patch bounds');
  const patchRowBytes = bounds.width * 4;
  const bytes = new Uint8Array(patchRowBytes * bounds.height);
  for (let row = 0; row < bounds.height; row += 1) {
    const sourceStart = (bounds.y + row) * rowBytes + bounds.x * 4;
    bytes.set(raster.data.subarray(sourceStart, sourceStart + patchRowBytes), row * patchRowBytes);
  }
  return bytes;
}

export async function createRgbaPatch(raster, bounds) {
  const bytes = extractRgbaBytes(raster, bounds);
  return {
    encoding: 'rgba8-base64',
    coordinateSpace: OCR_SOURCE_RASTER_SPACE,
    originX: bounds.x,
    originY: bounds.y,
    widthPx: bounds.width,
    heightPx: bounds.height,
    rowBytes: bounds.width * 4,
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    data: bytesToBase64(bytes),
  };
}

export async function decodeRgbaPatch(patch, { verifyDigest = true } = {}) {
  if (!patch || patch.encoding !== 'rgba8-base64'
      || patch.coordinateSpace !== OCR_SOURCE_RASTER_SPACE) {
    fail('INVALID_PATCH', 'Patch must be an rgba8-base64 source-raster patch');
  }
  const bytes = base64ToBytes(patch.data);
  const expectedLength = patch.widthPx * patch.heightPx * 4;
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0
      || patch.rowBytes !== patch.widthPx * 4 || patch.byteLength !== expectedLength
      || bytes.byteLength !== expectedLength) {
    zeroBytes(bytes);
    fail('INVALID_PATCH_LENGTH', 'Patch dimensions, stride, byteLength, and decoded data disagree');
  }
  if (verifyDigest && await sha256Hex(bytes) !== patch.sha256) {
    zeroBytes(bytes);
    fail('PATCH_DIGEST_MISMATCH', 'Decoded patch bytes do not match the recorded SHA-256 digest');
  }
  return bytes;
}

export function cloneRgbaRaster(raster) {
  const { rowBytes } = validateRgbaRaster(raster);
  return {
    ...raster,
    rowBytes,
    data: new Uint8ClampedArray(raster.data),
  };
}

export function blitRgbaBytes(targetRaster, bytes, bounds) {
  const { rowBytes } = validateRgbaRaster(targetRaster);
  validatePixelBounds(bounds, targetRaster, 'blit bounds');
  const patchRowBytes = bounds.width * 4;
  if (!(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray)
      || bytes.byteLength !== patchRowBytes * bounds.height) {
    fail('INVALID_BLIT_PATCH', 'Blit bytes must exactly cover the approved region');
  }
  for (let row = 0; row < bounds.height; row += 1) {
    const targetStart = (bounds.y + row) * rowBytes + bounds.x * 4;
    targetRaster.data.set(bytes.subarray(row * patchRowBytes, (row + 1) * patchRowBytes), targetStart);
  }
  return targetRaster;
}

export function containsPixel(bounds, x, y) {
  return x >= bounds.x && y >= bounds.y
    && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
}

export function zeroBytes(bytes) {
  if (bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray) bytes.fill(0);
}
