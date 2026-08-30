import {
  markPageRenderReady,
  markPageSemanticReady,
} from '../core/document-revision-state.runtime.js';
import {
  markPageEditLayerReady,
  PAGE_EDIT_READY_LAYERS,
} from '../pdf/page-edit-readiness.js';
import {
  markPageSurfacePublication,
  resolvePageSurface,
  subscribePageSurfaceRegistry,
} from '../pdf/page-surface-registry.js';
import {
  captureRenderPublicationToken,
  renderPublicationTokenIsCurrent,
} from '../pdf/render-publication-token.js';

function pageRevision(documentState, pageNum) {
  return Number(documentState?.revisionState?.pageContentRevisions?.[pageNum]
    ?? documentState?.revisionState?.contentRevision) || 0;
}

function resultFor(token, status, {
  visiblePublished = false,
  semanticPublished = false,
  errorCode = null,
  error = null,
  baseStamp = null,
  semanticStamp = null,
  surfaceKind = null,
} = {}) {
  const normalizedSurfaceKind = status === 'deferred-unmounted'
    ? 'deferred'
    : surfaceKind === 'single-viewport' || String(surfaceKind || '').startsWith('single-page')
      ? 'single-viewport'
      : surfaceKind === 'continuous-image'
        || String(surfaceKind || '').includes('raster-image')
        ? 'continuous-image'
        : 'continuous-canvas';
  const publishedRevision = Number(token?.publishedPageRevision ?? token?.pageRevision) || 0;
  return Object.freeze({
    status,
    documentId: token?.documentId || '',
    lifecycleGeneration: Number(token?.lifecycleGeneration) || 0,
    documentGeneration: Number(token?.lifecycleGeneration) || 0,
    pageNum: Number(token?.pageNum) || 0,
    contentRevision: Number(token?.contentRevision) || 0,
    pageRevision: publishedRevision,
    renderRevision: visiblePublished ? publishedRevision : null,
    semanticRevision: semanticPublished ? publishedRevision : null,
    surfaceKind: normalizedSurfaceKind,
    visiblePublished: visiblePublished === true,
    semanticPublished: semanticPublished === true,
    errorCode: errorCode == null ? null : String(errorCode),
    error: error == null ? null : String(error),
    baseStamp,
    semanticStamp,
  });
}

function pendingKey(documentState, pageNum, revision) {
  return [
    String(documentState?.id || ''),
    Number(documentState?.lifecycleGeneration) || 0,
    Number(pageNum) || 0,
    Number(revision) || 0,
  ].join(':');
}

