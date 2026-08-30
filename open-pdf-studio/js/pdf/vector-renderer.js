/**
 * Vector renderer: plays back binary draw commands on Canvas2D.
 * Commands are produced by open-pdf-render (Rust) and transferred as a Uint8Array.
 *
 * Binary format (all values little-endian):
 *   Header: f32 pageWidth, f32 pageHeight (8 bytes)
 *   Then a sequence of commands, each starting with a u8 opcode:
 *     0  MoveTo(f32 x, f32 y)
 *     1  LineTo(f32 x, f32 y)
 *     2  CubicTo(f32 x1, y1, x2, y2, x3, y3)
 *     3  Rect(f32 x, y, w, h)
 *     4  ClosePath
 *     5  SetStroke(u32 rgba, f32 width)
 *     6  SetFill(u32 rgba)
 *     7  Stroke
 *     8  Fill
 *     9  FillEvenOdd
 *    10  Save
 *    11  Restore
 *    12  Transform(f32 a, b, c, d, e, f)
 *    13  SetLineCap(u8)
 *    14  SetLineJoin(u8)
 *    15  SetMiterLimit(f32)
 *    16  SetDash(u8 count, count*f32, f32 phase)
 *    17  BeginPath
 *    18  TextAt(f32 x, f32 y, f32 fontSize, u32 rgba, u8 len, UTF-8 bytes)
 */

import {
  registerRenderResource,
  touchRenderResource,
  unregisterRenderResource,
  isActiveRenderDocument,
} from './render-resource-budget.js';
import {
  recordRejectedRenderPublication,
  renderPublicationTokenIsCurrent,
} from './render-publication-token.js';

// Command and decoded-image keys include logical document/page revision plus
// rotation. Validated proxy adoption therefore preserves unchanged pages.
const _cache = new Map();
const _fileOwners = new Map();

function revisionIdentity(filePath, pageNum, publicationToken = null) {
  const owner = _fileOwners.get(filePath);
  return {
    documentId: publicationToken?.documentId || owner?.documentId || filePath,
    lifecycleGeneration: Number(publicationToken?.lifecycleGeneration
      ?? owner?.lifecycleGeneration) || 0,
    contentRevision: Number(publicationToken?.contentRevision
      ?? owner?.contentRevisionReader?.()) || 0,
    pageRevision: Number(publicationToken?.pageRevision
      ?? owner?.pageRevisionReader?.(pageNum)) || 0,
  };
}

function _key(filePath, pageNum, rotation, publicationToken = null) {
  const identity = revisionIdentity(filePath, pageNum, publicationToken);
  return [
    filePath,
    `d${identity.documentId}`,
    `p${pageNum}`,
    `v${identity.pageRevision}`,
    `r${((rotation || 0) % 360)}`,
  ].join('|');
}

const _commandResourceKey = (key) => `vector-command:${key}`;
const _imageKey = (commandKey, position) => `${commandKey}@${position}`;
const _imageResourceKey = (key) => `vector-image:${key}`;

export function registerVectorCacheOwner(
  filePath,
  documentId,
  lifecycleGeneration = 0,
  contentRevisionReader = null,
  pageRevisionReader = null,
) {
  if (!filePath || !documentId) return;
  _fileOwners.set(filePath, {
    documentId,
    lifecycleGeneration: Math.max(0, Number(lifecycleGeneration) || 0),
    contentRevisionReader: typeof contentRevisionReader === 'function' ? contentRevisionReader : null,
    pageRevisionReader: typeof pageRevisionReader === 'function' ? pageRevisionReader : null,
  });
  for (const [key, entry] of _cache) {
    if (entry.filePath === filePath) registerCommandResource(key, entry);
  }
  for (const [key, entry] of _imageCache) {
    if (entry.filePath === filePath) registerImageResource(key, entry);
  }
}

function resourceProtected(filePath, pageNum) {
  if (typeof window === 'undefined') return false;
  const ownerIsActive = isActiveRenderDocument(_fileOwners.get(filePath)?.documentId || filePath);
  return (window.__pdfViewport?.filePath === filePath && window.__pdfViewport?.pageNum === pageNum)
    || (ownerIsActive && typeof document !== 'undefined'
      && Boolean(document.querySelector?.(`#continuous-container .page-wrapper[data-page="${pageNum}"]`)));
}

