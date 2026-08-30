import { canonicalRichTextHash } from './rich-text.js';

const PERSISTED_RUN_STYLE_KEYS = Object.freeze([
  'faceId',
  'size',
  'color',
  'bold',
  'italic',
  'underline',
  'strikeout',
  'direction',
]);
const PDF_LAYOUT_EPSILON = 1e-7;

function stableLayoutNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const rounded = Math.round(number / PDF_LAYOUT_EPSILON) * PDF_LAYOUT_EPSILON;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Ignore only sub-pixel PDF-number round-trip noise, never authored point changes. */
export function textEditGeometryChanged(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
    return leftNumber !== rightNumber;
  }
  return Math.abs(leftNumber - rightNumber) > PDF_LAYOUT_EPSILON;
}

function samePersistedRunStyle(left, right) {
  return PERSISTED_RUN_STYLE_KEYS.every((key) => left?.[key] === right?.[key]);
}

/**
 * Exact layout may split or coalesce adjacent runs while preserving every
 * persisted value. Run partition boundaries have no authored meaning, so the
 * dirty-state hash normalizes them without weakening the stricter layout and
 * persistence fingerprints used elsewhere.
 */
function semanticRichTextDocument(document) {
  return {
    ...document,
    // The packaged Rust round-trip may alphabetize JSON object keys. Hash the
    // six authored region values in one stable order so insertion order alone
    // cannot make a reopened owned edit appear dirty.
    region: {
      x: stableLayoutNumber(document.region.x),
      y: stableLayoutNumber(document.region.y),
      width: stableLayoutNumber(document.region.width),
      height: stableLayoutNumber(document.region.height),
      rotation: document.region.rotation,
      baselineDirection: document.region.baselineDirection,
    },
    lines: document.lines.map((line) => {
      const runs = [];
      for (const sourceRun of line.runs) {
        const previous = runs.at(-1);
        if (previous && samePersistedRunStyle(previous, sourceRun)) {
          previous.text += sourceRun.text;
        } else {
          runs.push({ ...sourceRun });
        }
      }
      return {
        ...line,
        baseline: stableLayoutNumber(line.baseline),
        baselineAdvance: stableLayoutNumber(line.baselineAdvance),
        runs,
      };
    }),
  };
}

function richTextFingerprint(document) {
  if (!document) return null;
  try {
    return canonicalRichTextHash(semanticRichTextDocument(document));
  } catch {
    // A malformed or partially torn-down editor draft must fail dirty rather
    // than silently matching the immutable source snapshot.
    return 'invalid-rich-text-draft';
  }
}

function recordFingerprint(record) {
  if (!record) return null;
  try {
    return JSON.stringify(semanticTextEditRecord(record));
  } catch {
    return 'invalid-text-edit-record';
  }
}

const TRANSIENT_RECORD_KEYS = new Set([
  'editorStatus',
  'editorStatusKind',
  'selection',
  'typingStyle',
  'mixedFormatState',
  'layoutState',
  'draftLayout',
  'reactiveProxyIdentity',
]);

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function semanticRichTextForRecord(document) {
  if (!document) return null;
  return richTextFingerprint(document);
}

function semanticTextEditRecord(record) {
  const result = {};
  for (const key of Object.keys(record).sort()) {
    if (key === 'revision' || TRANSIENT_RECORD_KEYS.has(key)) continue;
    if (key === 'richText' || key === 'original') {
      result[key] = semanticRichTextForRecord(record[key]);
      continue;
    }
    result[key] = stableObject(record[key]);
  }
  return result;
}

/** Compare persisted record meaning before assigning its next revision. */
export function textEditRecordContentChanged(previous, candidateWithoutRevision) {
  if (!previous || !candidateWithoutRevision) return previous !== candidateWithoutRevision;
  try {
    return JSON.stringify(semanticTextEditRecord(previous))
      !== JSON.stringify(semanticTextEditRecord(candidateWithoutRevision));
  } catch {
    // Invalid drafts must fail dirty and cannot be treated as a safe no-op.
    return true;
  }
}

/** Capture the immutable values against which one transient editor is judged. */
export function createTextEditDirtyBaseline({
  text = '',
  richText = null,
  record = null,
} = {}) {
  return Object.freeze({
    text: String(text ?? ''),
    richTextFingerprint: richTextFingerprint(richText),
    recordFingerprint: recordFingerprint(record),
  });
}

/**
 * Compare all persisted parts of an editor draft without mutating either the
 * live draft or its owner. Canonical rich text includes run/paragraph styles
 * and x/y/width/height region geometry; record comparison covers legacy and
 * owner-record-only mutations such as keyboard nudges.
 */
export function textEditDraftIsDirty(baseline, {
  text = '',
  richText = null,
  record = null,
  transientStyleChanged = false,
  geometryChanged = false,
} = {}) {
  if (!baseline) return false;
  if (String(text ?? '') !== baseline.text) return true;
  if (richTextFingerprint(richText) !== baseline.richTextFingerprint) return true;
  if (recordFingerprint(record) !== baseline.recordFingerprint) return true;
  return transientStyleChanged === true || geometryChanged === true;
}
