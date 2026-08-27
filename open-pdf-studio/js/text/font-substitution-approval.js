import { getActiveDocument, getDocumentById } from '../core/state.js';
import { openDialog } from '../solid/stores/dialogStore.js';
import { proposeFontSubstitution, resolvePackagedFace } from './font-catalog.js';
import {
  ensureFontSubstitutionApprovalMap,
  fontSubstitutionApprovalKey,
  normalizeFontSubstitutionSources,
} from './font-substitution-approval-state.js';

export { fontSubstitutionApprovalKey } from './font-substitution-approval-state.js';

const approvalQueue = [];
let activeApprovalRequest = null;

function sameDocumentOwner(documentId, lifecycleGeneration) {
  const documentState = getDocumentById(documentId);
  const activeDocument = getActiveDocument();
  return documentState
    && documentState === activeDocument
    && (Number(documentState.lifecycleGeneration) || 0) === lifecycleGeneration
    ? documentState
    : null;
}

function openNextApprovalRequest() {
  if (activeApprovalRequest || approvalQueue.length === 0) return;
  const request = approvalQueue.shift();
  if (!sameDocumentOwner(request.documentId, request.lifecycleGeneration)) {
    request.resolve({ approved: false, remember: false, stale: true });
    queueMicrotask(openNextApprovalRequest);
    return;
  }
  activeApprovalRequest = request;
  openDialog('font-substitution', {
    ownerDocumentId: request.documentId,
    ownerDocumentGeneration: request.lifecycleGeneration,
    sourceFonts: request.sourceFonts,
    substituteFamily: request.substituteFamily,
    sampleText: request.sampleText,
    scope: request.scope,
    resolve(decision) {
      if (activeApprovalRequest !== request) return;
      activeApprovalRequest = null;
      request.resolve(decision);
      queueMicrotask(openNextApprovalRequest);
    },
  });
}

function enqueueApprovalRequest(request) {
  return new Promise((resolve) => {
    approvalQueue.push({ ...request, resolve });
    openNextApprovalRequest();
  });
}

/**
 * Request explicit approval for a packaged font substitute.
 *
 * Returns an approved persistence record, or null when rejected/stale. The
 * optional remembered decision is stored only on the supplied open document.
 */
export async function requestFontSubstitutionApproval({
  documentState,
  sourceFonts,
  bold = false,
  italic = false,
  sampleText = '',
  scope = 'paragraph',
}) {
  if (!documentState) return null;
  const documentId = documentState.id;
  const lifecycleGeneration = Number(documentState.lifecycleGeneration) || 0;
  if (!sameDocumentOwner(documentId, lifecycleGeneration)) return null;

  const normalizedSources = normalizeFontSubstitutionSources(sourceFonts);
  const face = resolvePackagedFace(normalizedSources[0], bold, italic);
  if (!face) return null;
  const proposed = proposeFontSubstitution(normalizedSources[0], bold, italic);
  const approvalKey = fontSubstitutionApprovalKey({
    sourceFonts: normalizedSources,
    faceId: proposed.faceId,
  });
  const approvalMap = ensureFontSubstitutionApprovalMap(documentState);

  let decision = { approved: true, remember: false };
  if (approvalMap.get(approvalKey) !== true) {
    decision = await enqueueApprovalRequest({
      documentId,
      lifecycleGeneration,
      sourceFonts: normalizedSources,
      substituteFamily: face.family,
      sampleText: String(sampleText || ''),
      scope,
    });
  }
  const currentOwner = sameDocumentOwner(documentId, lifecycleGeneration);
  if (!decision?.approved || !currentOwner) return null;
  if (decision.remember) currentOwner.fontSubstitutionApprovals.set(approvalKey, true);
  return {
    ...proposed,
    approved: true,
    approvedAt: new Date().toISOString(),
  };
}