async function defaultBasePublisher(context) {
  const publishOverlay = async () => {
    const rendering = await import('../annotations/rendering.js');
    const overlay = context.surface?.overlayCanvas;
    if (!overlay?.getContext) throw new Error('Page overlay surface is unavailable');
    if (context.surface.surfaceKind.startsWith('continuous')) {
      const dimensions = context.surface.canonicalPageDimensions;
      rendering.renderAnnotationsForPage(
        overlay.getContext('2d'),
        context.pageNum,
        (Number(dimensions?.width) || 1) * context.surface.cssScale,
        (Number(dimensions?.height) || 1) * context.surface.cssScale,
        context.surface.dpr,
      );
    } else {
      rendering.redrawAnnotations();
    }
    overlay.dataset.textEditContentRevision = String(context.token.contentRevision);
    overlay.dataset.textEditPageRevision = String(context.revision);
  };
  if (context.nativeAuthoritative) {
    try {
      const { publishNativeTextCandidatePreview } = await import('./native-text-candidate-preview.js');
      const publication = await publishNativeTextCandidatePreview(context);
      if (publication?.status === 'published') await publishOverlay();
      return publication;
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  try {
    await publishOverlay();
    return {
      status: 'published',
      stamp: Object.freeze({
        kind: 'model-overlay',
        mountGeneration: context.surface.mountGeneration,
        contentRevision: context.token.contentRevision,
        pageRevision: context.revision,
      }),
    };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

async function defaultSemanticPublisher(context) {
  const { publishOwnerAwareTextProjections } = await import('./text-layer.js');
  return publishOwnerAwareTextProjections({
    documentState: context.documentState,
    pageNum: context.pageNum,
    revision: context.revision,
    editRevision: context.editRevision,
    textLayer: context.surface?.textLayer || null,
  });
}

/** Build one publication coordinator with injectable boundaries for race tests. */
export function createTextEditPublicationCoordinator({
  resolveSurface = resolvePageSurface,
  captureToken = captureRenderPublicationToken,
  tokenIsCurrent = renderPublicationTokenIsCurrent,
  publishBase = defaultBasePublisher,
  publishSemantics = defaultSemanticPublisher,
  markSurface = markPageSurfacePublication,
  markLayerReady = markPageEditLayerReady,
  markRenderReady = markPageRenderReady,
  markSemanticReady = markPageSemanticReady,
  subscribeSurface = subscribePageSurfaceRegistry,
  surfaceWaitTimeoutMs = 1500,
} = {}) {
  const pending = new Map();

  const clearPending = (key) => {
    const entry = pending.get(key);
    if (!entry) return false;
    entry.unsubscribe?.();
    pending.delete(key);
    return true;
  };

  const matches = (surface, documentState, pageNum, revision) => Boolean(surface
    && surface.documentId === String(documentState.id)
    && Number(surface.lifecycleGeneration) === (Number(documentState.lifecycleGeneration) || 0)
    && Number(surface.pageNum) === Number(pageNum)
    && Number(surface.pageContentRevision) <= Number(revision));

  const waitForSurfaceUpdate = (
    documentState,
    pageNum,
    revision,
    previousSurface,
  ) => new Promise((resolve) => {
    let settled = false;
    let unsubscribe = null;
    let timer = null;
    const finish = (surface) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(surface);
    };
    unsubscribe = subscribeSurface((event) => {
      if (!['registered', 'updated'].includes(event?.type)) return;
      if (event.surface !== previousSurface
          && matches(event.surface, documentState, pageNum, revision)
          && event.surface.textLayer) finish(event.surface);
    });
    timer = setTimeout(() => finish(null), Math.max(1, Number(surfaceWaitTimeoutMs) || 1));
    timer?.unref?.();
    // Close the register-before-subscribe race by resolving once after the
    // listener is installed. A valid exact layer can be retried immediately.
    const current = resolveSurface(documentState, pageNum, { targetRevision: revision });
    if (current !== previousSurface
        && matches(current, documentState, pageNum, revision)
        && current.textLayer) finish(current);
  });

  const queuePending = (input, token) => {
    const key = pendingKey(input.documentState, input.pageNum, token.publishedPageRevision);
    if (pending.has(key)) return;
    const entry = { input: { ...input, expectedVisible: false }, token, unsubscribe: null };
    entry.unsubscribe = subscribeSurface((event) => {
      if (!['registered', 'updated'].includes(event?.type)
          || !matches(
            event.surface,
            input.documentState,
            input.pageNum,
            token.publishedPageRevision,
          )) return;
      // Remove before retry so another legitimate defer can install a fresh
      // listener instead of leaving a listener-free pending entry behind.
      clearPending(key);
      void publish(entry.input);
    });
    pending.set(key, entry);
  };

  const publish = async ({
    documentState,
    pageNum,
    editId = null,
    editRevision = null,
    expectedVisible = true,
    nativeAuthoritative = false,
  } = {}) => {
    if (!documentState?.id) throw new TypeError('Committed text publication requires a document owner');
    const revision = pageRevision(documentState, pageNum);
    const token = captureToken(documentState, pageNum, 'committed-text-edit', {
      revisionAuthority: 'model',
      publishedPageRevision: revision,
    });
    if (!tokenIsCurrent(token, documentState)) return resultFor(token, 'superseded');
    let surface = resolveSurface(documentState, pageNum, { targetRevision: revision });
    const input = {
      documentState,
      pageNum,
      editId,
      editRevision,
      expectedVisible,
      nativeAuthoritative,
    };
    if (!surface) {
      queuePending(input, token);
      return expectedVisible
        ? resultFor(token, 'failed', {
          errorCode: 'PAGE_SURFACE_MISSING',
          error: 'The actively edited page surface is not mounted',
          surfaceKind: 'deferred',
        })
        : resultFor(token, 'deferred-unmounted');
    }
    const context = {
      ...input,
      token,
      revision,
      surface,
    };
    let [base, semantics] = await Promise.all([
      publishBase(context),
      publishSemantics(context),
    ]);
    if (semantics?.status === 'deferred-unmounted') {
      const replacement = await waitForSurfaceUpdate(
        documentState,
        pageNum,
        revision,
        surface,
      );
      if (replacement && tokenIsCurrent(token, documentState)) {
        surface = replacement;
        context.surface = replacement;
        semantics = await publishSemantics(context);
      }
    }
    if (!tokenIsCurrent(token, documentState)
        || base?.status === 'superseded' || semantics?.status === 'superseded') {
      return resultFor(token, 'superseded');
    }
    if (base?.status === 'deferred-unmounted' && !expectedVisible) {
      queuePending(input, token);
      return resultFor(token, 'deferred-unmounted', {
        semanticPublished: semantics?.status === 'published',
        semanticStamp: semantics?.stamp || null,
        surfaceKind: 'deferred',
      });
    }
    if (base?.status !== 'published') {
      return resultFor(token, 'failed', {
        errorCode: 'PAGE_BASE_PUBLICATION_FAILED',
        error: base?.error || base?.status || 'Page base publication failed',
        semanticPublished: semantics?.status === 'published',
        semanticStamp: semantics?.stamp || null,
        surfaceKind: surface.surfaceKind,
      });
    }
    if (semantics?.status !== 'published') {
      if (!expectedVisible && semantics?.status === 'deferred-unmounted') {
        queuePending(input, token);
        return resultFor(token, 'deferred-unmounted', {
          visiblePublished: true,
          baseStamp: base.stamp || null,
          surfaceKind: 'deferred',
        });
      }
      return resultFor(token, 'failed', {
        errorCode: 'PAGE_SEMANTIC_PUBLICATION_FAILED',
        error: semantics?.error || semantics?.status || 'Page semantic publication failed',
        visiblePublished: true,
        baseStamp: base.stamp || null,
        surfaceKind: base.surfaceKind || surface.surfaceKind,
      });
    }
    if (!markSurface(surface, {
      documentState,
      revision,
      basePublished: true,
      semanticPublished: true,
      baseSurface: base.surface || surface.baseSurface,
      textLayer: semantics.textLayer || surface.textLayer,
      surfaceKind: base.surfaceKind || surface.surfaceKind,
    })) {
      return resultFor(token, 'superseded');
    }
    for (const layer of PAGE_EDIT_READY_LAYERS) {
      markLayerReady(documentState, pageNum, layer, token);
    }
    markRenderReady(documentState, pageNum, revision);
    markSemanticReady(documentState, pageNum, revision);
    clearPending(pendingKey(documentState, pageNum, revision));
    return resultFor(token, 'published', {
      visiblePublished: true,
      semanticPublished: true,
      baseStamp: base.stamp || null,
      semanticStamp: semantics.stamp || null,
      surfaceKind: base.surfaceKind || surface.surfaceKind,
    });
  };

  return Object.freeze({
    publish,
    pendingSnapshot() {
      return Object.freeze([...pending.values()].map((entry) => Object.freeze({
        documentId: entry.token.documentId,
        lifecycleGeneration: entry.token.lifecycleGeneration,
        pageNum: entry.token.pageNum,
        pageRevision: entry.token.publishedPageRevision,
      })));
    },
    cancelDocument(documentId, lifecycleGeneration = null) {
      const id = String(documentId || '');
      const generation = lifecycleGeneration == null
        ? null : Number(lifecycleGeneration) || 0;
      let cancelled = 0;
      for (const [key, entry] of pending) {
        if (entry.token.documentId !== id
            || (generation !== null && entry.token.lifecycleGeneration !== generation)) continue;
        clearPending(key);
        cancelled += 1;
      }
      return cancelled;
    },
    dispose() {
      for (const key of [...pending.keys()]) clearPending(key);
    },
  });
}

const committedTextPublicationCoordinator = createTextEditPublicationCoordinator();

export function publishCommittedTextEdit(input) {
  return committedTextPublicationCoordinator.publish(input);
}

export function pendingCommittedTextPublicationSnapshot() {
  return committedTextPublicationCoordinator.pendingSnapshot();
}

export function cancelCommittedTextPublicationsForDocument(
  documentId,
  lifecycleGeneration = null,
) {
  return committedTextPublicationCoordinator.cancelDocument(documentId, lifecycleGeneration);
}
