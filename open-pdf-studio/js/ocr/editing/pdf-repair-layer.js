import {
  PDFArray,
  PDFBool,
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

import {
  SCANNED_TEXT_EDIT_OWNER,
  SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION,
  assertScannedTextEditStateV1,
} from '../contracts/scanned-text-edit-state.v1.js';
import {
  OCR_PDF_USER_SPACE,
  OCR_SOURCE_RASTER_SPACE,
  mapPointBetweenSpaces,
} from '../contracts/geometry.js';
import { assertOcrPageGeometryV1 } from '../contracts/page-geometry.v1.js';
import { decodeRgbaPatch, sha256Hex, zeroBytes } from './raster.js';

export const SCANNED_TEXT_EDIT_PDF_PIECE_INFO_KEY = 'OpenPDFStudioScannedTextEdit';
export const SCANNED_TEXT_EDIT_PDF_WRITER_VERSION = '1.0.0';

const OWNER = PDFName.of('Owner');
const SCHEMA_VERSION = PDFName.of('SchemaVersion');
const WRITER_VERSION = PDFName.of('WriterVersion');
const CONTENTS = PDFName.of('Contents');
const RESOURCES = PDFName.of('Resources');
const XOBJECT = PDFName.of('XObject');
const PIECE_INFO = PDFName.of('PieceInfo');
const VENDOR_KEY = PDFName.of(SCANNED_TEXT_EDIT_PDF_PIECE_INFO_KEY);
const PRIVATE = PDFName.of('Private');
const LAST_MODIFIED = PDFName.of('LastModified');
const CONTENT_STREAM = PDFName.of('ContentStream');
const CONTENT_DIGEST = PDFName.of('ContentDigest');
const STATE_STREAM = PDFName.of('StateStream');
const STATE_DIGEST = PDFName.of('StateDigest');
const STATE_ID = PDFName.of('StateId');
const STATE_REVISION = PDFName.of('StateRevision');
const ORIGINAL_RASTER_DIGEST = PDFName.of('OriginalRasterDigest');
const IMAGE_REFS = PDFName.of('ImageRefs');
const IMAGE_RESOURCES = PDFName.of('ImageResources');
const IMAGE_DIGESTS = PDFName.of('ImageDigests');
const PATCH_DIGESTS = PDFName.of('PatchDigests');
const SELECTION_IDS = PDFName.of('SelectionIds');
const TYPE = PDFName.of('Type');
const SUBTYPE = PDFName.of('Subtype');
const WIDTH = PDFName.of('Width');
const HEIGHT = PDFName.of('Height');
const COLOR_SPACE = PDFName.of('ColorSpace');
const BITS_PER_COMPONENT = PDFName.of('BitsPerComponent');
const INTERPOLATE = PDFName.of('Interpolate');
const IMAGE_DIGEST = PDFName.of('ImageDigest');
const PATCH_DIGEST = PDFName.of('PatchDigest');

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export class ScannedTextEditPdfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScannedTextEditPdfError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ScannedTextEditPdfError(code, message);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  fail('INVALID_PDF_BYTES', 'PDF input must be a Uint8Array or ArrayBuffer');
}

function pdfText(value) {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return null;
}

function pdfInteger(value) {
  return value instanceof PDFNumber && Number.isSafeInteger(value.asNumber()) ? value.asNumber() : null;
}

function sameRef(left, right) {
  return left instanceof PDFRef && right instanceof PDFRef
    && left.objectNumber === right.objectNumber && left.generationNumber === right.generationNumber;
}

function sameFingerprint(left, right) {
  return left?.algorithm === right?.algorithm && left?.value === right?.value;
}

