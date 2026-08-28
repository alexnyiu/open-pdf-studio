import fontkit from '@pdf-lib/fontkit';
import { cloneRichTextDocument } from './rich-text.js';

const ROOT = '/pdfjs/web/standard_fonts';

const definitions = [
  ['liberation-sans-regular', 'Liberation Sans', 400, false, 'LiberationSans-Regular.ttf', 'f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f'],
  ['liberation-sans-bold', 'Liberation Sans', 700, false, 'LiberationSans-Bold.ttf', '361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc'],
  ['liberation-sans-italic', 'Liberation Sans', 400, true, 'LiberationSans-Italic.ttf', '832b4406dbef23628800d3aaad21048534ac84d7e3ad955be83b8172ed8ef512'],
  ['liberation-sans-bold-italic', 'Liberation Sans', 700, true, 'LiberationSans-BoldItalic.ttf', 'a224075ac17495ad0a3af3bc0a419ac0704a8b3fd1095456201fb9b095fc281d'],
  ['liberation-serif-regular', 'Liberation Serif', 400, false, 'LiberationSerif-Regular.ttf', '058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74'],
  ['liberation-serif-bold', 'Liberation Serif', 700, false, 'LiberationSerif-Bold.ttf', 'd754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce'],
  ['liberation-serif-italic', 'Liberation Serif', 400, true, 'LiberationSerif-Italic.ttf', '0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e'],
  ['liberation-serif-bold-italic', 'Liberation Serif', 700, true, 'LiberationSerif-BoldItalic.ttf', 'f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7'],
  ['liberation-mono-regular', 'Liberation Mono', 400, false, 'LiberationMono-Regular.ttf', 'f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1'],
  ['liberation-mono-bold', 'Liberation Mono', 700, false, 'LiberationMono-Bold.ttf', 'bd62a0672d0b9b6710b01df434c80ad54fa5f0835207eb7b17b7a761463067bb'],
  ['liberation-mono-italic', 'Liberation Mono', 400, true, 'LiberationMono-Italic.ttf', '605c01c711b44480a7508d349dfbf3264e81fa43d69e61cfa7d10b86e764c4d1'],
  ['liberation-mono-bold-italic', 'Liberation Mono', 700, true, 'LiberationMono-BoldItalic.ttf', '79451f3c09fe25116098853b7a2ca6e2436220ccc11af022979adbcf195be130'],
];

export const PACKAGED_FONT_FACES = Object.freeze(definitions.map((entry) => Object.freeze({
  id: entry[0],
  family: entry[1],
  weight: entry[2],
  italic: entry[3],
  assetUrl: `${ROOT}/${entry[4]}`,
  fileName: entry[4],
  sha256: entry[5],
  license: 'SIL Open Font License 1.1',
})));

const faceById = new Map(PACKAGED_FONT_FACES.map((face) => [face.id, face]));
const bytesCache = new Map();
const parsedCache = new Map();
const shapedRunCache = new Map();
const shapedRunPending = new Map();
const SHAPED_RUN_CACHE_ENTRIES = 4096;
const SHAPED_RUN_CACHE_BYTES = 16 * 1024 * 1024;
let shapedRunCacheBytes = 0;
let fontAssetGeneration = 0;
let assetLoaderOverride = null;

