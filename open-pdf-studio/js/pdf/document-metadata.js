import { PDFHexString, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

export const DOCUMENT_METADATA_FIELDS = Object.freeze([
  'title',
  'author',
  'subject',
  'keywords',
  'creator',
  'producer',
  'creationDate',
  'modificationDate',
]);

export const DOCUMENT_METADATA_DATE_FIELDS = Object.freeze([
  'creationDate',
  'modificationDate',
]);

const DOCUMENT_METADATA_FIELD_SET = new Set(DOCUMENT_METADATA_FIELDS);
const DOCUMENT_METADATA_DATE_FIELD_SET = new Set(DOCUMENT_METADATA_DATE_FIELDS);

export function isDocumentMetadataField(field) {
  return DOCUMENT_METADATA_FIELD_SET.has(field);
}

export function documentMetadataFieldToEditorValue(field, value) {
  if (!isDocumentMetadataField(field)) throw new TypeError(`Unsupported document metadata field: ${field}`);
  if (!DOCUMENT_METADATA_DATE_FIELD_SET.has(field)) return value == null ? '' : String(value);
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 19);
}

export function documentMetadataFieldFromEditorValue(field, value) {
  if (!isDocumentMetadataField(field)) throw new TypeError(`Unsupported document metadata field: ${field}`);
  if (!DOCUMENT_METADATA_DATE_FIELD_SET.has(field)) return value == null ? '' : String(value);
  if (value == null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid ${field}`);
  return date.toISOString();
}

export function createEmptyDocumentMetadata() {
  return {
    title: '',
    author: '',
    subject: '',
    keywords: '',
    creator: '',
    producer: '',
    creationDate: null,
    modificationDate: null,
  };
}

function parsePdfDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const raw = String(value).trim();
  if (!raw) return null;
  if (!raw.startsWith('D:')) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const match = raw.match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz])|([+-])(\d{2})'?((?:\d{2})?)'?)?/u);
  if (!match) return null;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', zulu, sign, zoneHour = '00', zoneMinute = '00'] = match;
  const localUtc = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const offsetMinutes = zulu ? 0 : ((+zoneHour * 60) + +(zoneMinute || 0)) * (sign === '-' ? -1 : 1);
  const parsed = new Date(localUtc - (offsetMinutes * 60_000));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function documentMetadataFromPdfInfo(info = {}) {
  return normalizeDocumentMetadata({
    title: info.Title,
    author: info.Author,
    subject: info.Subject,
    keywords: Array.isArray(info.Keywords) ? info.Keywords.join(', ') : info.Keywords,
    creator: info.Creator,
    producer: info.Producer,
    creationDate: parsePdfDate(info.CreationDate),
    modificationDate: parsePdfDate(info.ModDate),
  });
}

export function normalizeDocumentMetadata(value = {}) {
  const normalized = createEmptyDocumentMetadata();
  for (const field of DOCUMENT_METADATA_FIELDS) {
    if (field === 'creationDate' || field === 'modificationDate') {
      const raw = value[field];
      if (raw == null || raw === '') {
        normalized[field] = null;
      } else {
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid ${field}`);
        normalized[field] = date.toISOString();
      }
    } else {
      normalized[field] = value[field] == null ? '' : String(value[field]);
    }
  }
  return normalized;
}

export function documentMetadataWithEditorField(value, field, editorValue) {
  const current = normalizeDocumentMetadata(value || {});
  return normalizeDocumentMetadata({
    ...current,
    [field]: documentMetadataFieldFromEditorValue(field, editorValue),
  });
}

export function cloneDocumentMetadata(value) {
  return normalizeDocumentMetadata(value || {});
}

export function documentMetadataEqual(left, right) {
  const a = normalizeDocumentMetadata(left || {});
  const b = normalizeDocumentMetadata(right || {});
  return DOCUMENT_METADATA_FIELDS.every((field) => a[field] === b[field]);
}

const INFO_FIELD_CONFIG = Object.freeze({
  title: ['Title', 'setTitle'],
  author: ['Author', 'setAuthor'],
  subject: ['Subject', 'setSubject'],
  keywords: ['Keywords', 'setKeywords'],
  creator: ['Creator', 'setCreator'],
  producer: ['Producer', 'setProducer'],
  creationDate: ['CreationDate', 'setCreationDate'],
  modificationDate: ['ModDate', 'setModificationDate'],
});

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function replaceElementText(xml, qualifiedName, value) {
  const escapedName = regexEscape(qualifiedName);
  const expression = new RegExp(`(<${escapedName}\\b[^>]*>)([\\s\\S]*?)(<\\/${escapedName}\\s*>)`, 'giu');
  if (!expression.test(xml)) return xml;
  if (value === '') return xml.replace(expression, '');
  return xml.replace(expression, `$1${xmlEscape(value)}$3`);
}

