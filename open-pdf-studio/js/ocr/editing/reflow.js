import fontkit from '@pdf-lib/fontkit';

import {
  OCR_PDF_USER_SPACE,
  OCR_SOURCE_RASTER_SPACE,
  mapPointBetweenSpaces,
  mapPolygonBetweenSpaces,
} from '../contracts/geometry.js';
import { base64ToBytes, zeroBytes } from './raster.js';
import {
  assertRegionTarget,
  boundsOfPolygon,
  horizontalAngle,
  midpoint,
  searchableRecord,
  sourceRecord,
} from './fixed-region.js';
import {
  estimateStyle,
  patchRecord,
  repairHaloMetrics,
  revisedEstimatedStyle,
} from './single-line.js';

export const SCANNED_TEXT_REFLOW_SCOPE = 'approved-region-paragraph-reflow';
export const SCANNED_TEXT_REFLOW_LAYOUT_MODE = 'paragraph-reflow';
export const SCANNED_TEXT_REFLOW_FONT_URL = '/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf';
export const SCANNED_TEXT_REFLOW_FONT_NAME = 'Liberation Sans';
export const SCANNED_TEXT_REFLOW_SHAPING = 'fontkit-liberation-sans-ltr-v1';

const VISIBLE_FONT_FAMILY = 'OpenPDFStudioOCRReflow';
const SUPPORTED_SCRIPT = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]$/u;
const RTL_SCRIPT_RANGE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{1e800}-\u{1eeff}]/u;
const UNSUPPORTED_FORMATTING = /[\p{Cc}\p{Cs}\p{Co}\p{Cf}\p{Cn}]/u;

let approvedFontBytesPromise = null;
let approvedFontFacePromise = null;

export class ScannedTextReflowError extends Error {
  constructor(code, message, evidence = null) {
    super(message);
    this.name = 'ScannedTextReflowError';
    this.code = code;
    this.evidence = evidence;
  }
}

function fail(code, message, evidence = null) {
  throw new ScannedTextReflowError(code, message, evidence);
}

function clone(value) {
  return structuredClone(value);
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values, fallback = 0) {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return null;
}

