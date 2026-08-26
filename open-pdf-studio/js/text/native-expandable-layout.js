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

async function shapedLineWidth(runs, antialiasMargin = 1) {
  let advance = 0;
  let left = 0;
  let right = 0;
  for (const run of runs) {
    const shaped = await shapeTextRun(run);
    left = Math.min(left, advance + shaped.inkBounds.left - antialiasMargin);
    right = Math.max(right, advance + shaped.inkBounds.right + antialiasMargin, advance + shaped.advance);
    advance += shaped.advance;
  }
  return right - left;
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

function shapedBounds(document, layout, antialiasMargin = 1) {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (const line of layout.lines) {
    const lineAdvanceWidth = line.runs.reduce((sum, run) => sum + (run.shaped?.advance || 0), 0);
    const alignmentOffset = line.alignment === 'center'
      ? (document.region.width - lineAdvanceWidth) / 2
      : line.alignment === 'right' ? document.region.width - lineAdvanceWidth : 0;
    for (const run of line.runs) {
      const shaped = run.shaped;
      if (!shaped) continue;
      const runX = document.region.x + alignmentOffset + (run.geometry?.x || 0);
      left = Math.min(left, runX + shaped.inkBounds.left - antialiasMargin);
      right = Math.max(right, runX + shaped.inkBounds.right + antialiasMargin);
      bottom = Math.min(bottom, line.baseline - shaped.metrics.descent - antialiasMargin);
      top = Math.max(top, line.baseline + shaped.metrics.ascent + antialiasMargin);
    }
  }
  if (![left, right, bottom, top].every(Number.isFinite)) {
    return { x: document.region.x, y: document.region.y, width: 0, height: 0 };
  }
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

/**
 * Exact native-only reflow. Width stays fixed, authored hard breaks survive,
 * generated wraps become soft, and the immutable top edge remains anchored.
 */
export async function layoutExpandableNativeText(document, options = {}) {
  const width = Number(options.width ?? document.region.width);
  if (!(width > 0)) throw new Error('Expandable native text width must be positive');
  const minimumHeight = Math.max(0, Number(options.minimumHeight ?? document.region.height) || 0);
  const anchorTop = Number.isFinite(options.anchorTop)
    ? options.anchorTop : document.region.y + document.region.height;
  const sign = document.region.baselineDirection === 'increasing-y' ? 1 : -1;
  const output = [];
  let runs = [];
  let baseline = document.lines[0].baseline;
  let activeAlignment = document.lines[0].alignment;
  let activeAdvance = document.lines[0].baselineAdvance;

  const pushLine = (breakAfter) => {
    const fallback = runs[0] || document.lines[0].runs[0];
    const safeRuns = runs.length ? runs : [createTextRun('', fallback)];
    const advance = lineAdvance(safeRuns, activeAdvance);
    output.push(createTextLine(safeRuns, {
      baseline,
      baselineAdvance: advance,
      alignment: activeAlignment,
      breakAfter,
    }));
    baseline += sign * advance;
    runs = [];
  };

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
            && await shapedLineWidth(tokenRuns) > width + 1e-6) pushLine('soft');
        for (const unit of graphemes(token)) {
          const candidate = structuredClone(runs);
          appendText(candidate, unit, sourceRun);
          if (runs.length && await shapedLineWidth(candidate) > width + 1e-6) pushLine('soft');
          appendText(runs, unit, sourceRun);
        }
      }
    }
    if (sourceLine.breakAfter !== 'soft') pushLine('hard');
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
  const requiredHeight = Math.max(minimumHeight, advanceHeight, preliminary.height);
  reflowed = createRichTextDocument(preliminary.lines, {
    ...document.region,
    width,
    height: requiredHeight,
    y: document.region.baselineDirection === 'increasing-y'
      ? document.region.y : anchorTop - requiredHeight,
  });
  const layout = await shapeRichTextDocument(reflowed);
  const bounds = shapedBounds(reflowed, layout);
  const pageBounds = normalizedPageBounds(options.pageBounds);
  const crossesPageEdge = Boolean(pageBounds && (
    bounds.x < pageBounds.x - 1e-6
    || bounds.y < pageBounds.y - 1e-6
    || bounds.x + bounds.width > pageBounds.x + pageBounds.width + 1e-6
    || bounds.y + bounds.height > pageBounds.y + pageBounds.height + 1e-6
  ));
  const regionRect = reflowed.region;
  const overlapWarnings = (options.existingBounds || [])
    .filter((entry) => entry && entry.id !== options.editId && intersects(regionRect, entry))
    .map((entry) => entry.id || 'native-page-content');
  const rejectionReasons = [...layout.rejectionReasons];
  if (crossesPageEdge) rejectionReasons.push('Shaped text crosses the page CropBox');
  return {
    document: reflowed,
    layout,
    shapedBounds: bounds,
    requiredHeight,
    overlapWarnings,
    pageEdgeValid: !crossesPageEdge,
    valid: rejectionReasons.length === 0,
    rejectionReasons: [...new Set(rejectionReasons)],
  };
}
