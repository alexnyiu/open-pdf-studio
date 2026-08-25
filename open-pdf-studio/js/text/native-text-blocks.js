const VISUALLY_EMPTY_TEXT = /^[\p{White_Space}\p{Cf}\p{Cc}]*$/u;

export function isVisibleNativeText(value) {
  return !VISUALLY_EMPTY_TEXT.test(String(value ?? ''));
}

function right(item) {
  return item.pdfX + Math.max(0, item.pdfWidth || 0);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function segmentMetrics(items) {
  const left = Math.min(...items.map((item) => item.pdfX));
  const segmentRight = Math.max(...items.map(right));
  return {
    left,
    right: segmentRight,
    center: (left + segmentRight) / 2,
    baseline: average(items.map((item) => item.pdfY)),
    fontSize: average(items.map((item) => item.fontSize)),
  };
}

function alignmentDistance(block, segment) {
  return Math.min(
    Math.abs(block.anchorLeft - segment.left),
    Math.abs(block.anchorCenter - segment.center),
    Math.abs(block.anchorRight - segment.right),
  );
}

function attachLine(block, line, metrics) {
  block.lines.push(line);
  block.lastBaseline = metrics.baseline;
  block.fontSize = average([block.fontSize, metrics.fontSize]);
  block.left = Math.min(block.left, metrics.left);
  block.right = Math.max(block.right, metrics.right);
  block.anchorLeft = average([block.anchorLeft, metrics.left]);
  block.anchorCenter = average([block.anchorCenter, metrics.center]);
  block.anchorRight = average([block.anchorRight, metrics.right]);
}

function newBlock(line, metrics) {
  return {
    lines: [line],
    firstBaseline: metrics.baseline,
    lastBaseline: metrics.baseline,
    fontSize: metrics.fontSize,
    left: metrics.left,
    right: metrics.right,
    anchorLeft: metrics.left,
    anchorCenter: metrics.center,
    anchorRight: metrics.right,
  };
}

/**
 * Build conservative layout paragraphs from PDF.js fragments.
 *
 * Whitespace/control-only fragments are discarded before any layout decision.
 * Physical lines are split at visible gaps, then each segment is associated
 * with at most one independently tracked column paragraph. Ambiguous matches
 * start a new block rather than joining unrelated content.
 */
export function groupNativeTextFragments(fragments) {
  const visible = (fragments || [])
    .filter((item) => isVisibleNativeText(item.text))
    .filter((item) => [item.pdfX, item.pdfY, item.fontSize].every(Number.isFinite))
    .map((item) => ({ ...item, pdfWidth: Number.isFinite(item.pdfWidth) ? item.pdfWidth : 0 }))
    .sort((left, rightItem) => rightItem.pdfY - left.pdfY || left.pdfX - rightItem.pdfX);
  if (visible.length === 0) return [];

  const physicalLines = [];
  for (const item of visible) {
    const current = physicalLines[physicalLines.length - 1];
    const reference = current?.[0];
    const tolerance = reference ? Math.max(reference.fontSize, item.fontSize) * 0.3 : 0;
    if (!current || Math.abs(item.pdfY - reference.pdfY) > tolerance) {
      physicalLines.push([item]);
    } else {
      current.push(item);
    }
  }
  for (const line of physicalLines) line.sort((left, rightItem) => left.pdfX - rightItem.pdfX);

  const segmentedLines = physicalLines.map((line) => {
    const segments = [];
    let segment = [];
    for (const item of line) {
      const previous = segment[segment.length - 1];
      if (previous) {
        const gap = item.pdfX - right(previous);
        const fontSize = average([previous.fontSize, item.fontSize]);
        if (gap > fontSize * 3) {
          segments.push(segment);
          segment = [];
        }
      }
      segment.push(item);
    }
    if (segment.length) segments.push(segment);
    return segments;
  });

  const blocks = [];
  let active = [];
  for (const segments of segmentedLines) {
    const metrics = segments.map(segmentMetrics);
    const baseline = Math.max(...metrics.map((entry) => entry.baseline));
    active = active.filter((block) => (
      block.lastBaseline - baseline < Math.max(block.fontSize, ...metrics.map((entry) => entry.fontSize)) * 1.8
    ));
    const claimed = new Set();

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const current = metrics[index];
      const candidates = active
        .filter((block) => !claimed.has(block))
        .map((block) => {
          const fontRatio = Math.min(block.fontSize, current.fontSize)
            / Math.max(block.fontSize, current.fontSize);
          const baselineGap = block.lastBaseline - current.baseline;
          const fontSize = average([block.fontSize, current.fontSize]);
          const alignment = alignmentDistance(block, current);
          const eligible = fontRatio > 0.92
            && baselineGap > fontSize * 0.5
            && baselineGap < fontSize * 1.8
            && alignment < fontSize;
          return { block, eligible, score: alignment / fontSize + baselineGap / fontSize * 0.1 };
        })
        .filter((candidate) => candidate.eligible)
        .sort((left, rightItem) => left.score - rightItem.score);

      // When two active columns are comparably plausible, keep them separate.
      const unambiguous = candidates.length === 1
        || (candidates.length > 1 && candidates[1].score - candidates[0].score >= 0.25);
      if (candidates.length && unambiguous) {
        attachLine(candidates[0].block, segment, current);
        claimed.add(candidates[0].block);
      } else {
        const block = newBlock(segment, current);
        blocks.push(block);
        active.push(block);
        claimed.add(block);
      }
    }
  }

  return blocks.sort((left, rightItem) => (
    rightItem.firstBaseline - left.firstBaseline || left.left - rightItem.left
  ));
}

