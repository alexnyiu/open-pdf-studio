import { PDFName, PDFString, PDFHexString } from 'pdf-lib';

/**
 * Persistence of named line-style presets INSIDE the PDF.
 *
 * The presets array (see js/solid/stores/stylePresetsStore.js) is stored as
 * JSON in a document-level catalog entry, following the same pattern as the
 * other OPS_* custom keys the app already writes (annotation-level
 * OPS_Subtype etc., and /Outlines on the catalog for bookmarks):
 *
 *   /Root (catalog) -> /OPS_StylePresets (hex string, UTF-16 JSON)
 *
 * PDFHexString.fromText is used instead of PDFString.of because JSON can
 * contain characters (parentheses, backslashes, non-ASCII names) that
 * literal PDF strings do not escape reliably.
 */

export const STYLE_PRESETS_CATALOG_KEY = 'OPS_StylePresets';

/**
 * Write one immutable owner's presets into the pdf-lib document's catalog.
 * Deletes the entry when there are no presets.
 */
export function saveStylePresetsToCatalog(pdfDocLib, snapshot) {
  if (!snapshot?.documentId) throw new TypeError('An owner save snapshot is required');
  const presets = snapshot.stylePresets || null;
  const context = pdfDocLib.context;
  const catalog = context.lookup(context.trailerInfo.Root);
  if (!catalog) return;

  if (!presets || presets.length === 0) {
    catalog.delete(PDFName.of(STYLE_PRESETS_CATALOG_KEY));
    return;
  }
  catalog.set(
    PDFName.of(STYLE_PRESETS_CATALOG_KEY),
    PDFHexString.fromText(JSON.stringify(presets))
  );
}

/**
 * Read presets back from a pdf-lib document's catalog.
 * Returns [] when absent or malformed. Entries are sanity-checked
 * (must have a string name and a props object).
 */
export function readStylePresetsFromCatalog(pdfDocLib) {
  try {
    const context = pdfDocLib.context;
    const catalog = context.lookup(context.trailerInfo.Root);
    if (!catalog) return [];
    const raw = catalog.lookup(PDFName.of(STYLE_PRESETS_CATALOG_KEY));
    let text = null;
    if (raw instanceof PDFHexString) {
      text = raw.decodeText();
    } else if (raw instanceof PDFString) {
      text = raw.decodeText();
    }
    if (!text) return [];
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    return arr.filter(p =>
      p && typeof p === 'object' &&
      typeof p.name === 'string' && p.name.length > 0 &&
      p.props && typeof p.props === 'object'
    ).map(p => ({
      id: typeof p.id === 'string' && p.id ? p.id : `sp_${Math.random().toString(36).slice(2, 10)}`,
      name: p.name,
      props: p.props,
    }));
  } catch {
    return [];
  }
}
