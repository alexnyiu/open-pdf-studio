import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import {
  OWNED_TEXT_EDIT_MANIFEST_SCHEMA,
  OWNED_TEXT_EDIT_MANIFEST_VERSION,
  TEXT_EDIT_SCHEMA,
  TEXT_EDIT_VERSION,
  assertRichTextDocumentV2,
  canonicalRichTextHash,
} from './rich-text.js';

const OWNER_KEY = PDFName.of('OpenPDFStudioTextEdit');
const OWNED_LAYER_KEY = PDFName.of('OPDSOwnedTextLayer');
const LAST_MODIFIED_KEY = PDFName.of('LastModified');

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalPayload(payload) {
  return JSON.stringify({
    schema: payload.schema,
    version: payload.version,
    documentId: payload.documentId,
    revision: payload.revision,
    pages: payload.pages,
  });
}

function streamMatchesManifest(stream, serializedManifest) {
  if (!(stream instanceof PDFRawStream)) return false;
  try {
    const decoded = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    return decoded === serializedManifest;
  } catch {
    return false;
  }
}

function validateRecord(record) {
  if (record?.schema !== TEXT_EDIT_SCHEMA || record?.version !== TEXT_EDIT_VERSION) {
    throw new Error('Unknown owned text edit record version');
  }
  if (!record.id || !Number.isInteger(record.page) || record.page < 1 || !(record.revision > 0)) {
    throw new Error('Malformed owned text edit record identity');
  }
  if (record.ownedLayerId !== `OpenPDFStudioTextEdit-${record.id}`) {
    throw new Error(`Owned text edit ${record.id} has an invalid layer identity`);
  }
  assertRichTextDocumentV2(record.richText);
  if (record.original) assertRichTextDocumentV2(record.original);
  if (record.original && !record.sourceProvenance) {
    throw new Error('Native text edit lacks trustworthy source provenance');
  }
  if (record.sourceProvenance && (!Array.isArray(record.sourceProvenance)
      || record.sourceProvenance.length === 0
      || record.sourceProvenance.some((source) => source?.schema !== 'open-pdf-studio.native-text-source'
        || source?.version !== 1
        || source?.eligibility?.eligible !== true))) {
    throw new Error('Native text edit has malformed or ineligible source provenance');
  }
  if (record.substitution && record.substitution.approved !== true) {
    throw new Error('Font substitution was not explicitly approved');
  }
  return record;
}

export async function buildOwnedTextEditManifest(documentId, records, previousManifestOrRevision = 0) {
  const edits = records.map(validateRecord);
  const byPage = new Map();
  for (const edit of edits) {
    if (!byPage.has(edit.page)) byPage.set(edit.page, []);
    byPage.get(edit.page).push(edit);
  }
  const pages = [...byPage.entries()].sort(([left], [right]) => left - right).map(([page, pageEdits]) => ({
    page,
    layerId: `OpenPDFStudioTextEditPage-${page}`,
    edits: pageEdits.sort((left, right) => left.id.localeCompare(right.id)),
  }));
  const previousManifest = previousManifestOrRevision
    && typeof previousManifestOrRevision === 'object' ? previousManifestOrRevision : null;
  const previousRevision = previousManifest
    ? Number(previousManifest.revision) || 0
    : Number(previousManifestOrRevision) || 0;
  const unchanged = previousManifest
    && previousManifest.documentId === String(documentId)
    && JSON.stringify(previousManifest.pages) === JSON.stringify(pages);
  const payload = {
    schema: OWNED_TEXT_EDIT_MANIFEST_SCHEMA,
    version: OWNED_TEXT_EDIT_MANIFEST_VERSION,
    documentId: String(documentId),
    revision: unchanged
      ? previousRevision
      : Math.max(previousRevision, ...edits.map((edit) => edit.revision), 0) + 1,
    pages,
    integrityHash: '',
  };
  payload.integrityHash = await sha256(canonicalPayload(payload));
  return payload;
}

