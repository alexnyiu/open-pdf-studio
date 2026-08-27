function normalizedColor(value) {
  return String(value || '').trim().toLowerCase();
}

export function scannedFontClassFromFamily(value) {
  const family = String(value || '').toLowerCase();
  if (family.includes('courier') || family.includes('mono')) return 'monospace';
  if (family.includes('sans')) return 'sans-serif';
  if (family.includes('times') || family.includes('serif')) return 'serif';
  return 'sans-serif';
}

/**
 * Persisted OCR style values represented independently from display aliases.
 * For example, Arial and Helvetica are the same approved sans-serif class.
 */
export function scannedStyleSnapshot(style = {}) {
  return Object.freeze({
    fontClass: scannedFontClassFromFamily(style.family),
    fontSize: Number(style.size),
    weight: style.bold === true ? 'bold' : 'normal',
    italic: style.italic === true,
    textColor: normalizedColor(style.color),
    alignment: ['left', 'center', 'right'].includes(style.alignment)
      ? style.alignment : 'left',
  });
}

/** Keep the touched-key set equal to the net persisted OCR style delta. */
export function syncScannedStyleTouchedKey(touchedKeys, baseline, style, key) {
  if (!(touchedKeys instanceof Set) || !Object.hasOwn(scannedStyleSnapshot(), key)) return false;
  const current = scannedStyleSnapshot(style);
  if (baseline && current[key] === baseline[key]) touchedKeys.delete(key);
  else touchedKeys.add(key);
  return touchedKeys.has(key);
}
