import {
  createRichTextDocument,
  createTextLine,
  createTextRun,
} from '../../text/rich-text.js';

function polygonBounds(polygon) {
  const points = polygon?.points || [];
  const xs = points.map((point) => Number(point[0]));
  const ys = points.map((point) => Number(point[1]));
  if (xs.length === 0 || xs.some((value) => !Number.isFinite(value))
      || ys.some((value) => !Number.isFinite(value))) {
    throw new TypeError('Scanned rich text requires canonical fixed-region geometry');
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function faceIdForStyle(style) {
  const family = style.fontClass.value === 'monospace' ? 'mono'
    : style.fontClass.value === 'serif' ? 'serif' : 'sans';
  const bold = style.weight.value === 'bold';
  const italic = style.italic.value === true;
  const variant = bold && italic ? 'bold-italic' : bold ? 'bold' : italic ? 'italic' : 'regular';
  return `liberation-${family}-${variant}`;
}

function sourceConfidence(style) {
  return Math.min(...['fontClass', 'fontSize', 'weight', 'italic', 'textColor']
    .map((key) => Number(style[key]?.confidence))
    .filter(Number.isFinite), 1);
}

function runFor(text, content, line) {
  const style = content.estimatedStyle;
  return createTextRun(text, {
    faceId: faceIdForStyle(style),
    size: style.fontSize.value,
    color: style.textColor.value,
    bold: style.weight.value === 'bold',
    italic: style.italic.value === true,
    underline: false,
    strikeout: false,
    direction: 'ltr',
  }, {
    id: `ocr-run-${line.index ?? 0}`,
    sourceConfidence: sourceConfidence(style),
    geometry: {
      x: line.origin.point[0],
      baseline: line.origin.point[1],
      width: line.widthPt,
      height: line.heightPt,
    },
  });
}

/**
 * Add the canonical V2 run model to an already validated OCR repair record.
 * Existing raster repair geometry remains authoritative; this projection is
 * the durable source for explicit style choices and shared editor reopening.
 */
export function withScannedRichText(content) {
  if (!content) return content;
  const layoutLines = Array.isArray(content.layout.lines)
    ? content.layout.lines
    : [{
        index: 0,
        text: content.replacementText,
        origin: content.layout.origin,
        widthPt: content.layout.widthPt,
        heightPt: content.layout.heightPt,
      }];
  const regionPolygon = content.layout.canonicalRegion || content.source.canonicalPolygon;
  const region = polygonBounds(regionPolygon);
  const baselineAdvance = content.source.lineSpacing?.valuePt
    || content.layout.measuredLineSpacingPt
    || content.estimatedStyle.fontSize.value * 1.2;
  const lines = layoutLines.map((line) => createTextLine([
    runFor(line.text, content, line),
  ], {
    id: `ocr-line-${line.index}`,
    baseline: line.origin.point[1],
    baselineAdvance,
    alignment: content.estimatedStyle.alignment.value,
  }));
  return {
    ...content,
    richText: createRichTextDocument(lines, {
      ...region,
      rotation: 0,
      baselineDirection: 'decreasing-y',
    }),
  };
}
