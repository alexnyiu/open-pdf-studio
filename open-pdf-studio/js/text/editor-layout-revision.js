import { canonicalRichTextHash } from './rich-text.js';

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function canonicalBounds(bounds) {
  if (!bounds) return null;
  return {
    x: finite(bounds.x ?? bounds.left),
    y: finite(bounds.y ?? bounds.top ?? bounds.bottom),
    width: finite(bounds.width),
    height: finite(bounds.height),
    left: finite(bounds.left),
    right: finite(bounds.right),
  };
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function hash(value) {
  const input = JSON.stringify(stableObject(value));
  let result = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    result ^= input.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return `layout-${(result >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Immutable identity for every input that can affect exact native layout.
 * Results may publish only when their fingerprint still matches this value.
 */
export function createEditorLayoutRevision(document, config = {}, identity = {}) {
  const payload = {
    richTextHash: canonicalRichTextHash(document),
    lines: document.lines.map((line) => ({
      id: line.id,
      alignment: line.alignment,
      baseline: finite(line.baseline),
      baselineAdvance: finite(line.baselineAdvance),
      breakAfter: line.breakAfter || 'hard',
      runs: line.runs.map((run) => ({
        id: run.id,
        text: run.text,
        faceId: run.faceId,
        size: finite(run.size),
        color: run.color,
        bold: run.bold === true,
        italic: run.italic === true,
        underline: run.underline === true,
        strikeout: run.strikeout === true,
        direction: run.direction,
      })),
    })),
    region: canonicalBounds(document.region),
    config: {
      width: finite(config.width),
      contentWidth: finite(config.contentWidth),
      contentInset: finite(config.contentInset),
      inkPadding: finite(config.inkPadding),
      minimumHeight: finite(config.minimumHeight),
      anchorTop: finite(config.anchorTop),
      pageBounds: canonicalBounds(config.pageBounds),
      columnBounds: canonicalBounds(config.columnBounds),
      editorBackground: config.editorBackground || null,
      manualLineBreaks: config.manualLineBreaks === true,
      editId: config.editId == null ? null : String(config.editId),
      directManipulationRevision: Number(config.directManipulationRevision) || 0,
      existingBounds: [...(config.existingBounds || [])]
        .map((entry) => ({ id: String(entry?.id || ''), ...canonicalBounds(entry) }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    },
    identity: {
      sessionId: identity.sessionId || null,
      ownerDocumentId: identity.ownerDocumentId || null,
      ownerDocumentGeneration: Number(identity.ownerDocumentGeneration) || 0,
      placementGeneration: Number(identity.placementGeneration) || 0,
    },
  };
  return Object.freeze({ fingerprint: hash(payload), payload: stableObject(payload) });
}

export function sameEditorLayoutRevision(left, right) {
  return Boolean(left?.fingerprint && left.fingerprint === right?.fingerprint);
}
