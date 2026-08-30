export function viewportOwnsDocumentZoom(documentState, viewportState) {
  if (!documentState || documentState.viewMode !== 'single' || !viewportState?.active) {
    return false;
  }
  return String(documentState.id) === String(viewportState.documentId)
    && (Number(documentState.lifecycleGeneration) || 0)
      === (Number(viewportState.documentLifecycleGeneration) || 0);
}
