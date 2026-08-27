/**
 * Immutable ownership for one text-layer render request.
 *
 * Single-page layers also bind to the visible page. Continuous layers remain
 * valid while scrolling changes currentPage because each page has its own
 * container and request generation.
 */
export function captureTextLayerOwner(documentState, pageNum) {
  if (!documentState?.id || !Number.isSafeInteger(Number(pageNum))) return null;
  return Object.freeze({
    documentId: String(documentState.id),
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    pageNum: Number(pageNum),
    viewMode: documentState.viewMode || 'single',
  });
}

export function textLayerOwnerMatchesDocument(owner, documentState) {
  if (!owner || !documentState
      || String(documentState.id) !== owner.documentId
      || (Number(documentState.lifecycleGeneration) || 0) !== owner.lifecycleGeneration
      || (documentState.viewMode || 'single') !== owner.viewMode) return false;
  return owner.viewMode !== 'single'
    || Number(documentState.currentPage) === owner.pageNum;
}

export function stampTextLayerOwner(element, owner, requestGeneration = null) {
  if (!element?.dataset || !owner) return false;
  element.dataset.documentId = owner.documentId;
  element.dataset.documentGeneration = String(owner.lifecycleGeneration);
  element.dataset.page = String(owner.pageNum);
  element.dataset.viewMode = owner.viewMode;
  if (requestGeneration != null) {
    element.dataset.textLayerRequest = String(requestGeneration);
  }
  return true;
}

export function textLayerElementMatchesOwner(element, owner) {
  if (!element?.dataset || !owner) return false;
  return element.dataset.documentId === owner.documentId
    && Number(element.dataset.documentGeneration) === owner.lifecycleGeneration
    && Number(element.dataset.page) === owner.pageNum
    && element.dataset.viewMode === owner.viewMode;
}

/** Resolve only the owner-stamped layer inside the active page container. */
export function findTextLayerForOwner(container, owner) {
  if (!container?.querySelectorAll || !owner) return null;
  return [...container.querySelectorAll('.textLayer')]
    .find((element) => textLayerElementMatchesOwner(element, owner)) || null;
}

/** Latest-only request registry, scoped independently to each page container. */
export function createTextLayerRequestRegistry() {
  let epoch = 0;
  let nextGeneration = 0;
  const currentByContainer = new WeakMap();

  return {
    begin(container, owner) {
      if (!container || !owner) return null;
      const generation = ++nextGeneration;
      currentByContainer.set(container, generation);
      return Object.freeze({ container, owner, epoch, generation });
    },

    invalidateContainer(container) {
      if (!container) return false;
      currentByContainer.delete(container);
      return true;
    },

    invalidateAll() {
      epoch += 1;
    },

    isCurrent(request, documentState) {
      return Boolean(
        request
          && request.epoch === epoch
          && currentByContainer.get(request.container) === request.generation
          && textLayerOwnerMatchesDocument(request.owner, documentState),
      );
    },
  };
}
