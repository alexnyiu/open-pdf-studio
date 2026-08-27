import {
  createTextEditRecordV2,
  richTextFromPlainText,
} from './rich-text.js';
import { invertPageRotation } from './text-edit-appearance.js';

export const INSERTED_TEXT_DEFAULT_FONT_SIZE = 12;
export const INSERTED_TEXT_DEFAULT_LINE_SPACING = INSERTED_TEXT_DEFAULT_FONT_SIZE * 1.2;
export const INSERTED_TEXT_DEFAULT_WIDTH = 240;
export const INSERTED_TEXT_MINIMUM_WIDTH = 96;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function createInsertedTextId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `inserted-text-${uuid}`;
  return `inserted-text-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Build an application-owned V2 text record without installing it in a
 * document. Pointer coordinates are page-display points (top-left, Y-down);
 * the returned record is in the immutable unrotated PDF frame (Y-up).
 */
export function createInsertedTextDraft({
  id = createInsertedTextId(),
  page,
  x,
  y,
  pageWidth,
  pageHeight,
  pageRotation = 0,
  fontSize = INSERTED_TEXT_DEFAULT_FONT_SIZE,
  color = '#000000',
} = {}) {
  const numericPageWidth = Number(pageWidth);
  const numericPageHeight = Number(pageHeight);
  const numericFontSize = Number(fontSize);
  if (!Number.isInteger(page) || page < 1) {
    throw new TypeError('Inserted text page must be a positive integer');
  }
  if (!(numericPageWidth > 0) || !(numericPageHeight > 0)) {
    throw new TypeError('Inserted text requires trustworthy page dimensions');
  }
  if (!(numericFontSize > 0)) {
    throw new TypeError('Inserted text font size must be positive');
  }

  const displayPoint = invertPageRotation(
    Number(x) || 0,
    Number(y) || 0,
    numericPageWidth,
    numericPageHeight,
    pageRotation,
  );
  const minimumWidth = Math.min(INSERTED_TEXT_MINIMUM_WIDTH, numericPageWidth);
  const pdfX = clamp(displayPoint.x, 0, Math.max(0, numericPageWidth - minimumWidth));
  const regionWidth = Math.max(1, Math.min(
    INSERTED_TEXT_DEFAULT_WIDTH,
    numericPageWidth - pdfX,
  ));
  const baselineAdvance = numericFontSize * 1.2;
  const maximumBaseline = Math.max(
    numericFontSize,
    numericPageHeight - (baselineAdvance - numericFontSize),
  );
  const baseline = clamp(
    numericPageHeight - displayPoint.y,
    Math.min(numericFontSize, numericPageHeight),
    maximumBaseline,
  );
  const regionY = Math.max(0, baseline - numericFontSize);
  const regionHeight = Math.min(baselineAdvance, numericPageHeight - regionY);

  const richText = richTextFromPlainText('', {
    faceId: 'liberation-sans-regular',
    size: numericFontSize,
    color,
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    direction: 'ltr',
    alignment: 'left',
    baselineAdvance,
  }, {
    x: pdfX,
    y: regionY,
    width: regionWidth,
    height: regionHeight,
    rotation: 0,
    baseline,
    baselineDirection: 'decreasing-y',
  });

  return createTextEditRecordV2({
    id,
    page,
    richText,
    original: null,
    sourceProvenance: null,
    substitution: null,
  });
}