async function loadApprovedFontBytes(providedBytes) {
  const provided = asBytes(providedBytes);
  if (provided) return provided;
  if (!approvedFontBytesPromise) {
    approvedFontBytesPromise = (async () => {
      if (typeof fetch !== 'function') {
        fail('APPROVED_FONT_UNAVAILABLE', 'The approved Unicode reflow font is unavailable in this runtime');
      }
      const response = await fetch(SCANNED_TEXT_REFLOW_FONT_URL, { cache: 'force-cache' });
      if (!response.ok) {
        fail('APPROVED_FONT_UNAVAILABLE', `The approved Unicode reflow font returned HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    })().catch((error) => {
      approvedFontBytesPromise = null;
      throw error;
    });
  }
  return (await approvedFontBytesPromise).slice();
}

async function parseApprovedFont(providedBytes) {
  const bytes = await loadApprovedFontBytes(providedBytes);
  let parsed;
  try {
    parsed = await fontkit.create(bytes);
  } catch (error) {
    fail('APPROVED_FONT_UNAVAILABLE', `The approved Unicode reflow font could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed?.familyName !== SCANNED_TEXT_REFLOW_FONT_NAME
      || !Number.isFinite(parsed.unitsPerEm) || parsed.unitsPerEm <= 0
      || !Number.isFinite(parsed.ascent) || !Number.isFinite(parsed.descent)
      || parsed.ascent <= parsed.descent) {
    fail('APPROVED_FONT_UNAVAILABLE', 'The approved Unicode reflow font has unexpected identity or metrics');
  }
  return { bytes, parsed };
}

function normalizedParagraph(value) {
  if (typeof value !== 'string') fail('EMPTY_REPLACEMENT', 'Paragraph replacement text must be a string');
  if (value.length === 0 || value.trim().length === 0) {
    fail('EMPTY_REPLACEMENT', 'Paragraph replacement text must contain visible characters');
  }
  if (value.length > 4096) fail('REPLACEMENT_TOO_LONG', 'Paragraph replacement text exceeds 4096 UTF-16 code units');
  let wellFormed = true;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        wellFormed = false;
        break;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      wellFormed = false;
      break;
    }
  }
  if (!wellFormed) {
    fail('INVALID_UNICODE', 'Paragraph replacement text contains malformed Unicode');
  }
  if (/[\u2028\u2029]/u.test(value)) {
    fail('MULTIPLE_PARAGRAPHS_UNSUPPORTED', 'This phase reflows one paragraph inside one approved region');
  }
  const normalized = value.normalize('NFC');
  if (RTL_SCRIPT_RANGE.test(normalized) || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) {
    fail(
      'UNSUPPORTED_TEXT_DIRECTION',
      'Right-to-left reflow is unavailable because the approved font and geometry path have not passed RTL shaping tests',
    );
  }
  const paragraph = normalized.replace(/\p{White_Space}+/gu, ' ').trim();
  for (const character of paragraph) {
    if (UNSUPPORTED_FORMATTING.test(character)) {
      fail('UNSUPPORTED_TEXT_CONTROL', 'Paragraph replacement text contains unsupported formatting or control characters');
    }
    if (!SUPPORTED_SCRIPT.test(character)) {
      const codePoint = character.codePointAt(0);
      fail('UNSUPPORTED_SCRIPT', `Script for U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} has not passed the approved reflow shaping path`);
    }
  }
  return paragraph;
}

function assertGlyphCoverage(font, text) {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (!font.hasGlyphForCodePoint(codePoint)) {
      fail('MISSING_GLYPH', `Approved reflow font has no glyph for U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
}

function shapeText(font, text, fontSize) {
  assertGlyphCoverage(font, text);
  const run = font.layout(text, { liga: false, clig: false });
  if (!run?.glyphs?.length || run.glyphs.length !== run.positions?.length
      || run.glyphs.some((glyph) => !Number.isSafeInteger(glyph.id) || glyph.id <= 0 || glyph.id > 0xffff)) {
    fail('UNSUPPORTED_SHAPING', 'Approved font shaping did not return a complete bounded glyph run');
  }
  const advanceUnits = run.positions.reduce((sum, position) => sum + position.xAdvance, 0);
  if (!Number.isFinite(advanceUnits) || advanceUnits <= 0) {
    fail('UNSUPPORTED_SHAPING', 'Approved font shaping returned invalid horizontal advances');
  }
  const widthPt = advanceUnits / font.unitsPerEm * fontSize;
  const heightPt = (font.ascent - font.descent) / font.unitsPerEm * fontSize;
  return {
    glyphCount: run.glyphs.length,
    encodedText: run.glyphs.map((glyph) => glyph.id.toString(16).toUpperCase().padStart(4, '0')).join(''),
    widthPt,
    heightPt,
  };
}

function wrapParagraph(paragraph, font, fontSize, availableWidthPt) {
  const lines = [];
  let current = '';
  for (const word of paragraph.split(' ')) {
    const shapedWord = shapeText(font, word, fontSize);
    if (shapedWord.widthPt > availableWidthPt + 0.25) {
      fail('REFLOW_OVERFLOW', 'An unbreakable word cannot fit inside the approved OCR region');
    }
    const candidate = current ? `${current} ${word}` : word;
    if (shapeText(font, candidate, fontSize).widthPt <= availableWidthPt + 0.25) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function polygonForShapedLine(origin, shaped, angleDegrees, font, fontSize) {
  const radians = angleDegrees * Math.PI / 180;
  const along = [Math.cos(radians), Math.sin(radians)];
  const normal = [-Math.sin(radians), Math.cos(radians)];
  const ascent = font.ascent / font.unitsPerEm * fontSize;
  const descent = -font.descent / font.unitsPerEm * fontSize;
  const topLeft = [origin[0] + normal[0] * ascent, origin[1] + normal[1] * ascent];
  const topRight = [topLeft[0] + along[0] * shaped.widthPt, topLeft[1] + along[1] * shaped.widthPt];
  const bottomLeft = [origin[0] - normal[0] * descent, origin[1] - normal[1] * descent];
  const bottomRight = [bottomLeft[0] + along[0] * shaped.widthPt, bottomLeft[1] + along[1] * shaped.widthPt];
  return {
    coordinateSpace: OCR_PDF_USER_SPACE,
    points: [topLeft, topRight, bottomRight, bottomLeft].map((point) => point.map((value) => round(value))),
  };
}

function approvedUnicodeStyle(style) {
  return {
    ...style,
    fontClass: {
      value: 'sans-serif',
      estimated: true,
      confidence: 1,
      method: 'approved-unicode-font-v1',
    },
    weight: {
      value: 'normal',
      estimated: true,
      confidence: 1,
      method: 'approved-unicode-font-v1',
    },
    italic: {
      value: false,
      estimated: true,
      confidence: 1,
      method: 'approved-unicode-font-v1',
    },
  };
}

function assertApprovedStyleOverrides(styleOverrides) {
  if ((Object.hasOwn(styleOverrides, 'fontClass') && styleOverrides.fontClass !== 'sans-serif')
      || (Object.hasOwn(styleOverrides, 'weight') && styleOverrides.weight !== 'normal')
      || (Object.hasOwn(styleOverrides, 'italic') && styleOverrides.italic !== false)) {
    fail(
      'UNSUPPORTED_REFLOW_FONT_STYLE',
      'Paragraph reflow supports only the approved regular sans-serif Unicode font',
    );
  }
}

function fitInferredApprovedFontSize(style, region, font, styleOverrides) {
  if (Object.hasOwn(styleOverrides, 'fontSize')) return style;
  const medianOriginalHeight = median(region.lines.map((entry) =>
    boundsOfPolygon(entry.geometry.canonicalPolygon).height));
  const maxFontSize = Math.max(
    1,
    (medianOriginalHeight - 0.25) * font.unitsPerEm / (font.ascent - font.descent),
  );
  if (style.fontSize.value > maxFontSize) {
    style.fontSize.value = round(maxFontSize);
    style.fontSize.confidence = Math.min(style.fontSize.confidence, 0.9);
    style.fontSize.method = 'approved-unicode-region-fit-v1';
  }
  return style;
}

function layoutParagraph({ paragraph, style, region, selected, pageGeometry, font }) {
  const canonicalRegion = mapPolygonBetweenSpaces(
    pageGeometry.transformChain,
    selected.geometry.selectionPolygon,
    OCR_PDF_USER_SPACE,
  );
  const regionBounds = boundsOfPolygon(canonicalRegion);
  const fontSize = style.fontSize.value;
  const lineTexts = wrapParagraph(paragraph, font, fontSize, regionBounds.width);
  if (lineTexts.length > region.lines.length) {
    fail('REFLOW_OVERFLOW', 'Paragraph requires more wrapped lines than the approved OCR region can contain', {
      requiredLines: lineTexts.length,
      availableLines: region.lines.length,
    });
  }
  const metricHeight = (font.ascent - font.descent) / font.unitsPerEm * fontSize;
  const medianOriginalHeight = median(region.lines.map((entry) =>
    boundsOfPolygon(entry.geometry.canonicalPolygon).height));
  if (metricHeight > medianOriginalHeight + 0.75) {
    fail('REFLOW_OVERFLOW', 'Approved Unicode glyph height would clip inside the OCR region');
  }

  const lines = lineTexts.map((lineText, index) => {
    const source = region.lines[index];
    const sourceBaseline = source.geometry.canonicalBaseline.points;
    const angleDegrees = horizontalAngle(sourceBaseline);
    const shaped = shapeText(font, lineText, fontSize);
    const offset = style.alignment.value === 'center' ? (regionBounds.width - shaped.widthPt) / 2
      : style.alignment.value === 'right' ? regionBounds.width - shaped.widthPt
        : 0;
    const radians = angleDegrees * Math.PI / 180;
    const origin = [
      regionBounds.minX + Math.cos(radians) * offset,
      midpoint(sourceBaseline)[1] + Math.sin(radians) * offset,
    ];
    const polygon = polygonForShapedLine(origin, shaped, angleDegrees, font, fontSize);
    const polygonBounds = boundsOfPolygon(polygon);
    const tolerance = 0.75;
    if (polygonBounds.minX < regionBounds.minX - tolerance
        || polygonBounds.maxX > regionBounds.maxX + tolerance
        || polygonBounds.minY < regionBounds.minY - tolerance
        || polygonBounds.maxY > regionBounds.maxY + tolerance) {
      fail('REGION_CLIPPING', 'Reflowed glyphs cannot be contained by the approved OCR region', {
        line: index,
        polygonBounds,
        regionBounds,
      });
    }
    const baselineEnd = [
      origin[0] + Math.cos(radians) * shaped.widthPt,
      origin[1] + Math.sin(radians) * shaped.widthPt,
    ];
    return {
      index,
      text: lineText,
      encodedGlyphCount: shaped.glyphCount,
      encodedText: shaped.encodedText,
      widthPt: round(shaped.widthPt),
      heightPt: round(shaped.heightPt),
      origin: { coordinateSpace: OCR_PDF_USER_SPACE, point: origin.map((value) => round(value)) },
      angleDegrees: round(angleDegrees),
      baselineAligned: true,
      canonicalPolygon: polygon,
      canonicalBaseline: {
        status: 'provided',
        provenance: source.geometry.canonicalBaseline.provenance,
        coordinateSpace: OCR_PDF_USER_SPACE,
        points: [origin, baselineEnd].map((point) => point.map((value) => round(value))),
      },
    };
  });
  return {
    fontName: SCANNED_TEXT_REFLOW_FONT_NAME,
    direction: 'ltr',
    shaping: SCANNED_TEXT_REFLOW_SHAPING,
    glyphCoverage: 'complete',
    availableWidthPt: round(regionBounds.width),
    availableHeightPt: round(regionBounds.height),
    canonicalRegion,
    measuredLineSpacingPt: region.spacingPt,
    lineSpacingMethod: 'median-canonical-baseline-delta-v1',
    alignment: style.alignment.value,
    safeWrapped: lines.length > 1,
    clippingPrevented: true,
    overflow: false,
    lines,
  };
}

async function ensureVisibleFont(fontBytes) {
  if (!approvedFontFacePromise) {
    approvedFontFacePromise = (async () => {
      if (typeof FontFace !== 'function' || !globalThis.document?.fonts) {
        fail('VISIBLE_FONT_UNAVAILABLE', 'The approved Unicode font cannot be installed in the visible renderer');
      }
      const source = fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength);
      const face = new FontFace(VISIBLE_FONT_FAMILY, source, { style: 'normal', weight: '400' });
      await face.load();
      globalThis.document.fonts.add(face);
      return face;
    })().catch((error) => {
      approvedFontFacePromise = null;
      throw error;
    });
  }
  await approvedFontFacePromise;
}

async function defaultReflowVisibleRenderer({
  basePatchBytes,
  patch,
  style,
  geometry,
  layout,
  sourceRaster,
  fontBytes,
}) {
  await ensureVisibleFont(fontBytes);
  const Canvas = globalThis.OffscreenCanvas;
  let canvas;
  if (typeof Canvas === 'function') canvas = new Canvas(patch.widthPx, patch.heightPx);
  else if (globalThis.document?.createElement) {
    canvas = document.createElement('canvas');
    canvas.width = patch.widthPx;
    canvas.height = patch.heightPx;
  } else {
    fail('VISIBLE_RENDERER_UNAVAILABLE', 'A deterministic canvas renderer is required for paragraph reflow');
  }
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) fail('VISIBLE_RENDERER_UNAVAILABLE', 'The paragraph reflow canvas could not be initialized');
  const image = context.createImageData(patch.widthPx, patch.heightPx);
  image.data.set(basePatchBytes);
  context.putImageData(image, 0, 0);
  context.font = `${style.fontSize.value * sourceRaster.dpi / 72}px "${VISIBLE_FONT_FAMILY}"`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.direction = 'ltr';
  context.fillStyle = style.textColor.value;
  for (const line of layout.lines) {
    const origin = mapPointBetweenSpaces(
      geometry.transformChain,
      line.origin.point,
      OCR_PDF_USER_SPACE,
      OCR_SOURCE_RASTER_SPACE,
    );
    const metrics = context.measureText(line.text);
    const localX = origin[0] - patch.originX;
    const localY = origin[1] - patch.originY;
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
    const left = -(metrics.actualBoundingBoxLeft || 0);
    const right = metrics.actualBoundingBoxRight || metrics.width;
    if (![ascent, descent, left, right].every(Number.isFinite)) {
      fail('UNSUPPORTED_SHAPING', 'Visible Unicode shaping did not return complete glyph metrics');
    }
    const radians = line.angleDegrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const glyphCorners = [
      [left, -ascent], [right, -ascent], [right, descent], [left, descent],
    ].map(([x, y]) => [
      localX + x * cosine - y * sine,
      localY + x * sine + y * cosine,
    ]);
    const xs = glyphCorners.map((point) => point[0]);
    const ys = glyphCorners.map((point) => point[1]);
    if (Math.min(...xs) < -0.5 || Math.max(...xs) > patch.widthPx + 0.5
        || Math.min(...ys) < -0.5 || Math.max(...ys) > patch.heightPx + 0.5) {
      fail('REGION_CLIPPING', 'Visible Unicode glyphs would clip inside the approved repair patch');
    }
    context.save();
    context.translate(localX, localY);
    context.rotate(radians);
    context.fillText(line.text, 0, 0);
    context.restore();
  }
  return new Uint8Array(context.getImageData(0, 0, patch.widthPx, patch.heightPx).data);
}

function approvedRegion(region, selected, repair, analysis) {
  if (repair?.status !== 'applied' || !repair.repairedPatch
      || analysis?.eligibility?.eligible !== true
      || JSON.stringify(repair.approvedRegion) !== JSON.stringify(selected.geometry.repairBounds)) {
    const reasons = analysis?.eligibility?.rejectionReasons || [];
    fail(
      'UNAPPROVED_REFLOW_REGION',
      reasons.map((reason) => reason.message).join('; ')
        || 'Paragraph reflow requires a region already approved by the edit-foundation eligibility rules',
      { rejectionReasons: clone(reasons) },
    );
  }
  return region;
}

function regionFromOwnedSelection(page, selection, style) {
  return {
    alignment: style.alignment.value,
    spacingPx: selection.content.source.lineSpacing.valuePx,
    spacingPt: selection.content.source.lineSpacing.valuePt,
    lines: selection.content.source.canonicalBaselines.map((canonicalBaseline, index) => ({
      line: { id: selection.content.source.ocrIds.lineIds[index] },
      geometry: {
        canonicalBaseline,
        canonicalPolygon: mapPolygonBetweenSpaces(
          page.pageGeometry.transformChain,
          selection.geometry.lineGeometry[index].sourcePolygon,
          OCR_PDF_USER_SPACE,
        ),
      },
    })),
  };
}

export async function buildApprovedRegionParagraphReflowContent({
  result,
  pageGeometry,
  raster,
  selected,
  originalPatch,
  repair,
  analysis,
  replacementText,
  styleOverrides = {},
  revision,
  parentRevision,
  renderVisiblePatch = defaultReflowVisibleRenderer,
  reflowFontBytes,
}) {
  assertApprovedStyleOverrides(styleOverrides);
  const region = approvedRegion(assertRegionTarget(result, selected, pageGeometry), selected, repair, analysis);
  const paragraph = normalizedParagraph(replacementText);
  const { bytes: fontBytes, parsed: font } = await parseApprovedFont(reflowFontBytes);
  const representative = region.lines.reduce((longest, entry) =>
    entry.line.text.length > longest.line.text.length ? entry : longest, region.lines[0]);
  const inferredOverrides = Object.hasOwn(styleOverrides, 'alignment')
    ? styleOverrides
    : { ...styleOverrides, alignment: region.alignment };
  const style = fitInferredApprovedFontSize(approvedUnicodeStyle(estimateStyle({
    line: representative.line,
    raster,
    geometry: representative.geometry,
    pageGeometry,
    analysis,
    overrides: inferredOverrides,
  })), region, font, styleOverrides);
  if (!Object.hasOwn(styleOverrides, 'alignment')) {
    style.alignment.confidence = 0.88;
    style.alignment.method = 'fixed-region-edge-alignment-v1';
  }
  const layout = layoutParagraph({ paragraph, style, region, selected, pageGeometry, font });
  const originalExtraction = base64ToBytes(originalPatch.data);
  const repairedBytes = base64ToBytes(repair.repairedPatch.data);
  let visibleBytes = null;
  try {
    const halo = repairHaloMetrics(originalExtraction, originalPatch, repairedBytes, repair.approvedRegion);
    visibleBytes = await renderVisiblePatch({
      basePatchBytes: repairedBytes,
      patch: repair.repairedPatch,
      text: paragraph,
      style,
      geometry: { transformChain: pageGeometry.transformChain },
      layout,
      sourceRaster: result.sourceRaster,
      fontBytes,
    });
    if (!(visibleBytes instanceof Uint8Array || visibleBytes instanceof Uint8ClampedArray)
        || visibleBytes.byteLength !== repairedBytes.byteLength) {
      fail('INVALID_VISIBLE_PATCH', 'Paragraph renderer returned invalid RGBA bytes');
    }
    const source = sourceRecord(region, selected, pageGeometry);
    return {
      scope: SCANNED_TEXT_REFLOW_SCOPE,
      source,
      replacementText: paragraph,
      estimatedStyle: style,
      layout,
      repairPatch: clone(repair.repairedPatch),
      visibleReplacement: {
        text: paragraph,
        patch: await patchRecord(new Uint8Array(visibleBytes), repair.approvedRegion),
        halo,
        outsideEditRegionChangedPixels: 0,
      },
      searchableText: searchableRecord(layout, paragraph),
      undo: {
        kind: 'scanned-text-edit',
        before: { text: source.originalText, repairStatus: 'original' },
        after: { text: paragraph, repairStatus: 'applied' },
        revision,
        parentRevision,
      },
    };
  } finally {
    zeroBytes(originalExtraction);
    zeroBytes(repairedBytes);
    zeroBytes(visibleBytes);
  }
}

export async function reviseApprovedRegionParagraphReflowContent({
  page,
  selection,
  replacementText,
  styleOverrides = {},
  revision,
  parentRevision,
  renderVisiblePatch = defaultReflowVisibleRenderer,
  reflowFontBytes,
}) {
  assertApprovedStyleOverrides(styleOverrides);
  if (selection?.repair?.status !== 'applied'
      || !['fixed-region-multiline', SCANNED_TEXT_REFLOW_SCOPE].includes(selection?.content?.scope)
      || selection?.analysis?.eligibility?.eligible !== true
      || !page?.pageGeometry?.transformChain) {
    fail('UNAPPROVED_REFLOW_REGION', 'Only an applied, eligibility-approved owned OCR region can be reflowed');
  }
  const paragraph = normalizedParagraph(replacementText);
  const { bytes: fontBytes, parsed: font } = await parseApprovedFont(reflowFontBytes);
  const style = approvedUnicodeStyle(revisedEstimatedStyle(selection.content.estimatedStyle, styleOverrides));
  const region = regionFromOwnedSelection(page, selection, style);
  fitInferredApprovedFontSize(style, region, font, styleOverrides);
  const layout = layoutParagraph({
    paragraph,
    style,
    region,
    selected: selection,
    pageGeometry: page.pageGeometry,
    font,
  });
  const repairedBytes = base64ToBytes(selection.repair.repairedPatch.data);
  let visibleBytes = null;
  try {
    visibleBytes = await renderVisiblePatch({
      basePatchBytes: repairedBytes,
      patch: selection.repair.repairedPatch,
      text: paragraph,
      style,
      geometry: { transformChain: page.pageGeometry.transformChain },
      layout,
      sourceRaster: page.sourceRaster,
      fontBytes,
    });
    if (!(visibleBytes instanceof Uint8Array || visibleBytes instanceof Uint8ClampedArray)
        || visibleBytes.byteLength !== repairedBytes.byteLength) {
      fail('INVALID_VISIBLE_PATCH', 'Paragraph renderer returned invalid RGBA bytes');
    }
    return {
      ...clone(selection.content),
      scope: SCANNED_TEXT_REFLOW_SCOPE,
      replacementText: paragraph,
      estimatedStyle: style,
      layout,
      visibleReplacement: {
        ...clone(selection.content.visibleReplacement),
        text: paragraph,
        patch: await patchRecord(new Uint8Array(visibleBytes), selection.repair.approvedRegion),
        outsideEditRegionChangedPixels: 0,
      },
      searchableText: searchableRecord(layout, paragraph),
      undo: {
        kind: 'scanned-text-edit',
        before: { text: selection.content.replacementText, repairStatus: 'applied' },
        after: { text: paragraph, repairStatus: 'applied' },
        revision,
        parentRevision,
      },
    };
  } finally {
    zeroBytes(repairedBytes);
    zeroBytes(visibleBytes);
  }
}
