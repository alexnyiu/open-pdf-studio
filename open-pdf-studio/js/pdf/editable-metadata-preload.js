import { getActiveDocument } from '../core/state.js';
import { groupNativeTextFragments } from '../text/native-text-blocks.js';
import { matchNativeTextSources } from '../text/native-text-matching.js';
import {
  captureNativeTextSourceRevision,
  clearNativeTextSourceCache,
  discardNativeTextSourcePages,
  inspectNativeTextSourcesForPages,
  nativeTextSourceRevisionIsCurrent,
} from '../text/native-text-provenance.js';
import { BoundedPdfPreloadController, directionalPreloadPages } from './pdf-preload-controller.js';
import { adoptEditableMetadataController } from './editable-metadata-adoption.js';
import { isThumbnailPipelineIdle } from '../ui/panels/left-panel.js';
import { isPdfForegroundIdle } from './foreground-activity.js';
import { backgroundRenderAdmissionAllowed } from './render-resource-budget.js';
import {
  captureRenderPublicationToken,
  recordRejectedRenderPublication,
  renderPublicationTokenIsCurrent,
} from './render-publication-token.js';

const controllers = new WeakMap();

export const captureEditableMetadataRevision = captureNativeTextSourceRevision;
export const editableMetadataRevisionIsCurrent = nativeTextSourceRevisionIsCurrent;

function byteEstimate(textContent, sourceMap) {
  const text = (textContent?.items || []).reduce((sum, item) => sum + String(item.str || '').length * 2 + 96, 0);
  return text + JSON.stringify(sourceMap || {}).length * 2;
}

function pureBlocks(textContent, sourceMap) {
  const matches = matchNativeTextSources(textContent?.items || [], sourceMap?.runs || []);
  const fragments = (textContent?.items || []).flatMap((item, index) => {
    if (!String(item.str || '').trim() || !Array.isArray(item.transform)) return [];
    const fontSize = Math.hypot(item.transform[2], item.transform[3]);
    return [{
      itemIndex: index,
      text: item.str,
      sourceText: (matches.get(index) || []).map((source) => source.decodedText || '').join(''),
      pdfX: item.transform[4], pdfY: item.transform[5], pdfWidth: Number(item.width) || 0, fontSize,
      domLeft: item.transform[4], domTop: item.transform[5] - fontSize,
      domRight: item.transform[4] + (Number(item.width) || 0), domBottom: item.transform[5],
    }];
  });
  return groupNativeTextFragments(fragments);
}

