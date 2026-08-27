import { richTextToPlainText } from '../../text/rich-text.js';

/**
 * Recover authored FreeText content without turning appearance-only wrapping
 * into canonical newlines. Our owned rich-text payload is authoritative when
 * present; PDF /Contents is next. PDF.js `textContent` is derived from the
 * appearance stream and is only a last-resort fallback for foreign files.
 */
export function canonicalFreeTextContent(annotation = {}, ownedRichText = null) {
  if (ownedRichText) return richTextToPlainText(ownedRichText);
  if (typeof annotation.contentsObj?.str === 'string') return annotation.contentsObj.str;
  if (typeof annotation.contents === 'string') return annotation.contents;
  if (Array.isArray(annotation.textContent)) return annotation.textContent.join('\n');
  return '';
}