/** Test/runtime host hook for environments that cannot fetch packaged URLs. */
export function setPackagedFontAssetLoader(loader) {
  assetLoaderOverride = typeof loader === 'function' ? loader : null;
  fontAssetGeneration += 1;
  bytesCache.clear();
  parsedCache.clear();
  shapedRunCache.clear();
  shapedRunPending.clear();
  shapedRunCacheBytes = 0;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function familyFromName(name = '') {
  const normalized = String(name).toLowerCase();
  if (normalized.includes('mono') || normalized.includes('courier') || normalized.includes('consolas')) {
    return 'Liberation Mono';
  }
  if ((normalized.includes('serif') && !normalized.includes('sans'))
      || /times|garamond|georgia|palatino|cambria|bookman/u.test(normalized)) {
    return 'Liberation Serif';
  }
  return 'Liberation Sans';
}

export function resolvePackagedFace(family, bold = false, italic = false) {
  const targetFamily = familyFromName(family);
  return PACKAGED_FONT_FACES.find((face) => face.family === targetFamily
    && face.weight === (bold ? 700 : 400) && face.italic === Boolean(italic)) || null;
}

export function proposeFontSubstitution(sourceFont, bold = false, italic = false) {
  const face = resolvePackagedFace(sourceFont, bold, italic);
  return {
    sourceFont: String(sourceFont || 'Unknown'),
    faceId: face.id,
    approved: false,
    approvedAt: null,
  };
}

async function loadDefaultAsset(face) {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const moduleName = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ moduleName);
    return new Uint8Array(await readFile(new URL(
      `../../public/pdfjs/web/standard_fonts/${face.fileName}`,
      import.meta.url,
    )));
  }
  const response = await fetch(face.assetUrl);
  if (!response.ok) throw new Error(`Missing packaged font asset ${face.fileName}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadPackagedFaceBytes(faceId) {
  const face = faceById.get(faceId);
  if (!face) throw new Error(`Unsupported packaged font face: ${faceId}`);
  if (!bytesCache.has(faceId)) {
    bytesCache.set(faceId, (async () => {
      const bytes = assetLoaderOverride
        ? new Uint8Array(await assetLoaderOverride(face))
        : await loadDefaultAsset(face);
      const actual = await sha256Hex(bytes);
      if (actual !== face.sha256) {
        throw new Error(`Packaged font checksum mismatch for ${face.fileName}`);
      }
      return bytes;
    })());
  }
  return bytesCache.get(faceId);
}

export async function parsedPackagedFace(faceId) {
  if (!parsedCache.has(faceId)) {
    parsedCache.set(faceId, loadPackagedFaceBytes(faceId).then((bytes) => fontkit.create(bytes)));
  }
  return parsedCache.get(faceId);
}

export async function verifyPackagedFontCatalog() {
  if (PACKAGED_FONT_FACES.length !== 12) throw new Error('The packaged font catalog must contain exactly 12 faces');
  await Promise.all(PACKAGED_FONT_FACES.map(async (face) => {
    const parsed = await parsedPackagedFace(face.id);
    if (!parsed || !(parsed.unitsPerEm > 0) || !parsed.postscriptName) {
      throw new Error(`Packaged font is not parseable: ${face.fileName}`);
    }
  }));
  return true;
}

function rejectUnsupportedText(text) {
  if (/\r|\u2028|\u2029/u.test(text)) throw new Error('Unsupported line separator');
  // Complex shaping and RTL remain fail-closed until they have external-reader acceptance.
  if (/[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u.test(text)) {
    throw new Error('Unsupported shaping or text direction');
  }
}

async function shapeTextRunUncached(run) {
  if (run.direction !== 'ltr') throw new Error('Unsupported shaping or text direction');
  rejectUnsupportedText(run.text);
  const font = await parsedPackagedFace(run.faceId);
  const scale = run.size / font.unitsPerEm;
  const layout = typeof font.layout === 'function' ? font.layout(run.text) : null;
  const glyphs = layout?.glyphs || font.glyphsForString(run.text);
  const positions = layout?.positions || glyphs.map((glyph) => ({
    xAdvance: glyph.advanceWidth,
    yAdvance: 0,
    xOffset: 0,
    yOffset: 0,
  }));
  if (glyphs.some((glyph) => !glyph || glyph.id === 0)) throw new Error(`Missing glyph in ${run.faceId}`);
  let advance = 0;
  let left = 0;
  let right = 0;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const shapedGlyphs = glyphs.map((glyph, index) => {
    const position = positions[index] || {};
    const xAdvance = Number(position.xAdvance ?? glyph.advanceWidth) * scale;
    const xOffset = Number(position.xOffset || 0) * scale;
    const yOffset = Number(position.yOffset || 0) * scale;
    const box = glyph.bbox || {};
    const bounds = [box.minX, box.maxX, box.minY, box.maxY].map(Number);
    if (bounds.every(Number.isFinite)) {
      const [minX, maxX, minY, maxY] = bounds;
      left = Math.min(left, advance + minX * scale + xOffset);
      right = Math.max(right, advance + maxX * scale + xOffset);
      top = Math.min(top, -maxY * scale - yOffset);
      bottom = Math.max(bottom, -minY * scale - yOffset);
    }
    const result = {
      id: glyph.id,
      cluster: Number(layout?.stringIndices?.[index] ?? index),
      advance: xAdvance,
      xOffset,
      yOffset,
    };
    advance += xAdvance;
    return result;
  });
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
    top = -font.ascent * scale;
    bottom = -font.descent * scale;
  }
  return {
    engine: 'fontkit-liberation-ltr-v1',
    glyphs: shapedGlyphs,
    advance,
    inkBounds: { left, top, right, bottom },
    metrics: {
      ascent: font.ascent * scale,
      descent: Math.abs(font.descent * scale),
      underlinePosition: font.underlinePosition * scale,
      underlineThickness: Math.max(0.25, font.underlineThickness * scale),
      strikeoutPosition: (font.ascent * 0.3) * scale,
      strikeoutThickness: Math.max(0.25, font.underlineThickness * scale),
    },
  };
}

function shapedRunCacheKey(run) {
  return JSON.stringify([
    run.faceId,
    Number(run.size),
    run.direction || 'ltr',
    run.bold === true,
    run.italic === true,
    run.underline === true,
    run.strikeout === true,
    String(run.text || ''),
  ]);
}

function retainShapedRun(key, shaped) {
  const bytes = key.length * 2 + JSON.stringify(shaped).length * 2;
  if (bytes > SHAPED_RUN_CACHE_BYTES) return;
  const previous = shapedRunCache.get(key);
  if (previous) {
    shapedRunCache.delete(key);
    shapedRunCacheBytes = Math.max(0, shapedRunCacheBytes - previous.bytes);
  }
  shapedRunCache.set(key, { shaped, bytes });
  shapedRunCacheBytes += bytes;
  while (shapedRunCache.size > SHAPED_RUN_CACHE_ENTRIES
      || shapedRunCacheBytes > SHAPED_RUN_CACHE_BYTES) {
    const oldestEntry = shapedRunCache.keys().next();
    if (oldestEntry.done) {
      // Defensive recovery for accounting corruption: eviction must always
      // terminate even if a future cache mutation violates the invariant.
      shapedRunCacheBytes = 0;
      break;
    }
    const oldestKey = oldestEntry.value;
    const oldest = shapedRunCache.get(oldestKey);
    shapedRunCache.delete(oldestKey);
    shapedRunCacheBytes = Math.max(0, shapedRunCacheBytes - (oldest?.bytes || 0));
  }
}

/** Shape one maximal same-style run through a bounded module-local LRU. */
export async function shapeTextRun(run) {
  const key = shapedRunCacheKey(run);
  const cached = shapedRunCache.get(key);
  if (cached) {
    shapedRunCache.delete(key);
    shapedRunCache.set(key, cached);
    return cached.shaped;
  }
  const pending = shapedRunPending.get(key);
  if (pending) return pending;
  const generation = fontAssetGeneration;
  const request = shapeTextRunUncached(run).then((shaped) => {
    if (generation === fontAssetGeneration) retainShapedRun(key, shaped);
    return shaped;
  }).finally(() => {
    if (shapedRunPending.get(key) === request) shapedRunPending.delete(key);
  });
  shapedRunPending.set(key, request);
  return request;
}

export function shapedRunCacheMetrics() {
  return { entries: shapedRunCache.size, bytes: shapedRunCacheBytes };
}

export async function shapeRichTextDocument(document, { antialiasMargin = 1 } = {}) {
  const output = cloneRichTextDocument(document);
  const rejectionReasons = [];
  let maximumWidth = 0;
  let minimumTop = Number.POSITIVE_INFINITY;
  let maximumBottom = Number.NEGATIVE_INFINITY;
  for (const line of output.lines) {
    let x = 0;
    let minimumLeft = 0;
    let maximumRight = 0;
    for (const run of line.runs) {
      try {
        run.shaped = await shapeTextRun(run);
        run.geometry = {
          x,
          baseline: line.baseline,
          width: run.shaped.advance,
          height: run.shaped.metrics.ascent + run.shaped.metrics.descent,
        };
        minimumLeft = Math.min(minimumLeft, x + run.shaped.inkBounds.left - antialiasMargin);
        maximumRight = Math.max(
          maximumRight,
          x + run.shaped.inkBounds.right + antialiasMargin,
          x + run.shaped.advance,
        );
        x += run.shaped.advance;
        minimumTop = Math.min(minimumTop, line.baseline + run.shaped.inkBounds.top - antialiasMargin);
        maximumBottom = Math.max(maximumBottom, line.baseline + run.shaped.inkBounds.bottom + antialiasMargin);
      } catch (error) {
        rejectionReasons.push(error instanceof Error ? error.message : String(error));
      }
    }
    maximumWidth = Math.max(maximumWidth, maximumRight - minimumLeft);
  }
  const height = Number.isFinite(minimumTop) && Number.isFinite(maximumBottom)
    ? maximumBottom - minimumTop : 0;
  if (output.region.width > 0 && maximumWidth > output.region.width + 1e-6) rejectionReasons.push('Text overflows fixed region width');
  if (output.region.height > 0 && height > output.region.height + 1e-6) rejectionReasons.push('Text overflows fixed region height');
  return {
    schema: 'open-pdf-studio.shaped-text-layout',
    version: 1,
    width: maximumWidth,
    height,
    lines: output.lines,
    overflow: rejectionReasons.length > 0,
    rejectionReasons: [...new Set(rejectionReasons)],
  };
}

/**
 * Revalidate an owned text edit using the same canonical geometry that the
 * exact-layout worker commits. PDF vector text does not need the raster-only
 * antialias padding used by approximate preview bounds.
 */
export function shapeOwnedTextEditForPersistence(document) {
  return shapeRichTextDocument(document, { antialiasMargin: 0 });
}

export const packagedFontCatalog = Object.freeze({
  faces: PACKAGED_FONT_FACES,
  resolveFace: resolvePackagedFace,
  proposeSubstitution: proposeFontSubstitution,
  loadFaceBytes: loadPackagedFaceBytes,
  verifyAssets: verifyPackagedFontCatalog,
});
