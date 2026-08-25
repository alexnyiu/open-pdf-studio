import { state, getActiveDocument, getPageRotation } from '../core/state.js';
import { isTauri, invoke } from '../core/platform.js';
import * as pdfjsLib from 'pdfjs-dist';
import { resolveTextEditPageGeometry } from './text-edit-appearance.js';
import { assessPdfJsTextContent } from '../ocr/existing-text.js';
import { projectTextEditRecord } from './rich-text.js';
import {
  getPendingOcrTextItems,
  OPEN_PDF_STUDIO_OCR_OWNER,
  recordOcrExistingTextAssessment,
} from '../ocr/document-state.js';
import {
  OCR_CROPPED_DISPLAY_PDF_SPACE,
  OCR_PDF_USER_SPACE,
  OCR_SOURCE_RASTER_SPACE,
  mapPolygonBetweenSpaces,
} from '../ocr/contracts/geometry.js';

/**
 * Text Layer Management Module
 * Uses PDF.js built-in TextLayer class for accurate text selection positioning
 */

// Store references to text layers for cleanup
const textLayers = new Map();
const pageFontResolutionPromises = new WeakMap();

/** @param {HTMLElement} textLayerDiv @param {any} context */
export function setOcrTextLayerProjection(textLayerDiv, context) {
  if (!textLayerDiv) return;
  textLayerDiv._opdsOcrProjection = context;
}

/**
 * Project canonical raw-PDF OCR geometry into a text layer's local frame.
 * PDF.js viewports own zoom/rotation in raster and continuous modes. The Rust
 * layer is laid out in cropped display points and receives application zoom
 * and rotation from its parent CSS matrix.
 * @param {HTMLElement} textLayerDiv
 * @param {any} item
 */
export function projectOcrItemToTextLayer(textLayerDiv, item) {
  const context = textLayerDiv?._opdsOcrProjection;
  if (!context || !item?.polygon?.points?.length) return null;
  let points;
  if (context.kind === 'pdfjs') {
    if (typeof context.viewport?.convertToViewportPoint !== 'function') return null;
    points = item.polygon.points.map(([x, y]) => context.viewport.convertToViewportPoint(x, y));
  } else if (context.kind === 'cropped-display') {
    const pageGeometry = item.pageGeometry || context.pageGeometry;
    if (!pageGeometry?.transformChain) return null;
    points = mapPolygonBetweenSpaces(
      pageGeometry.transformChain,
      item.polygon,
      OCR_CROPPED_DISPLAY_PDF_SPACE,
    ).points;
  } else {
    return null;
  }
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  const origin = points[0];
  const edge = points[1] || [right, top];
  const opposite = points[points.length - 1] || [left, bottom];
  return {
    points,
    bounds: { left, top, width: right - left, height: bottom - top },
    origin,
    width: Math.max(Math.hypot(edge[0] - origin[0], edge[1] - origin[1]), 1),
    height: Math.max(Math.hypot(opposite[0] - origin[0], opposite[1] - origin[1]), 1),
    angleDegrees: Math.atan2(edge[1] - origin[1], edge[0] - origin[0]) * 180 / Math.PI,
  };
}

/**
 * Replace only Open PDF Studio's pending OCR nodes. Native PDF.js spans,
 * third-party spans, and Add Text spans are never selected by this cleanup.
 * @param {HTMLElement} textLayerDiv
 * @param {number} pageNum
 */
