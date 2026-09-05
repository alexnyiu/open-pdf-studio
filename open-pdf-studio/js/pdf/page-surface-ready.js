import { resolvePageSurface, subscribePageSurfaceRegistry } from './page-surface-registry.js';

/** Wait for publication, not a guessed render duration. No recurring polling. */
export function waitForPageTextSurface(doc, pageNum, { signal, timeoutMs = 15000 } = {}) {
  const generation = Number(doc.lifecycleGeneration) || 0;
  const revision = Number(doc.revisionState?.contentRevision) || 0;
  const pageRevision = Number(doc.revisionState?.pageContentRevisions?.[pageNum]
    ?? doc.pageRenderRevisions?.[pageNum] ?? revision) || 0;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {}, timer, settled = false;
    const finish = (error, surface) => {
      if (settled) return;
      settled = true;
      unsubscribe(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(surface);
    };
    const abort = () => finish(new DOMException('Navigation superseded', 'AbortError'));
    const check = () => {
      if (signal?.aborted) return abort();
      if ((Number(doc.lifecycleGeneration) || 0) !== generation
          || (Number(doc.revisionState?.contentRevision) || 0) !== revision) return abort();
      const surface = resolvePageSurface(doc, pageNum);
      if (surface?.textLayer?.isConnected && surface.baseSurface?.isConnected
          && surface.pageContentRevision === pageRevision
          && surface.basePublishedRevision >= pageRevision
          && surface.semanticPublishedRevision >= pageRevision) finish(null, surface);
    };
    unsubscribe = subscribePageSurfaceRegistry(check);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('The search page did not become ready. Try again.')), timeoutMs);
    check();
  });
}
