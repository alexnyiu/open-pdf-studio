let requestSequence = 0;
const stalePublicationCounts = new Map();
const activeRenderTasks = new Map();
const MAX_DIAGNOSTIC_KEYS = 64;

function nonNegativeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export function captureRenderPublicationToken(
  documentState,
  pageNum,
  source = 'render',
  { revisionAuthority = 'proxy', publishedPageRevision = null } = {},
) {
  if (!documentState?.id || !documentState.pdfDoc) {
    throw new TypeError('A render publication token requires a document owner and PDF proxy');
  }
  const page = Number(pageNum);
  if (!Number.isSafeInteger(page) || page < 1) throw new RangeError('Render page must be one-based');
  const targetPageRevision = nonNegativeRevision(
    documentState.revisionState?.pageContentRevisions?.[page]
      ?? documentState.pageRenderRevisions?.[page]
      ?? documentState.revisionState?.contentRevision,
  );
  const livePdfRevision = nonNegativeRevision(documentState.revisionState?.livePdfRevision);
  const authority = revisionAuthority === 'model' ? 'model' : 'proxy';
  const publicationRevision = publishedPageRevision == null
    ? authority === 'model' ? targetPageRevision : Math.min(targetPageRevision, livePdfRevision)
    : nonNegativeRevision(publishedPageRevision);
  if (publicationRevision > targetPageRevision) {
    throw new RangeError('A render publication cannot exceed the current page revision');
  }
  if (authority === 'proxy' && publicationRevision > livePdfRevision) {
    throw new RangeError('A proxy publication cannot exceed the live PDF revision');
  }
  requestSequence += 1;
  return Object.freeze({
    requestId: `render-${requestSequence.toString(36)}`,
    source: String(source || 'render'),
    documentId: String(documentState.id),
    lifecycleGeneration: nonNegativeRevision(documentState.lifecycleGeneration),
    pdfDocument: documentState.pdfDoc,
    contentRevision: nonNegativeRevision(documentState.revisionState?.contentRevision),
    livePdfRevision,
    pageRevision: targetPageRevision,
    publishedPageRevision: publicationRevision,
    revisionAuthority: authority,
    pageNum: page,
  });
}

export function renderPublicationTokenIsCurrent(token, documentState) {
  if (!token || !documentState) return false;
  return String(documentState.id) === token.documentId
    && nonNegativeRevision(documentState.lifecycleGeneration) === token.lifecycleGeneration
    && documentState.pdfDoc === token.pdfDocument
    && nonNegativeRevision(documentState.revisionState?.contentRevision) === token.contentRevision
    && nonNegativeRevision(documentState.revisionState?.livePdfRevision) === token.livePdfRevision
    && nonNegativeRevision(
      documentState.revisionState?.pageContentRevisions?.[token.pageNum]
      ?? documentState.pageRenderRevisions?.[token.pageNum]
      ?? documentState.revisionState?.contentRevision,
    ) === token.pageRevision;
}

export function recordRejectedRenderPublication(token, reason = 'stale') {
  if (!token) return;
  const key = `${token.source}:${reason}`;
  if (!stalePublicationCounts.has(key) && stalePublicationCounts.size >= MAX_DIAGNOSTIC_KEYS) {
    stalePublicationCounts.delete(stalePublicationCounts.keys().next().value);
  }
  stalePublicationCounts.set(key, (stalePublicationCounts.get(key) || 0) + 1);
  if (typeof window !== 'undefined') {
    window.__renderPublicationDebug = Object.freeze({
      at: Date.now(),
      requestId: token.requestId,
      source: token.source,
      documentId: token.documentId,
      lifecycleGeneration: token.lifecycleGeneration,
      contentRevision: token.contentRevision,
      pageRevision: token.pageRevision,
      pageNum: token.pageNum,
      reason,
      rejectedCounts: Object.freeze(Object.fromEntries(stalePublicationCounts)),
    });
  }
}

function taskMapFor(documentId) {
  let tasks = activeRenderTasks.get(documentId);
  if (!tasks) {
    tasks = new Map();
    activeRenderTasks.set(documentId, tasks);
  }
  return tasks;
}

