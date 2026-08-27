const EMPTY_VALUE = '-';

export function createEmptyDocumentInfo(noFileOpen = EMPTY_VALUE) {
  return {
    filename: noFileOpen,
    filepath: EMPTY_VALUE,
    pages: EMPTY_VALUE,
    pageSize: EMPTY_VALUE,
    title: EMPTY_VALUE,
    author: EMPTY_VALUE,
    subject: EMPTY_VALUE,
    keywords: EMPTY_VALUE,
    creator: EMPTY_VALUE,
    producer: EMPTY_VALUE,
    creationDate: EMPTY_VALUE,
    modificationDate: EMPTY_VALUE,
    version: EMPTY_VALUE,
    annotCount: '0',
    annotPage: '0',
  };
}

function displayMetadataDate(value) {
  if (!value) return EMPTY_VALUE;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? EMPTY_VALUE : parsed.toLocaleString();
}

/**
 * Read every document-info field into one local snapshot. `isCurrent` is
 * checked after each asynchronous boundary so callers can discard results
 * belonging to an old tab, page, lifecycle generation, or PDF proxy.
 */
export async function collectDocumentInfoSnapshot(documentState, {
  noFileOpen = EMPTY_VALUE,
  onPageCount = ({ count, page }) => `${count} (page ${page})`,
  isCurrent = () => true,
} = {}) {
  if (!documentState) return createEmptyDocumentInfo(noFileOpen);

  const filePath = documentState.filePath || '';
  const normalizedPath = filePath.replace(/\\/gu, '/');
  const metadata = { ...(documentState.metadata || {}) };
  const currentPage = documentState.currentPage || 1;
  const annotations = [...(documentState.annotations || [])];
  const snapshot = createEmptyDocumentInfo(filePath
    ? normalizedPath.split('/').at(-1) || noFileOpen
    : noFileOpen);

  snapshot.filepath = filePath || EMPTY_VALUE;
  snapshot.title = metadata.title || EMPTY_VALUE;
  snapshot.author = metadata.author || EMPTY_VALUE;
  snapshot.subject = metadata.subject || EMPTY_VALUE;
  snapshot.keywords = metadata.keywords || EMPTY_VALUE;
  snapshot.creator = metadata.creator || EMPTY_VALUE;
  snapshot.producer = metadata.producer || EMPTY_VALUE;
  snapshot.creationDate = displayMetadataDate(metadata.creationDate);
  snapshot.modificationDate = displayMetadataDate(metadata.modificationDate);
  snapshot.annotCount = String(annotations.length);
  const onPage = annotations.filter((annotation) => annotation.page === currentPage).length;
  snapshot.annotPage = onPageCount({ count: onPage, page: currentPage });

  const pdfDocument = documentState.pdfDoc;
  if (!pdfDocument) return isCurrent() ? snapshot : null;

  snapshot.pages = `${currentPage} / ${pdfDocument.numPages}`;
  try {
    const page = await pdfDocument.getPage(currentPage);
    if (!isCurrent()) return null;
    const viewport = page.getViewport({ scale: 1 });
    const widthMm = (viewport.width / 72 * 25.4).toFixed(1);
    const heightMm = (viewport.height / 72 * 25.4).toFixed(1);
    snapshot.pageSize = `${widthMm} x ${heightMm} mm`;
  } catch {
    if (!isCurrent()) return null;
  }

  try {
    const pdfMetadata = await pdfDocument.getMetadata();
    if (!isCurrent()) return null;
    snapshot.version = pdfMetadata?.info?.PDFFormatVersion || EMPTY_VALUE;
  } catch {
    if (!isCurrent()) return null;
  }

  return isCurrent() ? snapshot : null;
}