function logPreload(event) {
  const detail = Object.entries(event).map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value) : value}`).join(' ');
  console.log(`[PERF-PRELOAD] ${detail}`);
}

function expectedRevisionMatches(expectedRevision, doc) {
  if (!expectedRevision) return true;
  return String(doc?.id || '') === String(expectedRevision.documentId || '')
    && (Number(doc?.lifecycleGeneration) || 0)
      === (Number(expectedRevision.lifecycleGeneration) || 0)
    && doc?.pdfDoc === expectedRevision.pdfDocument
    && (Number(doc?.revisionState?.contentRevision) || 0)
      === (Number(expectedRevision.contentRevision) || 0)
    && (expectedRevision.livePdfRevision === undefined
      || (Number(doc?.revisionState?.livePdfRevision) || 0)
        === (Number(expectedRevision.livePdfRevision) || 0));
}

function metadataLoader(doc, revisionIdentity) {
  return async (pageNum) => {
    const publicationToken = captureRenderPublicationToken(doc, pageNum, 'editable-metadata');
    const isCurrent = () => editableMetadataRevisionIsCurrent(revisionIdentity, doc)
      && renderPublicationTokenIsCurrent(publicationToken, doc);
    const [page, sourceMaps] = await Promise.all([
      doc.pdfDoc.getPage(pageNum),
      inspectNativeTextSourcesForPages([pageNum], doc, revisionIdentity),
    ]);
    if (!isCurrent()) {
      discardNativeTextSourcePages(doc, [pageNum]);
      recordRejectedRenderPublication(publicationToken, 'metadata-after-source-extraction');
      return null;
    }
    const textContent = await page.getTextContent();
    if (!isCurrent()) {
      discardNativeTextSourcePages(doc, [pageNum]);
      recordRejectedRenderPublication(publicationToken, 'metadata-after-text-extraction');
      return null;
    }
    const sourceMap = sourceMaps.get(pageNum) || null;
    const value = {
      textContent,
      sourceMap,
      blocks: pureBlocks(textContent, sourceMap),
      revisionIdentity,
    };
    if (!isCurrent()) {
      discardNativeTextSourcePages(doc, [pageNum]);
      recordRejectedRenderPublication(publicationToken, 'metadata-before-cache-insertion');
      return null;
    }
    return { value, bytes: byteEstimate(textContent, sourceMap) };
  };
}

function controllerFor(doc, expectedRevision = null) {
  if (!doc?.pdfDoc || !expectedRevisionMatches(expectedRevision, doc)) return null;
  const revisionIdentity = captureEditableMetadataRevision(doc);
  let record = controllers.get(doc);
  if (record && editableMetadataRevisionIsCurrent(record.revisionIdentity, doc)) {
    return record.controller;
  }
  record?.controller?.clear();
  clearNativeTextSourceCache(doc);
  const controller = new BoundedPdfPreloadController({
    maxPages: doc.performanceProfile?.largeDocument ? 9 : 50,
    maxBytes: Math.max(8 * 1024 * 1024, Math.floor(
      (doc.performanceProfile?.budget?.metadataBytes || 32 * 1024 * 1024) * 0.8,
    )),
    isIdle: () => isPdfForegroundIdle() && backgroundRenderAdmissionAllowed() && isThumbnailPipelineIdle(),
    log: (event) => {
      logPreload(event);
      if (event.type === 'eviction') discardNativeTextSourcePages(doc, [event.page]);
    },
    load: metadataLoader(doc, revisionIdentity),
  });
  controllers.set(doc, { controller, revisionIdentity });
  return controller;
}

export function getPrefetchedEditableMetadata(pageNum, doc = getActiveDocument()) {
  const controller = doc ? controllerFor(doc) : null;
  return controller?.get(pageNum) || null;
}

export function scheduleEditableMetadataPreload(centerPage, direction = 1, { editTextActive = false } = {}) {
  const doc = getActiveDocument();
  if (!doc?.pdfDoc) return Promise.resolve();
  const pages = directionalPreloadPages(centerPage, doc.pdfDoc.numPages, direction);
  if (!editTextActive) {
    // Navigation still warms text/provenance, while operator-list/font
    // resolution remains reserved for the foreground editable page.
  } else {
    void doc.pdfDoc.getPage(centerPage).then((page) => page.getOperatorList()).catch(() => {});
  }
  const controller = controllerFor(doc);
  return controller
    ? controller.schedule(pages, { protectedPages: [centerPage] })
    : Promise.resolve();
}

export async function preloadEditableMetadataPage(
  doc,
  pageNum,
  expectedRevision = captureEditableMetadataRevision(doc),
) {
  if (!doc?.pdfDoc || pageNum < 1 || pageNum > doc.pdfDoc.numPages) return null;
  if (!expectedRevisionMatches(expectedRevision, doc)) return null;
  const controller = controllerFor(doc, expectedRevision);
  if (!controller) return null;
  await controller.loadNow(pageNum, { protectedPages: [doc.currentPage, pageNum] });
  if (!expectedRevisionMatches(expectedRevision, doc)) return null;
  const value = controller.get(pageNum);
  const bytes = value ? byteEstimate(value.textContent, value.sourceMap) : 0;
  return value ? { value, bytes } : null;
}

export function releaseEditableMetadataPage(doc, pageNum) {
  controllers.get(doc)?.controller?.delete(pageNum);
  discardNativeTextSourcePages(doc, [pageNum]);
}

export function clearEditableMetadataPreload(doc = getActiveDocument()) {
  const record = doc && controllers.get(doc);
  record?.controller?.clear();
  clearNativeTextSourceCache(doc);
  if (doc) controllers.delete(doc);
}

/**
 * Move resolved unchanged metadata to a validated replacement proxy. Pending
 * work is cancelled and changed pages are discarded before the loader is
 * rebound to the new PDF.js owner.
 */
export function adoptEditableMetadataPreloadRevision(doc, changedPages = []) {
  const record = doc && controllers.get(doc);
  if (!record) return false;
  const revisionIdentity = captureEditableMetadataRevision(doc);
  return adoptEditableMetadataController(record, {
    revisionIdentity,
    changedPages,
    load: metadataLoader(doc, revisionIdentity),
  });
}

export function editableMetadataPreloadSnapshotForTests(doc) {
  const record = doc && controllers.get(doc);
  return Object.freeze({
    revisionIdentity: record?.revisionIdentity || null,
    active: Boolean(record?.controller),
  });
}
