import { isTauri, invoke } from '../core/platform.js';
import { PageGeometryIndex, pageGeometryEntries } from './page-geometry-index.js';
import { createPdfPerformanceProfile } from './render-performance.js';
import { configureRenderResourceBudget } from './render-resource-budget.js';

const profilePromises = new WeakMap();

function contentRevision(documentState) {
  return Number(documentState?.revisionState?.contentRevision) || 0;
}

function ownerMatches(documentState, generation, pdfDocument, expectedContentRevision) {
  return documentState?.pdfDoc === pdfDocument
    && (Number(documentState.lifecycleGeneration) || 0) === generation
    && contentRevision(documentState) === Number(expectedContentRevision || 0);
}

function geometryRevisionMatches(documentState) {
  const identity = documentState?.pageGeometryRevision;
  return Boolean(identity
    && identity.documentId === String(documentState.id)
    && identity.pdfDocument === documentState.pdfDoc
    && identity.lifecycleGeneration === (Number(documentState.lifecycleGeneration) || 0)
    && identity.contentRevision === contentRevision(documentState));
}

function stampGeometryRevision(documentState) {
  documentState.pageGeometryRevision = Object.freeze({
    documentId: String(documentState.id),
    pdfDocument: documentState.pdfDoc,
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    contentRevision: contentRevision(documentState),
  });
}

async function systemMemoryBytes() {
  if (!isTauri()) return null;
  try {
    const result = await invoke('get_system_memory_info');
    return Number(result?.physicalMemoryBytes) || null;
  } catch {
    return null;
  }
}

async function pageDimensions(documentState) {
  const count = Number(documentState?.pdfDoc?.numPages) || 0;
  if (!count) return { dimensions: [], complete: true };
  if (isTauri() && documentState.filePath) {
    try {
      const dimensions = await invoke('get_page_dimensions', { path: documentState.filePath });
      if (Array.isArray(dimensions) && dimensions.length === count) {
        return { dimensions, complete: true };
      }
    } catch (error) {
      console.warn('[performance] Native page geometry unavailable:', error?.message || error);
    }
  }
  const stored = documentState.pageDims || {};
  if (Object.keys(stored).length === count) {
    return { dimensions: Array.from({ length: count }, (_, index) => {
      const page = stored[index + 1];
      return [page?.widthPt || 612, page?.heightPt || 792];
    }), complete: true };
  }
  // Browser/blank-document fallback stays bounded: use the current page as a
  // provisional geometry instead of serially calling getPage() for every page.
  const pageNum = Math.min(count, Math.max(1, Number(documentState.currentPage) || 1));
  const page = await documentState.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  return {
    dimensions: Array.from({ length: count }, () => [viewport.width, viewport.height]),
    complete: false,
  };
}

