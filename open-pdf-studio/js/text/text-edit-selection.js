import {
  createRichTextDocument,
  createTextLine,
  createTextRun,
  graphemes,
} from './rich-text.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

export function selectionItemCenter(item) {
  const rect = item?.viewRect || item?.geometry;
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
}

export function marqueeContainsSelectionItem(marquee, item) {
  const center = selectionItemCenter(item);
  return Boolean(center && center.x >= marquee.left && center.x <= marquee.left + marquee.width
    && center.y >= marquee.top && center.y <= marquee.top + marquee.height);
}

export function sortTextEditSelectionItems(items) {
  return [...items].sort((left, right) => {
    const a = left.viewRect || left.geometry;
    const b = right.viewRect || right.geometry;
    const tolerance = Math.max(2, Math.min(a.height || 0, b.height || 0) * 0.45);
    const aBaseline = Number.isFinite(left.visualBaseline) ? left.visualBaseline : a.top + a.height;
    const bBaseline = Number.isFinite(right.visualBaseline) ? right.visualBaseline : b.top + b.height;
    if (Math.abs(aBaseline - bBaseline) <= tolerance) return a.left - b.left;
    return a.top - b.top || a.left - b.left;
  });
}

export function unionSelectionGeometry(items, field = 'geometry') {
  if (!items.length) return null;
  const rects = items.map((item) => item[field] || item.geometry);
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

function provenanceKey(source) {
  return String(source?.markerId || [source?.pageIndex, source?.objectId, source?.operatorIndex].join(':'));
}

function mergeProvenance(items) {
  const output = [];
  const seen = new Set();
  for (const source of items.flatMap((item) => item.sourceProvenance || [])) {
    const key = provenanceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(clone(source));
  }
  return output.length ? output : null;
}

function mergeDocuments(items, region, { normalizeBaselines = true } = {}) {
  const lines = [];
  for (const item of items) {
    const sourceLines = item.richText.lines;
    sourceLines.forEach((line, index) => lines.push(createTextLine(line.runs, {
      ...line,
      breakAfter: index === sourceLines.length - 1 ? 'hard' : line.breakAfter,
    })));
  }
  if (normalizeBaselines) {
    const first = lines[0];
    const sign = items[0].richText.region.baselineDirection === 'increasing-y' ? 1 : -1;
    let baseline = first.baseline;
    lines.forEach((line, index) => {
      if (index > 0) baseline += sign * lines[index - 1].baselineAdvance;
      line.baseline = baseline;
    });
  }
  return createRichTextDocument(lines, {
    x: region.left,
    y: region.top,
    width: region.width,
    height: region.height,
    rotation: items[0].rotation,
    baselineDirection: items[0].richText.region.baselineDirection,
  });
}

export function buildMergedTextEditSelection(items, { createId = () => `edit-${Date.now()}` } = {}) {
  if (!Array.isArray(items) || items.length < 2) throw new Error('Select at least two text boxes');
  const sorted = sortTextEditSelectionItems(items);
  const page = sorted[0].page;
  const rotation = sorted[0].rotation;
  if (sorted.some((item) => item.page !== page)) throw new Error('Selected text boxes must be on the same page');
  if (sorted.some((item) => item.rotation !== rotation)) throw new Error('Selected text boxes use incompatible rotation');
  if (sorted.some((item) => item.kind === 'scannedText')) throw new Error('Scanned text boxes cannot be combined');
  if (sorted.some((item) => !item.richText || item.eligible === false)) {
    throw new Error('Every selected visible text box must have validated editable ownership');
  }
  if (sorted.some((item) => item.substitution && item.substitution.approved !== true)) {
    throw new Error('Every required font substitution must be approved');
  }
  const geometry = unionSelectionGeometry(sorted);
  const existing = sorted.filter((item) => item.sourceRecord);
  const primary = existing[0]?.sourceRecord || null;
  const richText = mergeDocuments(sorted, geometry);
  const originalItems = sorted.filter((item) => item.original || item.kind === 'native').map((item) => ({
    ...item,
    richText: item.original || item.richText,
  }));
  return {
    orderedItems: sorted,
    primaryId: primary?.id || createId(),
    revision: primary ? Number(primary.revision || 1) + 1 : 1,
    page,
    rotation,
    geometry,
    richText,
    // Preserve the separate source boxes' physical baselines in the immutable
    // original snapshot. The editable copy is normalized into one paragraph.
    // This also makes an intentional native-only merge persistable when the
    // user accepts it without changing any words.
    original: originalItems.length ? mergeDocuments(originalItems, geometry, { normalizeBaselines: false }) : null,
    sourceProvenance: mergeProvenance(sorted),
    substitution: sorted.map((item) => item.substitution).find(Boolean) || null,
    consumedRecords: existing.map((item) => item.sourceRecord),
  };
}

function estimatedAdvance(grapheme, style) {
  if (/\s/u.test(grapheme)) return style.size * 0.32;
  if (/^[ilI.,'`]$/u.test(grapheme)) return style.size * 0.28;
  if (/^[MW@#]$/u.test(grapheme)) return style.size * 0.86;
  return style.size * (style.faceId?.includes('-mono-') ? 0.6 : 0.54);
}

function flowedRegion(document, width, contentHeight, options = {}) {
  const minimumHeight = Math.max(0, Number(options.minimumHeight ?? document.region.height) || 0);
  const height = Math.max(minimumHeight, contentHeight);
  const anchorTop = Number.isFinite(options.anchorTop)
    ? options.anchorTop : document.region.y + document.region.height;
  return {
    ...document.region,
    width,
    height,
    y: document.region.baselineDirection === 'increasing-y'
      ? document.region.y : anchorTop - height,
  };
}

/** Deterministic immediate reflow. Exact fontkit shaping follows asynchronously. */
export function reflowRichTextToWidth(document, width, measure = estimatedAdvance, options = {}) {
  if (!(width > 0)) throw new Error('Reflow width must be positive');
  const output = [];
  let lineRuns = [];
  let lineWidth = 0;
  let baseline = document.lines[0].baseline;
  let lineAlignment = document.lines[0].alignment;
  const sign = document.region.baselineDirection === 'increasing-y' ? 1 : -1;
  const pushLine = (breakAfter) => {
    const fallback = lineRuns[0] || document.lines[0].runs[0];
    const advance = Math.max(...(lineRuns.length ? lineRuns : [fallback]).map((run) => run.size)) * 1.2;
    output.push(createTextLine(lineRuns.length ? lineRuns : [createTextRun('', fallback)], {
      baseline,
      baselineAdvance: advance,
      alignment: lineAlignment,
      breakAfter,
    }));
    baseline += sign * advance;
    lineRuns = [];
    lineWidth = 0;
  };
  const append = (unit, style) => {
    const previous = lineRuns.at(-1);
    if (previous && ['faceId','size','color','bold','italic','underline','strikeout','direction']
      .every((key) => previous[key] === style[key])) previous.text += unit;
    else lineRuns.push(createTextRun(unit, style));
  };
  for (const sourceLine of document.lines) {
    if (lineRuns.length === 0) lineAlignment = sourceLine.alignment;
    for (const run of sourceLine.runs) {
      const tokens = run.text.match(/\s+|[^\s]+/gu) || [''];
      for (const token of tokens) {
        const units = graphemes(token);
        const tokenWidth = units.reduce((sum, unit) => sum + measure(unit, run), 0);
        if (lineRuns.length && lineWidth + tokenWidth > width && !/^\s+$/u.test(token)) pushLine('soft');
        for (const unit of units) {
          const advance = measure(unit, run);
          if (lineRuns.length && lineWidth + advance > width) pushLine('soft');
          append(unit, run);
          lineWidth += advance;
        }
      }
    }
    if (sourceLine.breakAfter !== 'soft') pushLine('hard');
  }
  if (lineRuns.length || output.length === 0) pushLine('hard');
  const height = output.reduce((sum, line) => sum + line.baselineAdvance, 0);
  return createRichTextDocument(output, flowedRegion(document, width, height, options));
}
