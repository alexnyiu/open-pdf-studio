export const MIB = 1024 * 1024;

export const LARGE_DOCUMENT_THRESHOLDS = Object.freeze({
  pageCount: 50,
  fileBytes: 64 * MIB,
  pageSurfaceBytes: 16 * MIB,
  slowForegroundMs: 150,
  slowForegroundSamples: 2,
});

export function calculateRenderResourceBudget(physicalMemoryBytes) {
  const physical = Number(physicalMemoryBytes);
  const globalBytes = Math.round(Math.min(
    512 * MIB,
    Math.max(192 * MIB, Number.isFinite(physical) && physical > 0 ? physical * 0.04 : 256 * MIB),
  ));
  return Object.freeze({
    physicalMemoryBytes: Number.isFinite(physical) && physical > 0 ? physical : null,
    globalBytes,
    javascriptBytes: Math.floor(globalBytes * 0.6),
    nativePixmapBytes: Math.floor(globalBytes * 0.3),
    metadataBytes: globalBytes - Math.floor(globalBytes * 0.6) - Math.floor(globalBytes * 0.3),
    activeDocumentShare: 0.8,
  });
}

export function createPdfPerformanceProfile({
  pageCount,
  fileBytes = 0,
  physicalMemoryBytes = null,
  pageDimensions = [],
} = {}) {
  const maximumSurfaceBytes = pageDimensions.reduce((maximum, dimensions) => {
    const width = Math.max(0, Number(dimensions?.widthPt ?? dimensions?.[0]) || 0);
    const height = Math.max(0, Number(dimensions?.heightPt ?? dimensions?.[1]) || 0);
    return Math.max(maximum, Math.ceil(width) * Math.ceil(height) * 4);
  }, 0);
  const profile = {
    pageCount: Math.max(0, Number(pageCount) || 0),
    fileBytes: Math.max(0, Number(fileBytes) || 0),
    maximumPageSurfaceBytes: maximumSurfaceBytes,
    foregroundRenderSamples: [],
    slowForegroundSamples: 0,
    budget: calculateRenderResourceBudget(physicalMemoryBytes),
    largeDocument: false,
    largeDocumentReasons: [],
  };
  refreshPdfPerformanceClassification(profile);
  return profile;
}

export function refreshPdfPerformanceClassification(profile) {
  const reasons = [];
  if ((Number(profile?.pageCount) || 0) >= LARGE_DOCUMENT_THRESHOLDS.pageCount) reasons.push('page-count');
  if ((Number(profile?.fileBytes) || 0) >= LARGE_DOCUMENT_THRESHOLDS.fileBytes) reasons.push('file-bytes');
  if ((Number(profile?.maximumPageSurfaceBytes) || 0) >= LARGE_DOCUMENT_THRESHOLDS.pageSurfaceBytes) {
    reasons.push('page-surface');
  }
  if ((Number(profile?.slowForegroundSamples) || 0) >= LARGE_DOCUMENT_THRESHOLDS.slowForegroundSamples) {
    reasons.push('foreground-render-time');
  }
  profile.largeDocumentReasons = reasons;
  profile.largeDocument = reasons.length > 0;
  return profile;
}

export function recordForegroundRenderSample(profile, { elapsedMs = 0, surfaceBytes = 0 } = {}) {
  if (!profile) return null;
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const bytes = Math.max(0, Number(surfaceBytes) || 0);
  profile.foregroundRenderSamples.push(elapsed);
  if (profile.foregroundRenderSamples.length > 20) profile.foregroundRenderSamples.shift();
  if (elapsed > LARGE_DOCUMENT_THRESHOLDS.slowForegroundMs) profile.slowForegroundSamples += 1;
  profile.maximumPageSurfaceBytes = Math.max(profile.maximumPageSurfaceBytes || 0, bytes);
  return refreshPdfPerformanceClassification(profile);
}

export function shouldFullyPrewarmAdaptiveDocument(profile) {
  if (!profile || profile.largeDocument) return false;
  const estimatedBytes = Math.max(
    Number(profile.fileBytes) || 0,
    (Number(profile.maximumPageSurfaceBytes) || 0) * Math.min(3, Number(profile.pageCount) || 0),
  );
  return estimatedBytes <= 64 * MIB;
}