function sourceBoundaryHasSpace(item, edge) {
  const text = String(item.sourceText ?? '');
  return edge === 'start' ? /^\s/u.test(text) : /\s$/u.test(text);
}

export function needsLexicalSpace(left, rightItem) {
  if (!left || !rightItem) return false;
  const leftText = String(left.text ?? '');
  const rightText = String(rightItem.text ?? '');
  if (/\s$/u.test(leftText) || /^\s/u.test(rightText)) return false;
  if (sourceBoundaryHasSpace(left, 'end') || sourceBoundaryHasSpace(rightItem, 'start')) return true;
  const gap = rightItem.pdfX - right(left);
  const fontSize = average([left.fontSize, rightItem.fontSize]);
  return gap > Math.max(fontSize * 0.18, 0.35) && gap < fontSize * 3;
}

export function nativeTextLinePieces(line) {
  const pieces = [];
  for (const item of line || []) {
    const previous = pieces.findLast?.((piece) => !piece.syntheticSpace)?.item
      || [...pieces].reverse().find((piece) => !piece.syntheticSpace)?.item;
    if (previous && needsLexicalSpace(previous, item)) {
      pieces.push({ text: ' ', syntheticSpace: true, item: previous });
    }
    pieces.push({ text: String(item.text ?? ''), syntheticSpace: false, item });
  }
  return pieces;
}

export function collectVisibleNativeTextProvenance(spans) {
  const sources = [];
  const owners = new Set();
  for (const span of spans || []) {
    if (!isVisibleNativeText(span?.textContent)) continue;
    let linked;
    try { linked = JSON.parse(span?.dataset?.nativeTextProvenance || 'null'); }
    catch (_) { return null; }
    if (!Array.isArray(linked) || linked.length === 0) return null;
    for (const source of linked) {
      const owner = `${source.streamObjectId}:${source.operatorIndex}`;
      if (owners.has(owner)) continue;
      owners.add(owner);
      sources.push(source);
    }
  }
  if (sources.length === 0 || sources.some((source) => !source?.eligibility?.eligible)) return null;
  return sources;
}