export function trackPdfJsRenderTask(token, documentState, renderTask) {
  if (!renderTask?.promise || !token) return renderTask;
  if (!renderPublicationTokenIsCurrent(token, documentState)) {
    try { renderTask.cancel?.(); } catch {}
    recordRejectedRenderPublication(token, 'stale-before-task-registration');
    return renderTask;
  }
  const tasks = taskMapFor(token.documentId);
  const entry = { token, documentState, renderTask, watchTimer: null };
  if (typeof setInterval === 'function') {
    entry.watchTimer = setInterval(() => {
      if (renderPublicationTokenIsCurrent(token, documentState)) return;
      try { renderTask.cancel?.(); } catch {}
      clearInterval(entry.watchTimer);
      entry.watchTimer = null;
      tasks.delete(token.requestId);
      if (tasks.size === 0) activeRenderTasks.delete(token.documentId);
      recordRejectedRenderPublication(token, 'revision-changed');
    }, 25);
    entry.watchTimer?.unref?.();
  }
  tasks.set(token.requestId, entry);
  void Promise.resolve(renderTask.promise).catch(() => {}).finally(() => {
    if (entry.watchTimer) clearInterval(entry.watchTimer);
    if (tasks.get(token.requestId)?.renderTask === renderTask) tasks.delete(token.requestId);
    if (tasks.size === 0) activeRenderTasks.delete(token.documentId);
  });
  return renderTask;
}

export function cancelStalePdfJsRenderTasks(documentState, reason = 'revision-changed') {
  if (!documentState?.id) return 0;
  const tasks = activeRenderTasks.get(String(documentState.id));
  if (!tasks) return 0;
  let cancelled = 0;
  for (const [requestId, entry] of tasks) {
    if (renderPublicationTokenIsCurrent(entry.token, documentState)) continue;
    try { entry.renderTask?.cancel?.(); } catch {}
    if (entry.watchTimer) clearInterval(entry.watchTimer);
    tasks.delete(requestId);
    cancelled += 1;
    recordRejectedRenderPublication(entry.token, reason);
  }
  if (tasks.size === 0) activeRenderTasks.delete(String(documentState.id));
  return cancelled;
}

export function cancelPdfJsRenderTasksForDocument(documentId, reason = 'document-cancelled') {
  const id = String(documentId || '');
  const tasks = activeRenderTasks.get(id);
  if (!tasks) return 0;
  let cancelled = 0;
  for (const entry of tasks.values()) {
    try { entry.renderTask?.cancel?.(); } catch {}
    if (entry.watchTimer) clearInterval(entry.watchTimer);
    cancelled += 1;
    recordRejectedRenderPublication(entry.token, reason);
  }
  activeRenderTasks.delete(id);
  return cancelled;
}

export function releaseStaleRenderResult(result) {
  try { result?.bitmap?.close?.(); } catch {}
  try { result?.close?.(); } catch {}
  try { result?.revoke?.(); } catch {}
  try { result?.cancel?.(); } catch {}
}

export function publishRenderResultIfCurrent({
  token,
  documentState,
  result,
  publish,
  release = releaseStaleRenderResult,
  reason = 'stale-before-publication',
}) {
  if (renderPublicationTokenIsCurrent(token, documentState)) {
    publish(result, token);
    return true;
  }
  release(result, token);
  recordRejectedRenderPublication(token, reason);
  return false;
}

export function renderPublicationDiagnosticsSnapshot() {
  return Object.freeze({
    rejectedCounts: Object.freeze(Object.fromEntries(stalePublicationCounts)),
    activePdfJsTasks: [...activeRenderTasks.values()]
      .reduce((sum, tasks) => sum + tasks.size, 0),
  });
}

export function clearRenderPublicationDiagnosticsForTests() {
  stalePublicationCounts.clear();
  for (const tasks of activeRenderTasks.values()) {
    for (const entry of tasks.values()) if (entry.watchTimer) clearInterval(entry.watchTimer);
  }
  activeRenderTasks.clear();
}