function releaseVectorEntry(key) {
  _cache.delete(key);
  unregisterRenderResource(_commandResourceKey(key));
  const prefix = `${key}@`;
  for (const [imageKey, entry] of _imageCache) {
    if (!imageKey.startsWith(prefix)) continue;
    try { entry.bitmap?.close?.(); } catch {}
    _imageCache.delete(imageKey);
    unregisterRenderResource(_imageResourceKey(imageKey));
  }
}

function registerCommandResource(key, entry) {
  registerRenderResource({
    key: _commandResourceKey(key),
    category: 'javascript',
    documentId: _fileOwners.get(entry.filePath)?.documentId || entry.filePath,
    bytes: entry.bytes.byteLength,
    protected: () => resourceProtected(entry.filePath, entry.pageNum),
    release: () => releaseVectorEntry(key),
  });
}

function registerImageResource(key, entry) {
  registerRenderResource({
    key: _imageResourceKey(key),
    category: 'javascript',
    documentId: _fileOwners.get(entry.filePath)?.documentId || entry.filePath,
    bytes: entry.width * entry.height * 4,
    protected: () => resourceProtected(entry.filePath, entry.pageNum),
    release: () => {
      const current = _imageCache.get(key);
      try { current?.bitmap?.close?.(); } catch {}
      _imageCache.delete(key);
    },
  });
}

export function clearVectorCache() {
  for (const key of [..._cache.keys()]) releaseVectorEntry(key);
  for (const [key, entry] of _imageCache) {
    try { entry.bitmap?.close?.(); } catch {}
    unregisterRenderResource(_imageResourceKey(key));
  }
  _imageCache.clear();
  _fileOwners.clear();
}

export function clearVectorCacheForFile(filePath) {
  if (!filePath) return;
  for (const [key, entry] of [..._cache.entries()]) {
    if (entry.filePath === filePath) releaseVectorEntry(key);
  }
  _fileOwners.delete(filePath);
}

/// Drop ALL cached entries for a specific (filePath, pageNum), regardless
/// of rotation. Use this when the page content changes (e.g. after save).
export function invalidatePageCache(filePath, pageNum) {
  for (const [key, entry] of [..._cache.entries()]) {
    if (entry.filePath === filePath && entry.pageNum === Number(pageNum)) releaseVectorEntry(key);
  }
}

export function clearVectorCacheForPages(filePath, pages) {
  if (!filePath) return;
  for (const pageNum of new Set((pages || []).map(Number))) {
    if (Number.isSafeInteger(pageNum) && pageNum > 0) invalidatePageCache(filePath, pageNum);
  }
}

export function cacheCommands(filePath, pageNum, rawBytes, rotation, publication = null) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  if (bytes.length < 16) return false;
  if (publication?.token
      && !renderPublicationTokenIsCurrent(publication.token, publication.documentState)) {
    recordRejectedRenderPublication(publication.token, 'vector-commands-before-cache');
    return false;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 16-byte header: x0, y0, width, height (all f32 LE)
  const x0 = dv.getFloat32(0, true);
  const y0 = dv.getFloat32(4, true);
  const w = dv.getFloat32(8, true);
  const h = dv.getFloat32(12, true);
  const key = _key(filePath, pageNum, rotation, publication?.token);
  if (_cache.has(key)) releaseVectorEntry(key);
  const entry = {
    bytes,
    x0,
    y0,
    w,
    h,
    filePath,
    pageNum: Number(pageNum),
    ...revisionIdentity(filePath, pageNum, publication?.token),
  };
  _cache.set(key, entry);
  registerCommandResource(key, entry);
  return true;
}

export function hasCachedCommands(filePath, pageNum, rotation) {
  const key = _key(filePath, pageNum, rotation);
  const found = _cache.has(key);
  if (found) touchRenderResource(_commandResourceKey(key));
  return found;
}

export function getCachedPageDimensions(filePath, pageNum, rotation) {
  const key = _key(filePath, pageNum, rotation);
  const entry = _cache.get(key);
  if (!entry) return null;
  touchRenderResource(_commandResourceKey(key));
  return { x0: entry.x0, y0: entry.y0, w: entry.w, h: entry.h };
}