export function injectPendingOcrTextSpans(textLayerDiv, pageNum) {
  if (!textLayerDiv) return;
  textLayerDiv.querySelectorAll(`[data-ocr-owner="${OPEN_PDF_STUDIO_OCR_OWNER}"]`)
    .forEach((node) => node.remove());

  const doc = getActiveDocument();
  if (!doc || textLayerDiv._opdsOcrProjection?.documentId !== doc.id) return;
  const pendingItems = getPendingOcrTextItems(doc, pageNum);
  const editPage = doc.scannedTextEdits?.pages?.find((page) => page.index === pageNum - 1);
  const appliedEdits = (editPage?.selections || []).filter((selection) =>
    selection.repair?.status === 'applied'
      && ['isolated-horizontal-line', 'fixed-region-multiline', 'approved-region-paragraph-reflow']
        .includes(selection.content?.scope));
  let items = pendingItems;
  if (appliedEdits.length > 0) {
    const editsByLine = new Map(appliedEdits
      .filter((selection) => selection.target.kind === 'line')
      .map((selection) => [selection.target.targetId, selection]));
    const pendingSelectionIds = new Set(pendingItems
      .map((item) => item.scannedSelection?.id)
      .filter(Boolean));
    items = pendingItems.map((item) => ({
      ...item,
      scannedSelection: item.scannedSelection || editsByLine.get(item.lineId) || null,
    }));
    for (const selection of appliedEdits) {
      if (pendingSelectionIds.has(selection.id)) continue;
      const fixedRegion = ['fixed-region-multiline', 'approved-region-paragraph-reflow']
        .includes(selection.content.scope);
      items.push({
        id: `${selection.id}-hit-target`,
        lineId: selection.target.targetId,
        pageNum,
        readingOrder: Number.MAX_SAFE_INTEGER,
        text: selection.content.searchableText.text,
        confidence: selection.geometry.confidence,
        polygon: fixedRegion
          ? selection.content.source.canonicalRegion
          : selection.content.source.canonicalPolygon,
        baseline: fixedRegion
          ? selection.content.source.canonicalBaselines[0]
          : selection.content.source.canonicalBaseline,
        pageGeometry: doc.ocr?.pages?.[pageNum]?.recognition?.geometry
          || (editPage?.pageGeometry?.transformChain ? editPage.pageGeometry : null),
        resultRevision: 0,
        correctionRevision: 0,
        scannedTextEditRevision: selection.revision,
        language: null,
        direction: 'ltr',
        words: undefined,
        ownership: { stream: 'persisted-scanned-text-edit' },
        scannedSelection: selection,
        sourceLineIds: fixedRegion ? [...selection.target.lineIds] : [selection.target.targetId],
        hitOnly: true,
      });
    }
  }
  if (items.length === 0) return;

  const measureCanvas = document.createElement('canvas');
  const measureContext = measureCanvas.getContext('2d');
  let inserted = 0;
  for (const item of items) {
    const projected = projectOcrItemToTextLayer(textLayerDiv, item);
    if (!projected || !item.text) continue;
    const scannedSelection = item.scannedSelection;
    const showVisiblePreview = scannedSelection
      && doc.scannedTextEditPersistedRevision !== doc.scannedTextEdits?.stateRevision
      && item.pageGeometry;
    if (showVisiblePreview) {
      const patch = scannedSelection.content.visibleReplacement.patch;
      const bounds = scannedSelection.repair.approvedRegion;
      const repairPolygon = mapPolygonBetweenSpaces(
        item.pageGeometry.transformChain,
        {
          coordinateSpace: OCR_SOURCE_RASTER_SPACE,
          points: [
            [bounds.x, bounds.y],
            [bounds.x + bounds.width, bounds.y],
            [bounds.x + bounds.width, bounds.y + bounds.height],
            [bounds.x, bounds.y + bounds.height],
          ],
        },
        OCR_PDF_USER_SPACE,
      );
      const previewProjection = projectOcrItemToTextLayer(textLayerDiv, {
        polygon: repairPolygon,
        pageGeometry: item.pageGeometry,
      });
      if (previewProjection) {
        const canvas = document.createElement('canvas');
        canvas.width = patch.widthPx;
        canvas.height = patch.heightPx;
        canvas.setAttribute('aria-hidden', 'true');
        canvas.dataset.ocrOwner = OPEN_PDF_STUDIO_OCR_OWNER;
        canvas.dataset.ocrStream = 'scanned-text-visible-preview';
        canvas.dataset.ocrLineId = item.lineId;
        if (scannedSelection.target?.kind === 'region') {
          canvas.dataset.ocrRegionId = scannedSelection.target.targetId;
        }
        canvas.style.position = 'absolute';
        canvas.style.left = `${previewProjection.origin[0].toFixed(4)}px`;
        canvas.style.top = `${previewProjection.origin[1].toFixed(4)}px`;
        canvas.style.width = `${previewProjection.width.toFixed(4)}px`;
        canvas.style.height = `${previewProjection.height.toFixed(4)}px`;
        canvas.style.transformOrigin = '0 0';
        canvas.style.transform = `rotate(${previewProjection.angleDegrees.toFixed(6)}deg)`;
        canvas.style.pointerEvents = 'none';
        const context = canvas.getContext('2d');
        if (context) {
          const binary = atob(patch.data);
          const rgba = new Uint8ClampedArray(binary.length);
          for (let index = 0; index < binary.length; index += 1) rgba[index] = binary.charCodeAt(index);
          const image = context.createImageData(patch.widthPx, patch.heightPx);
          image.data.set(rgba);
          context.putImageData(image, 0, 0);
          textLayerDiv.appendChild(canvas);
        }
      }
    }
    if (inserted > 0 && !item.hitOnly) {
      const separator = document.createElement('br');
      separator.dataset.ocrOwner = OPEN_PDF_STUDIO_OCR_OWNER;
      separator.dataset.ocrStream = item.ownership.stream;
      textLayerDiv.appendChild(separator);
    }

    const span = document.createElement('span');
    span.id = item.id;
    span.textContent = item.hitOnly ? '' : item.text;
    span.setAttribute('aria-label', item.text);
    if (item.language) span.setAttribute('lang', item.language);
    if (item.direction === 'ltr' || item.direction === 'rtl') span.setAttribute('dir', item.direction);
    if (item.direction === 'ttb' || item.direction === 'btt') {
      span.style.writingMode = 'vertical-rl';
    }
    span.style.position = 'absolute';
    span.style.left = `${projected.origin[0].toFixed(4)}px`;
    span.style.top = `${projected.origin[1].toFixed(4)}px`;
    span.style.fontFamily = 'sans-serif';
    span.style.fontSize = `${projected.height.toFixed(4)}px`;
    span.style.lineHeight = '1';
    span.style.whiteSpace = 'pre';
    span.style.color = 'transparent';
    span.style.background = 'transparent';
    span.style.textShadow = 'none';
    span.style.caretColor = 'transparent';
    span.style.transformOrigin = '0 0';
    let scaleX = 1;
    if (item.hitOnly) {
      span.style.display = 'block';
      span.style.width = `${projected.width.toFixed(4)}px`;
      span.style.height = `${projected.height.toFixed(4)}px`;
    } else if (measureContext) {
      measureContext.font = `${projected.height}px sans-serif`;
      const measured = measureContext.measureText(item.text).width;
      if (measured > 0) scaleX = projected.width / measured;
    }
    span.style.transform = `rotate(${projected.angleDegrees.toFixed(6)}deg) scaleX(${scaleX.toFixed(6)})`;
    span.dataset.ocrOwner = OPEN_PDF_STUDIO_OCR_OWNER;
    span.dataset.ocrStream = item.ownership.stream;
    span.dataset.ocrLineId = item.lineId;
    if (Array.isArray(item.sourceLineIds)) span.dataset.ocrSourceLineIds = item.sourceLineIds.join(' ');
    span.dataset.ocrConfidence = String(item.confidence);
    span.dataset.ocrReadingOrder = String(item.readingOrder);
    span.dataset.ocrResultRevision = String(item.resultRevision);
    span.dataset.ocrCorrectionRevision = String(item.correctionRevision);
    if (scannedSelection || item.hitOnly) {
      span.dataset.scannedTextEditRevision = String(item.scannedTextEditRevision || 0);
    }
    if (scannedSelection) span.dataset.scannedTextEditSelectionId = scannedSelection.id;
    if (scannedSelection?.target?.kind === 'region') {
      span.dataset.ocrRegionId = scannedSelection.target.targetId;
    }
    if (item.hitOnly) span.dataset.scannedTextEditHitOnly = 'true';
    if (item.language) span.dataset.ocrLanguage = item.language;
    if (item.direction) span.dataset.ocrDirection = item.direction;
    const needsTextAccess = state.currentTool === 'select' || state.currentTool === 'editText';
    span.style.pointerEvents = needsTextAccess ? 'auto' : 'none';
    span.style.cursor = needsTextAccess ? 'text' : 'default';
    textLayerDiv.appendChild(span);
    inserted += 1;
  }
}

