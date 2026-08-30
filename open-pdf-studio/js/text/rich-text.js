export const RICH_TEXT_SCHEMA = 'open-pdf-studio.rich-text-document';
export const RICH_TEXT_VERSION = 2;
export const TEXT_EDIT_SCHEMA = 'open-pdf-studio.text-edit-record';
export const TEXT_EDIT_VERSION = 2;
export const OWNED_TEXT_EDIT_MANIFEST_SCHEMA = 'open-pdf-studio.owned-text-edit-manifest';
export const OWNED_TEXT_EDIT_MANIFEST_VERSION = 3;

export const DEFAULT_TEXT_FORMAT_CAPABILITIES = Object.freeze({
  family: true,
  size: true,
  color: true,
  bold: true,
  italic: true,
  underline: true,
  strikeout: true,
  alignment: true,
  spacing: true,
  directions: Object.freeze(['ltr']),
});

/** Plain Enter inserts a canonical hard break only in multiline rich editors. */
export function shouldInsertRichHardBreak(event, { singleLine = false } = {}) {
  return event?.key === 'Enter'
    && event.metaKey !== true
    && event.ctrlKey !== true
    && singleLine !== true;
}

const FACE_IDS = new Set([
  'liberation-sans-regular', 'liberation-sans-bold', 'liberation-sans-italic',
  'liberation-sans-bold-italic', 'liberation-serif-regular', 'liberation-serif-bold',
  'liberation-serif-italic', 'liberation-serif-bold-italic', 'liberation-mono-regular',
  'liberation-mono-bold', 'liberation-mono-italic', 'liberation-mono-bold-italic',
]);

const STYLE_KEYS = Object.freeze([
  'faceId', 'size', 'color', 'bold', 'italic', 'underline', 'strikeout', 'direction',
]);

function clone(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Solid stores expose JSON-shaped reactive proxies. They deliberately
      // cannot cross the structured-clone boundary, so normalize them before
      // they enter persisted document or undo state.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function cloneRichTextDocument(document) {
  const copy = clone(document);
  assertRichTextDocumentV2(copy);
  return copy;
}

/** Detach one JSON-only edit record from reactive owner-document storage. */
export function cloneTextEditRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

/** Detach the complete owned-text state before persistence or native IPC. */
export function cloneOwnedTextEditPersistenceState(documentState) {
  return {
    records: (documentState?.textEdits || []).map((record) => cloneTextEditRecord(record)),
    previousManifest: documentState?.textEditManifest
      ? JSON.parse(JSON.stringify(documentState.textEditManifest))
      : null,
  };
}

/**
 * Remove one owned record only after its undo snapshot is safely detached.
 * `recordRemoval` must synchronously accept the plain snapshot and its index.
 */
export function removeTextEditRecordFromDocument(documentState, recordId, recordRemoval) {
  if (!documentState || !Array.isArray(documentState.textEdits)) return false;
  if (typeof recordRemoval !== 'function') throw new TypeError('A text-edit removal recorder is required');
  const index = documentState.textEdits.findIndex((entry) => String(entry?.id) === String(recordId));
  if (index < 0) return false;

  // Solid's browser store returns a proxy from splice(). Snapshot before the
  // mutation so a clone failure can never leave the owner record removed.
  const snapshot = cloneTextEditRecord(documentState.textEdits[index]);
  const [removed] = documentState.textEdits.splice(index, 1);
  try {
    if (recordRemoval(snapshot, index) === true) return true;
  } catch (error) {
    documentState.textEdits.splice(index, 0, removed);
    throw error;
  }
  documentState.textEdits.splice(index, 0, removed);
  return false;
}

function stableId(prefix, value) {
  let hash = 2166136261;
  const input = String(value);
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export function graphemes(text) {
  const value = String(text ?? '');
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(value)].map((entry) => entry.segment);
  }
  return Array.from(value);
}

export function graphemeLength(text) {
  return graphemes(text).length;
}

function splitAtGrapheme(text, offset) {
  const units = graphemes(text);
  const safe = Math.max(0, Math.min(units.length, Number(offset) || 0));
  return [units.slice(0, safe).join(''), units.slice(safe).join('')];
}

