import { getDocumentById } from '../core/state.js';
import { createTextEditSessionRegistry } from './text-edit-session-registry.js';

const registry = createTextEditSessionRegistry(getDocumentById);

/**
 * Register the one application-wide transient text editor.
 * Registration is synchronous so tab/view transitions can tear it down before
 * changing active-document state.
 */
export function registerTextEditSession({
  ownerDocumentId,
  ownerDocumentGeneration,
  pageNum,
  kind,
  targetIdentity = null,
  isDirty = () => false,
  commit,
  cancel,
}) {
  return registry.register({
    ownerDocumentId,
    ownerDocumentGeneration,
    pageNum,
    kind,
    targetIdentity,
    isDirty,
    commit,
    cancel,
  });
}

export function getActiveTextEditSession() {
  return registry.active();
}

export function textEditSessionDiagnostics() {
  return registry.diagnostics();
}

export function completeTextEditSession(sessionId) {
  registry.complete(sessionId);
}

export function cancelActiveTextEditing(reason = 'cancelled') {
  return registry.cancelActive(reason);
}

export function cancelTextEditingForDocument(documentId, reason = 'document-transition') {
  return registry.cancelForDocument(documentId, reason);
}

/** Return whether the immutable owner currently has an uncommitted text draft. */
export function isTextEditingDirtyForDocument(documentId) {
  return registry.isDirtyForDocument(documentId);
}

export async function applyActiveTextEditing(reason = 'apply') {
  return registry.applyActive(reason);
}

/**
 * Commit the active draft for one immutable document owner before a command
 * such as Save serializes document state. Concurrent callers share the same
 * in-flight commit and a document with no live draft is already ready.
 */
export function commitTextEditingForDocument(documentId, reason = 'document-command') {
  return registry.commitForDocument(documentId, reason);
}

export function textEditSessionOwnerIsCurrent(session = registry.active()) {
  return registry.ownerIsCurrent(session);
}