/** @param {number} pageNum */
export function refreshPendingOcrTextLayer(pageNum) {
  const entry = textLayers.get(pageNum);
  if (!entry?.element) return false;
  injectPendingOcrTextSpans(entry.element, pageNum);
  ensureEndOfContent(entry.element);
  return true;
}

/**
 * Strip subset prefix from PDF font name (e.g., "NDPKKA+TimesNewRomanPSMT" → "TimesNewRomanPSMT")
 */
function stripSubsetPrefix(fontName) {
  if (!fontName) return '';
  const plusIdx = fontName.indexOf('+');
  if (plusIdx >= 0 && plusIdx <= 6) {
    return fontName.substring(plusIdx + 1);
  }
  return fontName;
}

/**
 * Parse bold/italic from PDF font name suffix
 * Common patterns: -Bold, -Italic, -BoldItalic, -BoldOblique, -Medium, -Book, -Regular
 */
function parseFontWeight(cleanFontName) {
  const name = (cleanFontName || '').toLowerCase();
  const bold = name.includes('bold') || name.includes(',bold') || name.endsWith('-bd');
  const italic = name.includes('italic') || name.includes('oblique')
    || name.includes(',italic') || name.endsWith('-it');
  return { bold, italic };
}

function getResolvedFontInfo(page, fontName) {
  if (!page?.commonObjs || !fontName) return null;
  try {
    const fontObj = page.commonObjs.get(fontName);
    if (!fontObj) return null;
    const cleanName = stripSubsetPrefix(fontObj.name || '');
    const weight = parseFontWeight(cleanName);
    const loadedName = fontObj.loadedName || fontName;
    return {
      name: cleanName,
      bold: fontObj.bold === true || weight.bold,
      italic: fontObj.italic === true || weight.italic,
      loadedName: loadedName && document.fonts.check(`12px "${loadedName}"`)
        ? loadedName
        : '',
    };
  } catch (_) {
    return null;
  }
}

/**
 * Build font info cache from page.commonObjs for actual font name detection
 */
function buildFontInfoCache(textContent, page) {
  const fontInfoCache = {};
  if (!page?.commonObjs) return fontInfoCache;

  for (const item of textContent.items) {
    const fontName = item.fontName;
    if (fontName && !fontInfoCache[fontName]) {
      const info = getResolvedFontInfo(page, fontName);
      if (info) fontInfoCache[fontName] = info;
    }
  }
  return fontInfoCache;
}

function applyResolvedFontInfo(textLayerDiv, page) {
  let changed = false;
  const spans = textLayerDiv?.querySelectorAll('span[data-pdf-font-name]') || [];
  for (const span of spans) {
    const info = getResolvedFontInfo(page, span.dataset.pdfFontName);
    if (!info) continue;
    span.dataset.pdfActualFontName = info.name;
    span.dataset.pdfLoadedFontName = info.loadedName;
    span.dataset.pdfBold = String(info.bold);
    span.dataset.pdfItalic = String(info.italic);
    changed = true;
  }
  return changed;
}

