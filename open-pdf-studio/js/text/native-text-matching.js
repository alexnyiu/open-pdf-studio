function normalizeText(value) {
  return String(value || '').normalize('NFC');
}

function comparableText(value) {
  return normalizeText(value).replace(/\s+/gu, ' ').trim();
}

function geometryCompatible(item, runs) {
  if (!item?.transform || runs.length === 0) return true;
  const x = Number(item.transform[4]);
  const y = Number(item.transform[5]);
  const width = Number(item.width) || 0;
  const first = runs[0].geometry;
  const sourceWidth = runs.reduce((sum, run) => sum + (Number(run.geometry?.[2]) || 0), 0);
  // Standard 14 fonts may be intentionally unembedded and omit /Widths.
  // In that case Rust can still decode the exact operator but cannot derive
  // trustworthy geometry; ordered Unicode remains the binding criterion.
  if (sourceWidth <= 0) return true;
  const fontSize = Math.max(Math.hypot(Number(item.transform[2]) || 0, Number(item.transform[3]) || 0), 1);
  const positionTolerance = Math.max(fontSize * 0.75, 2);
  const widthTolerance = Math.max(fontSize, Math.max(width, sourceWidth) * 0.35);
  return Math.abs(x - Number(first?.[0] || 0)) <= positionTolerance
    && Math.abs(y - Number(first?.[1] || 0)) <= positionTolerance
    && (sourceWidth <= 0 || Math.abs(width - sourceWidth) <= widthTolerance);
}

/** Ordered Unicode + geometry matching with atomic source ownership. */
export function matchNativeTextSources(textItems, sourceRuns) {
  const matches = new Map();
  const linkedRuns = new Set();
  let itemCursor = 0;

  // One source operator may be split into many PDF.js spans (notably
  // monospaced text, where PDF.js emits a span per word and per space).
  for (let runIndex = 0; runIndex < sourceRuns.length; runIndex += 1) {
    const run = sourceRuns[runIndex];
    if (!run?.eligibility?.eligible || run.ownershipState !== 'source') continue;
    const target = comparableText(run.decodedText);
    if (!target) continue;
    while (itemCursor < textItems.length && !normalizeText(textItems[itemCursor]?.str).trim()) itemCursor += 1;
    let combined = '';
    for (let end = itemCursor; end < textItems.length; end += 1) {
      combined += normalizeText(textItems[end]?.str);
      const compared = comparableText(combined);
      if (compared === target) {
        const item = {
          ...textItems[itemCursor],
          width: textItems.slice(itemCursor, end + 1)
            .reduce((sum, part) => sum + (Number(part.width) || 0), 0),
        };
        if (geometryCompatible(item, [run])) {
          for (let index = itemCursor; index <= end; index += 1) {
            if (normalizeText(textItems[index]?.str)) matches.set(index, [run]);
          }
          linkedRuns.add(runIndex);
          itemCursor = end + 1;
        }
        break;
      }
      if (!target.startsWith(compared)) break;
    }
  }

  // Conversely, PDF.js may merge several consecutive show-text operators
  // into one span. Attach the complete operator set to that single span.
  let cursor = 0;
  for (let itemIndex = 0; itemIndex < textItems.length; itemIndex += 1) {
    if (matches.has(itemIndex)) continue;
    const item = textItems[itemIndex];
    const target = comparableText(item?.str);
    if (!target) continue;
    while (cursor < sourceRuns.length
      && (linkedRuns.has(cursor) || !normalizeText(sourceRuns[cursor]?.decodedText))) cursor += 1;
    const candidates = [];
    const candidateIndexes = [];
    let combined = '';
    let scan = cursor;
    while (scan < sourceRuns.length && combined.length <= target.length) {
      const run = sourceRuns[scan];
      if (linkedRuns.has(scan)) { scan += 1; continue; }
      if (!run?.eligibility?.eligible || run.ownershipState !== 'source') break;
      candidates.push(run);
      candidateIndexes.push(scan);
      combined += normalizeText(run.decodedText);
      if (comparableText(combined) === target) break;
      if (!target.startsWith(comparableText(combined))) break;
      scan += 1;
    }
    if (comparableText(combined) === target && geometryCompatible(item, candidates)) {
      matches.set(itemIndex, candidates);
      candidateIndexes.forEach((index) => linkedRuns.add(index));
      cursor = scan + 1;
    }
  }
  return matches;
}

function ownershipKey(source) {
  if (typeof source?.markerId === 'string' && source.markerId) return source.markerId;
  const path = Array.isArray(source?.invocationPath)
    ? source.invocationPath.map((entry) => JSON.stringify(entry)).join('/')
    : '';
  return `${path}:${source?.streamObjectId ?? ''}:${source?.operatorIndex ?? ''}`;
}

export function sameNativeTextOwnership(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    return false;
  }
  const leftKeys = left.map(ownershipKey).sort();
  const rightKeys = right.map(ownershipKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

export function matchOwnedReplacementTextItems(textItems, editViews) {
  const matches = new Map();
  for (const edit of editViews || []) {
    const target = comparableText(edit?.newText);
    if (!target || !edit?.id) continue;
    for (let start = 0; start < textItems.length; start += 1) {
      const first = textItems[start];
      const transform = first?.transform;
      if (!Array.isArray(transform) || transform.length < 6) continue;
      const fontSize = Math.max(Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0), 1);
      const tolerance = Math.max(fontSize * 0.75, 2);
      if (Math.abs(Number(transform[4]) - Number(edit.pdfX)) > tolerance
          || Math.abs(Number(transform[5]) - Number(edit.pdfY)) > tolerance) continue;
      let combined = '';
      for (let end = start; end < textItems.length; end += 1) {
        combined += normalizeText(textItems[end]?.str);
        const compared = comparableText(combined);
        if (compared === target) {
          for (let index = start; index <= end; index += 1) matches.set(index, String(edit.id));
          break;
        }
        if (!target.startsWith(compared)) break;
      }
      if ([...matches.values()].includes(String(edit.id))) break;
    }
  }
  return matches;
}
