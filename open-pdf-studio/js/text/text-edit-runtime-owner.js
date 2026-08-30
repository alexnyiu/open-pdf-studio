/**
 * Annotation drafts are assigned through Solid's mutable store and may be
 * exposed as reactive proxies. Runtime ownership must therefore use only the
 * immutable editor tuple, never object identity for the draft annotation.
 */
export function textEditRuntimeOwnerIsCurrent({
  isEditing,
  activeSession,
  session,
  mountOwner,
}) {
  if (isEditing !== true || !activeSession || !session || !mountOwner) return false;
  return activeSession.sessionId === session.sessionId
    && activeSession.ownerDocumentId === session.ownerDocumentId
    && activeSession.ownerDocumentGeneration === session.ownerDocumentGeneration
    && mountOwner.sessionId === session.sessionId
    && mountOwner.documentId === session.ownerDocumentId
    && mountOwner.documentGeneration === session.ownerDocumentGeneration;
}
