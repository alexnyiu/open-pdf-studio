// @ts-check

/**
 * Meaningful-existing-text policy
 * --------------------------------
 * PDF.js text content is the neutral source for both native PDF text and text
 * streams written by software other than Open PDF Studio. A page is treated as
 * meaningful when any one of these conservative thresholds is met:
 *
 * - at least 6 Unicode letters/numbers;
 * - at least 2 Unicode words containing at least 4 letters/numbers total; or
 * - at least 3 non-empty PDF.js text items containing at least 3
 *   letters/numbers total.
 *
 * This ignores isolated page numbers, bullets, and drawing labels while
 * defaulting real sentences and OCR text layers to "skip". The assessment
 * never removes, hides, or rewrites source text.
 */

const VISIBLE_TEXT = /[^\p{White_Space}\p{Cf}\p{Cc}]/u;
const ALPHANUMERIC = /[\p{L}\p{N}]/gu;
const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

/** @param {unknown} value */
function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Cc}]/gu, '')
    .replace(/[\p{White_Space}]+/gu, ' ')
    .trim();
}

/**
 * @param {Array<{str?: unknown}> | undefined | null} items
 * @returns {import('../types/ocr.js').OcrExistingTextAssessment}
 */
export function assessMeaningfulPdfText(items) {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => normalizeText(item?.str))
    .filter((text) => text.length > 0 && VISIBLE_TEXT.test(text));
  const joined = normalizedItems.join(' ');
  const alphanumericCharacters = (joined.match(ALPHANUMERIC) || []).length;
  const wordCount = (joined.match(WORD) || []).length;
  const normalizedCharacters = [...joined].length;
  const nonEmptyItemCount = normalizedItems.length;

  let meaningful = false;
  /** @type {import('../types/ocr.js').OcrExistingTextAssessment['reason']} */
  let reason = normalizedCharacters === 0 ? 'empty' : 'insignificant';
  if (alphanumericCharacters >= 6) {
    meaningful = true;
    reason = 'substantial-text';
  } else if (wordCount >= 2 && alphanumericCharacters >= 4) {
    meaningful = true;
    reason = 'multiple-words';
  } else if (nonEmptyItemCount >= 3 && alphanumericCharacters >= 3) {
    meaningful = true;
    reason = 'multiple-items';
  }

  return {
    source: 'pdfjs-text-content',
    meaningful,
    reason,
    normalizedCharacters,
    alphanumericCharacters,
    wordCount,
    nonEmptyItemCount,
    revision: 0,
  };
}

/** @param {{items?: Array<{str?: unknown}>} | undefined | null} textContent */
export function assessPdfJsTextContent(textContent) {
  return assessMeaningfulPdfText(textContent?.items);
}