function decodedStreamBytes(stream) {
  try {
    return decodePDFRawStream(stream).decode();
  } catch (error) {
    fail('UNSUPPORTED_STREAM_FILTER', `Cannot decode application-owned repair stream: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractOwnedRegion(originalBytes, originalPatch, approvedRegion) {
  const relativeX = approvedRegion.x - originalPatch.originX;
  const relativeY = approvedRegion.y - originalPatch.originY;
  const bytes = new Uint8Array(approvedRegion.width * approvedRegion.height * 4);
  for (let row = 0; row < approvedRegion.height; row += 1) {
    const sourceStart = ((relativeY + row) * originalPatch.widthPx + relativeX) * 4;
    const targetStart = row * approvedRegion.width * 4;
    bytes.set(
      originalBytes.subarray(sourceStart, sourceStart + approvedRegion.width * 4),
      targetStart,
    );
  }
  return bytes;
}

function changedRegionFacts(before, after, approvedRegion) {
  if (before.byteLength !== after.byteLength
      || before.byteLength !== approvedRegion.width * approvedRegion.height * 4) {
    fail('INVALID_OWNED_EDIT_STATE', 'Owned original and repaired regions must have identical RGBA dimensions');
  }
  let changedPixelCount = 0;
  let maxChannelDelta = 0;
  let minX = approvedRegion.width;
  let minY = approvedRegion.height;
  let maxX = -1;
  let maxY = -1;
  for (let pixelIndex = 0; pixelIndex < before.byteLength / 4; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(before[offset + channel] - after[offset + channel]);
      if (delta > 0) changed = true;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (!changed) continue;
    changedPixelCount += 1;
    const x = pixelIndex % approvedRegion.width;
    const y = Math.floor(pixelIndex / approvedRegion.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    actualBounds: changedPixelCount === 0 ? null : {
      coordinateSpace: OCR_SOURCE_RASTER_SPACE,
      x: approvedRegion.x + minX,
      y: approvedRegion.y + minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    },
    changedPixelCount,
    outsideApprovedChangedPixels: 0,
    maxChannelDelta,
  };
}

function sameChangedRegionFacts(recorded, actual) {
  const boundsMatch = recorded.actualBounds === null && actual.actualBounds === null
    || recorded.actualBounds !== null && actual.actualBounds !== null
      && recorded.actualBounds.coordinateSpace === actual.actualBounds.coordinateSpace
      && recorded.actualBounds.x === actual.actualBounds.x
      && recorded.actualBounds.y === actual.actualBounds.y
      && recorded.actualBounds.width === actual.actualBounds.width
      && recorded.actualBounds.height === actual.actualBounds.height;
  return recorded.changedPixelCount === actual.changedPixelCount
    && recorded.outsideApprovedChangedPixels === actual.outsideApprovedChangedPixels
    && recorded.maxChannelDelta === actual.maxChannelDelta
    && boundsMatch;
}

async function verifyStatePatchDigests(state) {
  for (const page of state.pages) {
    for (const selection of page.selections) {
      const original = await decodeRgbaPatch(selection.originalPatch);
      let beforeRegion = null;
      let repaired = null;
      let visible = null;
      try {
        if (selection.repair.changedRegion !== null) {
          beforeRegion = extractOwnedRegion(
            original,
            selection.originalPatch,
            selection.repair.approvedRegion,
          );
          if (await sha256Hex(beforeRegion) !== selection.repair.changedRegion.beforeSha256) {
            fail('INVALID_OWNED_EDIT_STATE', 'Original repair-region bytes do not match changed-region ownership metadata');
          }
        }
        if (selection.repair.repairedPatch !== null) {
          repaired = await decodeRgbaPatch(selection.repair.repairedPatch);
        }
        if (selection.content?.visibleReplacement?.patch) {
          visible = await decodeRgbaPatch(selection.content.visibleReplacement.patch);
          const patch = selection.content.visibleReplacement.patch;
          const approved = selection.repair.approvedRegion;
          if (patch.originX !== approved.x || patch.originY !== approved.y
              || patch.widthPx !== approved.width || patch.heightPx !== approved.height) {
            fail('INVALID_OWNED_EDIT_STATE', 'Visible replacement patch must exactly cover the approved edit region');
          }
        }
        if (selection.repair.changedRegion !== null) {
          const facts = changedRegionFacts(
            beforeRegion,
            repaired,
            selection.repair.approvedRegion,
          );
          if (!sameChangedRegionFacts(selection.repair.changedRegion, facts)) {
            fail('INVALID_OWNED_EDIT_STATE', 'Changed-region metadata does not exactly match the owned original and repaired pixels');
          }
        }
      } finally {
        zeroBytes(original);
        zeroBytes(beforeRegion);
        zeroBytes(repaired);
        zeroBytes(visible);
      }
    }
  }
}

function visiblePatchForSelection(selection) {
  return selection.content?.visibleReplacement?.patch || selection.repair.repairedPatch;
}

function pageContentRefs(page, context) {
  const raw = page.node.get(CONTENTS);
  if (raw == null) return [];
  let values;
  if (raw instanceof PDFRef) {
    const target = context.lookup(raw);
    if (target instanceof PDFArray) values = target.asArray();
    else if (target instanceof PDFRawStream) values = [raw];
    else fail('MALFORMED_CONTENTS', 'Page Contents reference is neither an array nor a stream');
  } else if (raw instanceof PDFArray) values = raw.asArray();
  else fail('MALFORMED_CONTENTS', 'Direct or malformed page content streams are not modified');
  for (const value of values) {
    if (!(value instanceof PDFRef) || !(context.lookup(value) instanceof PDFRawStream)) {
      fail('MALFORMED_CONTENTS', 'Every preserved page content entry must be an indirect stream');
    }
  }
  return [...values];
}

function setPageContentRefs(page, context, refs) {
  const array = PDFArray.withContext(context);
  refs.forEach((ref) => array.push(ref));
  page.node.set(CONTENTS, array);
}

function clonedResources(page, context) {
  const inherited = page.node.Resources();
  const resources = inherited instanceof PDFDict ? inherited.clone(context) : PDFDict.withContext(context);
  const inheritedXObjects = inherited?.lookupMaybe(XOBJECT, PDFDict);
  const xobjects = inheritedXObjects instanceof PDFDict
    ? inheritedXObjects.clone(context)
    : PDFDict.withContext(context);
  resources.set(XOBJECT, xobjects);
  return { resources, xobjects };
}

function clonedPieceInfo(page, context) {
  const raw = page.node.get(PIECE_INFO);
  if (raw == null) return PDFDict.withContext(context);
  const pieceInfo = context.lookup(raw);
  if (!(pieceInfo instanceof PDFDict)) fail('MALFORMED_OWNERSHIP', 'Page PieceInfo is not a dictionary');
  return pieceInfo.clone(context);
}

function getOwnershipDictionaries(page, context) {
  const rawPieceInfo = page.node.get(PIECE_INFO);
  if (rawPieceInfo == null) return null;
  const pieceInfo = context.lookup(rawPieceInfo);
  if (!(pieceInfo instanceof PDFDict)) fail('MALFORMED_OWNERSHIP', 'Page PieceInfo is not a dictionary');
  const rawVendor = pieceInfo.get(VENDOR_KEY);
  if (rawVendor == null) return null;
  const vendor = context.lookup(rawVendor);
  if (!(vendor instanceof PDFDict)) fail('MALFORMED_OWNERSHIP', 'Scanned-text PieceInfo entry is not a dictionary');
  const privateDict = context.lookup(vendor.get(PRIVATE));
  if (!(privateDict instanceof PDFDict)) fail('MALFORMED_OWNERSHIP', 'Scanned-text private ownership entry is not a dictionary');
  return { pieceInfo, vendor, privateDict };
}

function refArray(dict, key, context, label) {
  const array = context.lookup(dict.get(key));
  if (!(array instanceof PDFArray)) fail('MALFORMED_OWNERSHIP', `${label} must be an array`);
  const values = array.asArray();
  if (values.some((value) => !(value instanceof PDFRef))) {
    fail('MALFORMED_OWNERSHIP', `${label} must contain only indirect references`);
  }
  return values;
}

function textArray(dict, key, context, label) {
  const array = context.lookup(dict.get(key));
  if (!(array instanceof PDFArray)) fail('MALFORMED_OWNERSHIP', `${label} must be an array`);
  const values = array.asArray().map(pdfText);
  if (values.some((value) => value === null)) fail('MALFORMED_OWNERSHIP', `${label} must contain only text`);
  return values;
}

async function validateOwnership(page, context, pageIndex, pageCount) {
  const dictionaries = getOwnershipDictionaries(page, context);
  if (!dictionaries) return null;
  const { privateDict } = dictionaries;
  if (pdfText(privateDict.get(OWNER)) !== SCANNED_TEXT_EDIT_OWNER
      || pdfInteger(privateDict.get(SCHEMA_VERSION)) !== SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION
      || pdfText(privateDict.get(WRITER_VERSION)) !== SCANNED_TEXT_EDIT_PDF_WRITER_VERSION) {
    fail('MALFORMED_OWNERSHIP', 'Scanned-text repair metadata has an unsupported owner or version');
  }
  const contentStreamRef = privateDict.get(CONTENT_STREAM);
  const stateStreamRef = privateDict.get(STATE_STREAM);
  const contentDigest = pdfText(privateDict.get(CONTENT_DIGEST));
  const stateDigest = pdfText(privateDict.get(STATE_DIGEST));
  const stateId = pdfText(privateDict.get(STATE_ID));
  const stateRevision = pdfInteger(privateDict.get(STATE_REVISION));
  const originalRasterDigest = pdfText(privateDict.get(ORIGINAL_RASTER_DIGEST));
  if (!(contentStreamRef instanceof PDFRef) || !(stateStreamRef instanceof PDFRef)
      || !contentDigest || !stateDigest || !stateId || stateRevision === null
      || !originalRasterDigest) {
    fail('MALFORMED_OWNERSHIP', 'Scanned-text repair ownership metadata is incomplete');
  }
  const contentRefs = pageContentRefs(page, context);
  if (contentRefs.filter((ref) => sameRef(ref, contentStreamRef)).length !== 1) {
    fail('MALFORMED_OWNERSHIP', 'Owned repair content stream must appear exactly once in page Contents');
  }
  const contentStream = context.lookup(contentStreamRef);
  const stateStream = context.lookup(stateStreamRef);
  if (!(contentStream instanceof PDFRawStream) || !(stateStream instanceof PDFRawStream)) {
    fail('MALFORMED_OWNERSHIP', 'Owned repair content and state references must identify streams');
  }
  if (pdfText(contentStream.dict.get(OWNER)) !== SCANNED_TEXT_EDIT_OWNER
      || pdfInteger(contentStream.dict.get(SCHEMA_VERSION)) !== SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION
      || pdfText(contentStream.dict.get(CONTENT_DIGEST)) !== contentDigest) {
    fail('MALFORMED_OWNERSHIP', 'Owned repair content marker does not match PieceInfo');
  }
  if (pdfText(stateStream.dict.get(OWNER)) !== SCANNED_TEXT_EDIT_OWNER
      || pdfInteger(stateStream.dict.get(SCHEMA_VERSION)) !== SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION
      || pdfText(stateStream.dict.get(STATE_DIGEST)) !== stateDigest) {
    fail('MALFORMED_OWNERSHIP', 'Owned edit-state stream marker does not match PieceInfo');
  }
  const contentBytes = decodedStreamBytes(contentStream);
  const stateBytes = decodedStreamBytes(stateStream);
  if (await sha256Hex(contentBytes) !== contentDigest || await sha256Hex(stateBytes) !== stateDigest) {
    fail('MALFORMED_OWNERSHIP', 'Owned repair stream digest mismatch');
  }
  let state;
  try {
    state = JSON.parse(textDecoder.decode(stateBytes));
    assertScannedTextEditStateV1(state);
    await verifyStatePatchDigests(state);
  } catch (error) {
    fail('INVALID_OWNED_EDIT_STATE', `Owned scanned-text edit state is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (state.stateId !== stateId || state.stateRevision !== stateRevision) {
    fail('MALFORMED_OWNERSHIP', 'Owned edit-state identity or revision does not match PieceInfo');
  }
  if (state.document.pageCount !== pageCount) {
    fail('MALFORMED_OWNERSHIP', 'Owned edit state page count does not match the reopened PDF');
  }
  const imageRefs = refArray(privateDict, IMAGE_REFS, context, 'ImageRefs');
  const imageResources = textArray(privateDict, IMAGE_RESOURCES, context, 'ImageResources');
  const imageDigests = textArray(privateDict, IMAGE_DIGESTS, context, 'ImageDigests');
  const patchDigests = textArray(privateDict, PATCH_DIGESTS, context, 'PatchDigests');
  const selectionIds = textArray(privateDict, SELECTION_IDS, context, 'SelectionIds');
  const length = imageRefs.length;
  if ([imageResources, imageDigests, patchDigests, selectionIds]
    .some((values) => values.length !== length)) {
    fail('MALFORMED_OWNERSHIP', 'Owned repair image metadata arrays must have equal length');
  }
  const resources = page.node.Resources();
  const xobjects = resources?.lookupMaybe(XOBJECT, PDFDict);
  if (length > 0 && !(xobjects instanceof PDFDict)) {
    fail('MALFORMED_OWNERSHIP', 'Owned repair page lacks XObject resources');
  }
  for (let index = 0; index < length; index += 1) {
    const imageRef = imageRefs[index];
    if (!sameRef(xobjects?.get(PDFName.of(imageResources[index])), imageRef)) {
      fail('MALFORMED_OWNERSHIP', 'Owned repair image resource no longer matches PieceInfo');
    }
    const stream = context.lookup(imageRef);
    if (!(stream instanceof PDFRawStream)
        || stream.dict.get(TYPE)?.toString() !== '/XObject'
        || stream.dict.get(SUBTYPE)?.toString() !== '/Image'
        || pdfText(stream.dict.get(OWNER)) !== SCANNED_TEXT_EDIT_OWNER
        || pdfText(stream.dict.get(IMAGE_DIGEST)) !== imageDigests[index]
        || pdfText(stream.dict.get(PATCH_DIGEST)) !== patchDigests[index]) {
      fail('MALFORMED_OWNERSHIP', 'Owned repair image marker is invalid');
    }
    if (await sha256Hex(decodedStreamBytes(stream)) !== imageDigests[index]) {
      fail('MALFORMED_OWNERSHIP', 'Owned repair image bytes do not match their digest');
    }
  }
  const pageState = state.pages.find((entry) => entry.index === pageIndex);
  if (!pageState || pageState.sourceRaster.rgbaSha256 !== originalRasterDigest) {
    fail('MALFORMED_OWNERSHIP', 'Owned edit state does not identify the page original raster');
  }
  const appliedSelections = pageState.selections.filter((selection) => selection.repair.status === 'applied');
  if (appliedSelections.length !== length
      || appliedSelections.some((selection, index) => selection.id !== selectionIds[index]
        || visiblePatchForSelection(selection).sha256 !== patchDigests[index])) {
    fail('MALFORMED_OWNERSHIP', 'Owned image metadata does not match applied edit-state selections');
  }
  return {
    ...dictionaries,
    contentStreamRef,
    stateStreamRef,
    contentDigest,
    stateDigest,
    stateId,
    stateRevision,
    originalRasterDigest,
    contentRefs,
    imageRefs,
    imageResources,
    imageDigests,
    patchDigests,
    selectionIds,
    state,
    pageState,
  };
}

function newImageResourceName(xobjects, reserved) {
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = `OPS_SCAN_EDIT_${suffix}`;
    if (!reserved.has(candidate) && !xobjects.has(PDFName.of(candidate))) return candidate;
  }
  fail('IMAGE_RESOURCE_EXHAUSTED', 'Could not allocate a private scanned-text image resource');
}

function formatNumber(value) {
  if (!Number.isFinite(value)) fail('INVALID_PDF_TRANSFORM', 'Repair transform contains a non-finite number');
  const normalized = Math.abs(value) < 1e-10 ? 0 : value;
  return Number(normalized.toFixed(8)).toString();
}

function imageMatrix(pageGeometry, bounds) {
  const chain = pageGeometry.transformChain;
  const topLeft = mapPointBetweenSpaces(chain, [bounds.x, bounds.y], OCR_SOURCE_RASTER_SPACE, OCR_PDF_USER_SPACE);
  const topRight = mapPointBetweenSpaces(chain, [bounds.x + bounds.width, bounds.y], OCR_SOURCE_RASTER_SPACE, OCR_PDF_USER_SPACE);
  const bottomLeft = mapPointBetweenSpaces(chain, [bounds.x, bounds.y + bounds.height], OCR_SOURCE_RASTER_SPACE, OCR_PDF_USER_SPACE);
  return [
    topRight[0] - topLeft[0],
    topRight[1] - topLeft[1],
    topLeft[0] - bottomLeft[0],
    topLeft[1] - bottomLeft[1],
    bottomLeft[0],
    bottomLeft[1],
  ];
}

function contentBytes(images) {
  const lines = ['q'];
  for (const image of images) {
    lines.push('q');
    lines.push(`${image.matrix.map(formatNumber).join(' ')} cm`);
    lines.push(`/${image.resourceName} Do`);
    lines.push('Q');
  }
  lines.push('Q', '');
  return textEncoder.encode(lines.join('\n'));
}

function rgbaToRgb(rgba) {
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset] !== 255) fail('NON_OPAQUE_REPAIR_PATCH', 'Owned scanned-text repair patches must be fully opaque');
  }
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source];
    rgb[target + 1] = rgba[source + 1];
    rgb[target + 2] = rgba[source + 2];
  }
  return rgb;
}

