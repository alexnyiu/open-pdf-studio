import {
  createRichTextDocument,
  createTextLine,
  createTextRun,
  graphemes,
} from './rich-text.js';
import { shapeRichTextDocument, shapeTextRun } from './font-catalog.js';

const sameStyle = (left, right) => [
  'faceId', 'size', 'color', 'bold', 'italic', 'underline', 'strikeout', 'direction',
].every((key) => left[key] === right[key]);

function appendText(runs, text, style) {
  const previous = runs.at(-1);
  if (previous && sameStyle(previous, style)) previous.text += text;
  else runs.push(createTextRun(text, style));
}

async function shapedLineAdvance(runs) {
  let advance = 0;
  for (const run of runs) {
    const shaped = await shapeTextRun(run);
    advance += shaped.advance;
  }
  return advance;
}

async function documentInkInsets(document, inkPadding = 0, antialiasMargin = 1) {
  let leftOverhang = 0;
  let rightOverhang = 0;
  for (const line of document.lines) {
    for (const run of line.runs) {
      const shaped = await shapeTextRun(run);
      leftOverhang = Math.max(leftOverhang, -shaped.inkBounds.left);
      rightOverhang = Math.max(rightOverhang, shaped.inkBounds.right - shaped.advance);
    }
  }
  return {
    left: Math.max(0, inkPadding) + antialiasMargin + Math.max(0, leftOverhang),
    right: Math.max(0, inkPadding) + antialiasMargin + Math.max(0, rightOverhang),
    top: Math.max(0, inkPadding) + antialiasMargin,
    bottom: Math.max(0, inkPadding) + antialiasMargin,
  };
}

function lineAdvance(runs, fallback) {
  return Math.max(fallback || 0, ...runs.map((run) => run.size * 1.2));
}

function intersects(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function normalizedPageBounds(value) {
  if (!value) return null;
  const x = Number(value.x ?? value.left ?? 0);
  const y = Number(value.y ?? value.bottom ?? value.top ?? 0);
  const width = Number(value.width);
  const height = Number(value.height);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height } : null;
}

function normalizedColumnBounds(value) {
  if (!value) return null;
  const left = Number(value.left ?? value.x);
  const right = Number(value.right ?? (Number(value.x) + Number(value.width)));
  return Number.isFinite(left) && Number.isFinite(right) && right > left ? { left, right } : null;
}

function shapedBounds(document, layout, contentWidth, inkInsets, antialiasMargin = 1) {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  const lineInkBounds = [];
  for (const line of layout.lines) {
    const lineAdvanceWidth = line.runs.reduce((sum, run) => sum + (run.shaped?.advance || 0), 0);
    const alignmentOffset = line.alignment === 'center'
      ? (contentWidth - lineAdvanceWidth) / 2
      : line.alignment === 'right' ? contentWidth - lineAdvanceWidth : 0;
    let lineLeft = Number.POSITIVE_INFINITY;
    let lineRight = Number.NEGATIVE_INFINITY;
    let lineBottom = Number.POSITIVE_INFINITY;
    let lineTop = Number.NEGATIVE_INFINITY;
    for (const run of line.runs) {
      const shaped = run.shaped;
      if (!shaped) continue;
      const runX = document.region.x + inkInsets.left + alignmentOffset + (run.geometry?.x || 0);
      lineLeft = Math.min(lineLeft, runX + shaped.inkBounds.left - antialiasMargin);
      lineRight = Math.max(lineRight, runX + shaped.inkBounds.right + antialiasMargin);
      lineBottom = Math.min(lineBottom, line.baseline - shaped.metrics.descent - antialiasMargin);
      lineTop = Math.max(lineTop, line.baseline + shaped.metrics.ascent + antialiasMargin);
    }
    if ([lineLeft, lineRight, lineBottom, lineTop].every(Number.isFinite)) {
      const lineBounds = {
        x: lineLeft,
        y: lineBottom,
        width: lineRight - lineLeft,
        height: lineTop - lineBottom,
      };
      lineInkBounds.push(lineBounds);
      left = Math.min(left, lineLeft);
      right = Math.max(right, lineRight);
      bottom = Math.min(bottom, lineBottom);
      top = Math.max(top, lineTop);
    }
  }
  if (![left, right, bottom, top].every(Number.isFinite)) {
    return {
      bounds: { x: document.region.x, y: document.region.y, width: 0, height: 0 },
      lineInkBounds,
    };
  }
  return {
    bounds: { x: left, y: bottom, width: right - left, height: top - bottom },
    lineInkBounds,
  };
}

/**
 * Exact native-only layout. Automatic mode generates soft wraps. Manual-line
 * mode preserves the displayed source lines and only accepts authored line
 * elements; an overlong line is reported instead of being silently reflowed.
 */
