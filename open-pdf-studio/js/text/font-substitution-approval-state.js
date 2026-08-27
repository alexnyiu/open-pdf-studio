export function normalizeFontSubstitutionSources(sourceFonts) {
  const normalized = [...new Set((sourceFonts || [])
    .map((font) => String(font || 'Unknown'))
    .filter(Boolean))];
  return normalized.length > 0 ? normalized : ['Unknown'];
}

export function fontSubstitutionApprovalKey({ sourceFonts, faceId }) {
  const sources = normalizeFontSubstitutionSources(sourceFonts)
    .sort((left, right) => left.localeCompare(right));
  return JSON.stringify({ sources, faceId: String(faceId || '') });
}

export function ensureFontSubstitutionApprovalMap(documentState) {
  if (!(documentState.fontSubstitutionApprovals instanceof Map)) {
    documentState.fontSubstitutionApprovals = new Map();
  }
  return documentState.fontSubstitutionApprovals;
}