function pdfArray(context, values) {
  const array = PDFArray.withContext(context);
  for (const value of values) array.push(value);
  return array;
}

function ownershipVendorDict(context, values, modifiedAt) {
  const privateDict = PDFDict.withContext(context);
  privateDict.set(OWNER, PDFString.of(SCANNED_TEXT_EDIT_OWNER));
  privateDict.set(SCHEMA_VERSION, PDFNumber.of(SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION));
  privateDict.set(WRITER_VERSION, PDFString.of(SCANNED_TEXT_EDIT_PDF_WRITER_VERSION));
  privateDict.set(CONTENT_STREAM, values.contentStreamRef);
  privateDict.set(CONTENT_DIGEST, PDFString.of(values.contentDigest));
  privateDict.set(STATE_STREAM, values.stateStreamRef);
  privateDict.set(STATE_DIGEST, PDFString.of(values.stateDigest));
  privateDict.set(STATE_ID, PDFString.of(values.stateId));
  privateDict.set(STATE_REVISION, PDFNumber.of(values.stateRevision));
  privateDict.set(ORIGINAL_RASTER_DIGEST, PDFString.of(values.originalRasterDigest));
  privateDict.set(IMAGE_REFS, pdfArray(context, values.images.map((image) => image.ref)));
  privateDict.set(IMAGE_RESOURCES, pdfArray(context, values.images.map((image) => PDFString.of(image.resourceName))));
  privateDict.set(IMAGE_DIGESTS, pdfArray(context, values.images.map((image) => PDFString.of(image.imageDigest))));
  privateDict.set(PATCH_DIGESTS, pdfArray(context, values.images.map((image) => PDFString.of(image.patchDigest))));
  privateDict.set(SELECTION_IDS, pdfArray(context, values.images.map((image) => PDFString.of(image.selectionId))));
  const vendor = PDFDict.withContext(context);
  vendor.set(LAST_MODIFIED, PDFString.of(modifiedAt));
  vendor.set(PRIVATE, privateDict);
  return vendor;
}