/**
 * Resolve embedded PDF fonts on demand before native text editing starts.
 * The vector renderer does not call PDF.js page.render(), so commonObjs can
 * still be unresolved even though the text layer already exists.
 */
export async function resolveTextLayerFonts(page, textLayerDiv) {
  if (!page || !textLayerDiv) return false;
  const needsResolution = [...textLayerDiv.querySelectorAll('span[data-pdf-font-name]')]
    .some(span => span.dataset.pdfFontName && !span.dataset.pdfLoadedFontName);
  if (!needsResolution) return true;

  let resolution = pageFontResolutionPromises.get(page);
  if (!resolution) {
    resolution = page.getOperatorList().catch((error) => {
      pageFontResolutionPromises.delete(page);
      throw error;
    });
    pageFontResolutionPromises.set(page, resolution);
  }

  try {
    await resolution;
  } catch (_) {
    return false;
  }
  return applyResolvedFontInfo(textLayerDiv, page);
}

/**
 * Map a PDF font name to a CSS font-family string
 * Uses actual font name from commonObjs to detect serif/sans-serif/monospace
 */
export function mapPdfFontToCss(actualFontName, fallbackFamily) {
  const name = (actualFontName || '').toLowerCase();

  if (name.includes('courier') || name.includes('consolas') || name.includes('mono')
      || fallbackFamily === 'monospace') {
    return '"Courier New", Courier, monospace';
  }

  if (name.includes('times') || name.includes('garamond') || name.includes('georgia')
      || name.includes('palatino') || name.includes('cambria') || name.includes('bookman')
      || (fallbackFamily === 'serif')) {
    return '"Times New Roman", Times, serif';
  }

  if (name.includes('arial') || name.includes('helvetica') || name.includes('calibri')
      || name.includes('verdana') || name.includes('tahoma') || name.includes('trebuchet')
      || name.includes('segoe') || fallbackFamily === 'sans-serif') {
    return 'Helvetica, Arial, sans-serif';
  }

  if (fallbackFamily && fallbackFamily !== 'sans-serif') {
    return fallbackFamily;
  }
  return 'Helvetica, Arial, sans-serif';
}

/**
 * Insert <br> elements between consecutive text spans that have a large horizontal gap
 * on the same baseline. This prevents the browser from merging columns during text selection.
 */
function insertColumnBreaks(textItems, textDivs) {
  let prevItem = null;
  let prevDiv = null;
  let breaksInserted = 0;

  for (let i = 0; i < textItems.length && i < textDivs.length; i++) {
    const item = textItems[i];
    const div = textDivs[i];

    // Skip items without visible text (not appended to DOM by TextLayer)
    if (!item.str) {
      prevItem = null;
      prevDiv = null;
      continue;
    }

    if (prevItem && prevDiv && div.parentNode) {
      const prevTx = prevItem.transform;
      const currTx = item.transform;

      const prevFontHeight = Math.hypot(prevTx[2], prevTx[3]);
      const currFontHeight = Math.hypot(currTx[2], currTx[3]);
      const avgFontHeight = (prevFontHeight + currFontHeight) / 2;

      const yDiff = Math.abs(prevTx[5] - currTx[5]);
      const sameBaseline = yDiff <= avgFontHeight * 0.5;

      if (sameBaseline) {
        // Same baseline — check horizontal gap
        const prevRight = prevTx[4] + (prevItem.width || 0);
        const currLeft = currTx[4];
        const gap = currLeft - prevRight;

        // Gap larger than 3x font size indicates a column boundary
        if (gap > avgFontHeight * 3) {
          const br = document.createElement('br');
          br.setAttribute('role', 'presentation');
          div.parentNode.insertBefore(br, div);
          breaksInserted++;
        }
      }
    }

    // Reset tracking after end-of-line items (TextLayer already inserts <br> for those)
    prevItem = item.hasEOL ? null : item;
    prevDiv = item.hasEOL ? null : div;
  }

}

/**
 * Markeert lege en witruimte-only spans in een tekstlaag met `data-ws`, zodat
 * de CSS hun selectie-achtergrond kan neutraliseren.
 *
 * ACHTERGROND: PDF.js zendt voor grote horizontale positiesprongen aparte
 * spans uit die alleen witruimte bevatten (trailing spaties aan regeleindes,
 * inspring-spaties, kolomgaten). Bij een tekstselectie kleuren die apart op als
 * losse blauwe streepjes — o.a. een kolom in de linkermarge en slierten tussen
 * kolommen ("spook-selectie"). Deze spans dragen geen leesbare inhoud: echte
 * spaties tussen twee woorden zitten IN de woord-span zelf en blijven dus wel
 * oplichten. Het markeren raakt de DOM-volgorde, tekst en kopieer-inhoud niet.
 * @param {HTMLElement} textLayerDiv
 */
