export function createLowResolutionPreviewKey(documentState, pageNum) {
  const page = Number(pageNum);
  if (!documentState?.id || !Number.isInteger(page) || page <= 0) {
    throw new TypeError('A low-resolution preview key requires a document and positive page');
  }
  return [
    documentState.filePath || 'blank',
    `d${documentState.id}`,
    `g${Number(documentState.lifecycleGeneration) || 0}`,
    `c${Number(documentState.revisionState?.contentRevision) || 0}`,
    `p${page}`,
    `v${Number(documentState.pageRenderRevisions?.[page]) || 0}`,
    `r${Number(documentState.pageRotations?.[page]) || 0}`,
  ].join('|');
}
