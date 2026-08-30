function policy(id, overrides = {}) {
  return Object.freeze({
    id,
    cancelTextEditing: true,
    cancelOcr: true,
    cancelSaves: true,
    clearProxyReadiness: true,
    preserveLogicalDocument: true,
    preserveView: false,
    ...overrides,
  });
}

export const LIFECYCLE_TRANSITION_POLICIES = Object.freeze({
  CONTENT_REPLACEMENT: policy('content-replacement'),
  DOCUMENT_LOAD: policy('document-load', { preserveLogicalDocument: false }),
  DOCUMENT_LOAD_FAILURE: policy('document-load-failure', { preserveLogicalDocument: false }),
  DOCUMENT_CLOSE: policy('document-close', { preserveLogicalDocument: false }),
  PROXY_RECOVERY: policy('proxy-recovery'),
  VALIDATED_SAVE_ADOPTION: policy('validated-save-adoption', {
    cancelTextEditing: false,
    cancelSaves: false,
    preserveView: true,
  }),
});

export function assertLifecycleTransitionPolicy(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') {
    throw new TypeError('LifecycleTransitionPolicy is required');
  }
  for (const field of [
    'cancelTextEditing',
    'cancelOcr',
    'cancelSaves',
    'clearProxyReadiness',
    'preserveLogicalDocument',
    'preserveView',
  ]) {
    if (typeof value[field] !== 'boolean') throw new TypeError(`Lifecycle policy ${field} is required`);
  }
  return value;
}

/** Pure lifecycle boundary shared by the application wrapper and unit tests. */
export function advanceDocumentLifecycleState(
  documentState,
  transitionPolicy = LIFECYCLE_TRANSITION_POLICIES.CONTENT_REPLACEMENT,
  cancelForDocument = () => false,
) {
  if (!documentState) return 0;
  const currentPolicy = assertLifecycleTransitionPolicy(transitionPolicy);
  cancelForDocument(documentState.id, currentPolicy);
  documentState.lifecycleGeneration = (Number(documentState.lifecycleGeneration) || 0) + 1;
  if (currentPolicy.clearProxyReadiness) documentState.pageEditReadiness = {};
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
      && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('opds:document-lifecycle-changed', {
      detail: {
        documentId: String(documentState.id || ''),
        lifecycleGeneration: documentState.lifecycleGeneration,
        reason: currentPolicy.id,
        policy: currentPolicy,
      },
    }));
  }
  return documentState.lifecycleGeneration;
}

export function replaceDocumentPdfProxyState(
  documentState,
  nextPdfDocument,
  transitionPolicy = LIFECYCLE_TRANSITION_POLICIES.CONTENT_REPLACEMENT,
  cancelForDocument = () => false,
) {
  if (!documentState) throw new TypeError('Document state is required');
  const previous = documentState.pdfDoc;
  advanceDocumentLifecycleState(documentState, transitionPolicy, cancelForDocument);
  documentState.pdfDoc = nextPdfDocument;
  return previous;
}