export function tagWhitespaceSpans(textLayerDiv) {
  if (!textLayerDiv) return;
  const spans = textLayerDiv.querySelectorAll('span:not(.markedContent)');
  spans.forEach(span => {
    const text = span.textContent;
    // PDF generators also use zero-width formatting/control characters for
    // positioning. They render no glyph but Chromium still paints a native
    // selection rectangle for them unless they are treated as whitespace.
    const isVisuallyEmpty = text === '' || /^[\p{White_Space}\p{Cf}\p{Cc}]*$/u.test(text);
    if (isVisuallyEmpty) {
      span.dataset.ws = '1';
    } else if (span.dataset.ws) {
      delete span.dataset.ws;
    }
  });
}

/**
 * Zorgt dat de tekstlaag een `.endOfContent`-div als laatste kind heeft.
 * Deze div (user-select:none via CSS) wordt tijdens een sleep door
 * text-selection.js op de start-Y geplaatst en geactiveerd, zodat een
 * omgekeerde sleep (onder -> boven) de selectie niet naar verre tekst laat
 * uitschieten. Zonder deze div werkt die mitigatie niet.
 * @param {HTMLElement} textLayerDiv
 */
export function ensureEndOfContent(textLayerDiv) {
  if (!textLayerDiv) return;
  let end = textLayerDiv.querySelector('.endOfContent');
  if (!end) {
    end = document.createElement('div');
    end.className = 'endOfContent';
    // Neutraliseer de generieke tekst-transform/font-size die de
    // .textLayer > :not(.markedContent)-regel ook op deze div zou toepassen,
    // zodat de inset:100%-positionering (CSS) niet verschuift.
    end.style.transform = 'none';
    end.style.fontSize = '0';
  }
  // Altijd als laatste kind plaatsen (na alle spans).
  textLayerDiv.appendChild(end);
}

/**
 * Creates a text layer for a PDF page using PDF.js built-in TextLayer
 * @param {Object} page - PDF.js page object
 * @param {Object} viewport - PDF.js viewport
 * @param {HTMLElement} container - Container element to append text layer to
 * @param {number} pageNum - Page number for tracking
 * @returns {Promise<HTMLElement>} The created text layer element
 */
export async function createTextLayer(page, viewport, container, pageNum) {
  const textContent = await page.getTextContent();
  const activeDocument = getActiveDocument();
  if (activeDocument) {
    recordOcrExistingTextAssessment(
      activeDocument,
      pageNum,
      assessPdfJsTextContent(textContent),
    );
  }

  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  textLayerDiv.dataset.page = pageNum;

  // Ensure --total-scale-factor is set (renderer usually sets this on parent)
  if (container) {
    container.style.setProperty('--total-scale-factor', viewport.scale);
  }

  container.appendChild(textLayerDiv);

  // Use PDF.js built-in TextLayer for accurate positioning
  let textLayer;
  try {
    textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport
    });
    await textLayer.render();
  } catch (err) {
    // A damaged native text stream must not make an already validated pending
    // OCR result disappear. Keep the empty layer and publish only owned OCR.
    textLayers.set(pageNum, { element: textLayerDiv, textLayer: null });
    setOcrTextLayerProjection(textLayerDiv, {
      kind: 'pdfjs',
      viewport,
      documentId: activeDocument?.id,
    });
    injectPendingOcrTextSpans(textLayerDiv, pageNum);
    ensureEndOfContent(textLayerDiv);
    return textLayerDiv;
  }

  // Build font info cache from page.commonObjs
  const fontInfoCache = buildFontInfoCache(textContent, page);
  const styles = textContent.styles || {};

  // Filter text items (those with str property, matching textDivs order)
  const textItems = textContent.items.filter(item => item.str !== undefined);
  const textDivs = textLayer.textDivs;

  // Add custom data attributes to rendered spans for the edit text tool
  for (let i = 0; i < textDivs.length && i < textItems.length; i++) {
    const span = textDivs[i];
    const item = textItems[i];

    const fontName = item.fontName || '';
    const fontInfo = fontInfoCache[fontName];
    const itemStyle = fontName ? styles[fontName] : null;

    const actualFontName = fontInfo?.name || '';
    const pdfFontFamily = itemStyle?.fontFamily || 'sans-serif';
    const isBold = fontInfo?.bold || false;
    const isItalic = fontInfo?.italic || false;
    const loadedFontName = fontInfo?.loadedName || '';

    span.dataset.pdfTransform = JSON.stringify(item.transform);
    span.dataset.pdfWidth = item.width || 0;
    span.dataset.itemIndex = i;
    span.dataset.pdfFontFamily = pdfFontFamily;
    span.dataset.pdfFontName = fontName;
    span.dataset.pdfActualFontName = actualFontName;
    span.dataset.pdfLoadedFontName = loadedFontName;
    span.dataset.pdfBold = isBold;
    span.dataset.pdfItalic = isItalic;
  }

  // Insert <br> between horizontally-distant spans on the same baseline so the
  // browser doesn't merge separate columns/labels into one selection range
  // (prevents over-broad "weird" selections on drawings with scattered text).
  insertColumnBreaks(textItems, textDivs);

  // Neutraliseer selectie-achtergrond op lege/witruimte-only spans (spook-
  // selectie: losse streepjes in de marge en tussen kolommen).
  tagWhitespaceSpans(textLayerDiv);

  textLayers.set(pageNum, { element: textLayerDiv, textLayer });
  setOcrTextLayerProjection(textLayerDiv, {
    kind: 'pdfjs',
    viewport,
    documentId: activeDocument?.id,
  });

  // Enable text selection when select or editText tool is active
  const needsTextAccess = state.currentTool === 'select' || state.currentTool === 'editText';
  if (needsTextAccess) {
    textLayerDiv.style.pointerEvents = 'auto';
  }
  const spans = textLayerDiv.querySelectorAll('span:not(.markedContent)');
  spans.forEach(span => {
    span.style.pointerEvents = needsTextAccess ? 'auto' : 'none';
    span.style.cursor = needsTextAccess ? 'text' : 'default';
  });

  // Inject synthetic spans for text added via "Add Text"
  const unscaledWidth = viewport.width / viewport.scale;
  const unscaledHeight = viewport.height / viewport.scale;
  injectSyntheticTextSpans(textLayerDiv, pageNum, unscaledWidth, unscaledHeight);
  injectPendingOcrTextSpans(textLayerDiv, pageNum);

  // endOfContent-marker als laatste kind (mitigatie omgekeerde sleep)
  ensureEndOfContent(textLayerDiv);

  return textLayerDiv;
}

