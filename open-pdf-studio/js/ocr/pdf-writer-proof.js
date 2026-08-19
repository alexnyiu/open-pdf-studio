// @ts-check

/**
 * Application-owned invisible Unicode OCR writer. This is the approved proof
 * implementation promoted in place: the production save adapter imports this
 * module, so there is only one ownership and stream-mutation contract.
 */

import fontkit from '@pdf-lib/fontkit';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

export const OCR_PDF_WRITER_OWNER = 'open-pdf-studio';
export const OCR_PDF_WRITER_SCHEMA_VERSION = 1;
export const OCR_PDF_WRITER_VERSION = 'invisible-unicode-v1';
export const OCR_PDF_WRITER_PIECE_INFO_KEY = 'OpenPDFStudioOCR';

// Proof-suite compatibility aliases. They deliberately point at the same
// production implementation and must never become a parallel contract.
export const OCR_WRITER_PROOF_OWNER = OCR_PDF_WRITER_OWNER;
export const OCR_WRITER_PROOF_SCHEMA_VERSION = OCR_PDF_WRITER_SCHEMA_VERSION;
export const OCR_WRITER_PROOF_VERSION = OCR_PDF_WRITER_VERSION;
export const OCR_WRITER_PROOF_PIECE_INFO_KEY = OCR_PDF_WRITER_PIECE_INFO_KEY;

const PDF_USER_SPACE = 'pdf-default-user-space';
const PIECE_INFO = PDFName.of('PieceInfo');
const PRIVATE = PDFName.of('Private');
const OWNER = PDFName.of('Owner');
const SCHEMA_VERSION = PDFName.of('SchemaVersion');
const WRITER_VERSION = PDFName.of('WriterVersion');
const STREAM = PDFName.of('Stream');
const FONT = PDFName.of('Font');
const FONT_RESOURCE = PDFName.of('FontResource');
const FONT_DIGEST = PDFName.of('FontDigest');
const CONTENT_DIGEST = PDFName.of('ContentDigest');
const LAST_MODIFIED = PDFName.of('LastModified');
const CONTENTS = PDFName.of('Contents');
const RESOURCES = PDFName.of('Resources');
const TYPE = PDFName.of('Type');
const SUBTYPE = PDFName.of('Subtype');
const ENCODING = PDFName.of('Encoding');
const DESCENDANT_FONTS = PDFName.of('DescendantFonts');
const TO_UNICODE = PDFName.of('ToUnicode');
const FONT_FILE_2 = PDFName.of('FontFile2');
const FONT_DESCRIPTOR = PDFName.of('FontDescriptor');
const VENDOR_KEY = PDFName.of(OCR_PDF_WRITER_PIECE_INFO_KEY);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('latin1');
const RIGHT_TO_LEFT_SCRIPT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{1E900}-\u{1E95F}]/u;

export class OcrPdfWriterError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'OcrPdfWriterError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message */
function fail(code, message) {
  throw new OcrPdfWriterError(code, message);
}

export const OcrPdfWriterProofError = OcrPdfWriterError;

/** @param {unknown} value */
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  fail('INVALID_BYTES', 'Expected PDF and font inputs to be byte arrays');
}

/** @param {Uint8Array} bytes */
async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    fail('SHA256_UNAVAILABLE', 'A Web Crypto SHA-256 implementation is required');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', /** @type {BufferSource} */ (bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {unknown} value */
function pdfText(value) {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return null;
}

/** @param {unknown} value */
function pdfInteger(value) {
  if (!(value instanceof PDFNumber)) return null;
  const number = value.asNumber();
  return Number.isSafeInteger(number) ? number : null;
}

/** @param {unknown} left @param {unknown} right */
function sameRef(left, right) {
  return left instanceof PDFRef && right instanceof PDFRef && left.toString() === right.toString();
}

/** @param {number} value */
function formatNumber(value) {
  if (!Number.isFinite(value)) fail('INVALID_GEOMETRY', 'Text matrix values must be finite');
  const normalized = Math.abs(value) < 0.0000005 ? 0 : value;
  return Number(normalized.toFixed(6)).toString();
}

/** @param {string} text */
function assertWellFormedText(text) {
  if (!text || typeof text !== 'string') fail('INVALID_TEXT', 'Each OCR line must contain text');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text) || /[\r\n]/u.test(text)) {
    fail('INVALID_TEXT', 'OCR lines may not contain controls or embedded line breaks');
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) fail('INVALID_UNICODE', 'OCR text contains an unpaired high surrogate');
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      fail('INVALID_UNICODE', 'OCR text contains an unpaired low surrogate');
    }
  }
}

/** @param {string} text @param {unknown} direction @param {string} scope */
function assertSupportedTextDirection(text, direction, scope) {
  if ((direction != null && direction !== 'ltr') || RIGHT_TO_LEFT_SCRIPT.test(text)) {
    fail(
      'UNSUPPORTED_TEXT_DIRECTION',
      `The invisible OCR writer currently accepts only left-to-right ${scope} text`,
    );
  }
}

/** @param {unknown} point */
function validPoint(point) {
  return Boolean(point && typeof point === 'object'
    && Number.isFinite(/** @type {any} */ (point).x)
    && Number.isFinite(/** @type {any} */ (point).y));
}