function normalizedModifiedAt(value) {
  if (value == null) return `D:${new Date().toISOString().replace(/[-:T]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}`;
  if (typeof value !== 'string' || !/^D:\d{14}Z$/u.test(value)) {
    fail('INVALID_MODIFIED_AT', 'modifiedAt must be a UTC PDF date string');
  }
  return value;
}

function failPdfLoad(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/encrypted|password/iu.test(message)) {
    fail('ENCRYPTED_PDF_UNSUPPORTED', 'Encrypted PDFs cannot be modified by the scanned-text repair writer');
  }
  fail('MALFORMED_PDF', `PDF could not be loaded: ${message}`);
}

async function loadPdfWithPages(sourceBytes) {
  try {
    const pdfDoc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    return { pdfDoc, pages: pdfDoc.getPages() };
  } catch (error) {
    failPdfLoad(error);
  }
}

function geometryForPage(pageState, documentState, pageGeometries) {
  const geometry = pageGeometries.find((entry) => entry.geometryId === pageState.pageGeometry.geometryId)
    || (pageState.pageGeometry?.transformChain ? pageState.pageGeometry : null);
  if (!geometry) fail('MISSING_PAGE_GEOMETRY', `Canonical page geometry ${pageState.pageGeometry.geometryId} is unavailable`);
  assertOcrPageGeometryV1(geometry);
  if (geometry.document.id !== documentState.id
      || geometry.document.revision !== documentState.revision
      || geometry.document.generation !== documentState.generation
      || geometry.document.pageCount !== documentState.pageCount
      || !sameFingerprint(geometry.document.fingerprint, documentState.fingerprint)
      || geometry.page.id !== pageState.id || geometry.page.index !== pageState.index
      || geometry.page.revision !== pageState.revision
      || geometry.sourceRaster.id !== pageState.sourceRaster.id) {
    fail('STALE_PAGE_GEOMETRY', 'Canonical page geometry does not match the owned scanned-text edit page');
  }
  return geometry;
}