function normalizedStyle(style = {}) {
  const requestedFaceId = FACE_IDS.has(style.faceId) ? style.faceId : 'liberation-sans-regular';
  const bold = style.bold === true;
  const italic = style.italic === true;
  const family = requestedFaceId.includes('-mono-') ? 'mono'
    : requestedFaceId.includes('-serif-') ? 'serif' : 'sans';
  const faceId = `liberation-${family}-${bold && italic ? 'bold-italic' : bold ? 'bold' : italic ? 'italic' : 'regular'}`;
  const size = Number(style.size);
  const color = /^#[0-9a-f]{6}$/iu.test(style.color || '') ? style.color.toLowerCase() : '#000000';
  return {
    faceId,
    size: Number.isFinite(size) && size > 0 && size <= 512 ? size : 12,
    color,
    bold,
    italic,
    underline: style.underline === true,
    strikeout: style.strikeout === true,
    direction: 'ltr',
  };
}

export function createTextRun(text, style = {}, extras = {}) {
  const normalized = normalizedStyle(style);
  const value = String(text ?? '');
  return {
    id: extras.id || stableId('run', `${value}|${JSON.stringify(normalized)}|${extras.seed || ''}`),
    text: value,
    ...normalized,
    shaped: extras.shaped || null,
    geometry: extras.geometry || { x: 0, baseline: 0, width: 0, height: normalized.size },
    sourceConfidence: Number.isFinite(extras.sourceConfidence)
      ? Math.max(0, Math.min(1, extras.sourceConfidence)) : 1,
  };
}

export function createTextLine(runs, options = {}) {
  const safeRuns = (runs || []).map((run, index) => createTextRun(run.text, run, {
    ...run,
    seed: `${options.id || ''}:${index}`,
  }));
  if (safeRuns.length === 0) safeRuns.push(createTextRun('', options.style));
  return {
    id: options.id || stableId('line', `${options.baseline || 0}|${safeRuns.map((run) => run.id).join('|')}`),
    baseline: Number(options.baseline) || 0,
    baselineAdvance: Number(options.baselineAdvance) > 0
      ? Number(options.baselineAdvance) : Math.max(...safeRuns.map((run) => run.size)) * 1.2,
    alignment: ['left', 'center', 'right'].includes(options.alignment) ? options.alignment : 'left',
    // Optional in V2. Older records omit it and therefore retain the historic
    // interpretation that every stored line ends with an authored paragraph
    // break. Generated wraps explicitly use "soft".
    breakAfter: options.breakAfter === 'soft' ? 'soft' : 'hard',
    runs: safeRuns,
  };
}

export function createRichTextDocument(lines, region = {}) {
  const safeLines = (lines || []).map((line) => createTextLine(line.runs, line));
  if (safeLines.length === 0) safeLines.push(createTextLine([createTextRun('')]));
  return {
    schema: RICH_TEXT_SCHEMA,
    version: RICH_TEXT_VERSION,
    region: {
      x: Number(region.x) || 0,
      y: Number(region.y) || 0,
      width: Math.max(0, Number(region.width) || 0),
      height: Math.max(0, Number(region.height) || 0),
      rotation: [0, 90, 180, 270].includes(Number(region.rotation)) ? Number(region.rotation) : 0,
      baselineDirection: region.baselineDirection === 'increasing-y'
        ? 'increasing-y' : 'decreasing-y',
    },
    lines: safeLines,
  };
}

export function richTextFromPlainText(text, style = {}, region = {}) {
  const values = String(text ?? '').split('\n');
  const size = normalizedStyle(style).size;
  const baselineAdvance = Number(style.baselineAdvance) > 0 ? Number(style.baselineAdvance) : size * 1.2;
  const baselineSign = region.baselineDirection === 'increasing-y' ? 1 : -1;
  return createRichTextDocument(values.map((value, index) => ({
    id: stableId('line', `${index}|${value}`),
    baseline: (Number(region.baseline) || 0) + baselineSign * index * baselineAdvance,
    baselineAdvance,
    alignment: style.alignment,
    runs: [createTextRun(value, style, { seed: index, sourceConfidence: style.sourceConfidence })],
  })), region);
}

