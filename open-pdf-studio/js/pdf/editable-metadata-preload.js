import { getActiveDocument } from '../core/state.js';
import { groupNativeTextFragments } from '../text/native-text-blocks.js';
import { matchNativeTextSources } from '../text/native-text-matching.js';
import {
  clearNativeTextSourceCache,
  discardNativeTextSourcePages,
  inspectNativeTextSourcesForPages,
} from '../text/native-text-provenance.js';
import { BoundedPdfPreloadController, directionalPreloadPages } from './pdf-preload-controller.js';
import { isThumbnailPipelineIdle } from '../ui/panels/left-panel.js';
import { isPdfForegroundIdle } from './foreground-activity.js';
import { backgroundRenderAdmissionAllowed } from './render-resource-budget.js';

const controllers = new WeakMap();

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

function controllerFor(doc) {
  let controller = controllers.get(doc);
  if (controller) return controller;
  controller = new BoundedPdfPreloadController({
    maxPages: doc.performanceProfile?.largeDocument ? 9 : 50,
    maxBytes: Math.max(8 * 1024 * 1024, Math.floor(
      (doc.performanceProfile?.budget?.metadataBytes || 32 * 1024 * 1024) * 0.8,
    )),
    isIdle: () => isPdfForegroundIdle() && backgroundRenderAdmissionAllowed() && isThumbnailPipelineIdle(),
    log: (event) => {
      logPreload(event);
      if (event.type === 'eviction') discardNativeTextSourcePages(doc, [event.page]);
    },
    beforeLoad: (pages) => inspectNativeTextSourcesForPages(pages),
    load: async (pageNum) => {
      const [page, sourceMaps] = await Promise.all([
        doc.pdfDoc.getPage(pageNum),
        inspectNativeTextSourcesForPages([pageNum]),
      ]);
      const textContent = await page.getTextContent();
      const sourceMap = sourceMaps.get(pageNum) || null;
      const value = { textContent, sourceMap, blocks: pureBlocks(textContent, sourceMap) };
      return { value, bytes: byteEstimate(textContent, sourceMap) };
    },
  });
  controllers.set(doc, controller);
  return controller;
}

export function getPrefetchedEditableMetadata(pageNum, doc = getActiveDocument()) {
  return doc ? controllerFor(doc).get(pageNum) : null;
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
  return controllerFor(doc).schedule(pages, { protectedPages: [centerPage] });
}

export async function preloadEditableMetadataPage(doc, pageNum) {
  if (!doc?.pdfDoc || pageNum < 1 || pageNum > doc.pdfDoc.numPages) return null;
  const controller = controllerFor(doc);
  await controller.schedule([pageNum], { protectedPages: [doc.currentPage, pageNum] });
  const value = controller.get(pageNum);
  const bytes = value ? byteEstimate(value.textContent, value.sourceMap) : 0;
  return value ? { value, bytes } : null;
}

export function releaseEditableMetadataPage(doc, pageNum) {
  controllers.get(doc)?.delete(pageNum);
  discardNativeTextSourcePages(doc, [pageNum]);
}

export function clearEditableMetadataPreload(doc = getActiveDocument()) {
  const controller = doc && controllers.get(doc);
  controller?.clear();
  clearNativeTextSourceCache(doc);
  if (doc) controllers.delete(doc);
}