async function assertTargetDocumentLineage(sourceBytes, state, ownershipByPage, lineagePdfBytes = null) {
  const expectedDigest = state.document.fingerprint.value;
  const ownedDigests = new Set(ownershipByPage
    .filter(Boolean)
    .map((ownership) => ownership.state.document.fingerprint.value));
  if (ownedDigests.size > 1 || (ownedDigests.size === 1 && !ownedDigests.has(expectedDigest))) {
    fail('STALE_DOCUMENT', 'Existing scanned-text repair ownership belongs to a different source PDF');
  }
  const lineageBytes = lineagePdfBytes === null ? sourceBytes : asBytes(lineagePdfBytes);
  if (ownedDigests.size === 0 && await sha256Hex(lineageBytes) !== expectedDigest) {
    fail('STALE_DOCUMENT', 'Scanned-text edit state fingerprint does not match the target source PDF');
  }
}

function removeValidatedOwnership(page, context, ownership) {
  if (!ownership) return;
  setPageContentRefs(page, context, ownership.contentRefs.filter((ref) => !sameRef(ref, ownership.contentStreamRef)));
  const { resources, xobjects } = clonedResources(page, context);
  for (let index = 0; index < ownership.imageRefs.length; index += 1) {
    const key = PDFName.of(ownership.imageResources[index]);
    if (!sameRef(xobjects.get(key), ownership.imageRefs[index])) {
      fail('MALFORMED_OWNERSHIP', 'Owned image resource changed during removal');
    }
    xobjects.delete(key);
  }
  page.node.set(RESOURCES, resources);
  const pieceInfo = ownership.pieceInfo.clone(context);
  pieceInfo.delete(VENDOR_KEY);
  if (pieceInfo.keys().length > 0) page.node.set(PIECE_INFO, pieceInfo);
  else page.node.delete(PIECE_INFO);
  context.delete(ownership.contentStreamRef);
  context.delete(ownership.stateStreamRef);
  ownership.imageRefs.forEach((ref) => context.delete(ref));
}

