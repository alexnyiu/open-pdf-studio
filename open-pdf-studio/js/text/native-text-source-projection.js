const NATIVE_TEXT_SOURCE_PROJECTION_SCHEMA = 'open-pdf-studio.native-text-source-projection';
const NATIVE_TEXT_SOURCE_PROJECTION_VERSION = 1;

function sourceSpanLocator(span, ordinal) {
  const markerIds = String(span?.dataset?.nativeTextMarkerIds || '');
  const itemIndex = String(span?.dataset?.itemIndex || '');
  return {
    markerIds: markerIds || null,
    itemIndex: itemIndex || null,
    ordinal,
  };
}

/**
 * Capture the transient text-layer projection changed by a native-source edit.
 * This belongs to the undo command only; it must never be copied into the
 * persisted V2 text-edit record.
 */
export function createNativeTextSourceProjection({
  pageNum,
  editId,
  lineData,
  replacementText,
} = {}) {
  if (!Number.isInteger(pageNum) || pageNum < 1) {
    throw new TypeError('Native source projection requires a positive page number');
  }
  if (!editId) throw new TypeError('Native source projection requires an edit id');
  if (!Array.isArray(lineData) || lineData.length === 0) {
    throw new TypeError('Native source projection requires source line data');
  }

  const replacementLines = String(replacementText ?? '').split('\n');
  let ordinal = 0;
  const spans = [];
  for (let lineIndex = 0; lineIndex < lineData.length; lineIndex += 1) {
    const lineSpans = lineData[lineIndex]?.spans;
    if (!Array.isArray(lineSpans) || lineSpans.length === 0) continue;
    for (let spanIndex = 0; spanIndex < lineSpans.length; spanIndex += 1) {
      const span = lineSpans[spanIndex];
      spans.push({
        ...sourceSpanLocator(span, ordinal++),
        beforeText: String(span?.textContent ?? ''),
        afterText: lineIndex < replacementLines.length && spanIndex === 0
          ? replacementLines[lineIndex]
          : '',
        beforeEditId: span?.dataset?.editId ? String(span.dataset.editId) : null,
        afterEditId: String(editId),
      });
    }
  }
  if (spans.length === 0) {
    throw new TypeError('Native source projection requires at least one source span');
  }
  return {
    schema: NATIVE_TEXT_SOURCE_PROJECTION_SCHEMA,
    version: NATIVE_TEXT_SOURCE_PROJECTION_VERSION,
    pageNum,
    editId: String(editId),
    spans,
  };
}

function isProjection(value) {
  return value?.schema === NATIVE_TEXT_SOURCE_PROJECTION_SCHEMA
    && value?.version === NATIVE_TEXT_SOURCE_PROJECTION_VERSION
    && Number.isInteger(value.pageNum)
    && Array.isArray(value.spans);
}

function sourceSpansForLayer(textLayer) {
  return [...(textLayer?.querySelectorAll?.('span[data-pdf-transform]') || [])]
    .filter((span) => span?.dataset?.synthetic !== 'true'
      && span?.dataset?.ownedTextEditHit !== 'true');
}

function matchingSpan(candidates, entry, projection, used) {
  const available = (predicate) => candidates.find((span) => !used.has(span) && predicate(span));
  if (entry.markerIds) {
    const markerMatch = available((span) => (
      String(span.dataset?.nativeTextMarkerIds || '') === entry.markerIds
    ));
    if (markerMatch) return markerMatch;
  }
  if (entry.itemIndex != null) {
    const indexMatch = available((span) => (
      String(span.dataset?.itemIndex || '') === entry.itemIndex
    ));
    if (indexMatch) return indexMatch;
  }
  const tagged = candidates.filter((span) => (
    String(span.dataset?.editId || '') === String(projection.editId)
  ));
  return tagged[entry.ordinal] && !used.has(tagged[entry.ordinal])
    ? tagged[entry.ordinal]
    : null;
}

/** Apply one side of a captured projection to one currently rendered layer. */
export function applyNativeTextSourceProjectionToLayer(textLayer, projection, direction) {
  if (!isProjection(projection) || !['undo', 'redo'].includes(direction)) {
    return { applied: 0, missing: projection?.spans?.length || 0 };
  }
  const candidates = sourceSpansForLayer(textLayer);
  const used = new Set();
  let applied = 0;
  let missing = 0;
  for (const entry of projection.spans) {
    const span = matchingSpan(candidates, entry, projection, used);
    if (!span) {
      missing += 1;
      continue;
    }
    used.add(span);
    const undo = direction === 'undo';
    span.textContent = undo ? entry.beforeText : entry.afterText;
    const editId = undo ? entry.beforeEditId : entry.afterEditId;
    if (editId) span.dataset.editId = String(editId);
    else delete span.dataset.editId;
    span.style?.removeProperty?.('visibility');
    applied += 1;
  }
  return { applied, missing };
}

/** Apply a projection to every rendered layer for its page. */
export function applyNativeTextSourceProjection(
  projection,
  direction,
  root = globalThis.document,
) {
  if (!isProjection(projection) || !root?.querySelectorAll) {
    return { applied: 0, missing: projection?.spans?.length || 0, layers: 0 };
  }
  const selector = `.textLayer[data-page="${projection.pageNum}"]`;
  const layers = [...root.querySelectorAll(selector)];
  let applied = 0;
  let missing = 0;
  for (const layer of layers) {
    const result = applyNativeTextSourceProjectionToLayer(layer, projection, direction);
    applied += result.applied;
    missing += result.missing;
  }
  return { applied, missing, layers: layers.length };
}

export function isNativeTextSourceProjection(value) {
  return isProjection(value);
}
