import { getPendingOcrTextItems } from '../ocr/document-state.js';
import { publishPageModelRevision } from '../text/text-edit-publication.js';
import { renderPublicationTokenIsCurrent } from './render-publication-token.js';

const REQUIRED_RENDERER_LAYERS = Object.freeze([
  'raster',
  'annotations',
  'text',
  'links',
  'forms',
]);

function result(status, { terminalFailure = false, error = null, publication = null } = {}) {
  return Object.freeze({ status, terminalFailure, error, publication });
}

/**
 * Pending searchable OCR changes semantics but not the visible page raster.
 * Once the complete current proxy surface has rendered, acknowledge that
 * installed surface at the model revision so edit readiness does not wait for
 * PDF bytes that intentionally do not exist until Save.
 */
export async function publishPendingOcrReadiness({
  documentState,
  pageNum,
  publicationToken,
  completedLayers,
  pendingItemsForPage = getPendingOcrTextItems,
  publishModelRevision = publishPageModelRevision,
  tokenIsCurrent = renderPublicationTokenIsCurrent,
} = {}) {
  const isCurrent = () => tokenIsCurrent(publicationToken, documentState);
  if (!isCurrent()) return result('superseded');
  if (documentState?.revisionState?.saveState === 'synchronizing') {
    return result('not-required');
  }
  if (!REQUIRED_RENDERER_LAYERS.every((layer) => completedLayers?.has?.(layer))) {
    return result('incomplete');
  }

  const targetRevision = Number(
    documentState?.revisionState?.pageContentRevisions?.[pageNum]
      ?? documentState?.revisionState?.contentRevision,
  ) || 0;
  const livePdfRevision = Number(documentState?.revisionState?.livePdfRevision) || 0;
  if (targetRevision <= livePdfRevision
      || pendingItemsForPage(documentState, pageNum).length === 0) {
    return result('not-required');
  }

  let publication;
  try {
    publication = await publishModelRevision({
      documentState,
      pageNum,
      expectedPageRevision: targetRevision,
      expectedVisible: true,
      publicationSource: 'pending-ocr-page',
    });
  } catch (error) {
    if (!isCurrent()) return result('superseded');
    return result('failed', { terminalFailure: true, error });
  }
  if (!isCurrent() || publication?.status === 'superseded') {
    return result('superseded', { publication });
  }
  if (publication?.status !== 'published') {
    const error = publication?.error
      || `Pending OCR page publication ended with ${publication?.status || 'an invalid result'}`;
    return result('failed', { terminalFailure: true, error, publication });
  }
  return result('published', { publication });
}