export async function layoutExpandableNativeText(document, options = {}) {
  const width = Number(options.width ?? document.region.width);
  if (!(width > 0)) throw new Error('Expandable native text width must be positive');
  const antialiasMargin = Math.max(0, Number(options.antialiasMargin ?? 1) || 0);
  const inkPadding = Math.max(0, Number(options.inkPadding) || 0);
  const inkInsets = await documentInkInsets(document, inkPadding, antialiasMargin);
  const contentWidth = width - inkInsets.left - inkInsets.right;
  if (!(contentWidth > 0)) throw new Error('Expandable native text has no ink-safe content width');
  const minimumHeight = Math.max(0, Number(options.minimumHeight ?? document.region.height) || 0);
  const anchorTop = Number.isFinite(options.anchorTop)
    ? options.anchorTop : document.region.y + document.region.height;
  const sign = document.region.baselineDirection === 'increasing-y' ? 1 : -1;
  const output = [];
  let runs = [];
  let baseline = document.lines[0].baseline;
  let activeAlignment = document.lines[0].alignment;
  let activeAdvance = document.lines[0].baselineAdvance;

  const pushLine = (breakAfter, preserveMeasuredAdvance = false) => {
    const fallback = runs[0] || document.lines[0].runs[0];
    const safeRuns = runs.length ? runs : [createTextRun('', fallback)];
    const advance = preserveMeasuredAdvance
      ? activeAdvance : lineAdvance(safeRuns, activeAdvance);
    output.push(createTextLine(safeRuns, {
      baseline,
      baselineAdvance: advance,
      alignment: activeAlignment,
      breakAfter,
    }));
    baseline += sign * advance;
    runs = [];
  };

  if (options.manualLineBreaks) {
    for (const sourceLine of document.lines) {
      activeAlignment = sourceLine.alignment;
      activeAdvance = sourceLine.baselineAdvance;
      for (const sourceRun of sourceLine.runs) appendText(runs, sourceRun.text, sourceRun);
      pushLine(sourceLine.breakAfter, true);
    }
  } else {
    for (const sourceLine of document.lines) {
      if (runs.length === 0) {
        activeAlignment = sourceLine.alignment;
        activeAdvance = sourceLine.baselineAdvance;
      }
      for (const sourceRun of sourceLine.runs) {
        const tokens = sourceRun.text.match(/\s+|[^\s]+/gu) || [''];
        for (const token of tokens) {
          const tokenRuns = structuredClone(runs);
          appendText(tokenRuns, token, sourceRun);
          if (runs.length && !/^\s+$/u.test(token)
              && await shapedLineAdvance(tokenRuns) > contentWidth + 1e-6) pushLine('soft');
          for (const unit of graphemes(token)) {
            const candidate = structuredClone(runs);
            appendText(candidate, unit, sourceRun);
            if (runs.length && await shapedLineAdvance(candidate) > contentWidth + 1e-6) pushLine('soft');
            appendText(runs, unit, sourceRun);
          }
        }
      }
      if (sourceLine.breakAfter !== 'soft') pushLine('hard');
    }
  }
  if (runs.length || output.length === 0) pushLine('hard');

  const advanceHeight = output.reduce((sum, line) => sum + line.baselineAdvance, 0);
  let reflowed = createRichTextDocument(output, {
    ...document.region,
    width,
    height: 0,
    y: document.region.y,
  });
  const preliminary = await shapeRichTextDocument(reflowed);
  const requiredHeight = Math.max(
    minimumHeight,
    advanceHeight + inkInsets.top + inkInsets.bottom,
    preliminary.height + inkInsets.top + inkInsets.bottom,
  );
  reflowed = createRichTextDocument(preliminary.lines, {
    ...document.region,
    width,
    height: requiredHeight,
    y: document.region.baselineDirection === 'increasing-y'
      ? document.region.y : anchorTop - requiredHeight,
  });
  const layout = await shapeRichTextDocument(reflowed);
  const maximumLineAdvance = Math.max(0, ...layout.lines.map((line) => (
    line.runs.reduce((sum, run) => sum + (run.shaped?.advance || 0), 0)
  )));
  const requiredWidth = maximumLineAdvance + inkInsets.left + inkInsets.right;
  const inkGeometry = shapedBounds(
    reflowed,
    layout,
    contentWidth,
    inkInsets,
    antialiasMargin,
  );
  const bounds = inkGeometry.bounds;
  const pageBounds = normalizedPageBounds(options.pageBounds);
  const crossesPageEdge = Boolean(pageBounds && (
    bounds.x < pageBounds.x - 1e-6
    || bounds.y < pageBounds.y - 1e-6
    || bounds.x + bounds.width > pageBounds.x + pageBounds.width + 1e-6
    || bounds.y + bounds.height > pageBounds.y + pageBounds.height + 1e-6
  ));
  const regionRect = reflowed.region;
  const columnBounds = normalizedColumnBounds(options.columnBounds);
  const crossesColumnBounds = Boolean(columnBounds && (
    regionRect.x < columnBounds.left - 1e-6
    || regionRect.x + regionRect.width > columnBounds.right + 1e-6
    || bounds.x < columnBounds.left - 1e-6
    || bounds.x + bounds.width > columnBounds.right + 1e-6
  ));
  const overlapWarnings = (options.existingBounds || [])
    .filter((entry) => entry && entry.id !== options.editId && intersects(regionRect, entry))
    .map((entry) => entry.id || 'native-page-content');
  const rejectionReasons = [...layout.rejectionReasons];
  if (options.manualLineBreaks && requiredWidth > width + 1e-6) {
    rejectionReasons.push('A line exceeds the text box width; press Enter to start a new line');
  }
  if (crossesColumnBounds) rejectionReasons.push('Shaped text crosses its native column boundary');
  if (crossesPageEdge) rejectionReasons.push('Shaped text crosses the page CropBox');
  return {
    document: reflowed,
    layout,
    shapedBounds: bounds,
    lineInkBounds: inkGeometry.lineInkBounds,
    editorBounds: { ...reflowed.region },
    inkInsets,
    contentWidth,
    requiredWidth,
    requiredHeight,
    overlapWarnings,
    columnValid: !crossesColumnBounds,
    pageEdgeValid: !crossesPageEdge,
    valid: rejectionReasons.length === 0,
    rejectionReasons: [...new Set(rejectionReasons)],
  };
}