/** Map a live root-text selection prefix back into one canonical rich-text point. */
export function richTextPointFromPlainTextPrefix(document, prefix) {
  if (!document?.lines?.length) return null;
  const normalized = String(prefix ?? '').replaceAll('\u200b', '').replaceAll('\r', '');
  const plainLines = normalized.split('\n');
  const line = Math.min(plainLines.length - 1, document.lines.length - 1);
  const lineLength = document.lines[line].runs
    .reduce((sum, run) => sum + graphemeLength(run.text), 0);
  return {
    line,
    offset: Math.min(graphemeLength(plainLines.at(-1) || ''), lineLength),
  };
}

export function richTextToPlainText(document) {
  assertRichTextDocumentV2(document);
  return document.lines.map((line, index) => {
    const value = line.runs.map((run) => run.text).join('');
    if (index === document.lines.length - 1) return value;
    return `${value}${line.breakAfter === 'soft' ? '' : '\n'}`;
  }).join('');
}

function sameStyle(left, right) {
  return STYLE_KEYS.every((key) => left[key] === right[key]);
}

function normalizeLineRuns(line) {
  const merged = [];
  for (const rawRun of line.runs) {
    const run = createTextRun(rawRun.text, rawRun, rawRun);
    const previous = merged[merged.length - 1];
    if (previous && sameStyle(previous, run)) {
      previous.text += run.text;
      previous.id = stableId('run', `${previous.id}|${run.id}|${previous.text}`);
      previous.shaped = null;
      previous.geometry.width = 0;
    } else {
      merged.push(run);
    }
  }
  line.runs = merged.length ? merged : [createTextRun('')];
  return line;
}

export function normalizeRichTextDocument(document) {
  assertRichTextDocumentV2(document);
  const output = clone(document);
  output.lines.forEach(normalizeLineRuns);
  return output;
}

function normalizePoint(document, point) {
  const line = Math.max(0, Math.min(document.lines.length - 1, Number(point?.line) || 0));
  const length = document.lines[line].runs.reduce((sum, run) => sum + graphemeLength(run.text), 0);
  return { line, offset: Math.max(0, Math.min(length, Number(point?.offset) || 0)) };
}

function comparePoints(left, right) {
  return left.line - right.line || left.offset - right.offset;
}