/**
 * Add or replace one application-owned opaque repair overlay per edited page.
 * Existing page content, including the original scanned image, remains intact.
 */
export async function writeOwnedScannedTextRepairLayer({
  pdfBytes,
  state,
  pageGeometries,
  modifiedAt,
  lineagePdfBytes = null,
}) {
  const sourceBytes = asBytes(pdfBytes);
  assertScannedTextEditStateV1(state);
  await verifyStatePatchDigests(state);
  if (!Array.isArray(pageGeometries)) fail('INVALID_PAGE_GEOMETRY', 'pageGeometries must be an array');
  const { pdfDoc, pages } = await loadPdfWithPages(sourceBytes);
  const context = pdfDoc.context;
  if (state.document.pageCount !== pages.length) {
    fail('STALE_DOCUMENT', 'Scanned-text edit state page count does not match the target PDF');
  }
  const prepared = state.pages.flatMap((pageState) => {
    const selections = pageState.selections
      .filter((selection) => selection.repair.status === 'applied');
    if (selections.length === 0 && !pageState.paragraphGrouping) return [];
    const page = pages[pageState.index];
    if (!page) fail('INVALID_PAGE_INDEX', 'Edit state identifies a page outside the PDF');
    return [{
      pageState,
      page,
      geometry: geometryForPage(pageState, state.document, pageGeometries),
      selections,
    }];
  });

  const ownershipByPage = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    ownershipByPage.push(await validateOwnership(pages[pageIndex], context, pageIndex, pages.length));
  }
  await assertTargetDocumentLineage(sourceBytes, state, ownershipByPage, lineagePdfBytes);
  const preparedIndexes = new Set(prepared.map((entry) => entry.pageState.index));
  let changed = false;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    if (ownershipByPage[pageIndex] && !preparedIndexes.has(pageIndex)) {
      removeValidatedOwnership(pages[pageIndex], context, ownershipByPage[pageIndex]);
      changed = true;
    }
  }
  if (prepared.length === 0) {
    return changed
      ? pdfDoc.save({ useObjectStreams: true, updateFieldAppearances: false })
      : sourceBytes.slice();
  }
  const stateBytes = textEncoder.encode(JSON.stringify(state));
  const stateDigest = await sha256Hex(stateBytes);
  const pdfModifiedAt = normalizedModifiedAt(modifiedAt);

  for (const entry of prepared) {
    changed = true;
    const previous = ownershipByPage[entry.pageState.index];
    const { resources, xobjects } = clonedResources(entry.page, context);
    if (previous) {
      for (let index = 0; index < previous.imageRefs.length; index += 1) {
        const key = PDFName.of(previous.imageResources[index]);
        if (!sameRef(xobjects.get(key), previous.imageRefs[index])) {
          fail('MALFORMED_OWNERSHIP', 'Existing repair image resource changed before replacement');
        }
        xobjects.delete(key);
      }
    }
    const reserved = new Set();
    const images = [];
    for (const selection of entry.selections) {
      const visiblePatch = visiblePatchForSelection(selection);
      const rgba = await decodeRgbaPatch(visiblePatch);
      let rgb = null;
      try {
        rgb = rgbaToRgb(rgba);
        const imageDigest = await sha256Hex(rgb);
        const resourceName = newImageResourceName(xobjects, reserved);
        reserved.add(resourceName);
        const stream = context.flateStream(rgb, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: visiblePatch.widthPx,
          Height: visiblePatch.heightPx,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Interpolate: PDFBool.False,
          Owner: PDFString.of(SCANNED_TEXT_EDIT_OWNER),
          SchemaVersion: SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION,
          ImageDigest: PDFString.of(imageDigest),
          PatchDigest: PDFString.of(visiblePatch.sha256),
        });
        const ref = context.register(stream);
        xobjects.set(PDFName.of(resourceName), ref);
        images.push({
          ref,
          resourceName,
          imageDigest,
          patchDigest: visiblePatch.sha256,
          selectionId: selection.id,
          matrix: imageMatrix(entry.geometry, selection.repair.approvedRegion),
        });
      } finally {
        zeroBytes(rgba);
        zeroBytes(rgb);
      }
    }
    entry.page.node.set(RESOURCES, resources);
    const ownedContentBytes = contentBytes(images);
    const contentDigest = await sha256Hex(ownedContentBytes);
    const ownedContent = context.flateStream(ownedContentBytes, {
      Owner: PDFString.of(SCANNED_TEXT_EDIT_OWNER),
      SchemaVersion: SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION,
      ContentDigest: PDFString.of(contentDigest),
    });
    const contentStreamRef = context.register(ownedContent);
    const stateStream = context.flateStream(stateBytes, {
      Owner: PDFString.of(SCANNED_TEXT_EDIT_OWNER),
      SchemaVersion: SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION,
      StateDigest: PDFString.of(stateDigest),
    });
    const stateStreamRef = context.register(stateStream);
    const contentRefs = pageContentRefs(entry.page, context);
    if (previous) {
      const index = contentRefs.findIndex((ref) => sameRef(ref, previous.contentStreamRef));
      if (index < 0) fail('MALFORMED_OWNERSHIP', 'Existing repair stream disappeared during replacement');
      contentRefs[index] = contentStreamRef;
      context.delete(previous.contentStreamRef);
      context.delete(previous.stateStreamRef);
      previous.imageRefs.forEach((ref) => context.delete(ref));
    } else contentRefs.push(contentStreamRef);
    setPageContentRefs(entry.page, context, contentRefs);

    const pieceInfo = clonedPieceInfo(entry.page, context);
    pieceInfo.set(VENDOR_KEY, ownershipVendorDict(context, {
      contentStreamRef,
      contentDigest,
      stateStreamRef,
      stateDigest,
      stateId: state.stateId,
      stateRevision: state.stateRevision,
      originalRasterDigest: entry.pageState.sourceRaster.rgbaSha256,
      images,
    }, pdfModifiedAt));
    entry.page.node.set(PIECE_INFO, pieceInfo);
  }
  return changed
    ? pdfDoc.save({ useObjectStreams: true, updateFieldAppearances: false })
    : sourceBytes.slice();
}

