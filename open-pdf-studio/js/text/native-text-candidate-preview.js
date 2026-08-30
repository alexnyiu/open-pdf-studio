const MAX_CANDIDATE_RASTER_AXIS_PX = 4096;
const latestCandidates = new Map();

function ownerKey(documentState) {
  return `${String(documentState?.id || '')}:${Number(documentState?.lifecycleGeneration) || 0}`;
}

function candidateKey(documentState, revision) {
  return `${ownerKey(documentState)}:${Number(revision) || 0}`;
}

function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${label} must be positive`);
  return number;
}

/** Compute a DPR-aware whole-page raster without exceeding the 4096 px cap. */
export function nativeTextCandidateRasterPlan({
  pageWidthPt,
  pageHeightPt,
  cssScale,
  dpr,
  maxAxisPx = MAX_CANDIDATE_RASTER_AXIS_PX,
} = {}) {
  const width = positive(pageWidthPt, 'Candidate page width');
  const height = positive(pageHeightPt, 'Candidate page height');
  const scale = positive(cssScale, 'Candidate CSS scale');
  const pixelRatio = positive(dpr, 'Candidate device pixel ratio');
  const axisCap = Math.max(1, Math.floor(positive(maxAxisPx, 'Candidate raster cap')));
  const requestedRenderScale = scale * pixelRatio;
  const capScale = axisCap / Math.max(width, height);
  const renderScale = Math.min(requestedRenderScale, capScale);
  return Object.freeze({
    pageWidthPt: width,
    pageHeightPt: height,
    cssScale: scale,
    dpr: pixelRatio,
    requestedRenderScale,
    renderScale,
    effectiveDpr: renderScale / scale,
    capped: renderScale + 1e-9 < requestedRenderScale,
    cssWidth: width * scale,
    cssHeight: height * scale,
    backingWidth: Math.min(axisCap, Math.max(1, Math.ceil(width * renderScale))),
    backingHeight: Math.min(axisCap, Math.max(1, Math.ceil(height * renderScale))),
    maxAxisPx: axisCap,
  });
}

export function latestNativeTextCandidate(documentState, revision = null) {
  const prefix = `${ownerKey(documentState)}:`;
  if (revision != null) return latestCandidates.get(candidateKey(documentState, revision)) || null;
  return [...latestCandidates.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, candidate]) => candidate)
    .sort((left, right) => right.revision - left.revision)[0] || null;
}

export function clearNativeTextCandidates(documentState = null) {
  if (!documentState) {
    latestCandidates.clear();
    return;
  }
  const prefix = `${ownerKey(documentState)}:`;
  for (const key of latestCandidates.keys()) {
    if (key.startsWith(prefix)) latestCandidates.delete(key);
  }
}

function storeLatestCandidate(documentState, candidate) {
  const owner = ownerKey(documentState);
  for (const key of latestCandidates.keys()) {
    if (key.startsWith(`${owner}:`) && key !== candidateKey(documentState, candidate.revision)) {
      latestCandidates.delete(key);
    }
  }
  latestCandidates.set(candidateKey(documentState, candidate.revision), candidate);
  return candidate;
}

async function sourceBytesFor(documentState) {
  const [{ getCachedPdfBytes }, platform] = await Promise.all([
    import('../pdf/loader.js'),
    import('../core/platform.js'),
  ]);
  const memoryKey = `__memory__${documentState.id}`;
  let bytes = documentState.filePath ? getCachedPdfBytes(documentState.filePath) : null;
  bytes ||= getCachedPdfBytes(memoryKey);
  if (!bytes && documentState.filePath) bytes = await platform.readBinaryFile(documentState.filePath);
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw Object.assign(new Error('The source PDF bytes are unavailable for text preview'), {
      code: 'TEXT_PREVIEW_SOURCE_BYTES_MISSING',
    });
  }
  return bytes;
}

async function buildNativeTextCandidate(context) {
  const existing = latestNativeTextCandidate(context.documentState, context.revision);
  if (existing) return existing;
  const [snapshotModule, textSaver, pdfLib] = await Promise.all([
    import('../pdf/save-document-snapshot.js'),
    import('../pdf/saver/text-edits.js'),
    import('pdf-lib'),
  ]);
  const documentState = context.documentState;
  const snapshot = snapshotModule.createSaveDocumentSnapshot({
    documentState,
    outputPath: documentState.filePath || `__memory__${documentState.id}`,
    requestedRevision: context.revision,
    expectedDocumentGeneration: documentState.lifecycleGeneration,
  });
  const nativeResult = await textSaver.applyNativeTextEditsToBytes(
    await sourceBytesFor(documentState),
    snapshot,
  );
  const pdfDocument = await pdfLib.PDFDocument.load(nativeResult.pdfBytes, {
    updateMetadata: false,
  });
  const manifest = await textSaver.saveTextEditsToPages(
    pdfDocument,
    pdfDocument.getPages(),
    snapshot,
    nativeResult.updatedRecords,
  );
  const candidateBytes = new Uint8Array(await pdfDocument.save());
  const candidate = Object.freeze({
    documentId: String(documentState.id),
    lifecycleGeneration: Number(documentState.lifecycleGeneration) || 0,
    revision: Number(context.revision) || 0,
    pageCount: snapshot.pageCount,
    candidateBytes,
    updatedRecords: Object.freeze(nativeResult.updatedRecords.map((record) => Object.freeze(record))),
    textEditManifest: manifest,
    nativeReport: nativeResult.report || null,
  });
  return storeLatestCandidate(documentState, candidate);
}

async function openCandidate(candidate) {
  const { preparePdfJsSaveCandidate } = await import('../ocr/pdf-persistence.js');
  return preparePdfJsSaveCandidate(candidate.candidateBytes, candidate.pageCount);
}

async function destroyCandidateDocument(documentState) {
  const { destroyPreparedPdfJsDocument } = await import('../ocr/pdf-persistence.js');
  await destroyPreparedPdfJsDocument(documentState);
}

async function tokenCurrent(token, documentState) {
  const { renderPublicationTokenIsCurrent } = await import('../pdf/render-publication-token.js');
  return renderPublicationTokenIsCurrent(token, documentState);
}

async function resolveSurface(documentState, pageNum, options) {
  const { resolvePageSurface } = await import('../pdf/page-surface-registry.js');
  return resolvePageSurface(documentState, pageNum, options);
}

async function pageRotation(documentState, pageNum) {
  const { getPageRotationForDocument } = await import('../core/state.js');
  return Number(getPageRotationForDocument(documentState, pageNum)) || 0;
}

function createCanvas() {
  return document.createElement('canvas');
}

function sameMountedSurface(current, previous) {
  return Boolean(current && previous
    && current.documentId === previous.documentId
    && current.lifecycleGeneration === previous.lifecycleGeneration
    && current.pageNum === previous.pageNum
    && current.mountGeneration === previous.mountGeneration
    && current.container === previous.container
    && Math.abs(current.cssScale - previous.cssScale) < 1e-9
    && Math.abs(current.dpr - previous.dpr) < 1e-9);
}

function stampCanvas(canvas, context, plan) {
  canvas.dataset.textEditCandidateBitmap = 'true';
  canvas.dataset.documentId = String(context.documentState.id);
  canvas.dataset.documentGeneration = String(context.documentState.lifecycleGeneration || 0);
  canvas.dataset.page = String(context.pageNum);
  canvas.dataset.contentRevision = String(context.token.contentRevision);
  canvas.dataset.pageRevision = String(context.revision);
  canvas.dataset.renderScale = String(plan.renderScale);
}

function swapContinuousCandidate(surface, canvas, plan) {
  const container = surface.container;
  if (!container?.appendChild) return null;
  const previous = container.querySelector?.('.text-edit-authoritative-preview') || null;
  canvas.className = 'text-edit-authoritative-preview';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = `${plan.cssWidth}px`;
  canvas.style.height = `${plan.cssHeight}px`;
  canvas.style.zIndex = '1';
  canvas.style.pointerEvents = 'none';
  canvas.style.background = 'white';
  if (surface.overlayCanvas?.style && !surface.overlayCanvas.style.zIndex) {
    surface.overlayCanvas.style.zIndex = '3';
  }
  container.appendChild(canvas);
  if (previous && previous !== canvas) previous.remove?.();
  return canvas;
}

async function publishSingleViewport(context, bitmap, plan) {
  const { publishViewportAuthoritativeTextPreview } = await import('../pdf/pdf-viewport.js');
  return publishViewportAuthoritativeTextPreview({
    documentState: context.documentState,
    pageNum: context.pageNum,
    revision: context.revision,
    bitmap,
    renderScale: plan.renderScale,
  });
}

/** Build the real native candidate, render its affected page, then swap it. */
export function createNativeTextCandidatePreviewPublisher({
  getCandidate = buildNativeTextCandidate,
  openCandidateDocument = openCandidate,
  destroyDocument = destroyCandidateDocument,
  isTokenCurrent = tokenCurrent,
  resolvePage = resolveSurface,
  getRotation = pageRotation,
  makeCanvas = createCanvas,
  publishSingle = publishSingleViewport,
  swapContinuous = swapContinuousCandidate,
} = {}) {
  return async function publish(context) {
    let candidateDocument = null;
    let bitmap = null;
    try {
      const candidate = await getCandidate(context);
      if (!await isTokenCurrent(context.token, context.documentState)) {
        return {
          status: 'superseded',
          errorCode: 'NATIVE_PREVIEW_TOKEN_STALE_AFTER_CANDIDATE',
          error: 'The document revision changed while building the native text candidate',
        };
      }
      candidateDocument = await openCandidateDocument(candidate);
      const page = await candidateDocument.getPage(context.pageNum);
      const rotation = ((Number(page.rotate) || 0)
        + (Number(await getRotation(context.documentState, context.pageNum)) || 0)) % 360;
      const unitViewport = page.getViewport({ scale: 1, rotation });
      const plan = nativeTextCandidateRasterPlan({
        pageWidthPt: unitViewport.width,
        pageHeightPt: unitViewport.height,
        cssScale: context.surface.cssScale,
        dpr: context.surface.dpr,
      });
      const renderViewport = page.getViewport({ scale: plan.renderScale, rotation });
      bitmap = makeCanvas();
      bitmap.width = plan.backingWidth;
      bitmap.height = plan.backingHeight;
      stampCanvas(bitmap, context, plan);
      const canvasContext = bitmap.getContext?.('2d', { alpha: false });
      if (!canvasContext) throw new Error('Candidate preview canvas is unavailable');
      await page.render({ canvasContext, viewport: renderViewport, annotationMode: 0 }).promise;
      if (!await isTokenCurrent(context.token, context.documentState)) {
        return {
          status: 'superseded',
          errorCode: 'NATIVE_PREVIEW_TOKEN_STALE_AFTER_RENDER',
          error: 'The document revision changed while rendering the native text candidate',
        };
      }
      const current = await resolvePage(context.documentState, context.pageNum, {
        targetRevision: context.revision,
      });
      if (!current) return { status: 'deferred-unmounted' };
      if (!sameMountedSurface(current, context.surface)) {
        return {
          status: 'superseded',
          errorCode: 'NATIVE_PREVIEW_SURFACE_CHANGED',
          error: [
            'The mounted page surface changed while rendering the native text candidate',
            `before=${Number(context.surface?.mountGeneration) || 0}`,
            `after=${Number(current.mountGeneration) || 0}`,
            `beforeScale=${Number(context.surface?.cssScale) || 0}`,
            `afterScale=${Number(current.cssScale) || 0}`,
            `beforeDpr=${Number(context.surface?.dpr) || 0}`,
            `afterDpr=${Number(current.dpr) || 0}`,
          ].join('; '),
        };
      }

      let publishedSurface;
      let surfaceKind;
      if (String(current.surfaceKind).startsWith('single-page')) {
        publishedSurface = await publishSingle(context, bitmap, plan);
        surfaceKind = 'single-viewport';
      } else {
        publishedSurface = swapContinuous(current, bitmap, plan);
        surfaceKind = 'continuous-canvas';
      }
      if (!publishedSurface) return { status: 'deferred-unmounted' };
      bitmap = null;
      return {
        status: 'published',
        surface: publishedSurface,
        surfaceKind,
        stamp: Object.freeze({
          kind: 'native-candidate-page',
          documentId: String(context.documentState.id),
          lifecycleGeneration: Number(context.documentState.lifecycleGeneration) || 0,
          pageNum: Number(context.pageNum),
          contentRevision: Number(context.token.contentRevision) || 0,
          pageRevision: Number(context.revision) || 0,
          mountGeneration: Number(current.mountGeneration) || 0,
          renderScale: plan.renderScale,
          capped: plan.capped,
          candidateBytes: candidate.candidateBytes.length,
        }),
      };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (candidateDocument) await destroyDocument(candidateDocument);
      if (bitmap?.dataset?.textEditCandidateBitmap === 'true') {
        bitmap.width = 0;
        bitmap.height = 0;
      }
    }
  };
}

const publishCandidatePreview = createNativeTextCandidatePreviewPublisher();

export function publishNativeTextCandidatePreview(context) {
  return publishCandidatePreview(context);
}
