import { graphemeLength } from './rich-text.js';

export const PATHOLOGICAL_PASTE_GRAPHEME_LIMIT = 10_000;
export const PATHOLOGICAL_PASTE_LINE_LIMIT = 250;

export function orderedRichTextSelectionStart(selection) {
  const anchor = {
    line: Math.max(0, Number(selection?.anchor?.line) || 0),
    offset: Math.max(0, Number(selection?.anchor?.offset) || 0),
  };
  const focus = {
    line: Math.max(0, Number(selection?.focus?.line) || 0),
    offset: Math.max(0, Number(selection?.focus?.offset) || 0),
  };
  return anchor.line < focus.line
    || (anchor.line === focus.line && anchor.offset <= focus.offset)
    ? anchor : focus;
}

export function pathologicalPasteDetails(value) {
  const text = String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const graphemeCount = graphemeLength(text);
  const lineCount = text.split('\n').length;
  const overGraphemeLimit = graphemeCount > PATHOLOGICAL_PASTE_GRAPHEME_LIMIT;
  const overLineLimit = lineCount > PATHOLOGICAL_PASTE_LINE_LIMIT;
  return {
    text,
    graphemeCount,
    lineCount,
    overGraphemeLimit,
    overLineLimit,
    pathological: overGraphemeLimit || overLineLimit,
  };
}

const RUN_STYLE_KEYS = Object.freeze([
  'faceId', 'size', 'color', 'bold', 'italic', 'underline', 'strikeout', 'direction',
]);

/**
 * A signature that changes for authored content or formatting, while ignoring
 * layout-worker-only soft wraps, glyph plans, baselines, and region geometry.
 */
export function semanticRichTextSignature(document) {
  if (!document?.lines?.length) return '';
  const paragraphs = [];
  let paragraph = null;
  for (const line of document.lines) {
    if (!paragraph) {
      paragraph = {
        alignment: line.alignment,
        baselineAdvance: line.baselineAdvance,
        runs: [],
      };
    }
    for (const run of line.runs || []) {
      const style = Object.fromEntries(RUN_STYLE_KEYS.map((key) => [key, run[key]]));
      const previous = paragraph.runs.at(-1);
      if (previous && RUN_STYLE_KEYS.every((key) => previous[key] === style[key])) {
        previous.text += String(run.text ?? '');
      } else {
        paragraph.runs.push({ text: String(run.text ?? ''), ...style });
      }
    }
    if (line.breakAfter !== 'soft') {
      paragraphs.push(paragraph);
      paragraph = null;
    }
  }
  if (paragraph) paragraphs.push(paragraph);
  return JSON.stringify(paragraphs);
}

export function displayArrowDelta(key, step = 1) {
  const distance = Math.max(0, Number(step) || 0);
  if (key === 'ArrowLeft') return { x: -distance, y: 0 };
  if (key === 'ArrowRight') return { x: distance, y: 0 };
  if (key === 'ArrowUp') return { x: 0, y: -distance };
  if (key === 'ArrowDown') return { x: 0, y: distance };
  return null;
}

/**
 * Return the exact-layout-approved canonical box expansion, or null when the
 * latest result is stale, invalid, outside the page/column, or does not grow.
 */
export function exactExpansionCandidate({ placement, layoutState, columnBounds }) {
  const result = layoutState?.result;
  if (!placement || layoutState?.pending || layoutState?.valid !== true
      || !result || result.pageEdgeValid !== true || result.columnValid !== true
      || !layoutState.requestedFingerprint
      || layoutState.requestedFingerprint !== layoutState.validatedFingerprint) return null;
  const current = placement.canonicalBounds;
  const region = result.document?.region;
  if (!current || !region) return null;
  const width = Math.max(current.width, Number(region.width) || 0);
  const height = Math.max(current.height, Number(result.requiredHeight) || Number(region.height) || 0);
  if (!(width > 0) || !(height > 0)
      || (width <= current.width + 1e-6 && height <= current.height + 1e-6)) return null;
  const candidate = { x: current.x, y: current.y, width, height };
  if (candidate.x < -1e-6 || candidate.y < -1e-6
      || candidate.x + candidate.width > Number(placement.pageWidth) + 1e-6
      || candidate.y + candidate.height > Number(placement.pageHeight) + 1e-6) return null;
  if (Number.isFinite(columnBounds?.left) && Number.isFinite(columnBounds?.right)
      && (candidate.x < columnBounds.left - 1e-6
        || candidate.x + candidate.width > columnBounds.right + 1e-6)) return null;
  return candidate;
}