async function refinePageDimensionsIncrementally(
  documentState,
  generation,
  pdfDocument,
  expectedContentRevision,
) {
  const dimensions = documentState.pageGeometryBaseDimensions?.slice();
  if (!dimensions || dimensions.length !== pdfDocument.numPages) return;
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum += 1) {
    if (!ownerMatches(documentState, generation, pdfDocument, expectedContentRevision)) return;
    try {
      const page = await pdfDocument.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      dimensions[pageNum - 1] = [viewport.width, viewport.height];
    } catch { /* keep the provisional dimensions for an unreadable page */ }
    if (pageNum % 8 === 0 || pageNum === pdfDocument.numPages) {
      if (!ownerMatches(documentState, generation, pdfDocument, expectedContentRevision)) return;
      documentState.pageGeometryBaseDimensions = dimensions.slice();
      rebuildDocumentPageGeometryIndex(documentState);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('opds:page-geometry-refined', {
          detail: { documentId: documentState.id, lifecycleGeneration: generation, throughPage: pageNum },
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

export function seedDocumentPerformanceProfile(documentState, fileBytes = 0) {
  if (!documentState?.pdfDoc) return null;
  documentState.sourceByteLength = Math.max(0, Number(fileBytes) || documentState.sourceByteLength || 0);
  documentState.performanceProfile = createPdfPerformanceProfile({
    pageCount: documentState.pdfDoc.numPages,
    fileBytes: documentState.sourceByteLength,
  });
  return documentState.performanceProfile;
}

export async function registerDocumentRenderCacheOwners(documentState) {
  if (!documentState?.filePath || !documentState.id) return;
  const [bitmaps, vectors, tiles, pageTypes] = await Promise.all([
    import('./page-bitmap-cache.js'),
    import('./vector-renderer.js'),
    import('./tile-cache.js'),
    import('./page-type-cache.js'),
  ]);
  const readContentRevision = () => contentRevision(documentState);
  const readPageRevision = (pageNum) => Number(documentState.pageRenderRevisions?.[pageNum]) || 0;
  bitmaps.registerPageBitmapCacheOwner(
    documentState.filePath,
    documentState.id,
    documentState.lifecycleGeneration,
    readPageRevision,
    readContentRevision,
  );
  vectors.registerVectorCacheOwner(
    documentState.filePath,
    documentState.id,
    documentState.lifecycleGeneration,
    readContentRevision,
    readPageRevision,
  );
  tiles.registerTileCacheOwner(
    documentState.filePath,
    documentState.id,
    documentState.lifecycleGeneration,
    readContentRevision,
    readPageRevision,
  );
  pageTypes.registerPageTypeCacheOwner(
    documentState.filePath,
    documentState.id,
    documentState.lifecycleGeneration,
    readContentRevision,
    readPageRevision,
  );
}

export function initializeDocumentPerformance(documentState, { fileBytes = 0 } = {}) {
  if (!documentState?.pdfDoc) return Promise.resolve(null);
  if (profilePromises.has(documentState)) return profilePromises.get(documentState);
  seedDocumentPerformanceProfile(documentState, fileBytes);
  const generation = Number(documentState.lifecycleGeneration) || 0;
  const pdfDocument = documentState.pdfDoc;
  const expectedContentRevision = contentRevision(documentState);
  const promise = Promise.all([systemMemoryBytes(), pageDimensions(documentState)])
    .then(async ([physicalMemoryBytes, geometryResult]) => {
      if (!ownerMatches(documentState, generation, pdfDocument, expectedContentRevision)) return null;
      const dimensions = geometryResult.dimensions;
      documentState.pageGeometryBaseDimensions = dimensions.map((dimension) => [
        Number(dimension?.widthPt ?? dimension?.[0]) || 612,
        Number(dimension?.heightPt ?? dimension?.[1]) || 792,
      ]);
      const entries = pageGeometryEntries(dimensions, documentState.pageRotations);
      documentState.pageGeometryIndex = new PageGeometryIndex(entries);
      stampGeometryRevision(documentState);
      documentState.pageDims = Object.fromEntries(entries.map((entry) => [entry.pageNum, {
        widthPt: entry.widthPt,
        heightPt: entry.heightPt,
        rotation: entry.applicationRotation,
      }]));
      documentState.performanceProfile = createPdfPerformanceProfile({
        pageCount: pdfDocument.numPages,
        fileBytes: documentState.sourceByteLength,
        physicalMemoryBytes,
        pageDimensions: entries,
      });
      configureRenderResourceBudget(documentState.performanceProfile.budget, documentState.id);
      await registerDocumentRenderCacheOwners(documentState);
      if (isTauri()) {
        try {
          await invoke('configure_render_resource_budget', {
            nativePixmapBytes: documentState.performanceProfile.budget.nativePixmapBytes,
          });
        } catch (error) {
          console.warn('[performance] Native render budget could not be configured:', error?.message || error);
        }
      }
      if (ownerMatches(documentState, generation, pdfDocument, expectedContentRevision)) {
        window.dispatchEvent(new CustomEvent('opds:performance-profile-ready', {
          detail: {
            documentId: documentState.id,
            lifecycleGeneration: generation,
            largeDocument: documentState.performanceProfile.largeDocument,
          },
        }));
        if (!geometryResult.complete) {
          void refinePageDimensionsIncrementally(
            documentState,
            generation,
            pdfDocument,
            expectedContentRevision,
          );
        }
        return documentState.performanceProfile;
      }
      return null;
    })
    .finally(() => {
      if (profilePromises.get(documentState) === promise) profilePromises.delete(documentState);
    });
  profilePromises.set(documentState, promise);
  return promise;
}

export async function ensureDocumentPageGeometryIndex(documentState) {
  if (documentState?.pageGeometryIndex && geometryRevisionMatches(documentState)) {
    return documentState.pageGeometryIndex;
  }
  clearDocumentPerformance(documentState);
  await initializeDocumentPerformance(documentState, { fileBytes: documentState?.sourceByteLength });
  return documentState?.pageGeometryIndex || null;
}

export function rebuildDocumentPageGeometryIndex(documentState) {
  if (!documentState?.pdfDoc) return null;
  const count = documentState.pdfDoc.numPages;
  const dimensions = documentState.pageGeometryBaseDimensions?.length === count
    ? documentState.pageGeometryBaseDimensions
    : Array.from({ length: count }, (_, index) => {
      const stored = documentState.pageDims?.[index + 1];
      return [stored?.widthPt || 612, stored?.heightPt || 792];
    });
  documentState.pageGeometryIndex = new PageGeometryIndex(pageGeometryEntries(dimensions, documentState.pageRotations));
  stampGeometryRevision(documentState);
  return documentState.pageGeometryIndex;
}

export function clearDocumentPerformance(documentState) {
  profilePromises.delete(documentState);
  if (!documentState) return;
  documentState.performanceProfile = null;
  documentState.pageGeometryIndex = null;
  documentState.pageGeometryBaseDimensions = null;
  documentState.pageGeometryRevision = null;
}
