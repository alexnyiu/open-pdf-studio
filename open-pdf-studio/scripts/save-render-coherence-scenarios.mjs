export const SAVE_RENDER_COHERENCE_SCENARIOS = Object.freeze([
  ['A1', 'Native text, single page', ['scripts/test-save-continue-editing-macos.mjs']],
  ['A2', 'Application-owned rich text', [
    'scripts/test-annotation-text-editing-macos.mjs',
    'js/text/owned-edit-manifest.test.mjs',
  ]],
  ['A3', 'Multiline, Enter, and paste', [
    'scripts/test-editor-coverage-macos.mjs',
    'js/text/rich-text.test.mjs',
  ]],
  ['A4', 'Continuous view', [
    'js/pdf/visible-page-render-barrier.test.mjs',
    'scripts/test-editor-coverage-macos.mjs',
  ]],
  ['A5', 'Book and facing spread', [
    'js/pdf/visible-page-render-barrier.test.mjs',
    'scripts/test-editor-coverage-macos.mjs',
  ]],
  ['A6', 'High zoom with prewarmed tile', [
    'js/pdf/tile-cache.test.mjs',
    'js/pdf/page-raster.test.mjs',
  ]],
  ['A7', 'Low-resolution preview in flight', [
    'js/pdf/low-resolution-preview-key.test.mjs',
    'js/pdf/render-publication-token.test.mjs',
  ]],
  ['A8', 'Vector diagnostic path', [
    'js/pdf/revision-owned-engine-caches.test.mjs',
  ]],
  ['A9', 'PDFium and Rust raster path', [
    'js/pdf/render-publication-token.test.mjs',
    'scripts/test-large-pdf-performance-macos.mjs',
  ]],
  ['A10', 'Thumbnail panel open', [
    'js/ui/panels/thumbnail-document-owner.test.mjs',
    'scripts/test-editor-coverage-macos.mjs',
  ]],
  ['A11', 'Search after save', [
    'js/search/text-cache.test.mjs',
    'js/pdf/saved-document-transition.test.mjs',
  ]],
  ['A12', 'Link and form page', [
    'js/pdf/page-edit-readiness.test.mjs',
    'js/pdf/visible-page-render-barrier.test.mjs',
  ]],
  ['A13', 'Automatic and manual save overlap', [
    'js/pdf/save-coordinator.test.mjs',
  ]],
  ['A14', 'Tab switch during save', [
    'js/pdf/saved-document-transition.test.mjs',
    'scripts/test-editor-coverage-macos.mjs',
  ]],
  ['A15', 'Close during save', [
    'js/pdf/save-coordinator.test.mjs',
    'js/ui/chrome/document-close-authorization.test.mjs',
  ]],
  ['A16', 'Save As', [
    'js/pdf/saved-document-transition.test.mjs',
    'scripts/test-native-paragraph-editing-macos.mjs',
  ]],
  ['A17', 'Page insert, delete, and rotate', [
    'js/pdf/document-performance.test.mjs',
    'scripts/test-editor-coverage-macos.mjs',
  ]],
  ['A18', 'Forced proxy-install failure', [
    'js/pdf/save-fault-injection.test.mjs',
    'js/pdf/saved-document-transition.test.mjs',
    'js/ui/chrome/document-save-status.test.mjs',
  ]],
  ['A19', 'Large PDF', [
    'scripts/test-large-pdf-performance-macos.mjs',
    'js/pdf/render-resource-budget.test.mjs',
  ]],
  ['A20', 'Signed and PDF-A policy', [
    'scripts/test-editor-coverage-macos.mjs',
    'scripts/test-macos-safe-ocr-save-packaged.mjs',
  ]],
  ['A21', 'OCR and scanned text edit', [
    'scripts/test-ocr-edit-single-line-macos.mjs',
    'scripts/test-ocr-edit-regions-macos.mjs',
  ]],
  ['A22', 'Three consecutive edits', ['scripts/test-save-continue-editing-macos.mjs']],
  ['A23', 'Typing-only commit without resize', [
    'scripts/test-save-continue-editing-macos.mjs',
    'js/text/final-text-layout.test.mjs',
  ]],
].map(([id, scenario, evidence]) => Object.freeze({
  id,
  scenario,
  evidence: Object.freeze(evidence),
})));

export const SAVE_RENDER_COHERENCE_SCENARIO_IDS = Object.freeze(
  SAVE_RENDER_COHERENCE_SCENARIOS.map(({ id }) => id),
);

export function saveRenderCoherenceScenarioMatrix(runtimePasses = []) {
  const runtime = new Set(runtimePasses);
  return SAVE_RENDER_COHERENCE_SCENARIOS.map((entry) => Object.freeze({
    ...entry,
    status: runtime.has(entry.id) ? 'PASS' : 'COVERED',
    evidenceKind: runtime.has(entry.id) ? 'packaged-production-ui' : 'deterministic-or-packaged-suite',
  }));
}