function orderedSelection(document, selection) {
  const anchor = normalizePoint(document, selection?.anchor || selection?.start);
  const focus = normalizePoint(document, selection?.focus || selection?.end || anchor);
  return comparePoints(anchor, focus) <= 0
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

/**
 * Resolve the canonical formatting used for inserted text. At a run boundary
 * the preceding run wins, matching desktop word processors; at offset zero
 * the first run supplies the format. Explicit typing-format overrides are
 * normalized on top without mutating the source document.
 */
export function richTextInsertionContext(document, point, typingStyle = null) {
  assertRichTextDocumentV2(document);
  const caret = normalizePoint(document, point);
  const line = document.lines[caret.line];
  let sourceRun = line.runs[0];
  if (caret.offset > 0) {
    let cursor = 0;
    for (const run of line.runs) {
      cursor += graphemeLength(run.text);
      sourceRun = run;
      if (caret.offset <= cursor) break;
    }
  }
  const normalizedRun = createTextRun('', {
    ...sourceRun,
    ...(typingStyle || {}),
  });
  return {
    point: caret,
    runStyle: Object.fromEntries(STYLE_KEYS.map((key) => [key, normalizedRun[key]])),
    lineStyle: {
      alignment: line.alignment,
      baselineAdvance: line.baselineAdvance,
      lineSpacingMultiplier: (() => {
        const maximumRunSize = Math.max(...line.runs.map((run) => Number(run.size) || 0));
        return maximumRunSize > 0
          ? Math.round((Number(line.baselineAdvance) / maximumRunSize) * 1e7) / 1e7
          : null;
      })(),
    },
    sourceLineId: line.id,
    sourceRunId: sourceRun.id,
  };
}

function splitLineByRange(line, start, end, patch) {
  const output = [];
  let cursor = 0;
  for (const run of line.runs) {
    const length = graphemeLength(run.text);
    const runStart = cursor;
    const runEnd = cursor + length;
    const selectedStart = Math.max(runStart, start);
    const selectedEnd = Math.min(runEnd, end);
    if (selectedStart >= selectedEnd) {
      output.push(clone(run));
      cursor = runEnd;
      continue;
    }
    const [before, remainder] = splitAtGrapheme(run.text, selectedStart - runStart);
    const [selected, after] = splitAtGrapheme(remainder, selectedEnd - selectedStart);
    if (before) output.push(createTextRun(before, run, run));
    if (selected) output.push(createTextRun(selected, { ...run, ...patch }, { ...run, shaped: null }));
    if (after) output.push(createTextRun(after, run, run));
    cursor = runEnd;
  }
  line.runs = output;
  return normalizeLineRuns(line);
}

export function applyTextFormat(document, selection, patch) {
  assertRichTextDocumentV2(document);
  const result = clone(document);
  const range = orderedSelection(result, selection);
  if (comparePoints(range.start, range.end) === 0) {
    return { document: result, typingStyle: clone(patch), collapsed: true };
  }
  for (let lineIndex = range.start.line; lineIndex <= range.end.line; lineIndex += 1) {
    const line = result.lines[lineIndex];
    const lineLength = line.runs.reduce((sum, run) => sum + graphemeLength(run.text), 0);
    const start = lineIndex === range.start.line ? range.start.offset : 0;
    const end = lineIndex === range.end.line ? range.end.offset : lineLength;
    if (start < end) splitLineByRange(line, start, end, patch);
  }
  return { document: normalizeRichTextDocument(result), typingStyle: null, collapsed: false };
}

export function textFormatState(document, selection) {
  assertRichTextDocumentV2(document);
  const range = orderedSelection(document, selection);
  if (comparePoints(range.start, range.end) === 0) {
    const context = richTextInsertionContext(document, range.start);
    return {
      ...context.runStyle,
      ...context.lineStyle,
    };
  }
  const seen = Object.fromEntries(STYLE_KEYS.map((key) => [key, new Set()]));
  for (let lineIndex = range.start.line; lineIndex <= range.end.line; lineIndex += 1) {
    const line = document.lines[lineIndex];
    let cursor = 0;
    for (const run of line.runs) {
      const end = cursor + graphemeLength(run.text);
      const intersects = lineIndex === range.start.line && lineIndex === range.end.line
        ? end > range.start.offset && cursor < range.end.offset
        : (lineIndex !== range.start.line || end > range.start.offset)
          && (lineIndex !== range.end.line || cursor < range.end.offset);
      if (intersects) {
        STYLE_KEYS.forEach((key) => seen[key].add(run[key]));
      }
      cursor = end;
    }
  }
  const output = Object.fromEntries(STYLE_KEYS.map((key) => {
    const values = [...seen[key]];
    return [key, values.length === 1 ? values[0] : null];
  }));
  const selectedLines = document.lines.slice(range.start.line, range.end.line + 1);
  const alignments = new Set(selectedLines.map((line) => line.alignment));
  const advances = new Set(selectedLines.map((line) => line.baselineAdvance));
  const spacingMultipliers = new Set(selectedLines.map((line) => {
    const maximumRunSize = Math.max(...line.runs.map((run) => Number(run.size) || 0));
    return maximumRunSize > 0
      ? Math.round((Number(line.baselineAdvance) / maximumRunSize) * 1e7) / 1e7
      : null;
  }));
  output.alignment = alignments.size === 1 ? [...alignments][0] : null;
  output.baselineAdvance = advances.size === 1 ? [...advances][0] : null;
  output.lineSpacingMultiplier = spacingMultipliers.size === 1
    ? [...spacingMultipliers][0] : null;
  return output;
}

export function replaceTextRange(document, selection, insertedText, typingStyle = null) {
  assertRichTextDocumentV2(document);
  const result = clone(document);
  const range = orderedSelection(result, selection);
  const startLine = result.lines[range.start.line];
  const endLine = result.lines[range.end.line];
  const lineLength = (line) => line.runs.reduce((sum, run) => sum + graphemeLength(run.text), 0);
  const sliceRuns = (line, from, to) => {
    const output = [];
    let cursor = 0;
    for (const run of line.runs) {
      const length = graphemeLength(run.text);
      const start = Math.max(cursor, from);
      const end = Math.min(cursor + length, to);
      if (start < end) {
        const [, remainder] = splitAtGrapheme(run.text, start - cursor);
        const [piece] = splitAtGrapheme(remainder, end - start);
        output.push(createTextRun(piece, run, { ...run, shaped: null }));
      }
      cursor += length;
    }
    return output;
  };
  const prefixRuns = sliceRuns(startLine, 0, range.start.offset);
  const suffixRuns = sliceRuns(endLine, range.end.offset, lineLength(endLine));
  const insertionContext = richTextInsertionContext(result, range.start, typingStyle);
  const style = insertionContext.runStyle;
  const insertedLines = String(insertedText ?? '').split('\n');
  const baselineSign = result.region.baselineDirection === 'increasing-y' ? 1 : -1;
  const newLines = insertedLines.map((value, index) => {
    const runs = [];
    if (index === 0) runs.push(...prefixRuns);
    if (value) runs.push(createTextRun(value, style, { shaped: null, seed: `insert-${index}` }));
    else if (index > 0) {
      // Retain an explicit zero-width insertion run even when the suffix has
      // another style. The caret at the start of the new line must continue
      // the pre-break format rather than inheriting the following glyph.
      runs.push(createTextRun('', style, { shaped: null, seed: `insert-empty-${index}` }));
    }
    if (index === insertedLines.length - 1) runs.push(...suffixRuns);
    if (runs.length === 0) runs.push(createTextRun('', style));
    return createTextLine(runs, {
      id: index === 0
        ? startLine.id
        : (range.start.line !== range.end.line && index === insertedLines.length - 1
          ? endLine.id : undefined),
      baseline: startLine.baseline + baselineSign * index * startLine.baselineAdvance,
      baselineAdvance: insertionContext.lineStyle.baselineAdvance,
      alignment: insertionContext.lineStyle.alignment,
      breakAfter: index === insertedLines.length - 1 ? endLine.breakAfter : 'hard',
    });
  });
  const followingLineShift = newLines.at(-1).baseline - endLine.baseline;
  result.lines.splice(range.start.line, range.end.line - range.start.line + 1, ...newLines);
  for (let index = range.start.line + newLines.length; index < result.lines.length; index += 1) {
    result.lines[index].baseline += followingLineShift;
  }
  const prefixLength = prefixRuns.reduce((sum, run) => sum + graphemeLength(run.text), 0);
  const caret = {
    line: range.start.line + insertedLines.length - 1,
    offset: graphemeLength(insertedLines[insertedLines.length - 1])
      + (insertedLines.length === 1 ? prefixLength : 0),
  };
  // Structural editing deliberately retains run boundaries. Coalescing an
  // inserted run with an adjacent, identically styled source run would change
  // the source run's stable identity and flatten the original segmentation.
  assertRichTextDocumentV2(result);
  return { document: result, selection: { anchor: caret, focus: caret } };
}

export function assertRichTextDocumentV2(document) {
  if (!document || typeof document !== 'object') throw new TypeError('Rich text document is required');
  if (document.schema !== RICH_TEXT_SCHEMA || document.version !== RICH_TEXT_VERSION) {
    throw new TypeError(`Unsupported rich text schema version: ${document.schema || 'missing'} v${document.version ?? 'missing'}`);
  }
  if (!document.region || !Array.isArray(document.lines) || document.lines.length === 0) {
    throw new TypeError('Rich text document requires a fixed region and at least one line');
  }
  if (!['decreasing-y', 'increasing-y'].includes(document.region.baselineDirection)) {
    throw new TypeError('Rich text document requires an explicit baseline direction');
  }
  for (const line of document.lines) {
    if (!Array.isArray(line.runs) || line.runs.length === 0 || !(Number(line.baselineAdvance) > 0)) {
      throw new TypeError('Each rich text line requires runs and a positive measured baseline advance');
    }
    for (const run of line.runs) {
      if (typeof run.text !== 'string' || !FACE_IDS.has(run.faceId) || !(Number(run.size) > 0)) {
        throw new TypeError('Invalid rich text run');
      }
      const expectedVariant = run.bold && run.italic ? 'bold-italic'
        : run.bold ? 'bold' : run.italic ? 'italic' : 'regular';
      if (!run.faceId.endsWith(`-${expectedVariant}`)) {
        throw new TypeError('Rich text run style does not match its packaged face');
      }
      if (run.direction !== 'ltr') throw new TypeError('Unsupported text direction');
    }
  }
  return document;
}

function legacyFaceId(fontFamily = '') {
  const value = String(fontFamily).toLowerCase();
  const family = value.includes('courier') || value.includes('mono') ? 'mono'
    : value.includes('times') || (value.includes('serif') && !value.includes('sans')) ? 'serif' : 'sans';
  const bold = value.includes('bold');
  const italic = value.includes('italic') || value.includes('oblique');
  return `liberation-${family}-${bold && italic ? 'bold-italic' : bold ? 'bold' : italic ? 'italic' : 'regular'}`;
}

export function migrateLegacyTextEditRecord(record) {
  if (record?.schema === TEXT_EDIT_SCHEMA) {
    if (record.version !== TEXT_EDIT_VERSION) throw new TypeError(`Unsupported text edit record version ${record.version}`);
    assertRichTextDocumentV2(record.richText);
    return clone(record);
  }
  if (!record || !Number.isInteger(record.page) || record.page < 1) {
    throw new TypeError('Legacy text edit has no trustworthy page geometry');
  }
  const x = Number(record.pdfX);
  const baseline = Number(record.pdfY);
  const width = Number(record.pdfWidth);
  const size = Number(record.fontSize);
  if (![x, baseline, width, size].every(Number.isFinite) || width < 0 || size <= 0) {
    throw new TypeError('Legacy text edit has no trustworthy fixed geometry');
  }
  const text = String(record.newText ?? '');
  const baselineAdvance = Number(record.lineSpacing) > 0 ? Number(record.lineSpacing) : size * 1.2;
  const richText = richTextFromPlainText(text, {
    faceId: legacyFaceId(record.fontFamily),
    size,
    color: record.color,
    bold: String(record.fontFamily).toLowerCase().includes('bold'),
    italic: /italic|oblique/iu.test(String(record.fontFamily)),
    underline: record.fontUnderline,
    strikeout: record.fontStrikethrough,
    baselineAdvance,
  }, {
    x,
    y: baseline - size,
    baseline,
    width,
    height: Math.max(size, text.split('\n').length * baselineAdvance),
    rotation: 0,
  });
  return {
    schema: TEXT_EDIT_SCHEMA,
    version: TEXT_EDIT_VERSION,
    id: String(record.id || stableId('edit', `${record.page}|${x}|${baseline}|${text}`)),
    page: record.page,
    revision: 1,
    richText,
    original: record.originalText == null || record.originalText === ''
      ? null
      : richTextFromPlainText(record.originalText, richText.lines[0].runs[0], richText.region),
    sourceProvenance: record.sourceProvenance || null,
    substitution: record.substitution || null,
    originalSnapshotHash: record.originalSnapshotHash || stableId('snapshot', String(record.originalText || '')),
    ownedLayerId: String(record.ownedLayerId || `OpenPDFStudioTextEdit-${record.id || stableId('layer', text)}`),
  };
}

export function migrateTextEditRecords(records) {
  const migrated = [];
  const rejected = [];
  for (const record of records || []) {
    try { migrated.push(migrateLegacyTextEditRecord(record)); }
    catch (error) { rejected.push({ record, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { migrated, rejected };
}

export function canonicalRichTextHash(document) {
  assertRichTextDocumentV2(document);
  const canonical = {
    schema: document.schema,
    version: document.version,
    region: document.region,
    lines: document.lines.map((line) => {
      const canonicalLine = {
        baseline: line.baseline,
        baselineAdvance: line.baselineAdvance,
        alignment: line.alignment,
        runs: line.runs.map((run) => Object.fromEntries([
          ['text', run.text],
          ...STYLE_KEYS.map((key) => [key, run[key]]),
        ])),
      };
      if (line.breakAfter === 'soft') canonicalLine.breakAfter = 'soft';
      return canonicalLine;
    }),
  };
  return stableId('rich', JSON.stringify(canonical));
}

export function isTextEditRecordV2(record) {
  return record?.schema === TEXT_EDIT_SCHEMA && record?.version === TEXT_EDIT_VERSION;
}

export function createTextEditRecordV2({
  id,
  page,
  richText,
  original = null,
  sourceProvenance = null,
  substitution = null,
  revision = 1,
}) {
  assertRichTextDocumentV2(richText);
  if (original) assertRichTextDocumentV2(original);
  const editId = String(id || stableId('edit', `${page}|${canonicalRichTextHash(richText)}`));
  if (!Number.isInteger(page) || page < 1) throw new TypeError('Text edit page must be a positive integer');
  if (sourceProvenance != null && (!Array.isArray(sourceProvenance) || sourceProvenance.length === 0)) {
    throw new TypeError('Native source provenance must contain complete source operators');
  }
  return {
    schema: TEXT_EDIT_SCHEMA,
    version: TEXT_EDIT_VERSION,
    id: editId,
    page,
    revision: Math.max(1, Number(revision) || 1),
    richText: clone(richText),
    original: original ? clone(original) : null,
    sourceProvenance: sourceProvenance ? clone(sourceProvenance) : null,
    substitution: substitution ? clone(substitution) : null,
    originalSnapshotHash: original ? canonicalRichTextHash(original) : canonicalRichTextHash(richTextFromPlainText('', richText.lines[0].runs[0], richText.region)),
    ownedLayerId: `OpenPDFStudioTextEdit-${editId}`,
  };
}

/** Compatibility projection for rendering/search while callers migrate to V2. */
export function projectTextEditRecord(record) {
  const migrated = isTextEditRecordV2(record) ? record : migrateLegacyTextEditRecord(record);
  const firstLine = migrated.richText.lines[0];
  const firstRun = firstLine.runs[0];
  const originalText = migrated.original ? richTextToPlainText(migrated.original) : '';
  const family = firstRun.faceId.includes('mono') ? 'LiberationMono'
    : firstRun.faceId.includes('serif') ? 'LiberationSerif' : 'LiberationSans';
  const suffix = firstRun.bold && firstRun.italic ? '-BoldItalic'
    : firstRun.bold ? '-Bold' : firstRun.italic ? '-Italic' : '';
  return {
    id: migrated.id,
    page: migrated.page,
    originalText,
    newText: richTextToPlainText(migrated.richText),
    pdfX: migrated.richText.region.x,
    pdfY: firstLine.baseline,
    pdfWidth: migrated.richText.region.width,
    fontSize: firstRun.size,
    lineSpacing: firstLine.baselineAdvance,
    numOriginalLines: migrated.original?.lines.length || 0,
    fontFamily: `${family}${suffix}`,
    loadedFontName: '',
    pdfFontName: '',
    color: firstRun.color,
    fontUnderline: firstRun.underline,
    fontStrikethrough: firstRun.strikeout,
    richText: migrated.richText,
    original: migrated.original,
    record: migrated,
  };
}

export function replaceFirstRichTextMatch(document, matchText, replacement, { matchCase = true } = {}) {
  const plain = richTextToPlainText(document);
  const haystack = matchCase ? plain : plain.toLocaleLowerCase();
  const needle = matchCase ? String(matchText) : String(matchText).toLocaleLowerCase();
  const index = haystack.indexOf(needle);
  if (index < 0) return null;
  const before = plain.slice(0, index);
  const matched = plain.slice(index, index + String(matchText).length);
  const beforeLines = before.split('\n');
  const matchedLines = matched.split('\n');
  const start = {
    line: beforeLines.length - 1,
    offset: graphemeLength(beforeLines.at(-1)),
  };
  const end = matchedLines.length === 1
    ? { line: start.line, offset: start.offset + graphemeLength(matched) }
    : {
        line: start.line + matchedLines.length - 1,
        offset: graphemeLength(matchedLines.at(-1)),
      };
  return replaceTextRange(document, { anchor: start, focus: end }, replacement).document;
}