export async function inspectOwnedScannedTextRepairLayer(pdfBytes) {
  const sourceBytes = asBytes(pdfBytes);
  const { pdfDoc, pages } = await loadPdfWithPages(sourceBytes);
  const inspections = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const ownership = await validateOwnership(page, pdfDoc.context, pageIndex, pages.length);
    inspections.push(ownership ? {
      pageIndex,
      owned: true,
      owner: SCANNED_TEXT_EDIT_OWNER,
      schemaVersion: SCANNED_TEXT_EDIT_STATE_SCHEMA_VERSION,
      writerVersion: SCANNED_TEXT_EDIT_PDF_WRITER_VERSION,
      stateId: ownership.stateId,
      stateRevision: ownership.stateRevision,
      stateDigest: ownership.stateDigest,
      originalRasterDigest: ownership.originalRasterDigest,
      contentRef: ownership.contentStreamRef.toString(),
      contentRefs: ownership.contentRefs.map((ref) => ref.toString()),
      imageRefs: ownership.imageRefs.map((ref) => ref.toString()),
      imageResources: ownership.imageResources,
      selectionIds: ownership.selectionIds,
      patchDigests: ownership.patchDigests,
      state: ownership.state,
    } : {
      pageIndex,
      owned: false,
      contentRefs: pageContentRefs(page, pdfDoc.context).map((ref) => ref.toString()),
    });
  }
  return inspections;
}

export async function removeOwnedScannedTextRepairLayer({ pdfBytes, pageIndexes } = {}) {
  const sourceBytes = asBytes(pdfBytes);
  const { pdfDoc, pages } = await loadPdfWithPages(sourceBytes);
  const selected = pageIndexes === undefined ? null : new Set(pageIndexes);
  if (selected !== null && (!Array.isArray(pageIndexes) || selected.size !== pageIndexes.length
      || pageIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= pages.length))) {
    fail('INVALID_REMOVE_PAGES', 'Removed page indexes must be unique and inside the PDF');
  }
  const ownership = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    ownership.push(await validateOwnership(pages[pageIndex], pdfDoc.context, pageIndex, pages.length));
  }
  if (!ownership.some((entry, index) => entry && (selected === null || selected.has(index)))) {
    return sourceBytes.slice();
  }
  for (let index = 0; index < pages.length; index += 1) {
    if (selected !== null && !selected.has(index)) continue;
    if (ownership[index]) removeValidatedOwnership(pages[index], pdfDoc.context, ownership[index]);
  }
  return pdfDoc.save({ useObjectStreams: true, updateFieldAppearances: false });
}
