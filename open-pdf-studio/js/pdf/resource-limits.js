// Keep untrusted page trees from reaching eager batch-analysis, thumbnail, and
// annotation loops. The limit matches the existing persisted document/OCR
// contract ceiling; it does not expand supported document scope.
export const MAX_PDF_DOCUMENT_PAGES = 100_000;

export function assertPdfDocumentResourceLimits(pdfDocument) {
  const pageCount = pdfDocument?.numPages;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw Object.assign(new RangeError('PDF page count is invalid'), {
      code: 'PDF_PAGE_COUNT_INVALID',
    });
  }
  if (pageCount > MAX_PDF_DOCUMENT_PAGES) {
    throw Object.assign(new RangeError(
      `PDF contains ${pageCount} pages; the safe limit is ${MAX_PDF_DOCUMENT_PAGES}`,
    ), {
      code: 'PDF_PAGE_COUNT_LIMIT',
      pageCount,
      maximumPages: MAX_PDF_DOCUMENT_PAGES,
    });
  }
  return pdfDocument;
}
