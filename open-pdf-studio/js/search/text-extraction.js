// @ts-check

import { assessPdfJsTextContent } from '../ocr/existing-text.js';
import {
  getPendingOcrTextItems,
  recordOcrExistingTextAssessment,
} from '../ocr/document-state.js';
import {
  captureTextCacheRevision,
  readPageTextCache,
  textCacheRevisionIsCurrent,
  writePageTextCache,
} from './text-cache.js';
import { projectTextEditRecord } from '../text/rich-text.js';

/**
 * Extract merged searchable text for one page.
 *
 * itemIndex uses the same PDF.js filtering as text-layer.js, so native match
 * items still resolve to the corresponding rendered span. Pending OCR keeps
 * its canonical polygon/baseline instead of fabricating word geometry.
 */
export async function extractPageText(pdfDoc, pageNum, doc) {
  const cached = readPageTextCache(doc, pdfDoc, pageNum);
  if (cached) return cached;
  const revisionIdentity = captureTextCacheRevision(doc, pdfDoc, pageNum);
  if (doc && !textCacheRevisionIsCurrent(revisionIdentity, doc, pdfDoc)) return null;
  const page = await pdfDoc.getPage(pageNum);
  if (doc && !textCacheRevisionIsCurrent(revisionIdentity, doc, pdfDoc)) return null;
  const textContent = await page.getTextContent();
  if (doc && !textCacheRevisionIsCurrent(revisionIdentity, doc, pdfDoc)) return null;
  if (doc) {
    recordOcrExistingTextAssessment(doc, pageNum, assessPdfJsTextContent(textContent));
  }

  let pageText = '';
  const items = [];
  const textItems = textContent.items.filter((item) => item.str !== undefined);
  textItems.forEach((item, index) => {
    if (!item.str) return;
    items.push({
      str: item.str,
      startPos: pageText.length,
      endPos: pageText.length + item.str.length,
      transform: item.transform,
      width: item.width,
      height: item.height,
      fontName: item.fontName || '',
      source: 'native',
      geometry: null,
      itemIndex: index,
    });
    pageText += item.str;
  });

  for (const edit of (doc?.textEdits || []).filter((entry) => entry.page === pageNum)
    .map(projectTextEditRecord).filter((entry) => entry.originalText === '')) {
    for (const line of (edit.newText || '').split('\n')) {
      if (!line) continue;
      if (pageText.length > 0 && !pageText.endsWith(' ') && !pageText.endsWith('\n')) pageText += ' ';
      items.push({
        str: line,
        startPos: pageText.length,
        endPos: pageText.length + line.length,
        transform: null,
        width: 0,
        height: 0,
        fontName: '',
        source: 'application',
        geometry: null,
        editId: edit.id,
        itemIndex: -1,
      });
      pageText += line;
    }
  }

  for (const item of getPendingOcrTextItems(doc, pageNum)) {
    if (!item.text) continue;
    if (pageText.length > 0 && !pageText.endsWith('\n')) pageText += '\n';
    const startPos = pageText.length;
    items.push({
      str: item.text,
      startPos,
      endPos: startPos + item.text.length,
      transform: null,
      width: 0,
      height: 0,
      fontName: '',
      source: 'ocr',
      itemIndex: -1,
      ocrLineId: item.lineId,
      ocrTextId: item.id,
      confidence: item.confidence,
      geometry: {
        polygon: item.polygon,
        baseline: item.baseline,
        anchor: item.anchor,
        pageGeometry: item.pageGeometry,
      },
    });
    pageText += item.text;
  }

  if (doc && !textCacheRevisionIsCurrent(revisionIdentity, doc, pdfDoc)) return null;
  return writePageTextCache(doc, pdfDoc, pageNum, { pageNum, text: pageText, items });
}