function replaceAttribute(xml, qualifiedName, value) {
  const escapedName = regexEscape(qualifiedName);
  const expression = new RegExp(`(\\s${escapedName}\\s*=\\s*)(["'])([\\s\\S]*?)\\2`, 'giu');
  if (!expression.test(xml)) return xml;
  if (value === '') return xml.replace(expression, '');
  return xml.replace(expression, `$1$2${xmlEscape(value)}$2`);
}

function replaceRdfContainerValue(xml, qualifiedName, value) {
  const escapedName = regexEscape(qualifiedName);
  if (value === '') {
    const outer = new RegExp(`<${escapedName}\\b[^>]*>[\\s\\S]*?<\\/${escapedName}\\s*>`, 'giu');
    return xml.replace(outer, '');
  }
  const expression = new RegExp(`(<${escapedName}\\b[^>]*>[\\s\\S]*?<rdf:(?:Alt|Seq|Bag)\\b[^>]*>[\\s\\S]*?<rdf:li\\b[^>]*>)([\\s\\S]*?)(<\\/rdf:li\\s*>)`, 'giu');
  if (!expression.test(xml)) return xml;
  return xml.replace(expression, `$1${xmlEscape(value)}$3`);
}

function replaceExistingXmpValue(xml, qualifiedName, value, { rdfContainer = false } = {}) {
  if (rdfContainer) {
    const containerResult = replaceRdfContainerValue(xml, qualifiedName, value);
    if (containerResult !== xml) return replaceAttribute(containerResult, qualifiedName, value);
  }
  const elementResult = replaceElementText(xml, qualifiedName, value);
  return replaceAttribute(elementResult, qualifiedName, value);
}

function syncExistingXmpFields(pdfDocLib, metadata) {
  const metadataRef = pdfDocLib.catalog.get(PDFName.of('Metadata'));
  if (!metadataRef) return false;
  const metadataObj = pdfDocLib.context.lookup(metadataRef);
  if (!(metadataObj instanceof PDFRawStream)) return false;

  let xml;
  try {
    xml = new TextDecoder().decode(decodePDFRawStream(metadataObj).decode());
  } catch {
    return false;
  }
  const original = xml;
  const simpleFields = [
    ['keywords', 'pdf:Keywords'],
    ['creator', 'xmp:CreatorTool'],
    ['producer', 'pdf:Producer'],
    ['creationDate', 'xmp:CreateDate'],
    ['modificationDate', 'xmp:ModifyDate'],
  ];
  for (const [field, name] of simpleFields) {
    const value = metadata[field] || '';
    xml = replaceExistingXmpValue(xml, name, value);
  }
  xml = replaceExistingXmpValue(xml, 'dc:title', metadata.title || '', { rdfContainer: true });
  xml = replaceExistingXmpValue(xml, 'dc:creator', metadata.author || '', { rdfContainer: true });
  xml = replaceExistingXmpValue(xml, 'dc:description', metadata.subject || '', { rdfContainer: true });
  if (xml === original) return false;

  const replacement = pdfDocLib.context.stream(new TextEncoder().encode(xml), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  pdfDocLib.catalog.set(PDFName.of('Metadata'), pdfDocLib.context.register(replacement));
  return true;
}

export function applyDocumentMetadataToPdf(pdfDocLib, value) {
  const metadata = normalizeDocumentMetadata(value || {});
  const info = pdfDocLib.getInfoDict();
  for (const [field, [pdfKey, setter]] of Object.entries(INFO_FIELD_CONFIG)) {
    const current = metadata[field];
    if (current == null || current === '') {
      info.delete(PDFName.of(pdfKey));
      continue;
    }
    if (field === 'keywords') {
      info.set(PDFName.of(pdfKey), PDFHexString.fromText(current));
    } else if (field === 'creationDate' || field === 'modificationDate') {
      pdfDocLib[setter](new Date(current));
    } else {
      pdfDocLib[setter](current);
    }
  }
  syncExistingXmpFields(pdfDocLib, metadata);
  return metadata;
}

export async function assertDocumentMetadataRoundTrip(pdfJsDocument, expected) {
  const loaded = await pdfJsDocument.getMetadata();
  const actual = documentMetadataFromPdfInfo(loaded?.info || {});
  const normalizedExpected = normalizeDocumentMetadata(expected || {});
  if (!documentMetadataEqual(actual, normalizedExpected)) {
    const mismatches = DOCUMENT_METADATA_FIELDS
      .filter((field) => actual[field] !== normalizedExpected[field])
      .join(', ');
    throw new Error(`Document metadata did not round-trip: ${mismatches}`);
  }
  return actual;
}
