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
  isDirty = () => false,
  commit,
  cancel,
}) {
  return registry.register({
    ownerDocumentId,
    ownerDocumentGeneration,
    pageNum,
    kind,
    isDirty,
    commit,
    cancel,
  });
}

export function getActiveTextEditSession() {
  return registry.active();
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

export async function applyActiveTextEditing() {
  return registry.applyActive();
}

export function textEditSessionOwnerIsCurrent(session = registry.active()) {
  return registry.ownerIsCurrent(session);
}
