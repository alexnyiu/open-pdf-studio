import {
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

function validateRecord(record) {
  if (record?.schema !== TEXT_EDIT_SCHEMA || record?.version !== TEXT_EDIT_VERSION) {
    throw new Error('Unknown owned text edit record version');
  }
  if (!record.id || !Number.isInteger(record.page) || record.page < 1 || !(record.revision > 0)) {
    throw new Error('Malformed owned text edit record identity');
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
  const stream = context.stream(new TextEncoder().encode(JSON.stringify(manifest)), {
    Type: 'Metadata',
    Subtype: 'OpenPDFStudioTextEditManifest',
  });
  let privateRef = existingPrivateRef;
  if (privateRef) context.assign(privateRef, stream);
  else privateRef = context.register(stream);
  pieceInfo.set(OWNER_KEY, context.obj({
    LastModified: PDFString.of(new Date().toISOString()),
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

export async function hydrateOwnedTextEditManifest(documentState, pdfBytes) {
  const pdfDocument = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  const manifest = await readOwnedTextEditManifest(pdfDocument);
  if (!manifest) {
    documentState.textEditManifest = null;
    return null;
  }
  documentState.textEditManifest = manifest;
  documentState.textEdits = manifest.pages.flatMap((page) => page.edits);
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
