export const PARAGRAPH_BOUNDARY_JOIN = 'join';
export const PARAGRAPH_BOUNDARY_SPLIT = 'split';
export const PARAGRAPH_BOUNDARY_AMBIGUOUS = 'ambiguous';

const TERMINAL_PUNCTUATION = /[.!?][\])}'”’"]*$/u;
const HYPHENATED_END = /[\p{L}\p{N}][-‐‑]$/u;
const LIST_MARKER = /^\s*(?:[-•◦⁃] |\d+[.)] |[A-Za-z][.)] )/u;
const HEADING_END = /:\s*$/u;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function evidence(id, weight, value = null) {
  return { id, weight, value };
}

function startsLowercase(text) {
  const first = `${text ?? ''}`.trim().match(/\p{L}/u)?.[0];
  return Boolean(first && first === first.toLocaleLowerCase() && first !== first.toLocaleUpperCase());
}

function uppercaseHeading(text) {
  const letters = `${text ?? ''}`.match(/\p{L}/gu) ?? [];
  return letters.length >= 3 && letters.every((letter) => letter === letter.toLocaleUpperCase());
}

function forcedSplit(previous, next, context) {
  if (!previous.geometryValid || !next.geometryValid) return 'incompatible-geometry';
  if ((previous.direction ?? 'ltr') !== 'ltr' || (next.direction ?? 'ltr') !== 'ltr') {
    return 'unsupported-direction';
  }
  if (previous.columnId !== next.columnId) return 'column-change';
  if (Math.abs(finite(previous.angle) - finite(next.angle)) > 1.25) return 'baseline-angle';
  const height = Math.max(1, finite(context.medianHeight, Math.max(previous.height, next.height, 1)));
  if (finite(context.gap) > Math.max(height * 2.4, finite(context.medianGap, height) * 1.85)) {
    return 'large-gap';
  }
  const previousList = LIST_MARKER.test(previous.text ?? '');
  const nextList = LIST_MARKER.test(next.text ?? '');
  if (nextList && (!previousList || Math.abs(next.left - previous.left) <= height * 0.8)) {
    return 'list-transition';
  }
  if (uppercaseHeading(previous.text) && !uppercaseHeading(next.text)) return 'heading-transition';
  const heightRatio = Math.max(previous.height, next.height) / Math.max(1, Math.min(previous.height, next.height));
  const nextLooksHeading = nextList === false
    && heightRatio > 1.32
    && finite(next.width) < finite(context.medianWidth, next.width) * 0.82;
  if (nextLooksHeading) return 'heading-transition';
  return null;
}

/**
 * Scores one adjacent-line boundary. Adapters supply canonical measurements;
 * this module deliberately has no OCR, PDF.js, or DOM dependency.
 */
export function scoreParagraphBoundary(previous, next, context = {}) {
  const forcedReason = forcedSplit(previous, next, context);
  if (context.override === 'split') {
    return { decision: PARAGRAPH_BOUNDARY_SPLIT, score: Number.NEGATIVE_INFINITY, forced: true,
      reason: 'manual-split', evidence: [evidence('manual-split', -100)] };
  }
  if (forcedReason) {
    return { decision: PARAGRAPH_BOUNDARY_SPLIT, score: Number.NEGATIVE_INFINITY, forced: true,
      reason: forcedReason, evidence: [evidence(forcedReason, -100)] };
  }
  if (context.override === 'merge') {
    return { decision: PARAGRAPH_BOUNDARY_JOIN, score: Number.POSITIVE_INFINITY, forced: true,
      reason: 'manual-merge', evidence: [evidence('manual-merge', 100)] };
  }

  const signals = [];
  const height = Math.max(1, finite(context.medianHeight, Math.max(previous.height, next.height, 1)));
  const gap = finite(context.gap, next.top - previous.bottom);
  const medianGap = Math.max(1, finite(context.medianGap, gap));
  const leftDelta = Math.abs(finite(next.left) - finite(previous.left));
  const heightRatio = Math.max(previous.height, next.height) / Math.max(1, Math.min(previous.height, next.height));
  const widthReference = Math.max(1, finite(context.medianWidth, Math.max(previous.width, next.width, 1)));

  if (gap <= Math.max(height * 0.75, medianGap * 1.12)) signals.push(evidence('compact-spacing', 2, gap));
  else if (gap > Math.max(height * 1.2, medianGap * 1.35)) signals.push(evidence('expanded-spacing', -2, gap));
  if (heightRatio <= 1.14) signals.push(evidence('compatible-height', 1, heightRatio));
  else if (heightRatio > 1.24) signals.push(evidence('different-height', -2, heightRatio));
  const previousList = LIST_MARKER.test(previous.text ?? '');
  const firstLineIndentContinuation = next.left < previous.left
    && leftDelta <= height * 2.5 && !TERMINAL_PUNCTUATION.test(previous.text ?? '');
  const hangingIndentContinuation = previousList && next.left > previous.left && leftDelta <= height * 3;
  if (leftDelta <= height * 0.45) signals.push(evidence('aligned-left-edge', 1, leftDelta));
  else if (firstLineIndentContinuation) signals.push(evidence('first-line-indent-continuation', 1, leftDelta));
  else if (hangingIndentContinuation) signals.push(evidence('hanging-indent-continuation', 2, leftDelta));
  else if (leftDelta > height * 1.3) signals.push(evidence('strong-indentation-change', -2, leftDelta));
  if (HYPHENATED_END.test(previous.text ?? '')) signals.push(evidence('hyphenated-continuation', 3));
  if (startsLowercase(next.text)) signals.push(evidence('lowercase-continuation', 1));
  if (TERMINAL_PUNCTUATION.test(previous.text ?? '')) signals.push(evidence('terminal-punctuation', -2));
  else signals.push(evidence('nonterminal-line', 1));
  if (finite(previous.width) >= widthReference * 0.78) signals.push(evidence('full-previous-line', 1));
  if (finite(previous.width) < widthReference * 0.58) signals.push(evidence('short-previous-line', -2));
  if (HEADING_END.test(previous.text ?? '') && finite(previous.width) < widthReference * 0.8) {
    signals.push(evidence('heading-like-previous-line', -2));
  }

  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const positiveSignals = signals.filter((signal) => signal.weight > 0).length;
  const negativeSignals = signals.filter((signal) => signal.weight < 0).length;
  const decision = score >= 4 && positiveSignals >= 3
    ? PARAGRAPH_BOUNDARY_JOIN
    : score <= -2 && negativeSignals >= 1
      ? PARAGRAPH_BOUNDARY_SPLIT
      : PARAGRAPH_BOUNDARY_AMBIGUOUS;
  return { decision, score, forced: false, reason: decision, evidence: signals };
}

/** Ambiguous boundaries deliberately start a new paragraph. */
export function segmentParagraphLines(lines, { contextForBoundary, overrides = new Map() } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return { groups: [], boundaries: [] };
  const groups = [[lines[0]]];
  const boundaries = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const next = lines[index];
    const key = `${previous.id}\u0000${next.id}`;
    const result = scoreParagraphBoundary(previous, next, {
      ...(contextForBoundary?.(previous, next, index) ?? {}),
      override: overrides.get(key),
    });
    boundaries.push({ beforeLineId: previous.id, afterLineId: next.id, ...result });
    if (result.decision === PARAGRAPH_BOUNDARY_JOIN) groups.at(-1).push(next);
    else groups.push([next]);
  }
  return { groups, boundaries };
}