/**
 * Injects synthetic text layer spans for added text (textEdits with empty originalText).
 * These spans make added text selectable and editable like native PDF text.
 * @param {HTMLElement} textLayerDiv - The .textLayer element
 * @param {number} pageNum - Page number
 * @param {number} pageWidth - Unscaled page width in PDF points
 * @param {number} pageHeight - Unscaled page height in PDF points
 */
export function injectSyntheticTextSpans(textLayerDiv, pageNum, pageWidth, pageHeight) {
  const doc = getActiveDocument();
  if (!doc || !doc.textEdits || doc.textEdits.length === 0) return;

  const geometry = resolveTextEditPageGeometry(
    doc.pageDims?.[pageNum],
    pageWidth,
    pageHeight,
    getPageRotation(pageNum),
  );

  // Remove previously injected synthetic spans
  textLayerDiv.querySelectorAll('span[data-synthetic]').forEach(s => s.remove());

  const addedEdits = doc.textEdits
    .filter((entry) => entry.page === pageNum)
    .map(projectTextEditRecord)
    .filter((entry) => entry.originalText === '');
  if (addedEdits.length === 0) return;

  // Create a temporary canvas for text measurement (--scale-x computation)
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const scale = (doc.scale || 1.5) * (window.devicePixelRatio || 1);

  const ascentRatio = 0.8;

  for (const edit of addedEdits) {
    const fontSize = edit.fontSize;
    const ls = edit.lineSpacing || fontSize * 1.2;
    const lines = edit.newText.split('\n');

    // Map fontFamily to CSS font
    const ff = (edit.fontFamily || 'Helvetica').toLowerCase();
    let cssFontFamily;
    if (ff.includes('courier')) {
      cssFontFamily = '"Courier New", Courier, monospace';
    } else if (ff.includes('times')) {
      cssFontFamily = '"Times New Roman", Times, serif';
    } else {
      cssFontFamily = 'Helvetica, Arial, sans-serif';
    }

    const isBold = ff.includes('bold');
    const isItalic = ff.includes('italic') || ff.includes('oblique');
    const fontWeight = isBold ? 'bold ' : '';
    const fontStyle = isItalic ? 'italic ' : '';

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (!lineText) continue;

      // PDF coordinates for this line
      const linePdfX = edit.pdfX;
      const linePdfY = edit.pdfY - i * ls;

      const unrotatedTop = (geometry.pageHeight - linePdfY) - fontSize * ascentRatio;
      const leftPct = (100 * linePdfX / geometry.pageWidth).toFixed(2);
      const topPct = (100 * unrotatedTop / geometry.pageHeight).toFixed(2);

      // Create span
      const span = document.createElement('span');
      span.textContent = lineText;
      span.setAttribute('role', 'presentation');
      span.setAttribute('dir', 'ltr');

      // Inline styles
      span.style.left = `${leftPct}%`;
      span.style.top = `${topPct}%`;
      span.style.fontFamily = cssFontFamily;
      const decorations = [];
      if (edit.fontUnderline) decorations.push('underline');
      if (edit.fontStrikethrough) decorations.push('line-through');
      span.style.textDecorationLine = decorations.length ? decorations.join(' ') : 'none';
      span.style.textDecorationThickness = '0.06em';
      span.style.textUnderlineOffset = '0.08em';
      span.style.setProperty('--font-height', `${fontSize.toFixed(2)}px`);

      // Compute --scale-x
      measureCtx.font = `${fontStyle}${fontWeight}${fontSize * scale}px ${cssFontFamily}`;
      const measuredWidth = measureCtx.measureText(lineText).width;
      if (measuredWidth > 0) {
        // Estimate PDF text width: fontSize * 0.6 * numChars (approximate)
        const pdfTextWidth = fontSize * 0.6 * lineText.length;
        const scaleX = pdfTextWidth * scale / measuredWidth;
        span.style.setProperty('--scale-x', `${scaleX}`);
      }

      // Data attributes for the edit text tool
      const transform = [fontSize, 0, 0, fontSize, linePdfX, linePdfY];
      span.dataset.pdfTransform = JSON.stringify(transform);
      span.dataset.pdfWidth = String(fontSize * 0.6 * lineText.length);
      span.dataset.pdfFontFamily = cssFontFamily;
      span.dataset.pdfFontName = '';
      span.dataset.pdfActualFontName = edit.fontFamily || 'Helvetica';
      span.dataset.pdfLoadedFontName = '';
      span.dataset.pdfBold = String(isBold);
      span.dataset.pdfItalic = String(isItalic);
      span.dataset.synthetic = 'true';
      // Link the span back to its source textEdit record so the edit-text tool
      // re-opens/updates THAT record instead of creating a duplicate edit.
      span.dataset.editId = String(edit.id);

      textLayerDiv.appendChild(span);
    }
  }
}