export async function writeOwnedTextEditManifest(pdfDocument, documentId, records, previousManifestOrRevision = 0) {
  const manifest = await buildOwnedTextEditManifest(
    documentId,
    records,
    previousManifestOrRevision,
  );
  const context = pdfDocument.context;
  const catalog = pdfDocument.catalog;
  let pieceInfo = catalog.lookupMaybe(PDFName.of('PieceInfo'), PDFDict);
  if (!pieceInfo) {
    pieceInfo = context.obj({});
    catalog.set(PDFName.of('PieceInfo'), pieceInfo);
  }
  const existingEntry = pieceInfo.lookupMaybe(OWNER_KEY, PDFDict);
  const existingPrivateRef = existingEntry?.get(PDFName.of('Private')) || null;
  const serializedManifest = JSON.stringify(manifest);
  const existingPrivateStream = existingEntry?.lookupMaybe(PDFName.of('Private'), PDFRawStream);
  const unchanged = streamMatchesManifest(existingPrivateStream, serializedManifest);
  let privateRef = existingPrivateRef;
  if (!privateRef || !unchanged) {
    const stream = context.stream(new TextEncoder().encode(serializedManifest), {
      Type: 'Metadata',
      Subtype: 'OpenPDFStudioTextEditManifest',
    });
    if (privateRef) context.assign(privateRef, stream);
    else privateRef = context.register(stream);
  }
  const previousLastModified = existingEntry?.get(LAST_MODIFIED_KEY) || null;
  pieceInfo.set(OWNER_KEY, context.obj({
    LastModified: unchanged && previousLastModified
      ? previousLastModified
      : PDFString.of(new Date().toISOString()),
    Schema: PDFString.of(OWNED_TEXT_EDIT_MANIFEST_SCHEMA),
    Version: OWNED_TEXT_EDIT_MANIFEST_VERSION,
    Private: privateRef,
  }));
  return manifest;
}

export async function readOwnedTextEditManifest(pdfDocument) {
  const pieceInfo = pdfDocument.catalog.lookupMaybe(PDFName.of('PieceInfo'), PDFDict);
  const entry = pieceInfo?.lookupMaybe(OWNER_KEY, PDFDict);
  if (!entry) return null;
  const schema = entry.get(PDFName.of('Schema'))?.decodeText?.();
  const version = entry.get(PDFName.of('Version'))?.asNumber?.();
  if (schema !== OWNED_TEXT_EDIT_MANIFEST_SCHEMA || ![2, OWNED_TEXT_EDIT_MANIFEST_VERSION].includes(version)) {
    throw new Error(`Unknown owned text edit manifest version: ${schema || 'missing'} v${version ?? 'missing'}`);
  }
  const stream = entry.lookup(PDFName.of('Private'));
  if (!(stream instanceof PDFRawStream)) throw new Error('Owned text edit manifest stream is missing');
  const payload = JSON.parse(new TextDecoder().decode(decodePDFRawStream(stream).decode()));
  if (payload.schema !== schema || payload.version !== version || !Array.isArray(payload.pages)) {
    throw new Error('Owned text edit manifest payload is malformed');
  }
  const actualHash = await sha256(canonicalPayload(payload));
  if (actualHash !== payload.integrityHash) throw new Error('Owned text edit manifest integrity check failed');
  for (const page of payload.pages) for (const edit of page.edits || []) validateRecord(edit);
  if (version === 2) {
    const nativeV2 = payload.pages.some((page) => (page.edits || [])
      .some((edit) => edit.original || edit.sourceProvenance));
    if (nativeV2) throw new Error('Persisted native V2 text edits cannot be migrated safely');
    payload.version = OWNED_TEXT_EDIT_MANIFEST_VERSION;
    payload.integrityHash = await sha256(canonicalPayload(payload));
  }
  return payload;
}

export async function hydrateOwnedTextEditManifest(documentState, pdfBytes, parsedDocument = null) {
  const pdfDocument = parsedDocument || await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  const manifest = await readOwnedTextEditManifest(pdfDocument);
  if (!manifest) {
    documentState.textEditManifest = null;
    documentState.textEditReadOnlyReason = null;
    return null;
  }
  const pages = pdfDocument.getPages();
  for (const manifestPage of manifest.pages) {
    const expectedLayerId = `OpenPDFStudioTextEditPage-${manifestPage.page}`;
    if (manifestPage.layerId !== expectedLayerId) {
      throw new Error(`Owned text edit page ${manifestPage.page} has an invalid layer identity`);
    }
    const page = pages[manifestPage.page - 1];
    if (!page) throw new Error(`Owned text edit page ${manifestPage.page} is outside the PDF`);
    const contents = page.node.lookup(PDFName.of('Contents'));
    const streams = contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => pdfDocument.context.lookup(contents.get(index)))
      : [contents];
    const ownsLayer = streams.some((stream) => (
      stream instanceof PDFRawStream
        && stream.dict.get(OWNED_LAYER_KEY)?.decodeText?.() === expectedLayerId
    ));
    if (!ownsLayer) {
      throw new Error(`Owned text edit layer marker is missing or externally modified on page ${manifestPage.page}`);
    }
  }
  documentState.textEditManifest = manifest;
  documentState.textEdits = manifest.pages.flatMap((page) => page.edits);
  documentState.textEditReadOnlyReason = null;
  return manifest;
}

export function assertOwnedTextEditStable(records) {
  const ids = new Set();
  for (const record of records) {
    validateRecord(record);
    if (ids.has(record.id)) throw new Error(`Duplicate text edit identity ${record.id}`);
    ids.add(record.id);
    if (canonicalRichTextHash(record.richText) === record.originalSnapshotHash && record.original) {
      throw new Error(`Text edit ${record.id} does not differ from its opening snapshot`);
    }
  }
  return true;
}