function _rgbaToCSS(rgba) {
  const r = (rgba >>> 24) & 0xFF;
  const g = (rgba >>> 16) & 0xFF;
  const b = (rgba >>> 8) & 0xFF;
  const a = (rgba & 0xFF) / 255;
  return `rgba(${r},${g},${b},${a})`;
}

const LINE_CAP = ['butt', 'round', 'square'];
const LINE_JOIN = ['miter', 'round', 'bevel'];

// Image cache key includes the command owner plus byte offset. A bare byte
// offset collides across pages and documents.
const _imageCache = new Map();
let _imagePreparing = false;

/// Pre-decode all images in the command buffer before rendering.
/// Returns a promise that resolves when all images are ready.
export async function prepareImages(filePath, pageNum, rotation, publication = null) {
  const commandKey = _key(filePath, pageNum, rotation, publication?.token);
  const entry = _cache.get(commandKey);
  if (!entry) return;
  touchRenderResource(_commandResourceKey(commandKey));

  const { bytes } = entry;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 16; // skip header

  const promises = [];

  while (pos < bytes.length) {
    const op = bytes[pos++];
    switch (op) {
      case 0: pos += 8; break;  // MoveTo
      case 1: pos += 8; break;  // LineTo
      case 2: pos += 24; break; // CubicTo
      case 3: pos += 16; break; // Rect
      case 4: break;            // ClosePath
      case 5: pos += 8; break;  // SetStroke
      case 6: pos += 4; break;  // SetFill
      case 7: break;            // Stroke
      case 8: break;            // Fill
      case 9: break;            // FillEvenOdd
      case 10: break;           // Save
      case 11: break;           // Restore
      case 12: pos += 24; break; // Transform
      case 13: pos += 1; break; // SetLineCap
      case 14: pos += 1; break; // SetLineJoin
      case 15: pos += 4; break; // SetMiterLimit
      case 16: {                // SetDash
        const count = bytes[pos++];
        pos += count * 4 + 4;
        break;
      }
      case 17: break;           // BeginPath
      case 20: break;           // Clip
      case 21: break;           // ClipEvenOdd
      case 18: {                // TextAt
        pos += 16; // x + y + fontSize + rgba
        const len = bytes[pos++];
        pos += len;
        break;
      }
      case 19: {                // DrawImage
        const imgPos = pos - 1; // position of the opcode
        const w = dv.getUint16(pos, true); pos += 2;
        const h = dv.getUint16(pos, true); pos += 2;
        const dataLen = dv.getUint32(pos, true); pos += 4;
        const imgStart = pos;
        pos += dataLen;

        const imageKey = _imageKey(commandKey, imgPos);
        if (!_imageCache.has(imageKey)) {
          const imgBytes = bytes.slice(imgStart, imgStart + dataLen);
          promises.push(_decodeImage(
            imageKey,
            w,
            h,
            imgBytes,
            () => _cache.get(commandKey) === entry
              && (!publication?.token
                || renderPublicationTokenIsCurrent(publication.token, publication.documentState)),
            filePath,
            pageNum,
          ));
        }
        break;
      }
      default:
        return; // unknown opcode, stop scanning
    }
  }

  if (promises.length > 0) {
    _imagePreparing = true;
    await Promise.all(promises);
    _imagePreparing = false;
  }
  if (publication?.token
      && !renderPublicationTokenIsCurrent(publication.token, publication.documentState)) {
    if (_cache.get(commandKey) === entry) releaseVectorEntry(commandKey);
    recordRejectedRenderPublication(publication.token, 'vector-images-after-decode');
  }
}

function _storeDecodedImage(cacheKey, bitmap, isCurrent, filePath, pageNum) {
  if (!isCurrent()) {
    try { bitmap.close?.(); } catch {}
    return;
  }
  const old = _imageCache.get(cacheKey);
  try { old?.bitmap?.close?.(); } catch {}
  const entry = {
    bitmap,
    width: bitmap.width || 0,
    height: bitmap.height || 0,
    filePath,
    pageNum,
  };
  _imageCache.set(cacheKey, entry);
  registerImageResource(cacheKey, entry);
}