/**
 * Creates text layer for single page mode
 * @param {Object} page - PDF.js page object
 * @param {Object} viewport - PDF.js viewport
 */
export async function createSinglePageTextLayer(page, viewport) {
  const container = document.getElementById('canvas-container');
  if (!container) return;

  // Remove existing text layer for current page
  clearSinglePageTextLayer();

  const doc = getActiveDocument();
  await createTextLayer(page, viewport, container, doc ? doc.currentPage : 1);
}

/**
 * Clears text layer for single page mode
 */
export function clearSinglePageTextLayer() {
  const container = document.getElementById('canvas-container');
  if (!container) return;

  const existingLayer = container.querySelector('.textLayer');
  if (existingLayer) {
    existingLayer.remove();
  }

  // Clear from tracking map
  const clDoc = getActiveDocument();
  textLayers.delete(clDoc ? clDoc.currentPage : 1);
}

/**
 * Clears all text layers (for re-render or cleanup)
 */
export function clearTextLayers() {
  document.querySelectorAll('.textLayer').forEach(layer => {
    layer.remove();
  });

  textLayers.clear();
}

/**
 * Gets the text layer for a specific page
 * @param {number} pageNum - Page number
 * @returns {HTMLElement|null} The text layer element or null
 */
export function getTextLayer(pageNum) {
  const entry = textLayers.get(pageNum);
  return entry ? entry.element : null;
}

/**
 * Creates a text layer from Rust-extracted text positions.
 * Used when the vector renderer is active (no PDF.js rendering).
 * Text spans are positioned in PDF user space and scaled to match the viewport.
 *
 * @param {HTMLElement} container - Container element for the text layer
 * @param {number} pageNum - Page number (1-based)
 * @param {number} pageWidth - Page width in PDF points
 * @param {number} pageHeight - Page height in PDF points
 * @returns {Promise<boolean>} True if text layer was created successfully
 */
