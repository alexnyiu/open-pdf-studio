const PAGE_TEXT_EDIT_HOST_CLASS = 'pdf-text-edit-layer';

/** Exact immutable identity required before a page-local editor host is reused. */
export function pageTextEditHostMatchesPlacement(host, placement) {
  return Boolean(host?.classList?.contains?.(PAGE_TEXT_EDIT_HOST_CLASS)
    && placement
    && host.dataset?.documentId === String(placement.documentId)
    && host.dataset?.page === String(placement.pageNum)
    && Number(host.dataset?.generation) === Number(placement.generation));
}
