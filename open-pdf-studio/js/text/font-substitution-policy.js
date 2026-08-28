import { proposeFontSubstitution, resolvePackagedFace } from './font-catalog.js';

export function normalizeFontSubstitutionSources(sourceFonts) {
  const normalized = [...new Set((sourceFonts || [])
    .map((font) => String(font || 'Unknown'))
    .filter(Boolean))];
  return normalized.length > 0 ? normalized : ['Unknown'];
}

/**
 * Resolve the packaged substitute authorized by the application's automatic
 * substitution policy. Exact shaping still verifies the packaged asset,
 * checksum, glyph coverage, and layout before an edit can commit.
 */
export function resolveAutomaticFontSubstitution({
  sourceFonts,
  bold = null,
  italic = null,
  now = () => new Date(),
}) {
  const normalizedSources = normalizeFontSubstitutionSources(sourceFonts);
  const sourceName = normalizedSources[0];
  const resolvedBold = bold == null ? /bold|demi|semibold/iu.test(sourceName) : bold === true;
  const resolvedItalic = italic == null ? /italic|oblique/iu.test(sourceName) : italic === true;
  const face = resolvePackagedFace(sourceName, resolvedBold, resolvedItalic);
  if (!face) return null;
  const proposed = proposeFontSubstitution(sourceName, resolvedBold, resolvedItalic);
  return {
    ...proposed,
    approved: true,
    approvedAt: now().toISOString(),
  };
}
