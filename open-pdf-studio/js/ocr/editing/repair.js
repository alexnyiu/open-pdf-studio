import { OCR_SOURCE_RASTER_SPACE } from '../contracts/geometry.js';
import { bytesToBase64, sha256Hex } from './raster.js';

export class ScannedTextRepairError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScannedTextRepairError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ScannedTextRepairError(code, message);
}

function median(values) {
  if (values.length === 0) return 255;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function relativeBounds(patch, approvedRegion) {
  const value = {
    x: approvedRegion.x - patch.originX,
    y: approvedRegion.y - patch.originY,
    width: approvedRegion.width,
    height: approvedRegion.height,
  };
  if (!Object.values(value).every(Number.isSafeInteger)
      || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0
      || value.x + value.width > patch.widthPx || value.y + value.height > patch.heightPx) {
    fail('APPROVED_REGION_OUTSIDE_PATCH', 'The approved repair region must be contained by the extracted source patch');
  }
  return value;
}

function pixelOffset(width, x, y) {
  return (y * width + x) * 4;
}

function outside(bounds, x, y) {
  return x < bounds.x || y < bounds.y
    || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height;
}

function contextMedian(patchBytes, patch, repair) {
  const channels = [[], [], []];
  for (let y = 0; y < patch.heightPx; y += 1) {
    for (let x = 0; x < patch.widthPx; x += 1) {
      if (!outside(repair, x, y)) continue;
      const offset = pixelOffset(patch.widthPx, x, y);
      channels[0].push(patchBytes[offset]);
      channels[1].push(patchBytes[offset + 1]);
      channels[2].push(patchBytes[offset + 2]);
    }
  }
  if (channels[0].length === 0) fail('MISSING_REPAIR_CONTEXT', 'Flat repair requires context outside the approved region');
  return channels.map(median);
}

function extractRegion(patchBytes, patch, repair) {
  const bytes = new Uint8Array(repair.width * repair.height * 4);
  for (let row = 0; row < repair.height; row += 1) {
    const sourceStart = pixelOffset(patch.widthPx, repair.x, repair.y + row);
    const targetStart = row * repair.width * 4;
    bytes.set(patchBytes.subarray(sourceStart, sourceStart + repair.width * 4), targetStart);
  }
  return bytes;
}

function flatRepair(patchBytes, patch, repair) {
  const color = contextMedian(patchBytes, patch, repair);
  const repaired = new Uint8Array(repair.width * repair.height * 4);
  for (let offset = 0; offset < repaired.length; offset += 4) {
    repaired[offset] = color[0];
    repaired[offset + 1] = color[1];
    repaired[offset + 2] = color[2];
    repaired[offset + 3] = 255;
  }
  return repaired;
}

function samplePixel(patchBytes, patch, x, y) {
  const clampedX = Math.max(0, Math.min(patch.widthPx - 1, x));
  const clampedY = Math.max(0, Math.min(patch.heightPx - 1, y));
  const offset = pixelOffset(patch.widthPx, clampedX, clampedY);
  return [patchBytes[offset], patchBytes[offset + 1], patchBytes[offset + 2]];
}

function nearFlatRepair(patchBytes, patch, repair) {
  if (repair.x === 0 || repair.y === 0
      || repair.x + repair.width >= patch.widthPx
      || repair.y + repair.height >= patch.heightPx) {
    fail('MISSING_REPAIR_CONTEXT', 'Near-flat repair requires source pixels on all four sides of the approved region');
  }
  const repaired = new Uint8Array(repair.width * repair.height * 4);
  for (let localY = 0; localY < repair.height; localY += 1) {
    const sourceY = repair.y + localY;
    const verticalMix = (localY + 1) / (repair.height + 1);
    const left = samplePixel(patchBytes, patch, repair.x - 1, sourceY);
    const right = samplePixel(patchBytes, patch, repair.x + repair.width, sourceY);
    for (let localX = 0; localX < repair.width; localX += 1) {
      const sourceX = repair.x + localX;
      const horizontalMix = (localX + 1) / (repair.width + 1);
      const top = samplePixel(patchBytes, patch, sourceX, repair.y - 1);
      const bottom = samplePixel(patchBytes, patch, sourceX, repair.y + repair.height);
      const offset = pixelOffset(repair.width, localX, localY);
      for (let channel = 0; channel < 3; channel += 1) {
        const horizontal = left[channel] * (1 - horizontalMix) + right[channel] * horizontalMix;
        const vertical = top[channel] * (1 - verticalMix) + bottom[channel] * verticalMix;
        repaired[offset + channel] = Math.round((horizontal + vertical) / 2);
      }
      repaired[offset + 3] = 255;
    }
  }
  return repaired;
}

function applyRegionToExtraction(original, patch, repair, repairedRegion) {
  const candidate = new Uint8Array(original);
  for (let row = 0; row < repair.height; row += 1) {
    const targetStart = pixelOffset(patch.widthPx, repair.x, repair.y + row);
    const sourceStart = row * repair.width * 4;
    candidate.set(repairedRegion.subarray(sourceStart, sourceStart + repair.width * 4), targetStart);
  }
  return candidate;
}

async function changedRegionMetadata(original, candidate, patch, approvedRegion, repair) {
  let changedPixelCount = 0;
  let outsideApprovedChangedPixels = 0;
  let maxChannelDelta = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < patch.heightPx; y += 1) {
    for (let x = 0; x < patch.widthPx; x += 1) {
      const offset = pixelOffset(patch.widthPx, x, y);
      let changed = false;
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(original[offset + channel] - candidate[offset + channel]);
        if (delta > 0) changed = true;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
      }
      if (!changed) continue;
      changedPixelCount += 1;
      if (outside(repair, x, y)) outsideApprovedChangedPixels += 1;
      const sourceX = patch.originX + x;
      const sourceY = patch.originY + y;
      minX = Math.min(minX, sourceX);
      minY = Math.min(minY, sourceY);
      maxX = Math.max(maxX, sourceX);
      maxY = Math.max(maxY, sourceY);
    }
  }
  if (outsideApprovedChangedPixels !== 0) {
    fail('PIXELS_CHANGED_OUTSIDE_APPROVED_REGION', 'Repair changed pixels outside the approved source-raster rectangle');
  }
  const originalRegion = extractRegion(original, patch, repair);
  const candidateRegion = extractRegion(candidate, patch, repair);
  try {
    return {
      actualBounds: changedPixelCount === 0 ? null : {
        coordinateSpace: OCR_SOURCE_RASTER_SPACE,
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      },
      changedPixelCount,
      outsideApprovedChangedPixels,
      maxChannelDelta,
      beforeSha256: await sha256Hex(originalRegion),
      afterSha256: await sha256Hex(candidateRegion),
    };
  } finally {
    originalRegion.fill(0);
    candidateRegion.fill(0);
  }
}

