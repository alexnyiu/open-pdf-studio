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

function cancelledError() {
  return Object.assign(new Error('Exact text layout was superseded'), {
    code: 'TEXT_LAYOUT_CANCELLED',
  });
}

async function checkpoint(options, count, force = false) {
  if (options.shouldCancel?.()) throw cancelledError();
  if (!force && count % Math.max(32, Number(options.yieldEvery) || 256) !== 0) return;
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (options.shouldCancel?.()) throw cancelledError();
}

async function shapedGraphemeAdvances(run, options = {}) {
  const units = graphemes(run.text);
  if (units.length === 0) return [];
  const shaped = await shapeTextRun(run);
  const starts = [];
  let codeUnitOffset = 0;
  const yieldEvery = Math.max(32, Number(options.yieldEvery) || 256);
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const unit = units[unitIndex];
    starts.push(codeUnitOffset);
    codeUnitOffset += unit.length;
    if ((unitIndex + 1) % yieldEvery === 0) await checkpoint(options, unitIndex + 1, true);
  }
  // Resolve arbitrary font cluster order in O(code units + glyphs). The old
  // per-glyph reverse scan became quadratic for long paste input and could not
  // observe a superseding Worker request until the whole mapping completed.
  const clusterToUnit = new Uint32Array(codeUnitOffset + 1);
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const start = starts[unitIndex];
    const end = start + units[unitIndex].length;
    clusterToUnit.fill(unitIndex, start, end);
    if ((unitIndex + 1) % yieldEvery === 0) await checkpoint(options, unitIndex + 1, true);
  }
  if (units.length > 0) clusterToUnit[codeUnitOffset] = units.length - 1;
  const advances = units.map(() => 0);
  const glyphs = shaped.glyphs || [];
  for (let glyphIndex = 0; glyphIndex < glyphs.length; glyphIndex += 1) {
    const glyph = glyphs[glyphIndex];
    const cluster = Math.min(codeUnitOffset, Math.max(0, Math.floor(Number(glyph.cluster) || 0)));
    const index = clusterToUnit[cluster];
    advances[index] += Number(glyph.advance) || 0;
    if ((glyphIndex + 1) % yieldEvery === 0) await checkpoint(options, glyphIndex + 1, true);
  }
  // Font engines without cluster information still retain the exact run
  // advance and distribute it deterministically for wrapping decisions.
  const assigned = advances.reduce((sum, value) => sum + value, 0);
  if (assigned <= 0 && shaped.advance > 0) {
    const share = shaped.advance / units.length;
    advances.fill(share);
  }
  return units.map((text, index) => ({ text, advance: advances[index] || 0 }));
}

const TRAILING_UNICODE_WHITESPACE = /\p{White_Space}+$/u;

/**
 * Width of glyphs that actually paint on a visual line. A soft-wrap separator
 * remains in canonical text, but trailing Unicode whitespace has no visible
 * width for capacity or paragraph alignment.
 */
async function paintedLineAdvance(line, options = {}) {
  let lastVisibleRun = -1;
  for (let index = line.runs.length - 1; index >= 0; index -= 1) {
    if (line.runs[index].text.replace(TRAILING_UNICODE_WHITESPACE, '').length > 0) {
      lastVisibleRun = index;
      break;
    }
  }
  if (lastVisibleRun < 0) return 0;

  let advance = 0;
  for (let index = 0; index <= lastVisibleRun; index += 1) {
    const run = line.runs[index];
    if (index < lastVisibleRun || !TRAILING_UNICODE_WHITESPACE.test(run.text)) {
      advance += Number(run.shaped?.advance) || 0;
    } else {
      const visibleText = run.text.replace(TRAILING_UNICODE_WHITESPACE, '');
      if (visibleText) advance += (await shapeTextRun(createTextRun(visibleText, run))).advance;
    }
    await checkpoint(options, index + 1);
  }
  return advance;
}