/** @param {{x:number,y:number}[]} polygon */
function polygonArea(polygon) {
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

/** @param {{x:number,y:number}} point @param {{x:number,y:number,width:number,height:number}} box */
function pointInside(point, box) {
  const tolerance = 0.01;
  return point.x >= box.x - tolerance
    && point.x <= box.x + box.width + tolerance
    && point.y >= box.y - tolerance
    && point.y <= box.y + box.height + tolerance;
}

/** @param {{x:number,y:number}[]} points */
function polygonBounds(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** @param {any} word @param {any} line @param {{x:number,y:number,width:number,height:number}} pageBox */
function validateWordGeometry(word, line, pageBox) {
  assertWellFormedText(word?.text);
  assertSupportedTextDirection(word.text, word.direction, 'word');
  if (word?.polygon?.coordinateSpace !== PDF_USER_SPACE
    || !Array.isArray(word.polygon.points)
    || word.polygon.points.length < 3
    || !word.polygon.points.every(validPoint)
    || polygonArea(word.polygon.points) <= 0.0001
    || !word.polygon.points.every((point) => pointInside(point, pageBox))) {
    fail('INVALID_WORD_GEOMETRY', 'OCR word polygons must be non-empty, finite, in-bounds PDF user-space geometry');
  }
  const lineBounds = polygonBounds(line.polygon.points);
  const tolerance = 1;
  const expandedLineBounds = {
    x: lineBounds.x - tolerance,
    y: lineBounds.y - tolerance,
    width: lineBounds.width + tolerance * 2,
    height: lineBounds.height + tolerance * 2,
  };
  if (!word.polygon.points.every((point) => pointInside(point, expandedLineBounds))) {
    fail('INVALID_WORD_GEOMETRY', 'OCR word geometry must remain inside its line geometry');
  }
}

/**
 * @param {any} line
 * @param {{x:number,y:number,width:number,height:number}} box
 */
function validateLineGeometry(line, box) {
  assertWellFormedText(line?.text);
  if (!Number.isSafeInteger(line?.readingOrder) || line.readingOrder < 0) {
    fail('INVALID_READING_ORDER', 'Each OCR line needs a non-negative integer readingOrder');
  }
  assertSupportedTextDirection(line.text, line.direction, 'line');
  if (line?.polygon?.coordinateSpace !== PDF_USER_SPACE
    || !Array.isArray(line.polygon.points)
    || line.polygon.points.length < 3
    || !line.polygon.points.every(validPoint)
    || polygonArea(line.polygon.points) <= 0.0001
    || !line.polygon.points.every((point) => pointInside(point, box))) {
    fail('INVALID_GEOMETRY', 'OCR polygons must be non-empty, finite, in-bounds PDF user-space geometry');
  }
  if (line?.baseline?.status !== 'provided') {
    fail('MISSING_CANONICAL_BASELINE', 'The invisible OCR writer does not infer or substitute line baselines');
  }
  if (line.baseline.coordinateSpace !== PDF_USER_SPACE
    || !validPoint(line.baseline.start)
    || !validPoint(line.baseline.end)
    || !pointInside(line.baseline.start, box)
    || !pointInside(line.baseline.end, box)) {
    fail('INVALID_GEOMETRY', 'Canonical baselines must be finite, in-bounds PDF user-space geometry');
  }
  const dx = line.baseline.end.x - line.baseline.start.x;
  const dy = line.baseline.end.y - line.baseline.start.y;
  if (Math.hypot(dx, dy) <= 0.0001) fail('INVALID_GEOMETRY', 'Canonical baselines must have non-zero length');
  if (line.words !== undefined) {
    if (!Array.isArray(line.words) || line.words.length === 0) {
      fail('INVALID_WORD_GEOMETRY', 'Optional OCR word geometry must be a non-empty array when supplied');
    }
    line.words.forEach((word) => validateWordGeometry(word, line, box));
    const lineText = line.text.replace(/\s+/gu, ' ').trim();
    const wordText = line.words.map((word) => word.text).join(' ').replace(/\s+/gu, ' ').trim();
    if (lineText !== wordText) {
      fail('INVALID_WORD_GEOMETRY', 'OCR word text must reproduce its line text in declared order');
    }
  }
}

/** @param {any} parsedFont @param {string} text */
function layoutText(parsedFont, text) {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (!Number.isSafeInteger(codePoint)) fail('INVALID_UNICODE', 'Could not read a Unicode code point');
    const hasGlyph = typeof parsedFont.hasGlyphForCodePoint === 'function'
      ? parsedFont.hasGlyphForCodePoint(codePoint)
      : parsedFont.glyphForCodePoint(codePoint)?.id !== 0;
    if (!hasGlyph) {
      fail('MISSING_GLYPH', `Approved font has no glyph for U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  const result = parsedFont.layout(text, { liga: false, clig: false });
  if (!result?.glyphs?.length || result.glyphs.some((glyph) => !Number.isSafeInteger(glyph.id) || glyph.id <= 0 || glyph.id > 0xFFFF)) {
    fail('MISSING_GLYPH', 'Font shaping returned a missing or out-of-range CID glyph');
  }
  const hex = result.glyphs.map((glyph) => glyph.id.toString(16).toUpperCase().padStart(4, '0')).join('');
  const advanceWidth = result.glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0);
  if (!Number.isFinite(advanceWidth) || advanceWidth <= 0) fail('INVALID_FONT_METRICS', 'Font shaping returned an invalid advance width');
  return { hex, advanceWidth };
}

/** @param {any} parsedFont @param {any} line */
function linePlacement(parsedFont, line) {
  const dx = line.baseline.end.x - line.baseline.start.x;
  const dy = line.baseline.end.y - line.baseline.start.y;
  const baselineLength = Math.hypot(dx, dy);
  const ux = dx / baselineLength;
  const uy = dy / baselineLength;
  const nx = -uy;
  const ny = ux;
  const projections = line.polygon.points.map((point) => point.x * nx + point.y * ny);
  const geometryHeight = Math.max(...projections) - Math.min(...projections);
  const metricHeight = (parsedFont.ascent - parsedFont.descent) / parsedFont.unitsPerEm;
  const fontSize = geometryHeight / metricHeight;
  if (!Number.isFinite(fontSize) || fontSize < 0.25 || fontSize > 1000) {
    fail('INVALID_GEOMETRY', 'OCR geometry produces an unsafe font size');
  }
  const shaped = layoutText(parsedFont, line.text);
  const naturalWidth = shaped.advanceWidth / parsedFont.unitsPerEm * fontSize;
  const horizontalScale = baselineLength / naturalWidth;
  if (!Number.isFinite(horizontalScale) || horizontalScale < 0.2 || horizontalScale > 5) {
    fail('INVALID_GEOMETRY', 'OCR geometry produces an unsafe horizontal text scale');
  }
  return {
    text: line.text,
    readingOrder: line.readingOrder,
    fontSize,
    hex: shaped.hex,
    matrix: [
      ux * horizontalScale,
      uy * horizontalScale,
      -uy,
      ux,
      line.baseline.start.x,
      line.baseline.start.y,
    ],
  };
}

/** @param {any} parsedFont @param {any} line */
function placementsForLine(parsedFont, line) {
  if (!Array.isArray(line.words) || line.words.length === 0) return [linePlacement(parsedFont, line)];
  const dx = line.baseline.end.x - line.baseline.start.x;
  const dy = line.baseline.end.y - line.baseline.start.y;
  const baselineLength = Math.hypot(dx, dy);
  const ux = dx / baselineLength;
  const uy = dy / baselineLength;
  const tolerance = Math.max(0.5, baselineLength * 0.01);
  let previousEnd = -Infinity;
  return line.words.map((word, wordIndex) => {
    const projections = word.polygon.points.map((point) =>
      (point.x - line.baseline.start.x) * ux + (point.y - line.baseline.start.y) * uy);
    const startOffset = Math.min(...projections);
    const endOffset = Math.max(...projections);
    if (startOffset < -tolerance || endOffset > baselineLength + tolerance
      || endOffset - startOffset <= 0.0001 || startOffset < previousEnd - tolerance) {
      fail('INVALID_WORD_GEOMETRY', 'OCR word geometry must progress monotonically along the canonical line baseline');
    }
    previousEnd = endOffset;
    return linePlacement(parsedFont, {
      ...line,
      text: word.text,
      readingOrder: line.readingOrder * 1_000_000 + wordIndex,
      polygon: word.polygon,
      baseline: {
        ...line.baseline,
        start: {
          x: line.baseline.start.x + ux * Math.max(0, startOffset),
          y: line.baseline.start.y + uy * Math.max(0, startOffset),
        },
        end: {
          x: line.baseline.start.x + ux * Math.min(baselineLength, endOffset),
          y: line.baseline.start.y + uy * Math.min(baselineLength, endOffset),
        },
      },
    });
  });
}

/** @param {string} resourceName @param {ReturnType<typeof linePlacement>[]} placements */
function buildContent(resourceName, placements) {
  const lines = ['q', 'BT', '3 Tr'];
  for (const placement of placements) {
    lines.push(`/${resourceName} ${formatNumber(placement.fontSize)} Tf`);
    lines.push(`${placement.matrix.map(formatNumber).join(' ')} Tm`);
    lines.push(`<${placement.hex}> Tj`);
  }
  lines.push('ET', 'Q', '');
  return textEncoder.encode(lines.join('\n'));
}

/** @param {PDFRawStream} stream */
function decodedStreamBytes(stream) {
  try {
    return decodePDFRawStream(stream).decode();
  } catch (error) {
    fail('UNSUPPORTED_STREAM_FILTER', `Cannot decode an owned stream: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {PDFRawStream} stream */
function decodedStreamText(stream) {
  return textDecoder.decode(decodedStreamBytes(stream));
}

/** @param {any} page @param {any} context */
function pageContentRefs(page, context) {
  const raw = page.node.get(CONTENTS);
  if (raw == null) return [];
  let values;
  if (raw instanceof PDFRef) {
    const target = context.lookup(raw);
    if (target instanceof PDFArray) values = target.asArray();
    else if (target instanceof PDFRawStream) values = [raw];
    else fail('MALFORMED_CONTENTS', 'Page Contents reference is neither an array nor a stream');
  } else if (raw instanceof PDFArray) {
    values = raw.asArray();
  } else {
    fail('MALFORMED_CONTENTS', 'Direct or malformed page content streams are not modified by the invisible OCR writer');
  }
  for (const value of values) {
    if (!(value instanceof PDFRef) || !(context.lookup(value) instanceof PDFRawStream)) {
      fail('MALFORMED_CONTENTS', 'Every preserved page content entry must be an indirect stream');
    }
  }
  return /** @type {PDFRef[]} */ (values);
}

/** @param {any} page @param {any} context @param {PDFRef[]} refs */
function setPageContentRefs(page, context, refs) {
  const array = PDFArray.withContext(context);
  refs.forEach((ref) => array.push(ref));
  page.node.set(CONTENTS, array);
}

/** @param {any} page @param {any} context */
function clonedPageResources(page, context) {
  const inherited = page.node.Resources();
  const resources = inherited instanceof PDFDict ? inherited.clone(context) : PDFDict.withContext(context);
  const inheritedFonts = inherited?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const fonts = inheritedFonts instanceof PDFDict ? inheritedFonts.clone(context) : PDFDict.withContext(context);
  resources.set(PDFName.of('Font'), fonts);
  return { resources, fonts };
}

/** @param {PDFDict} fonts */
function newFontResourceName(fonts) {
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = `OPS_OCR_${suffix}`;
    if (!fonts.has(PDFName.of(candidate))) return candidate;
  }
  fail('FONT_RESOURCE_EXHAUSTED', 'Could not allocate a private OCR font resource name');
}

/** @param {any} page @param {any} context */
function clonedPieceInfo(page, context) {
  const raw = page.node.get(PIECE_INFO);
  if (raw == null) return PDFDict.withContext(context);
  const dict = context.lookup(raw);
  if (!(dict instanceof PDFDict)) fail('MALFORMED_OWNERSHIP', 'Page PieceInfo is not a dictionary');
  return dict.clone(context);
}

/** @param {any} page @param {any} context */
function getOwnershipDictionaries(page, context) {
  const rawPieceInfo = page.node.get(PIECE_INFO);
  if (rawPieceInfo == null) return null;
  const pieceInfo = context.lookup(rawPieceInfo);
  if (!(pieceInfo instanceof PDFDict)) fail('MALFORMED_OWNERSHIP', 'Page PieceInfo is not a dictionary');
  const rawVendor = pieceInfo.get(VENDOR_KEY);
  if (rawVendor == null) return null;
  const vendor = context.lookup(rawVendor);
  if (!(vendor instanceof PDFDict)) fail('MALFORMED_OWNERSHIP', 'OCR PieceInfo entry is not a dictionary');
  const rawPrivate = vendor.get(PRIVATE);
  const privateDict = context.lookup(rawPrivate);
  if (!(privateDict instanceof PDFDict)) fail('MALFORMED_OWNERSHIP', 'OCR private ownership entry is not a dictionary');
  return { pieceInfo, vendor, privateDict };
}

/** @param {string} cmap */
function cmapBlockSizes(cmap) {
  const sizes = [];
  const pattern = /(\d+)\s+beginbfchar\s*([\s\S]*?)\s*endbfchar/g;
  let match;
  while ((match = pattern.exec(cmap))) {
    const declared = Number(match[1]);
    const mappings = match[2].split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (declared !== mappings.length || mappings.some((line) => !/^<[0-9A-Fa-f]+>\s+<[0-9A-Fa-f]+>$/u.test(line))) {
      fail('INVALID_TOUNICODE', 'ToUnicode bfchar counts or mappings are malformed');
    }
    sizes.push(declared);
  }
  if (!sizes.length || !/1\s+begincodespacerange\s*<0000>\s*<ffff>\s*endcodespacerange/is.test(cmap)) {
    fail('INVALID_TOUNICODE', 'ToUnicode lacks the required two-byte codespace and mappings');
  }
  if (sizes.some((size) => size < 1 || size > 100)) fail('INVALID_TOUNICODE', 'ToUnicode bfchar blocks must contain at most 100 mappings');
  return sizes;
}

/** @param {any} context @param {PDFRef} fontRef @param {string|null} expectedDigest */
function validateOwnedFont(context, fontRef, expectedDigest = null) {
  const fontDict = context.lookup(fontRef);
  if (!(fontDict instanceof PDFDict)
    || fontDict.get(TYPE)?.toString() !== '/Font'
    || fontDict.get(SUBTYPE)?.toString() !== '/Type0'
    || fontDict.get(ENCODING)?.toString() !== '/Identity-H') {
    fail('INVALID_OWNED_FONT', 'Owned font is not an Identity-H Type 0 font');
  }
  if (pdfText(fontDict.get(OWNER)) !== OCR_PDF_WRITER_OWNER
    || pdfInteger(fontDict.get(SCHEMA_VERSION)) !== OCR_PDF_WRITER_SCHEMA_VERSION) {
    fail('INVALID_OWNED_FONT', 'Owned font marker is absent or has an unsupported version');
  }
  const digest = pdfText(fontDict.get(FONT_DIGEST));
  if (!digest || (expectedDigest && digest !== expectedDigest)) fail('INVALID_OWNED_FONT', 'Owned font digest does not match the approved font');
  const descendants = fontDict.lookup(DESCENDANT_FONTS, PDFArray);
  if (descendants.size() !== 1) fail('INVALID_OWNED_FONT', 'Owned Type 0 font must have one descendant font');
  const descendant = descendants.lookup(0, PDFDict);
  if (!['/CIDFontType0', '/CIDFontType2'].includes(descendant.get(SUBTYPE)?.toString())) {
    fail('INVALID_OWNED_FONT', 'Owned font descendant is not a CID font');
  }
  const descriptor = descendant.lookup(FONT_DESCRIPTOR, PDFDict);
  if (descendant.get(SUBTYPE)?.toString() === '/CIDFontType2' && !descriptor.has(FONT_FILE_2)) {
    fail('INVALID_OWNED_FONT', 'Owned TrueType CID font is not embedded');
  }
  const cmapRef = fontDict.get(TO_UNICODE);
  if (!(cmapRef instanceof PDFRef)) fail('INVALID_TOUNICODE', 'Owned font ToUnicode must be an indirect stream');
  const cmapStream = context.lookup(cmapRef);
  if (!(cmapStream instanceof PDFRawStream)) fail('INVALID_TOUNICODE', 'Owned font ToUnicode is not a stream');
  const cmap = decodedStreamText(cmapStream);
  const blockSizes = cmapBlockSizes(cmap);
  return { digest, fontDict, cmapRef, cmap, blockSizes, descendantSubtype: descendant.get(SUBTYPE).toString() };
}

/**
 * Rewrites pdf-lib's otherwise valid full-font ToUnicode table into the PDF
 * limit of at most 100 entries per bfchar block.
 * @param {any} context
 * @param {PDFRef} fontRef
 * @param {string} fontDigest
 */
function finalizeNewOwnedFont(context, fontRef, fontDigest) {
  const fontDict = context.lookup(fontRef);
  if (!(fontDict instanceof PDFDict)) fail('INVALID_OWNED_FONT', 'New embedded font dictionary is unavailable');
  const cmapRef = fontDict.get(TO_UNICODE);
  if (!(cmapRef instanceof PDFRef)) fail('INVALID_TOUNICODE', 'New font ToUnicode is not indirect');
  const cmapStream = context.lookup(cmapRef);
  if (!(cmapStream instanceof PDFRawStream)) fail('INVALID_TOUNICODE', 'New font ToUnicode is not a stream');
  const original = decodedStreamText(cmapStream);
  let sawBlock = false;
  const patched = original.replace(/(\d+)\s+beginbfchar\s*([\s\S]*?)\s*endbfchar/g, (_whole, count, body) => {
    sawBlock = true;
    const mappings = String(body).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (Number(count) !== mappings.length) fail('INVALID_TOUNICODE', 'Generated ToUnicode mapping count is inconsistent');
    const blocks = [];
    for (let index = 0; index < mappings.length; index += 100) {
      const chunk = mappings.slice(index, index + 100);
      blocks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
    }
    return blocks.join('\n');
  });
  if (!sawBlock) fail('INVALID_TOUNICODE', 'Generated ToUnicode has no bfchar mapping block');
  context.assign(cmapRef, context.flateStream(textEncoder.encode(patched)));
  fontDict.set(OWNER, PDFString.of(OCR_PDF_WRITER_OWNER));
  fontDict.set(SCHEMA_VERSION, PDFNumber.of(OCR_PDF_WRITER_SCHEMA_VERSION));
  fontDict.set(FONT_DIGEST, PDFString.of(fontDigest));
  validateOwnedFont(context, fontRef, fontDigest);
}

/**
 * @param {any} page
 * @param {any} context
 * @param {string|null} expectedFontDigest
 */
async function validateOwnership(page, context, expectedFontDigest = null) {
  const dictionaries = getOwnershipDictionaries(page, context);
  if (!dictionaries) return null;
  const { privateDict } = dictionaries;
  if (pdfText(privateDict.get(OWNER)) !== OCR_PDF_WRITER_OWNER
    || pdfInteger(privateDict.get(SCHEMA_VERSION)) !== OCR_PDF_WRITER_SCHEMA_VERSION
    || pdfText(privateDict.get(WRITER_VERSION)) !== OCR_PDF_WRITER_VERSION) {
    fail('MALFORMED_OWNERSHIP', 'OCR ownership metadata is not this writer and schema version');
  }
  const streamRef = privateDict.get(STREAM);
  const fontRef = privateDict.get(FONT);
  const resourceName = pdfText(privateDict.get(FONT_RESOURCE));
  const fontDigest = pdfText(privateDict.get(FONT_DIGEST));
  const contentDigest = pdfText(privateDict.get(CONTENT_DIGEST));
  if (!(streamRef instanceof PDFRef) || !(fontRef instanceof PDFRef) || !resourceName || !fontDigest || !contentDigest) {
    fail('MALFORMED_OWNERSHIP', 'OCR ownership metadata has missing or invalid references');
  }
  if (expectedFontDigest && fontDigest !== expectedFontDigest) {
    fail('OWNED_FONT_DIGEST_MISMATCH', 'Existing owned OCR layer uses a different font digest');
  }
  const contentRefs = pageContentRefs(page, context);
  if (contentRefs.filter((ref) => sameRef(ref, streamRef)).length !== 1) {
    fail('MALFORMED_OWNERSHIP', 'Owned OCR stream must appear exactly once in page Contents');
  }
  const stream = context.lookup(streamRef);
  if (!(stream instanceof PDFRawStream)
    || pdfText(stream.dict.get(OWNER)) !== OCR_PDF_WRITER_OWNER
    || pdfInteger(stream.dict.get(SCHEMA_VERSION)) !== OCR_PDF_WRITER_SCHEMA_VERSION
    || pdfText(stream.dict.get(CONTENT_DIGEST)) !== contentDigest) {
    fail('MALFORMED_OWNERSHIP', 'Owned OCR stream marker does not match its metadata');
  }
  const decoded = decodedStreamBytes(stream);
  if (await sha256Hex(decoded) !== contentDigest) fail('MALFORMED_OWNERSHIP', 'Owned OCR stream content digest does not match');
  const resources = page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const mappedFont = fonts?.get(PDFName.of(resourceName));
  if (!sameRef(mappedFont, fontRef)) fail('MALFORMED_OWNERSHIP', 'Owned OCR font resource no longer matches its metadata');
  const font = validateOwnedFont(context, fontRef, fontDigest);
  return {
    ...dictionaries,
    streamRef,
    fontRef,
    resourceName,
    fontDigest,
    contentDigest,
    contentRefs,
    decoded,
    font,
  };
}

/** @param {any} context @param {PDFRef} streamRef @param {PDFRef} fontRef @param {string} resourceName @param {string} fontDigest @param {string} contentDigest @param {string} modifiedAt */
function ownershipVendorDict(context, streamRef, fontRef, resourceName, fontDigest, contentDigest, modifiedAt) {
  const privateDict = PDFDict.withContext(context);
  privateDict.set(OWNER, PDFString.of(OCR_PDF_WRITER_OWNER));
  privateDict.set(SCHEMA_VERSION, PDFNumber.of(OCR_PDF_WRITER_SCHEMA_VERSION));
  privateDict.set(WRITER_VERSION, PDFString.of(OCR_PDF_WRITER_VERSION));
  privateDict.set(STREAM, streamRef);
  privateDict.set(FONT, fontRef);
  privateDict.set(FONT_RESOURCE, PDFString.of(resourceName));
  privateDict.set(FONT_DIGEST, PDFString.of(fontDigest));
  privateDict.set(CONTENT_DIGEST, PDFString.of(contentDigest));
  const vendor = PDFDict.withContext(context);
  vendor.set(LAST_MODIFIED, PDFString.of(modifiedAt));
  vendor.set(PRIVATE, privateDict);
  return vendor;
}

/** @param {unknown} value @returns {string} */
function normalizedModifiedAt(value) {
  if (value == null) return `D:${new Date().toISOString().replace(/[-:T]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}`;
  if (typeof value !== 'string' || !/^D:\d{14}Z$/u.test(value)) fail('INVALID_MODIFIED_AT', 'modifiedAt must be a UTC PDF date string');
  return /** @type {string} */ (value);
}

/** @param {unknown} error */
function failPdfLoad(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/encrypted|password/iu.test(message)) {
    fail('ENCRYPTED_PDF_UNSUPPORTED', 'Encrypted or password-protected PDFs cannot be modified by the OCR writer');
  }
  fail('MALFORMED_PDF', `PDF could not be loaded: ${message}`);
}

/** @param {any} page @param {any} context @param {Awaited<ReturnType<typeof validateOwnership>>} ownership */
function removeValidatedOwnership(page, context, ownership) {
  if (!ownership) return;
  setPageContentRefs(page, context, ownership.contentRefs.filter((ref) => !sameRef(ref, ownership.streamRef)));

  const { resources, fonts } = clonedPageResources(page, context);
  const resourceKey = PDFName.of(ownership.resourceName);
  if (!sameRef(fonts.get(resourceKey), ownership.fontRef)) fail('MALFORMED_OWNERSHIP', 'Owned font resource changed during removal');
  fonts.delete(resourceKey);
  page.node.set(RESOURCES, resources);

  const pieceInfo = ownership.pieceInfo.clone(context);
  pieceInfo.delete(VENDOR_KEY);
  if (pieceInfo.keys().length) page.node.set(PIECE_INFO, pieceInfo);
  else page.node.delete(PIECE_INFO);
  context.delete(ownership.streamRef);
}

/**
 * Creates or replaces one privately owned invisible OCR stream per requested
 * page. The source byte array is never mutated.
 *
 * @param {{pdfBytes:Uint8Array|ArrayBuffer,fontBytes:Uint8Array|ArrayBuffer,fontSha256:string,pages:any[],modifiedAt?:string,removeUnlistedOwned?:boolean}} input
 */
export async function writeOwnedInvisibleOcrLayer(input) {
  const sourceBytes = asBytes(input?.pdfBytes);
  const approvedFontBytes = asBytes(input?.fontBytes);
  if (!/^[0-9a-f]{64}$/u.test(input?.fontSha256 || '')) fail('INVALID_FONT_DIGEST', 'Expected a lowercase SHA-256 font digest');
  if (await sha256Hex(approvedFontBytes) !== input.fontSha256) fail('FONT_DIGEST_MISMATCH', 'Font bytes do not match the approved digest');
  if (!Array.isArray(input?.pages) || !input.pages.length) fail('INVALID_PAGES', 'At least one OCR page is required');

  let parsedFont;
  try {
    parsedFont = await fontkit.create(approvedFontBytes);
  } catch (error) {
    fail('MALFORMED_FONT', `Approved font could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Number.isFinite(parsedFont?.unitsPerEm) || parsedFont.unitsPerEm <= 0
    || !Number.isFinite(parsedFont?.ascent) || !Number.isFinite(parsedFont?.descent)
    || parsedFont.ascent <= parsedFont.descent) {
    fail('INVALID_FONT_METRICS', 'Approved font has invalid vertical metrics');
  }

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  } catch (error) {
    failPdfLoad(error);
  }
  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const requestedIndexes = new Set();
  const preparedPages = [];
  for (const requested of input.pages) {
    const pageIndex = requested?.pageIndex;
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length || requestedIndexes.has(pageIndex)) {
      fail('INVALID_PAGES', 'OCR page indexes must be unique and inside the document');
    }
    requestedIndexes.add(pageIndex);
    if (!Array.isArray(requested.lines) || !requested.lines.length) fail('INVALID_LINES', 'Each OCR page needs at least one line');
    const page = pages[pageIndex];
    const box = page.getCropBox();
    requested.lines.forEach((line) => validateLineGeometry(line, box));
    const sortedLines = [...requested.lines].sort((left, right) => left.readingOrder - right.readingOrder);
    sortedLines.forEach((line, index) => {
      if (line.readingOrder !== index) fail('INVALID_READING_ORDER', 'Reading order must be unique and contiguous from zero on each page');
    });
    preparedPages.push({
      pageIndex,
      page,
      placements: sortedLines.flatMap((line) => placementsForLine(parsedFont, line)),
    });
  }
  preparedPages.sort((left, right) => left.pageIndex - right.pageIndex);

  const ownershipByPage = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    ownershipByPage.push(await validateOwnership(pages[pageIndex], context, input.fontSha256));
  }
  const existing = ownershipByPage.filter(Boolean);
  let fontRef;
  if (existing.length) {
    fontRef = existing[0].fontRef;
    if (existing.some((ownership) => !sameRef(ownership.fontRef, fontRef))) {
      fail('MALFORMED_OWNERSHIP', 'One document may not contain multiple application-owned OCR font roots');
    }
  } else {
    pdfDoc.registerFontkit(fontkit);
    const embedded = await pdfDoc.embedFont(approvedFontBytes, {
      subset: false,
      customName: 'OpenPDFStudioOCR-LiberationSans',
      features: { liga: false, clig: false },
    });
    fontRef = embedded.ref;
    await pdfDoc.flush();
    finalizeNewOwnedFont(context, fontRef, input.fontSha256);
  }
  validateOwnedFont(context, fontRef, input.fontSha256);

  if (input.removeUnlistedOwned === true) {
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      if (!requestedIndexes.has(pageIndex) && ownershipByPage[pageIndex]) {
        removeValidatedOwnership(pages[pageIndex], context, ownershipByPage[pageIndex]);
      }
    }
  }

  const modifiedAt = normalizedModifiedAt(input.modifiedAt);
  for (const prepared of preparedPages) {
    const previous = ownershipByPage[prepared.pageIndex];
    const { resources, fonts } = clonedPageResources(prepared.page, context);
    const resourceName = previous?.resourceName || newFontResourceName(fonts);
    if (previous) {
      const current = fonts.get(PDFName.of(resourceName));
      if (!sameRef(current, fontRef)) fail('MALFORMED_OWNERSHIP', 'Existing owned font resource changed during replacement');
    }
    fonts.set(PDFName.of(resourceName), fontRef);
    prepared.page.node.set(RESOURCES, resources);

    const contentBytes = buildContent(resourceName, prepared.placements);
    const contentDigest = await sha256Hex(contentBytes);
    const ownedStream = context.flateStream(contentBytes, {
      Owner: PDFString.of(OCR_PDF_WRITER_OWNER),
      SchemaVersion: OCR_PDF_WRITER_SCHEMA_VERSION,
      ContentDigest: PDFString.of(contentDigest),
    });
    const ownedStreamRef = context.register(ownedStream);
    const contentRefs = pageContentRefs(prepared.page, context);
    if (previous) {
      const index = contentRefs.findIndex((ref) => sameRef(ref, previous.streamRef));
      if (index < 0) fail('MALFORMED_OWNERSHIP', 'Existing owned stream disappeared during replacement');
      contentRefs[index] = ownedStreamRef;
      context.delete(previous.streamRef);
    } else {
      contentRefs.push(ownedStreamRef);
    }
    setPageContentRefs(prepared.page, context, contentRefs);

    const pieceInfo = clonedPieceInfo(prepared.page, context);
    pieceInfo.set(VENDOR_KEY, ownershipVendorDict(
      context,
      ownedStreamRef,
      fontRef,
      resourceName,
      input.fontSha256,
      contentDigest,
      modifiedAt,
    ));
    prepared.page.node.set(PIECE_INFO, pieceInfo);
  }

  return pdfDoc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

/**
 * Replaces supplied application-owned pages and removes only explicit target
 * pages. Omitted pages are preserved so reopening a document without hydrating
 * every existing owned stream cannot silently delete searchable text.
 * @param {{pdfBytes:Uint8Array|ArrayBuffer,fontBytes:Uint8Array|ArrayBuffer,fontSha256:string,pages:any[],modifiedAt?:string,removePageIndexes?:number[]}} input
 */
export async function reconcileOwnedInvisibleOcrLayer(input) {
  if (!Array.isArray(input?.pages)) fail('INVALID_PAGES', 'OCR pages must be an array');
  const requestedIndexes = new Set(input.pages.map((page) => page?.pageIndex));
  const removePageIndexes = input.removePageIndexes || [];
  if (!Array.isArray(removePageIndexes)
    || removePageIndexes.some((pageIndex) => !Number.isSafeInteger(pageIndex) || pageIndex < 0)
    || new Set(removePageIndexes).size !== removePageIndexes.length
    || removePageIndexes.some((pageIndex) => requestedIndexes.has(pageIndex))) {
    fail('INVALID_REMOVE_PAGES', 'Removed OCR page indexes must be unique, non-negative, and disjoint from written pages');
  }
  let reconciled = input.pages.length > 0
    ? await writeOwnedInvisibleOcrLayer({ ...input, removeUnlistedOwned: false })
    : asBytes(input.pdfBytes).slice();
  if (removePageIndexes.length > 0) {
    reconciled = await removeOwnedInvisibleOcrLayer({
      pdfBytes: reconciled,
      pageIndexes: removePageIndexes,
    });
  }
  return reconciled;
}

/**
 * Removes only streams and resource keys that pass the private ownership
 * validation. Unreachable embedded font objects are deliberately left intact.
 * @param {{pdfBytes:Uint8Array|ArrayBuffer,pageIndexes?:number[]}} input
 */
export async function removeOwnedInvisibleOcrLayer(input) {
  const sourceBytes = asBytes(input?.pdfBytes);
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  } catch (error) {
    failPdfLoad(error);
  }
  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const selectedIndexes = input.pageIndexes === undefined
    ? null
    : new Set(input.pageIndexes);
  if (selectedIndexes !== null && (!Array.isArray(input.pageIndexes)
    || selectedIndexes.size !== input.pageIndexes.length
    || input.pageIndexes.some((pageIndex) => !Number.isSafeInteger(pageIndex)
      || pageIndex < 0 || pageIndex >= pages.length))) {
    fail('INVALID_REMOVE_PAGES', 'Removed OCR page indexes must be unique and inside the document');
  }
  const ownershipByPage = [];
  for (const page of pages) ownershipByPage.push(await validateOwnership(page, context));
  if (!ownershipByPage.some((ownership, pageIndex) => ownership
    && (selectedIndexes === null || selectedIndexes.has(pageIndex)))) return sourceBytes.slice();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    if (selectedIndexes !== null && !selectedIndexes.has(pageIndex)) continue;
    const ownership = ownershipByPage[pageIndex];
    if (!ownership) continue;
    removeValidatedOwnership(pages[pageIndex], context, ownership);
  }
  return pdfDoc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

/** @param {Uint8Array|ArrayBuffer} pdfBytes */
export async function inspectOwnedInvisibleOcrLayer(pdfBytes) {
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(asBytes(pdfBytes), { updateMetadata: false });
  } catch (error) {
    failPdfLoad(error);
  }
  const context = pdfDoc.context;
  const result = [];
  for (const [pageIndex, page] of pdfDoc.getPages().entries()) {
    const ownership = await validateOwnership(page, context);
    const contentRefs = pageContentRefs(page, context).map((ref) => ref.toString());
    if (!ownership) {
      result.push({ pageIndex, contentRefs, owned: false });
      continue;
    }
    const streamText = textDecoder.decode(ownership.decoded);
    result.push({
      pageIndex,
      contentRefs,
      owned: true,
      owner: OCR_PDF_WRITER_OWNER,
      schemaVersion: OCR_PDF_WRITER_SCHEMA_VERSION,
      writerVersion: OCR_PDF_WRITER_VERSION,
      ownedStreamRef: ownership.streamRef.toString(),
      fontRef: ownership.fontRef.toString(),
      fontResource: ownership.resourceName,
      fontDigest: ownership.fontDigest,
      contentDigest: ownership.contentDigest,
      streamText,
      renderingMode3Count: (streamText.match(/(?:^|\s)3\s+Tr(?:\s|$)/gu) || []).length,
      textMatrixCount: (streamText.match(/\sTm(?:\s|$)/gu) || []).length,
      showTextCount: (streamText.match(/\sTj(?:\s|$)/gu) || []).length,
      fontSubtype: 'Type0',
      descendantSubtype: ownership.font.descendantSubtype.slice(1),
      toUnicodeBlockSizes: ownership.font.blockSizes,
    });
  }
  return result;
}

/** @param {any} context @param {unknown} value */
function lookupDict(context, value) {
  if (value == null) return null;
  try {
    const resolved = context.lookup(value);
    return resolved instanceof PDFDict ? resolved : null;
  } catch (_) {
    return null;
  }
}

/**
 * Detects cryptographically populated signature fields before mutation. An
 * unsigned empty signature widget is not treated as a signed document.
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 */
export async function inspectPdfModificationPolicy(pdfBytes) {
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(asBytes(pdfBytes), { updateMetadata: false });
  } catch (error) {
    failPdfLoad(error);
  }
  const context = pdfDoc.context;
  const acroForm = pdfDoc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const rootFields = acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  const visited = new Set();
  let signatureCount = 0;

  /** @param {unknown} value @param {string|null} inheritedType */
  function visitField(value, inheritedType = null) {
    const key = value instanceof PDFRef ? value.toString() : null;
    if (key && visited.has(key)) return;
    if (key) visited.add(key);
    const field = lookupDict(context, value);
    if (!field) return;
    const fieldType = field.get(PDFName.of('FT'))?.toString() || inheritedType;
    if (fieldType === '/Sig') {
      const signature = lookupDict(context, field.get(PDFName.of('V')));
      if (signature && (signature.has(PDFName.of('ByteRange')) || signature.has(PDFName.of('Contents')))) {
        signatureCount += 1;
      }
    }
    const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) kids.asArray().forEach((kid) => visitField(kid, fieldType));
  }

  rootFields?.asArray().forEach((field) => visitField(field));
  const permissions = pdfDoc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  if (signatureCount === 0 && permissions
    && (permissions.has(PDFName.of('DocMDP')) || permissions.has(PDFName.of('UR3')))) {
    signatureCount = 1;
  }
  return { signed: signatureCount > 0, signatureCount };
}