export async function createTextLayerFromRust(container, pageNum, pageWidth, pageHeight) {
  if (!isTauri()) return false;

  try {
    const doc = getActiveDocument();
    if (!doc || !doc.filePath) return false;

    const jsonStr = await invoke('extract_page_text', {
      path: doc.filePath,
      pageIndex: pageNum - 1,
    });
    const spans = JSON.parse(jsonStr);
    if (!spans || spans.length === 0) {
      // Rust returned no text for this page → drop any stale textLayer
      // (e.g. left over from a previous page in vector mode) so the caller's
      // PDF.js fallback path can create a fresh one with the right data-page.
      const stale = container.querySelector('.textLayer');
      if (stale) {
        const stalePage = parseInt(stale.dataset.page);
        if (Number.isFinite(stalePage)) textLayers.delete(stalePage);
        stale.remove();
      }
      return false;
    }

    let textLayerDiv = container.querySelector('.textLayer');
    if (!textLayerDiv) {
      textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'textLayer';
      textLayerDiv.dataset.page = pageNum;
      container.appendChild(textLayerDiv);
    } else {
      // Reusing a textLayer that was created for a different page (e.g. user
      // navigated from page 1 to page 11 in vector mode). The DOM element is
      // recycled but the data-page attribute and the textLayers map entry
      // must be updated so downstream lookups (find-bar, edit-text-tool,
      // undo-manager) still resolve to the right page.
      const prevPage = parseInt(textLayerDiv.dataset.page);
      if (Number.isFinite(prevPage) && prevPage !== pageNum) {
        textLayers.delete(prevPage);
      }
      textLayerDiv.dataset.page = pageNum;
    }
    textLayerDiv.innerHTML = '';

    // The textLayer is sized + transformed by pdf-viewport.js so it sits in
    // PDF user space (origin top-left after Y flip), 1 CSS px = 1 PDF point.
    // --total-scale-factor is forced to 1 there so spans render at their
    // natural PDF point size; the canvas zoom matrix on the parent scales
    // everything to screen.
    textLayerDiv.style.setProperty('--total-scale-factor', '1');
    textLayerDiv.style.width = `${pageWidth}px`;
    textLayerDiv.style.height = `${pageHeight}px`;
    setOcrTextLayerProjection(textLayerDiv, {
      kind: 'cropped-display',
      documentId: doc.id,
      pageGeometry: doc.ocr?.pages?.[pageNum]?.recognition?.geometry
        || doc.scannedTextEdits?.pages?.find((page) => page.index === pageNum - 1)?.pageGeometry
        || null,
    });

    // Hidden text-width measurement canvas for --scale-x
    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');

    // Text spans are in PDF user space (origin bottom-left, Y up).
    for (const span of spans) {
      if (!span.text || !span.text.trim()) continue;

      const el = document.createElement('span');
      el.textContent = span.text;
      el.setAttribute('role', 'presentation');
      el.setAttribute('dir', 'ltr');

      // Convert PDF coordinates (Y-up, baseline) to text layer (Y-down, top of glyph).
      const ascentRatio = 0.8;
      const left = span.x;
      const top = pageHeight - span.y - span.fontSize * ascentRatio;

      el.style.position = 'absolute';
      el.style.left = `${left.toFixed(2)}px`;
      el.style.top = `${top.toFixed(2)}px`;
      el.style.fontFamily = 'sans-serif';
      el.style.setProperty('--font-height', `${span.fontSize.toFixed(2)}px`);
      el.style.lineHeight = '1';
      el.style.color = 'transparent';
      el.style.whiteSpace = 'pre';

      // Compute --scale-x so the rendered CSS text exactly fills the PDF
      // glyph run width. Without this the spans are too wide/narrow and
      // either clip the rendered text on selection or leave gaps that the
      // browser refuses to extend selection across.
      if (span.width > 0 && span.fontSize > 0) {
        measureCtx.font = `${span.fontSize}px sans-serif`;
        const measured = measureCtx.measureText(span.text).width;
        if (measured > 0) {
          const scaleX = span.width / measured;
          el.style.setProperty('--scale-x', `${scaleX.toFixed(4)}`);
        }
      }

      // Store PDF transform data for compatibility with edit text tool
      const transform = [span.fontSize, 0, 0, span.fontSize, span.x, span.y];
      el.dataset.pdfTransform = JSON.stringify(transform);
      el.dataset.pdfWidth = String(span.width);
      el.dataset.pdfFontFamily = 'sans-serif';
      el.dataset.pdfFontName = '';
      el.dataset.pdfActualFontName = '';
      el.dataset.pdfLoadedFontName = '';
      el.dataset.pdfBold = 'false';
      el.dataset.pdfItalic = 'false';

      textLayerDiv.appendChild(el);
    }

    // Enable text selection when select or editText tool is active
    const needsTextAccess = state.currentTool === 'select' || state.currentTool === 'editText';
    if (needsTextAccess) {
      textLayerDiv.style.pointerEvents = 'auto';
    }
    const spanEls = textLayerDiv.querySelectorAll('span:not(.markedContent)');
    spanEls.forEach(s => {
      s.style.pointerEvents = needsTextAccess ? 'auto' : 'none';
      s.style.cursor = needsTextAccess ? 'text' : 'default';
    });

    // Existing-text policy is intentionally based on PDF.js rather than the
    // renderer-specific Rust extraction so native and third-party streams have
    // one definition across all view modes.
    try {
      const pdfPage = await doc.pdfDoc?.getPage(pageNum);
      const pdfTextContent = await pdfPage?.getTextContent();
      if (pdfTextContent) {
        recordOcrExistingTextAssessment(doc, pageNum, assessPdfJsTextContent(pdfTextContent));
      }
    } catch (_) {
      // Rendering remains available; search extraction will retry assessment.
    }

    injectPendingOcrTextSpans(textLayerDiv, pageNum);

    // endOfContent-marker als laatste kind (mitigatie omgekeerde sleep)
    ensureEndOfContent(textLayerDiv);

    textLayers.set(pageNum, { element: textLayerDiv, textLayer: null });
    return true;
  } catch (e) {
    console.warn('[text-layer] Rust text extraction failed:', e);
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('open-pdf-studio:ocr-page-state-changed', (event) => {
    const detail = event.detail;
    if (detail?.documentId !== getActiveDocument()?.id) return;
    refreshPendingOcrTextLayer(detail.pageNum);
  });
  window.addEventListener('open-pdf-studio:ocr-document-state-changed', (event) => {
    if (event.detail?.documentId !== getActiveDocument()?.id) return;
    for (const entry of textLayers.values()) {
      entry.element.querySelectorAll(`[data-ocr-owner="${OPEN_PDF_STUDIO_OCR_OWNER}"]`)
        .forEach((node) => node.remove());
    }
  });
  window.addEventListener('open-pdf-studio:scanned-text-edit-state-changed', (event) => {
    const detail = event.detail;
    if (detail?.documentId !== getActiveDocument()?.id) return;
    if (Number.isSafeInteger(detail.pageIndex)) refreshPendingOcrTextLayer(detail.pageIndex + 1);
    else for (const pageNum of textLayers.keys()) refreshPendingOcrTextLayer(pageNum);
  });
}
