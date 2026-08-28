import { shouldFullyPrewarmAdaptiveDocument } from './render-performance.js';

export const PDF_PRELOAD_MODES = Object.freeze(['adaptive', 'entire', 'off']);

export function normalizePdfPreloadMode(value, legacyValue = undefined) {
  if (PDF_PRELOAD_MODES.includes(value)) return value;
  if (legacyValue === false || value === false) return 'off';
  return 'adaptive';
}

export function documentPreloadMode(preferences) {
  return normalizePdfPreloadMode(preferences?.pdfPreloadMode, preferences?.preloadEntirePdf);
}

export function shouldPreloadNearby(preferences) {
  return documentPreloadMode(preferences) !== 'off';
}

export function shouldPreloadEntireDocument(documentState, preferences) {
  const mode = documentPreloadMode(preferences);
  if (mode === 'entire') return true;
  if (mode === 'off') return false;
  return shouldFullyPrewarmAdaptiveDocument(documentState?.performanceProfile);
}