async function patchRecord(bytes, approvedRegion) {
  return {
    encoding: 'rgba8-base64',
    coordinateSpace: OCR_SOURCE_RASTER_SPACE,
    originX: approvedRegion.x,
    originY: approvedRegion.y,
    widthPx: approvedRegion.width,
    heightPx: approvedRegion.height,
    rowBytes: approvedRegion.width * 4,
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    data: bytesToBase64(bytes),
  };
}

/** Apply one deterministic, fully reversible background repair. */
export async function repairScannedTextBackground({
  patchBytes,
  patch,
  approvedRegion,
  classification,
}) {
  if (!(patchBytes instanceof Uint8Array || patchBytes instanceof Uint8ClampedArray)
      || patchBytes.byteLength !== patch.widthPx * patch.heightPx * 4) {
    fail('INVALID_SOURCE_PATCH', 'Repair requires exact extracted RGBA source-patch bytes');
  }
  if (!['flat', 'near-flat'].includes(classification)) {
    fail('BACKGROUND_REPAIR_REJECTED', `Background class ${classification} is not repairable`);
  }
  const repair = relativeBounds(patch, approvedRegion);
  const original = new Uint8Array(patchBytes);
  let repairedRegion = null;
  let candidate = null;
  try {
    repairedRegion = classification === 'flat'
      ? flatRepair(original, patch, repair)
      : nearFlatRepair(original, patch, repair);
    candidate = applyRegionToExtraction(original, patch, repair, repairedRegion);
    const changedRegion = await changedRegionMetadata(original, candidate, patch, approvedRegion, repair);
    return {
      method: classification === 'flat'
        ? 'flat-median-fill-v1'
        : 'near-flat-edge-interpolation-v1',
      repairedPatch: await patchRecord(repairedRegion, approvedRegion),
      changedRegion,
      repairedExtractionBytes: candidate,
    };
  } catch (error) {
    candidate?.fill(0);
    throw error;
  } finally {
    original.fill(0);
    repairedRegion?.fill(0);
  }
}