async function _decodeImage(cacheKey, w, h, imgBytes, isCurrent, filePath, pageNum) {
  try {
    // Check for RGBA raw format (header: "RGBA" + u16 w + u16 h + pixels)
    if (imgBytes.length > 8 &&
        imgBytes[0] === 0x52 && imgBytes[1] === 0x47 &&
        imgBytes[2] === 0x42 && imgBytes[3] === 0x41) {
      // Raw RGBA pixels
      const pixelData = imgBytes.slice(8);
      const imageData = new ImageData(new Uint8ClampedArray(pixelData), w, h);
      const bitmap = await createImageBitmap(imageData);
      _storeDecodedImage(cacheKey, bitmap, isCurrent, filePath, pageNum);
      return;
    }

    // Check for JPEG (starts with FF D8)
    if (imgBytes[0] === 0xFF && imgBytes[1] === 0xD8) {
      const blob = new Blob([imgBytes], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      _storeDecodedImage(cacheKey, bitmap, isCurrent, filePath, pageNum);
      return;
    }

    // Check for PNG (starts with 89 50 4E 47)
    if (imgBytes[0] === 0x89 && imgBytes[1] === 0x50) {
      const blob = new Blob([imgBytes], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      _storeDecodedImage(cacheKey, bitmap, isCurrent, filePath, pageNum);
      return;
    }

    // Unknown format — try as generic image blob
    const blob = new Blob([imgBytes]);
    const bitmap = await createImageBitmap(blob);
    _storeDecodedImage(cacheKey, bitmap, isCurrent, filePath, pageNum);
  } catch (e) {
    console.warn(`[vector-renderer] Failed to decode image at offset ${cacheKey}:`, e);
  }
}

export function renderVectorPage(ctx, filePath, pageNum, transform, rotation) {
  const commandKey = _key(filePath, pageNum, rotation);
  const entry = _cache.get(commandKey);
  if (!entry) return;
  touchRenderResource(_commandResourceKey(commandKey));
  import('../solid/stores/engineStatusStore.js')
    .then((m) => m.reportActiveEngine('vector', filePath, pageNum))
    .catch(() => {});

  const { bytes, x0, y0, h: pageH } = entry;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 16; // skip 16-byte header (x0, y0, w, h)

  // Apply caller transform, then Y-flip, then translate to MediaBox origin.
  // PDF content is drawn in MediaBox coordinates (which can start at -846, -595
  // etc.) for AutoCAD/Revit/Vectorworks-exported PDFs with centered coordinate
  // systems. After the Y-flip we need to translate by `+y0` (not `-y0`) to
  // map PDF bottom-left (x0,y0) onto canvas (0, pageH). The old `-y0` happened
  // to work when y0 == 0 (standard PDFs) but pushed content 2*|y0| points
  // off-canvas for AutoCAD PDFs — visible as "dark stripes" because only the
  // small portion still inside the viewport got drawn. See:
  // Zware vector PDF p18 regression (29% diff before fix).
  ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  ctx.transform(1, 0, 0, -1, 0, pageH);   // Y-flip
  ctx.translate(-x0, y0);                  // Shift to MediaBox origin

  while (pos < bytes.length) {
    const op = bytes[pos++];
    switch (op) {
      case 0: { // MoveTo
        const x = dv.getFloat32(pos, true); pos += 4;
        const y = dv.getFloat32(pos, true); pos += 4;
        ctx.moveTo(x, y);
        break;
      }
      case 1: { // LineTo
        const x = dv.getFloat32(pos, true); pos += 4;
        const y = dv.getFloat32(pos, true); pos += 4;
        ctx.lineTo(x, y);
        break;
      }
      case 2: { // CubicTo
        const x1 = dv.getFloat32(pos, true); pos += 4;
        const y1 = dv.getFloat32(pos, true); pos += 4;
        const x2 = dv.getFloat32(pos, true); pos += 4;
        const y2 = dv.getFloat32(pos, true); pos += 4;
        const x3 = dv.getFloat32(pos, true); pos += 4;
        const y3 = dv.getFloat32(pos, true); pos += 4;
        ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3);
        break;
      }
      case 3: { // Rect
        const x = dv.getFloat32(pos, true); pos += 4;
        const y = dv.getFloat32(pos, true); pos += 4;
        const w = dv.getFloat32(pos, true); pos += 4;
        const h = dv.getFloat32(pos, true); pos += 4;
        ctx.rect(x, y, w, h);
        break;
      }
      case 4: // ClosePath
        ctx.closePath();
        break;
      case 5: { // SetStroke(rgba, width)
        const rgba = dv.getUint32(pos, true); pos += 4;
        const w = dv.getFloat32(pos, true); pos += 4;
        ctx.strokeStyle = _rgbaToCSS(rgba);
        ctx.lineWidth = w;
        break;
      }
      case 6: { // SetFill(rgba)
        const rgba = dv.getUint32(pos, true); pos += 4;
        ctx.fillStyle = _rgbaToCSS(rgba);
        break;
      }
      case 7: // Stroke
        ctx.stroke();
        break;
      case 8: // Fill
        ctx.fill('nonzero');
        break;
      case 9: // FillEvenOdd
        ctx.fill('evenodd');
        break;
      case 10: // Save
        ctx.save();
        break;
      case 11: // Restore
        ctx.restore();
        break;
      case 12: { // Transform
        const a = dv.getFloat32(pos, true); pos += 4;
        const b = dv.getFloat32(pos, true); pos += 4;
        const c = dv.getFloat32(pos, true); pos += 4;
        const d = dv.getFloat32(pos, true); pos += 4;
        const e = dv.getFloat32(pos, true); pos += 4;
        const f = dv.getFloat32(pos, true); pos += 4;
        ctx.transform(a, b, c, d, e, f);
        break;
      }
      case 13: { // SetLineCap
        const cap = bytes[pos++];
        ctx.lineCap = LINE_CAP[cap] || 'butt';
        break;
      }
      case 14: { // SetLineJoin
        const join = bytes[pos++];
        ctx.lineJoin = LINE_JOIN[join] || 'miter';
        break;
      }
      case 15: { // SetMiterLimit
        const limit = dv.getFloat32(pos, true); pos += 4;
        ctx.miterLimit = limit;
        break;
      }
      case 16: { // SetDash
        const count = bytes[pos++];
        const pattern = [];
        for (let i = 0; i < count; i++) {
          pattern.push(dv.getFloat32(pos, true)); pos += 4;
        }
        const phase = dv.getFloat32(pos, true); pos += 4;
        ctx.setLineDash(pattern);
        ctx.lineDashOffset = phase;
        break;
      }
      case 17: // BeginPath
        ctx.beginPath();
        break;
      case 18: { // TextAt (legacy fallback, mostly unused now)
        const x = dv.getFloat32(pos, true); pos += 4;
        const y = dv.getFloat32(pos, true); pos += 4;
        const fontSize = dv.getFloat32(pos, true); pos += 4;
        const rgba = dv.getUint32(pos, true); pos += 4;
        const len = bytes[pos++];
        const text = new TextDecoder().decode(bytes.slice(pos, pos + len));
        pos += len;
        ctx.save();
        ctx.scale(1, -1);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillStyle = _rgbaToCSS(rgba);
        ctx.fillText(text, x, -y);
        ctx.restore();
        break;
      }
      case 20: // Clip (nonzero winding)
        ctx.clip('nonzero');
        break;
      case 21: // ClipEvenOdd
        ctx.clip('evenodd');
        break;
      case 19: { // DrawImage(w, h, dataLen, imageBytes)
        const imgPos = pos - 1; // cache key = opcode position
        const imgW = dv.getUint16(pos, true); pos += 2;
        const imgH = dv.getUint16(pos, true); pos += 2;
        const dataLen = dv.getUint32(pos, true); pos += 4;
        pos += dataLen; // skip image data (already decoded in cache)

        const imageCacheKey = _imageKey(commandKey, imgPos);
        const bitmap = _imageCache.get(imageCacheKey)?.bitmap;
        if (bitmap) {
          touchRenderResource(_imageResourceKey(imageCacheKey));
          // High-quality bilinear/bicubic interpolation for embedded raster images
          const prevSmoothing = ctx.imageSmoothingEnabled;
          const prevQuality = ctx.imageSmoothingQuality;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          // Draw image in the 1×1 PDF unit square (CTM maps to correct page position)
          ctx.drawImage(bitmap, 0, 0, 1, 1);
          ctx.imageSmoothingEnabled = prevSmoothing;
          ctx.imageSmoothingQuality = prevQuality;
        }
        break;
      }
      default:
        console.warn(`[vector-renderer] Unknown opcode ${op} at position ${pos - 1}`);
        return; // bail out on unknown command
    }
  }
}
