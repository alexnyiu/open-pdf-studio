import { PARAGRAPH_BOUNDARY_JOIN, scoreParagraphBoundary } from './paragraph-boundaries.js';

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

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, rightItem) => left - rightItem);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : average([sorted[middle - 1], sorted[middle]]);
}

function normalizedFontFamily(item) {
  const value = item.fontFamily || item.actualFontName || item.fontName || '';
  return String(value).trim().toLocaleLowerCase() || null;
}

function segmentMetrics(items) {
  const left = Math.min(...items.map((item) => item.pdfX));
  const segmentRight = Math.max(...items.map(right));
  const families = new Set(items.map(normalizedFontFamily).filter(Boolean));
  const sizes = new Set(items.map((item) => Number(item.fontSize).toFixed(3)));
  return {
    left,
    right: segmentRight,
    center: (left + segmentRight) / 2,
    baseline: average(items.map((item) => item.pdfY)),
    fontSize: average(items.map((item) => item.fontSize)),
    leadingFontSize: items[0].fontSize,
    trailingFontSize: items.at(-1).fontSize,
    leadingFontFamily: normalizedFontFamily(items[0]),
    trailingFontFamily: normalizedFontFamily(items.at(-1)),
    mixedInlineStyles: families.size > 1 || sizes.size > 1,
  };
}

function alignmentDistance(block, segment) {
  return Math.min(
    Math.abs(block.anchorLeft - segment.left),
    Math.abs(block.anchorCenter - segment.center),
    Math.abs(block.anchorRight - segment.right),
  );
}

function segmentText(items) {
  return nativeTextLinePieces(items).map((piece) => piece.text).join('');
}

function sharedBoundaryAllowsJoin(block, segment, current, baselineGap) {
  const previousSegment = block.lines.at(-1);
  const previous = block.lastMetrics || segmentMetrics(previousSegment);
  const fontSize = average([previous.fontSize, current.fontSize]);
  const edgeSizeRatio = Math.min(previous.trailingFontSize, current.leadingFontSize)
    / Math.max(previous.trailingFontSize, current.leadingFontSize);
  const sharedFontFamily = previous.trailingFontFamily && current.leadingFontFamily
    ? previous.trailingFontFamily === current.leadingFontFamily
    : null;
  return scoreParagraphBoundary({
    id: 'native-previous', text: segmentText(previousSegment), columnId: block.columnId,
    geometryValid: true, direction: 'ltr', left: previous.left, top: 0,
    bottom: previous.fontSize, width: previous.right - previous.left,
    height: previous.fontSize, angle: 0,
  }, {
    id: 'native-next', text: segmentText(segment), columnId: current.columnId,
    geometryValid: true, direction: 'ltr', left: current.left,
    top: baselineGap, bottom: baselineGap + current.fontSize,
    width: current.right - current.left, height: current.fontSize, angle: 0,
  }, {
    medianHeight: fontSize,
    medianGap: Math.max(1, baselineGap - fontSize),
    medianWidth: Math.max(previous.right - previous.left, current.right - current.left),
    gap: Math.max(0, baselineGap - fontSize),
    styleEvidence: {
      edgeSizeRatio,
      sharedFontFamily,
      mixedInlineStyles: previous.mixedInlineStyles || current.mixedInlineStyles,
    },
  }).decision === PARAGRAPH_BOUNDARY_JOIN;
}

function attachLine(block, line, metrics) {
  block.lines.push(line);
  block.lastBaseline = metrics.baseline;
  block.lastMetrics = metrics;
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
    lastMetrics: metrics,
    fontSize: metrics.fontSize,
    left: metrics.left,
    right: metrics.right,
    anchorLeft: metrics.left,
    anchorCenter: metrics.center,
    anchorRight: metrics.right,
    columnId: metrics.columnId,
    columnBounds: metrics.columnBounds,
  };
}

function buildPhysicalLines(visible) {
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
  return physicalLines;
}

function lineCrosses(line, x) {
  return line.some((item) => item.pdfX < x && right(item) > x);
}

function gapObservations(physicalLines) {
  const observations = [];
  physicalLines.forEach((line, lineIndex) => {
    for (let index = 1; index < line.length; index += 1) {
      const previous = line[index - 1];
      const current = line[index];
      const left = right(previous);
      const rightEdge = current.pdfX;
      const width = rightEdge - left;
      const fontSize = average([previous.fontSize, current.fontSize]);
      if (width < Math.max(2, fontSize * 1.25)) continue;
      observations.push({ lineIndex, left, right: rightEdge, width, fontSize });
    }
  });
  return observations;
}

