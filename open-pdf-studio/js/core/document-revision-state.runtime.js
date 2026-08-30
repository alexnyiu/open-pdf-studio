const SAVE_STATES = /* @__PURE__ */ new Set([
  "idle",
  "pending",
  "saving",
  "persisted",
  "synchronizing",
  "saved",
  "failed",
  "saved-refresh-failed"
]);
function revision(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return normalized;
}
function pageNumber(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new RangeError("Page numbers must be positive safe integers");
  }
  return normalized;
}
function normalizedRevisionMap(value) {
  const result = {};
  if (!value || typeof value !== "object") return result;
  for (const [rawPage, rawRevision] of Object.entries(value)) {
    const page = pageNumber(rawPage);
    result[page] = revision(rawRevision, `page ${page} revision`);
  }
  return result;
}
function normalizedPages(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(pageNumber))].sort((left, right) => left - right);
}
function createInitialDocumentRevisionState() {
  return {
    contentRevision: 0,
    serializedRevision: 0,
    persistedRevision: 0,
    livePdfRevision: 0,
    visibleRenderRevision: 0,
    visibleSemanticRevision: 0,
    pageContentRevisions: {},
    pageRenderReadyRevisions: {},
    pageSemanticReadyRevisions: {},
    visibleRequiredPages: [],
    pendingChangedPages: [],
    pendingStructuralChange: false,
    lastMutationReason: null,
    saveState: "idle",
    activeSaveRequestId: null,
    lastPersistedPath: null,
    lastSaveError: null,
    lastSynchronizationError: null
  };
}
function initializeDocumentRevisionState(documentState) {
  if (!documentState) throw new TypeError("Document state is required");
  const initial = createInitialDocumentRevisionState();
  const existing = documentState.revisionState;
  // Every live document is created with the complete revision contract. Keep
  // reads of that already-canonical state side-effect free: status/debug
  // accessors run inside Solid computations, where rewriting the same proxy
  // fields can recursively invalidate the computation during a tab switch.
  if (existing && typeof existing === "object"
      && Object.keys(initial).every((key) => Object.prototype.hasOwnProperty.call(existing, key))
      && documentState.pageRenderRevisions === existing.pageContentRevisions) {
    assertDocumentRevisionState(documentState);
    return existing;
  }
  if (!existing || typeof existing !== "object") {
    const legacyPages = normalizedRevisionMap(documentState.pageRenderRevisions);
    initial.pageContentRevisions = legacyPages;
    documentState.revisionState = initial;
  } else {
    const normalized = {
      ...initial,
      ...existing,
      contentRevision: revision(existing.contentRevision ?? 0, "contentRevision"),
      serializedRevision: revision(existing.serializedRevision ?? 0, "serializedRevision"),
      persistedRevision: revision(existing.persistedRevision ?? 0, "persistedRevision"),
      livePdfRevision: revision(existing.livePdfRevision ?? 0, "livePdfRevision"),
      visibleRenderRevision: revision(existing.visibleRenderRevision ?? 0, "visibleRenderRevision"),
      visibleSemanticRevision: revision(existing.visibleSemanticRevision ?? 0, "visibleSemanticRevision"),
      pageContentRevisions: normalizedRevisionMap(
        existing.pageContentRevisions ?? documentState.pageRenderRevisions
      ),
      pageRenderReadyRevisions: normalizedRevisionMap(existing.pageRenderReadyRevisions),
      pageSemanticReadyRevisions: normalizedRevisionMap(existing.pageSemanticReadyRevisions),
      visibleRequiredPages: normalizedPages(existing.visibleRequiredPages),
      pendingChangedPages: existing.pendingChangedPages === null ? null : normalizedPages(existing.pendingChangedPages),
      pendingStructuralChange: existing.pendingStructuralChange === true,
      lastMutationReason: existing.lastMutationReason == null ? null : String(existing.lastMutationReason),
      saveState: SAVE_STATES.has(existing.saveState) ? existing.saveState : "idle",
      activeSaveRequestId: existing.activeSaveRequestId == null ? null : String(existing.activeSaveRequestId),
      lastPersistedPath: existing.lastPersistedPath == null ? null : String(existing.lastPersistedPath),
      lastSaveError: existing.lastSaveError == null ? null : String(existing.lastSaveError),
      lastSynchronizationError: existing.lastSynchronizationError == null ? null : String(existing.lastSynchronizationError)
    };
    Object.assign(existing, normalized);
    documentState.revisionState = existing;
  }
  documentState.pageRenderRevisions = documentState.revisionState.pageContentRevisions;
  assertDocumentRevisionState(documentState);
  return documentState.revisionState;
}
function knownPages(documentState, state) {
  const result = /* @__PURE__ */ new Set();
  const count = Number(documentState?.pdfDoc?.numPages) || 0;
  for (let page = 1; page <= count; page += 1) result.add(page);
  for (const source of [
    state.pageContentRevisions,
    state.pageRenderReadyRevisions,
    state.pageSemanticReadyRevisions,
    documentState?.pageRotations,
    documentState?.pageDims
  ]) {
    if (!source || typeof source !== "object") continue;
    for (const key of Object.keys(source)) result.add(pageNumber(key));
  }
  if (Number.isSafeInteger(documentState?.currentPage) && documentState.currentPage > 0) {
    result.add(documentState.currentPage);
  }
  return [...result].sort((left, right) => left - right);
}
function recomputeVisibleReadiness(state) {
  const required = state.visibleRequiredPages;
  if (required.length === 0) {
    state.visibleRenderRevision = 0;
    state.visibleSemanticRevision = 0;
    return;
  }
  state.visibleRenderRevision = Math.min(
    ...required.map((page) => state.pageRenderReadyRevisions[page] ?? 0)
  );
  state.visibleSemanticRevision = Math.min(
    ...required.map((page) => state.pageSemanticReadyRevisions[page] ?? 0)
  );
}
function targetPageRevision(state, page) {
  return Object.prototype.hasOwnProperty.call(state.pageContentRevisions, page)
    ? state.pageContentRevisions[page] : state.contentRevision;
}
function assertDocumentRevisionState(documentState) {
  const state = documentState?.revisionState;
  if (!state || typeof state !== "object") throw new TypeError("Document revision state is required");
  for (const name of [
    "contentRevision",
    "serializedRevision",
    "persistedRevision",
    "livePdfRevision",
    "visibleRenderRevision",
    "visibleSemanticRevision"
  ]) revision(state[name], name);
  if (state.serializedRevision > state.contentRevision) {
    throw new RangeError("serializedRevision cannot exceed contentRevision");
  }
  if (state.persistedRevision > state.serializedRevision) {
    throw new RangeError("persistedRevision cannot exceed serializedRevision");
  }
  if (state.livePdfRevision > state.persistedRevision) {
    throw new RangeError("livePdfRevision cannot exceed persistedRevision");
  }
  if (state.visibleRenderRevision > state.contentRevision) {
    throw new RangeError("visibleRenderRevision cannot exceed contentRevision");
  }
  if (state.visibleSemanticRevision > state.contentRevision) {
    throw new RangeError("visibleSemanticRevision cannot exceed contentRevision");
  }
  for (const mapName of ["pageRenderReadyRevisions", "pageSemanticReadyRevisions"]) {
    for (const value of Object.values(state[mapName] || {})) {
      if (revision(value, `${mapName} value`) > state.contentRevision) {
        throw new RangeError(`${mapName} cannot contain a revision newer than contentRevision`);
      }
    }
  }
  if (!SAVE_STATES.has(state.saveState)) throw new TypeError(`Unsupported saveState: ${state.saveState}`);
  return state;
}
function noteDocumentMutation(documentState, {
  pages = [],
  structural = false,
  reason
}) {
  if (!reason) throw new TypeError("A committed document mutation requires a reason");
  const state = initializeDocumentRevisionState(documentState);
  const changedPages = structural ? knownPages(documentState, state) : normalizedPages(pages);
  const nextRevision = state.contentRevision + 1;
  state.contentRevision = nextRevision;
  state.lastMutationReason = String(reason);
  // A durable failure remains visible while the user continues working. The
  // next save attempt clears it at the explicit `saving` transition; an
  // unrelated mutation must not turn a failed automatic save into a generic
  // pending state and erase its exact diagnostic.
  if (state.saveState !== "failed" && state.saveState !== "saved-refresh-failed") {
    state.saveState = "pending";
    state.lastSaveError = null;
  }
  for (const page of changedPages) {
    state.pageContentRevisions[page] = nextRevision;
    delete state.pageRenderReadyRevisions[page];
    delete state.pageSemanticReadyRevisions[page];
  }
  if (structural || changedPages.length === 0) {
    documentState.pageEditReadiness = {};
  } else if (documentState.pageEditReadiness) {
    for (const page of changedPages) delete documentState.pageEditReadiness[page];
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function"
      && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("opds:page-edit-readiness-cleared", {
      detail: {
        documentId: String(documentState.id || ""),
        lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
        contentRevision: nextRevision,
        pages: structural || changedPages.length === 0 ? null : [...changedPages]
      }
    }));
  }
  if (structural) {
    state.pendingStructuralChange = true;
    state.pendingChangedPages = null;
    state.pageRenderReadyRevisions = {};
    state.pageSemanticReadyRevisions = {};
    documentState.pageGeometryIndex = null;
    documentState.pageGeometryBaseDimensions = null;
    documentState.pageGeometryRevision = null;
  } else if (changedPages.length === 0) {
    state.pendingChangedPages = null;
  } else if (state.pendingChangedPages !== null) {
    state.pendingChangedPages = normalizedPages([...state.pendingChangedPages, ...changedPages]);
  }
  recomputeVisibleReadiness(state);
  documentState.pageRenderRevisions = state.pageContentRevisions;
  documentState.modified = true;
  assertDocumentRevisionState(documentState);
  return nextRevision;
}
function markRevisionSerialized(documentState, requestedRevision) {
  const state = initializeDocumentRevisionState(documentState);
  const next = revision(requestedRevision, "serialized revision");
  if (next > state.contentRevision) throw new RangeError("Cannot serialize a future content revision");
  state.serializedRevision = Math.max(state.serializedRevision, next);
  state.saveState = "saving";
  assertDocumentRevisionState(documentState);
  return state.serializedRevision;
}
function markRevisionPersisted(documentState, requestedRevision, path) {
  const state = initializeDocumentRevisionState(documentState);
  const next = revision(requestedRevision, "persisted revision");
  if (next > state.serializedRevision) throw new RangeError("Cannot persist an unserialized revision");
  if (next < state.persistedRevision) throw new RangeError("Cannot move persistedRevision backward");
  state.persistedRevision = next;
  state.lastPersistedPath = String(path || "");
  state.saveState = "persisted";
  state.lastSaveError = null;
  assertDocumentRevisionState(documentState);
  return state.persistedRevision;
}
function markLivePdfRevision(documentState, requestedRevision) {
  const state = initializeDocumentRevisionState(documentState);
  const next = revision(requestedRevision, "live PDF revision");
  if (next > state.persistedRevision) throw new RangeError("Cannot install an unpersisted live PDF revision");
  if (next < state.livePdfRevision) throw new RangeError("Cannot move livePdfRevision backward");
  state.livePdfRevision = next;
  state.saveState = "synchronizing";
  state.lastSynchronizationError = null;
  assertDocumentRevisionState(documentState);
  return state.livePdfRevision;
}
function setVisibleRequiredPages(documentState, pages) {
  const state = initializeDocumentRevisionState(documentState);
  state.visibleRequiredPages = normalizedPages(pages);
  recomputeVisibleReadiness(state);
  assertDocumentRevisionState(documentState);
  return [...state.visibleRequiredPages];
}
function clearPageReadiness(documentState, pages = null) {
  const state = initializeDocumentRevisionState(documentState);
  const targets = pages === null ? null : normalizedPages(pages);
  if (targets === null) {
    state.pageRenderReadyRevisions = {};
    state.pageSemanticReadyRevisions = {};
  } else {
    for (const page of targets) {
      delete state.pageRenderReadyRevisions[page];
      delete state.pageSemanticReadyRevisions[page];
    }
  }
  recomputeVisibleReadiness(state);
}
function markPageRenderReady(documentState, page, requestedRevision) {
  const state = initializeDocumentRevisionState(documentState);
  const pageNum = pageNumber(page);
  const next = revision(requestedRevision, "page render-ready revision");
  if (next > state.contentRevision) throw new RangeError("Page render readiness cannot exceed contentRevision");
  state.pageRenderReadyRevisions[pageNum] = next;
  recomputeVisibleReadiness(state);
  assertDocumentRevisionState(documentState);
  return next;
}
function markPageSemanticReady(documentState, page, requestedRevision) {
  const state = initializeDocumentRevisionState(documentState);
  const pageNum = pageNumber(page);
  const next = revision(requestedRevision, "page semantic-ready revision");
  if (next > state.contentRevision) throw new RangeError("Page semantic readiness cannot exceed contentRevision");
  state.pageSemanticReadyRevisions[pageNum] = next;
  recomputeVisibleReadiness(state);
  assertDocumentRevisionState(documentState);
  return next;
}
function markDocumentSaveState(documentState, saveState, {
  requestId,
  saveError,
  synchronizationError
} = {}) {
  const state = initializeDocumentRevisionState(documentState);
  if (!SAVE_STATES.has(saveState)) throw new TypeError(`Unsupported saveState: ${saveState}`);
  state.saveState = saveState;
  if (requestId !== void 0) state.activeSaveRequestId = requestId == null ? null : String(requestId);
  if (saveError !== void 0) state.lastSaveError = saveError == null ? null : String(saveError);
  if (synchronizationError !== void 0) {
    state.lastSynchronizationError = synchronizationError == null ? null : String(synchronizationError);
  }
  if (saveState === "saving" || saveState === "saved") {
    documentState.saveRefreshRetryFailed = false;
  }
  return state.saveState;
}
function documentHasRevisionPersistenceDebt(documentState) {
  const state = initializeDocumentRevisionState(documentState);
  return state.contentRevision > state.persistedRevision;
}
function documentProxyRevisionSynchronized(documentState) {
  const state = initializeDocumentRevisionState(documentState);
  return state.contentRevision === state.persistedRevision
    && state.persistedRevision === state.livePdfRevision;
}
function documentNeedsSynchronization(documentState) {
  const state = initializeDocumentRevisionState(documentState);
  if (!documentProxyRevisionSynchronized(documentState)) return true;
  if (state.saveState === "saved-refresh-failed" || state.saveState === "synchronizing") return true;
  if (state.activeSaveRequestId || state.saveState === "saving" || state.saveState === "persisted") return true;
  if (state.visibleRequiredPages.length === 0) return false;
  return state.visibleRequiredPages.some((page) => {
    const target = targetPageRevision(state, page);
    return (state.pageRenderReadyRevisions[page] ?? -1) < target
      || (state.pageSemanticReadyRevisions[page] ?? -1) < target;
  });
}
function documentIsEditReady(documentState, page) {
  const state = initializeDocumentRevisionState(documentState);
  const pageNum = pageNumber(page);
  if (state.saveState === "failed" || state.saveState === "saved-refresh-failed" || state.saveState === "saving" || state.saveState === "persisted" || state.saveState === "synchronizing") return false;
  return documentRevisionReadinessSatisfied(documentState, pageNum);
}
function documentRevisionReadinessSatisfied(documentState, page) {
  const state = initializeDocumentRevisionState(documentState);
  const pageNum = pageNumber(page);
  const target = targetPageRevision(state, pageNum);
  return Object.prototype.hasOwnProperty.call(state.pageRenderReadyRevisions, pageNum)
    && Object.prototype.hasOwnProperty.call(state.pageSemanticReadyRevisions, pageNum)
    && state.pageRenderReadyRevisions[pageNum] === target
    && state.pageSemanticReadyRevisions[pageNum] === target;
}
function documentRevisionDebugSnapshot(documentState) {
  const state = initializeDocumentRevisionState(documentState);
  return Object.freeze({
    documentId: String(documentState.id || ""),
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    contentRevision: state.contentRevision,
    serializedRevision: state.serializedRevision,
    persistedRevision: state.persistedRevision,
    livePdfRevision: state.livePdfRevision,
    visibleRenderRevision: state.visibleRenderRevision,
    visibleSemanticRevision: state.visibleSemanticRevision,
    pageContentRevisions: { ...state.pageContentRevisions },
    pageRenderReadyRevisions: { ...state.pageRenderReadyRevisions },
    pageSemanticReadyRevisions: { ...state.pageSemanticReadyRevisions },
    saveState: state.saveState,
    activeSaveRequestId: state.activeSaveRequestId,
    lastSaveError: state.lastSaveError,
    lastSynchronizationError: state.lastSynchronizationError
  });
}
export {
  assertDocumentRevisionState,
  clearPageReadiness,
  createInitialDocumentRevisionState,
  documentHasRevisionPersistenceDebt,
  documentIsEditReady,
  documentRevisionReadinessSatisfied,
  documentNeedsSynchronization,
  documentProxyRevisionSynchronized,
  documentRevisionDebugSnapshot,
  initializeDocumentRevisionState,
  markDocumentSaveState,
  markLivePdfRevision,
  markPageRenderReady,
  markPageSemanticReady,
  markRevisionPersisted,
  markRevisionSerialized,
  noteDocumentMutation,
  setVisibleRequiredPages
};