async function documentInkInsets(document, inkPadding = 0, antialiasMargin = 1, options = {}) {
  let leftOverhang = 0;
  let rightOverhang = 0;
  let shapedRuns = 0;
  for (const line of document.lines) {
    for (const run of line.runs) {
      const shaped = await shapeTextRun(run);
      leftOverhang = Math.max(leftOverhang, -shaped.inkBounds.left);
      rightOverhang = Math.max(rightOverhang, shaped.inkBounds.right - shaped.advance);
      await checkpoint(options, ++shapedRuns);
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

function shapedBounds(
  document,
  layout,
  contentWidth,
  contentInset,
  paintedLineAdvances,
  antialiasMargin = 1,
) {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  const lineInkBounds = [];
  for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex += 1) {
    const line = layout.lines[lineIndex];
    const lineAdvanceWidth = paintedLineAdvances?.[lineIndex]
      ?? line.runs.reduce((sum, run) => sum + (run.shaped?.advance || 0), 0);
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
      // `contentInset` is part of the canonical PDF geometry. Editor-only ink
      // safety (antialiasing and glyph overhang) must never move the persisted
      // text origin away from document.region.x.
      const runX = document.region.x + contentInset + alignmentOffset + (run.geometry?.x || 0);
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
  const requestedContentWidth = Number(options.contentWidth);
  const hasExplicitContentWidth = Number.isFinite(requestedContentWidth)
    && requestedContentWidth > 0;
  const contentInset = hasExplicitContentWidth
    ? Math.max(0, Number(options.contentInset) || 0)
    : null;
  await checkpoint(options, 0, true);
  const inkInsets = await documentInkInsets(document, inkPadding, antialiasMargin, options);
  // Legacy callers treat width as an outer ink-safe editor width. New callers
  // provide the authored content width explicitly so visual AA/overhang never
  // steals horizontal capacity from the canonical draft.
  const contentWidth = hasExplicitContentWidth
    ? requestedContentWidth
    : width - inkInsets.left - inkInsets.right;
  if (!(contentWidth > 0)) throw new Error('Expandable native text has no ink-safe content width');
  const canonicalContentInset = hasExplicitContentWidth ? contentInset : inkInsets.left;
  const canonicalVerticalInset = hasExplicitContentWidth ? contentInset : null;
  const canonicalAntialiasMargin = hasExplicitContentWidth ? 0 : antialiasMargin;
  const minimumHeight = Math.max(0, Number(options.minimumHeight ?? document.region.height) || 0);
  const anchorTop = Number.isFinite(options.anchorTop)
    ? options.anchorTop : document.region.y + document.region.height;
  const sign = document.region.baselineDirection === 'increasing-y' ? 1 : -1;
  const output = [];
  let runs = [];
  let baseline = document.lines[0].baseline;
  let activeAlignment = document.lines[0].alignment;
  let activeAdvance = document.lines[0].baselineAdvance;
  let runningWidth = 0;
  let processedUnits = 0;

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
    runningWidth = 0;
  };

  if (options.manualLineBreaks) {
    for (const sourceLine of document.lines) {
      activeAlignment = sourceLine.alignment;
      activeAdvance = sourceLine.baselineAdvance;
      for (const sourceRun of sourceLine.runs) appendText(runs, sourceRun.text, sourceRun);
      pushLine(sourceLine.breakAfter, true);
      await checkpoint(options, ++processedUnits);
    }
  } else {
    for (const sourceLine of document.lines) {
      if (runs.length === 0) {
        activeAlignment = sourceLine.alignment;
        activeAdvance = sourceLine.baselineAdvance;
      }
      for (const sourceRun of sourceLine.runs) {
        const units = await shapedGraphemeAdvances(sourceRun, options);
        let unitIndex = 0;
        while (unitIndex < units.length) {
          const whitespace = /^\s$/u.test(units[unitIndex].text);
          let tokenEnd = unitIndex + 1;
          while (tokenEnd < units.length
              && /^\s$/u.test(units[tokenEnd].text) === whitespace) tokenEnd += 1;
          const tokenWidth = units.slice(unitIndex, tokenEnd)
            .reduce((sum, unit) => sum + unit.advance, 0);
          if (runs.length && !whitespace && runningWidth + tokenWidth > contentWidth + 1e-6) {
            pushLine('soft');
          }
          for (; unitIndex < tokenEnd; unitIndex += 1) {
            const unit = units[unitIndex];
            if (runs.length && runningWidth + unit.advance > contentWidth + 1e-6) pushLine('soft');
            appendText(runs, unit.text, sourceRun);
            runningWidth += unit.advance;
            await checkpoint(options, ++processedUnits);
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
  const preliminary = await shapeRichTextDocument(reflowed, {
    antialiasMargin: canonicalAntialiasMargin,
  });
  await checkpoint(options, ++processedUnits, true);
  const requiredHeight = Math.max(
    minimumHeight,
    advanceHeight + (hasExplicitContentWidth
      ? canonicalVerticalInset * 2 : inkInsets.top + inkInsets.bottom),
    preliminary.height + (hasExplicitContentWidth
      ? canonicalVerticalInset * 2 : inkInsets.top + inkInsets.bottom),
  );
  reflowed = createRichTextDocument(preliminary.lines, {
    ...document.region,
    width,
    height: requiredHeight,
    y: document.region.baselineDirection === 'increasing-y'
      ? document.region.y : anchorTop - requiredHeight,
  });
  const layout = await shapeRichTextDocument(reflowed, {
    antialiasMargin: canonicalAntialiasMargin,
  });
  await checkpoint(options, ++processedUnits, true);
  const fullLineAdvances = layout.lines.map((line) => (
    line.runs.reduce((sum, run) => sum + (run.shaped?.advance || 0), 0)
  ));
  const paintedLineAdvances = [];
  if (hasExplicitContentWidth) {
    for (const line of layout.lines) {
      paintedLineAdvances.push(await paintedLineAdvance(line, options));
    }
  } else {
    paintedLineAdvances.push(...fullLineAdvances);
  }
  const maximumLineAdvance = Math.max(0, ...paintedLineAdvances);
  const requiredWidth = maximumLineAdvance + (hasExplicitContentWidth
    ? canonicalContentInset * 2 : inkInsets.left + inkInsets.right);
  const inkGeometry = shapedBounds(
    reflowed,
    layout,
    contentWidth,
    canonicalContentInset,
    paintedLineAdvances,
    canonicalAntialiasMargin,
  );
  const bounds = inkGeometry.bounds;
  const regionRect = reflowed.region;
  const pageBounds = normalizedPageBounds(options.pageBounds);
  const crossesPageEdge = Boolean(pageBounds && (
    bounds.x < pageBounds.x - 1e-6
    || bounds.y < pageBounds.y - 1e-6
    || bounds.x + bounds.width > pageBounds.x + pageBounds.width + 1e-6
    || bounds.y + bounds.height > pageBounds.y + pageBounds.height + 1e-6
    || regionRect.x < pageBounds.x - 1e-6
    || regionRect.y < pageBounds.y - 1e-6
    || regionRect.x + regionRect.width > pageBounds.x + pageBounds.width + 1e-6
    || regionRect.y + regionRect.height > pageBounds.y + pageBounds.height + 1e-6
  ));
  const columnBounds = normalizedColumnBounds(options.columnBounds);
  const crossesColumnBounds = Boolean(columnBounds && (
    regionRect.x < columnBounds.left - 1e-6
    || regionRect.x + regionRect.width > columnBounds.right + 1e-6
    || bounds.x < columnBounds.left - 1e-6
    || bounds.x + bounds.width > columnBounds.right + 1e-6
  ));
  const overlapWarnings = (options.existingBounds || [])
    .filter((entry) => entry && entry.id !== options.editId
      && inkGeometry.lineInkBounds.some((lineBounds) => intersects(lineBounds, entry)))
    .map((entry) => entry.id || 'native-page-content');
  // Expandable layout owns width and height validation. The generic shaper's
  // fixed-region checks include visual ink/AA bounds and therefore reject
  // otherwise valid authored advances; preserve only genuine shaping errors.
  const rejectionReasons = layout.rejectionReasons.filter((reason) => (
    reason !== 'Text overflows fixed region width'
      && reason !== 'Text overflows fixed region height'
  ));
  if (maximumLineAdvance > contentWidth + 1e-6) {
    rejectionReasons.push(options.manualLineBreaks
      ? 'A line exceeds the text box width; press Enter to start a new line'
      : 'Text exceeds the available content width');
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
    contentInset: canonicalContentInset,
    contentInsets: hasExplicitContentWidth ? {
      left: canonicalContentInset,
      right: canonicalContentInset,
      top: canonicalVerticalInset,
      bottom: canonicalVerticalInset,
    } : { ...inkInsets },
    contentWidth,
    fullLineAdvances,
    paintedLineAdvances,
    requiredWidth,
    requiredHeight,
    overlapWarnings,
    columnValid: !crossesColumnBounds,
    pageEdgeValid: !crossesPageEdge,
    valid: rejectionReasons.length === 0,
    rejectionReasons: [...new Set(rejectionReasons)],
  };
}