function addObservation(cluster, observation) {
  cluster.observations.push(observation);
  cluster.left = Math.max(cluster.left, observation.left);
  cluster.right = Math.min(cluster.right, observation.right);
  cluster.firstLine = Math.min(cluster.firstLine, observation.lineIndex);
  cluster.lastLine = Math.max(cluster.lastLine, observation.lineIndex);
}

function clusteredGutters(physicalLines) {
  const clusters = [];
  for (const observation of gapObservations(physicalLines)) {
    const compatible = clusters
      .filter((cluster) => observation.lineIndex - cluster.lastLine <= 2)
      .map((cluster) => ({
        cluster,
        left: Math.max(cluster.left, observation.left),
        right: Math.min(cluster.right, observation.right),
      }))
      .filter((entry) => entry.right > entry.left)
      .sort((left, rightItem) => (rightItem.right - rightItem.left) - (left.right - left.left));
    if (compatible.length) addObservation(compatible[0].cluster, observation);
    else {
      clusters.push({
        observations: [observation],
        left: observation.left,
        right: observation.right,
        firstLine: observation.lineIndex,
        lastLine: observation.lineIndex,
      });
    }
  }

  return clusters.filter((cluster) => {
    const supportingLines = new Set(cluster.observations.map((entry) => entry.lineIndex));
    const fontSize = median(cluster.observations.map((entry) => entry.fontSize));
    const width = cluster.right - cluster.left;
    return (supportingLines.size >= 2 && width >= Math.max(2, fontSize * 1.25))
      || width > fontSize * 3;
  });
}

function expandGutterTrack(track, physicalLines) {
  const center = (track.left + track.right) / 2;
  let startLine = track.firstLine;
  let endLine = track.lastLine;
  const canExtend = (fromIndex, toIndex) => {
    const from = physicalLines[fromIndex];
    const to = physicalLines[toIndex];
    const baselineGap = Math.abs(from[0].pdfY - to[0].pdfY);
    const fontSize = Math.max(...from.concat(to).map((item) => item.fontSize));
    return baselineGap <= fontSize * 2.4 && !lineCrosses(to, center);
  };
  while (startLine > 0 && canExtend(startLine, startLine - 1)) startLine -= 1;
  while (endLine + 1 < physicalLines.length && canExtend(endLine, endLine + 1)) endLine += 1;
  return { ...track, center, startLine, endLine };
}

function detectColumnTracksForLines(physicalLines) {
  return clusteredGutters(physicalLines)
    .map((track) => expandGutterTrack(track, physicalLines))
    .sort((left, rightItem) => left.startLine - rightItem.startLine || left.center - rightItem.center)
    .map((track, index) => ({
      id: `native-gutter-${index}-${track.center.toFixed(3)}`,
      left: track.left,
      right: track.right,
      center: track.center,
      startLine: track.startLine,
      endLine: track.endLine,
      supportLineCount: new Set(track.observations.map((entry) => entry.lineIndex)).size,
    }));
}

/**
 * Infer local, canonical PDF-space column gutters without using DOM geometry,
 * fills, borders, or colors. IDs are deterministic for the same source layout.
 */
export function detectNativeColumnTracks(fragments) {
  const visible = (fragments || [])
    .filter((item) => isVisibleNativeText(item.text))
    .filter((item) => [item.pdfX, item.pdfY, item.fontSize].every(Number.isFinite))
    .map((item) => ({ ...item, pdfWidth: Number.isFinite(item.pdfWidth) ? item.pdfWidth : 0 }))
    .sort((left, rightItem) => rightItem.pdfY - left.pdfY || left.pdfX - rightItem.pdfX);
  return detectColumnTracksForLines(buildPhysicalLines(visible));
}

function segmentPhysicalLines(physicalLines, tracks) {
  const pageLeft = Math.min(...physicalLines.flat().map((item) => item.pdfX));
  const pageRight = Math.max(...physicalLines.flat().map(right));
  const outerMargin = Math.max(2, median(physicalLines.flat().map((item) => item.fontSize)) * 0.25);
  const outerLeft = pageLeft - outerMargin;
  const outerRight = pageRight + outerMargin;
  return physicalLines.map((line, lineIndex) => {
    const gutters = tracks
      .filter((track) => track.startLine <= lineIndex && track.endLine >= lineIndex)
      .filter((track) => !lineCrosses(line, track.center))
      .sort((left, rightItem) => left.center - rightItem.center);
    if (gutters.length === 0) {
      const isolated = [[]];
      const boundaries = [];
      for (const item of line) {
        const previous = isolated.at(-1).at(-1);
        if (previous) {
          const gap = item.pdfX - right(previous);
          const fontSize = average([previous.fontSize, item.fontSize]);
          if (gap > fontSize * 3) {
            boundaries.push({ left: right(previous), right: item.pdfX });
            isolated.push([]);
          }
        }
        isolated.at(-1).push(item);
      }
      if (isolated.length === 1) {
        return [{
          items: line,
          columnId: 'native-column-full',
          columnBounds: { left: outerLeft, right: outerRight },
        }];
      }
      return isolated.map((items, laneIndex) => ({
        items,
        columnId: `native-isolated-${line[0].pdfY.toFixed(3)}:lane-${laneIndex}`,
        columnBounds: {
          left: laneIndex === 0 ? outerLeft : boundaries[laneIndex - 1].right,
          right: laneIndex === isolated.length - 1 ? outerRight : boundaries[laneIndex].left,
        },
      }));
    }
    const segments = Array.from({ length: gutters.length + 1 }, () => []);
    for (const item of line) {
      const itemCenter = (item.pdfX + right(item)) / 2;
      const laneIndex = gutters.filter((gutter) => itemCenter > gutter.center).length;
      segments[laneIndex].push(item);
    }
    return segments.flatMap((items, laneIndex) => {
      if (items.length === 0) return [];
      const leftBoundary = laneIndex === 0 ? outerLeft : gutters[laneIndex - 1].center;
      const rightBoundary = laneIndex === gutters.length ? outerRight : gutters[laneIndex].center;
      const trackKey = gutters.map((gutter) => gutter.id).join('|');
      return [{
        items,
        columnId: `${trackKey}:lane-${laneIndex}`,
        columnBounds: { left: leftBoundary, right: rightBoundary },
      }];
    });
  });
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

  const physicalLines = buildPhysicalLines(visible);
  const tracks = detectColumnTracksForLines(physicalLines);
  const segmentedLines = segmentPhysicalLines(physicalLines, tracks);

  const blocks = [];
  let active = [];
  for (const segments of segmentedLines) {
    const metrics = segments.map((segment) => ({
      ...segmentMetrics(segment.items),
      columnId: segment.columnId,
      columnBounds: segment.columnBounds,
    }));
    const baseline = Math.max(...metrics.map((entry) => entry.baseline));
    active = active.filter((block) => (
      block.lastBaseline - baseline
        < Math.max(block.lastMetrics.fontSize, ...metrics.map((entry) => entry.fontSize)) * 1.8
    ));
    const claimed = new Set();

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index].items;
      const current = metrics[index];
      const candidates = active
        .filter((block) => !claimed.has(block))
        .filter((block) => block.columnId === current.columnId)
        .map((block) => {
          const baselineGap = block.lastBaseline - current.baseline;
          const fontSize = average([block.lastMetrics.fontSize, current.fontSize]);
          const alignment = alignmentDistance(block, current);
          const eligible = baselineGap > fontSize * 0.5
            && baselineGap < fontSize * 1.8
            && alignment < fontSize
            && sharedBoundaryAllowsJoin(block, segment, current, baselineGap);
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
    const sourceRuns = Array.isArray(item.sourceRuns) ? item.sourceRuns : [];
    const sourceText = sourceRuns.map((source) => String(source?.decodedText ?? '')).join('');
    const itemText = String(item.text ?? '');
    const comparable = (value) => value.replace(/\s+/gu, ' ').trim();
    const emitSourceRuns = sourceRuns.length > 0 && comparable(sourceText) === comparable(itemText);
    const emittedText = emitSourceRuns ? sourceText : itemText;
    const previousText = String(pieces.at(-1)?.text ?? '');
    if (previous && needsLexicalSpace(previous, item)
        && !/\s$/u.test(previousText) && !/^\s/u.test(emittedText)) {
      pieces.push({ text: ' ', syntheticSpace: true, item: previous });
    }
    // PDF.js may merge adjacent show-text operators into one visual span.
    // Split it back into the exact source runs only when their complete text
    // still matches, avoiding duplication when one operator was split across
    // several PDF.js spans.
    if (emitSourceRuns) {
      for (const source of sourceRuns) {
        pieces.push({
          text: String(source.decodedText ?? ''),
          syntheticSpace: false,
          item,
          source,
        });
      }
    } else {
      pieces.push({ text: itemText, syntheticSpace: false, item, source: null });
    }
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
