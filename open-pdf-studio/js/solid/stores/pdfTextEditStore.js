import { createSignal } from 'solid-js';
import {
  canonicalRichTextHash,
  applyTextFormat,
  graphemeLength,
  richTextToPlainText,
  textFormatState,
} from '../../text/rich-text.js';
import {
  canonicalEditorBoundsForRichText,
  canonicalDeltaFromDisplayDelta,
  mergePageTextEditStyle,
} from '../../text/page-text-edit-placement.js';
import { createEditorLayoutRevision } from '../../text/editor-layout-revision.js';

const [active, setActive] = createSignal(false);
const [editorMountGeneration, setEditorMountGeneration] = createSignal(0);
const [editorStyle, setEditorStyle] = createSignal({});
const [editorPlacement, setEditorPlacement] = createSignal(null);
const [text, setText] = createSignal('');
const [commitHandler, setCommitHandler] = createSignal(null);
const [cancelHandler, setCancelHandler] = createSignal(null);
const [keyDownHandler, setKeyDownHandler] = createSignal(null);
const [blurHandler, setBlurHandler] = createSignal(null);
const [selectOnFocus, setSelectOnFocus] = createSignal(false);
const [editorOptions, setEditorOptions] = createSignal({});
const [editorStatus, setEditorStatusValue] = createSignal('');
const [editorStatusKind, setEditorStatusKind] = createSignal(null);
const [editorLayoutState, setEditorLayoutState] = createSignal({ pending: false, valid: true, message: '' });
const [richTextDocument, setRichTextDocument] = createSignal(null);
const [richTextDraftRevision, setRichTextDraftRevision] = createSignal(0);
const [richTextSelection, setRichTextSelection] = createSignal(null);
const [typingStyle, setTypingStyle] = createSignal(null);
const [mixedFormatState, setMixedFormatState] = createSignal({});
const RICH_TEXT_HISTORY_MAX_ENTRIES = 100;
const RICH_TEXT_HISTORY_MAX_BYTES = 12 * 1024 * 1024;
const RICH_TEXT_TYPING_COALESCE_MS = 350;
let richTextHistory = [];
// Index points immediately after the last applied entry (0..length).
let richTextHistoryIndex = 0;
let richTextHistoryApproxBytes = 0;
let editorSessionGeneration = 0;
let editorDraftFlushHandler = null;
let activeMountOwner = null;
const EDITOR_LIFECYCLE_HISTORY_LIMIT = 64;
const editorLifecycleHistory = [];

function immutableMountOwner(value) {
  const mountGeneration = Number(value?.mountGeneration);
  if (!Number.isInteger(mountGeneration) || mountGeneration <= 0) return null;
  return Object.freeze({
    mountGeneration,
    sessionId: value?.sessionId ? String(value.sessionId) : null,
    documentId: value?.documentId ? String(value.documentId) : null,
    documentGeneration: Number(value?.documentGeneration) || 0,
  });
}

function recordEditorLifecycle(event) {
  const portalConnected = [...(globalThis.document
    ?.querySelectorAll?.('.pdf-text-edit-portal') || [])]
    .some((portal) => portal?.isConnected !== false);
  const value = Object.freeze({
    at: Math.round(globalThis.performance?.now?.() || Date.now()),
    portalConnected,
    ...event,
  });
  editorLifecycleHistory.push(value);
  if (editorLifecycleHistory.length > EDITOR_LIFECYCLE_HISTORY_LIMIT) {
    editorLifecycleHistory.splice(0, editorLifecycleHistory.length - EDITOR_LIFECYCLE_HISTORY_LIMIT);
  }
  return value;
}

export function pdfTextEditorLifecycleDiagnostics() {
  return Object.freeze(editorLifecycleHistory.map((entry) => Object.freeze({ ...entry })));
}

export function setEditorStatus(value, kind = 'info') {
  const message = String(value || '');
  setEditorStatusValue(message);
  setEditorStatusKind(message ? kind : null);
}

function cloneRichTextDocument(document) {
  // Rich-text drafts can come from Solid store proxies during re-editing.
  // The manifest contract is JSON-only, so a JSON clone safely unwraps them.
  return JSON.parse(JSON.stringify(document));
}

function cloneHistoryValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableArrayIdentity(value) {
  if (value && typeof value === 'object' && typeof value.id === 'string') return `id:${value.id}`;
  if (value === null || typeof value !== 'object') return `${typeof value}:${String(value)}`;
  return null;
}

function diffHistoryValues(before, after, path = [], operations = []) {
  if (before === after) return operations;
  if (typeof before === 'string' && typeof after === 'string') {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start
        && before[beforeEnd - 1] === after[afterEnd - 1]) {
      beforeEnd -= 1;
      afterEnd -= 1;
    }
    operations.push({
      type: 'string-splice',
      path,
      start,
      removed: before.slice(start, beforeEnd),
      inserted: after.slice(start, afterEnd),
    });
    return operations;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length === after.length) {
      for (let index = 0; index < before.length; index += 1) {
        diffHistoryValues(before[index], after[index], [...path, index], operations);
      }
      return operations;
    }
    let prefix = 0;
    while (prefix < before.length && prefix < after.length) {
      const left = stableArrayIdentity(before[prefix]);
      const right = stableArrayIdentity(after[prefix]);
      if (left === null || left !== right) break;
      diffHistoryValues(before[prefix], after[prefix], [...path, prefix], operations);
      prefix += 1;
    }
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix) {
      const beforeIndex = before.length - 1 - suffix;
      const afterIndex = after.length - 1 - suffix;
      const left = stableArrayIdentity(before[beforeIndex]);
      const right = stableArrayIdentity(after[afterIndex]);
      if (left === null || left !== right) break;
      // Suffix edits are applied before the splice, at their original index.
      diffHistoryValues(before[beforeIndex], after[afterIndex], [...path, beforeIndex], operations);
      suffix += 1;
    }
    operations.push({
      type: 'array-splice',
      path,
      start: prefix,
      removed: cloneHistoryValue(before.slice(prefix, before.length - suffix)),
      inserted: cloneHistoryValue(after.slice(prefix, after.length - suffix)),
    });
    return operations;
  }
  const beforeObject = before && typeof before === 'object' && !Array.isArray(before);
  const afterObject = after && typeof after === 'object' && !Array.isArray(after);
  if (beforeObject && afterObject) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const beforeExists = Object.hasOwn(before, key);
      const afterExists = Object.hasOwn(after, key);
      if (beforeExists && afterExists) {
        diffHistoryValues(before[key], after[key], [...path, key], operations);
      } else {
        operations.push({
          type: 'property',
          path: [...path, key],
          beforeExists,
          afterExists,
          before: cloneHistoryValue(before[key]),
          after: cloneHistoryValue(after[key]),
        });
      }
    }
    return operations;
  }
  operations.push({
    type: 'replace',
    path,
    before: cloneHistoryValue(before),
    after: cloneHistoryValue(after),
  });
  return operations;
}

function historyParent(root, path) {
  let value = root;
  for (let index = 0; index < path.length - 1; index += 1) value = value[path[index]];
  return { parent: value, key: path.at(-1) };
}

function applyHistoryOperation(root, operation, direction) {
  const { parent, key } = historyParent(root, operation.path);
  const target = operation.path.length === 0 ? root : parent[key];
  if (operation.type === 'string-splice') {
    if (direction === 'redo' && operation.redoValueRetained === false) return null;
    const removed = direction === 'redo'
      ? operation.removed
      : operation.redoValueRetained === false
        ? { length: operation.insertedLength }
        : operation.inserted;
    const inserted = direction === 'redo' ? operation.inserted : operation.removed;
    const next = `${target.slice(0, operation.start)}${inserted}${target.slice(operation.start + removed.length)}`;
    if (operation.path.length === 0) return next;
    parent[key] = next;
    return root;
  }
  if (operation.type === 'array-splice') {
    if (direction === 'redo' && operation.redoValueRetained === false) return null;
    const removed = direction === 'redo'
      ? operation.removed
      : operation.redoValueRetained === false
        ? { length: operation.insertedLength }
        : operation.inserted;
    const inserted = direction === 'redo' ? operation.inserted : operation.removed;
    target.splice(operation.start, removed.length, ...cloneHistoryValue(inserted));
    return root;
  }
  if (operation.type === 'property') {
    if (direction === 'redo' && operation.redoValueRetained === false) return null;
    const exists = direction === 'redo' ? operation.afterExists : operation.beforeExists;
    if (exists) parent[key] = cloneHistoryValue(direction === 'redo' ? operation.after : operation.before);
    else delete parent[key];
    return root;
  }
  if (direction === 'redo' && operation.redoValueRetained === false) return null;
  const replacement = cloneHistoryValue(direction === 'redo' ? operation.after : operation.before);
  if (operation.path.length === 0) return replacement;
  parent[key] = replacement;
  return root;
}

function estimateHistoryEntryBytes(entry) {
  return JSON.stringify(entry).length * 2;
}

function recomputeHistoryBytes() {
  richTextHistoryApproxBytes = richTextHistory.reduce(
    (sum, entry) => sum + estimateHistoryEntryBytes(entry), 0,
  );
}

function plainTextEditRange(before, after) {
  const left = richTextToPlainText(before);
  const right = richTextToPlainText(after);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  return { start, removedLength: leftEnd - start, insertedLength: rightEnd - start };
}

function adjacentTypingRanges(previous, next) {
  if (!previous || !next) return false;
  const previousEnd = previous.start + previous.insertedLength;
  const nextRemovedEnd = next.start + next.removedLength;
  return next.start <= previousEnd && nextRemovedEnd >= previous.start;
}

function compactEntryToUndoOnly(entry) {
  if (entry.redoUnavailable) return false;
  for (const operation of entry.operations) {
    if (operation.type === 'string-splice') {
      operation.insertedLength = operation.inserted.length;
      operation.inserted = null;
    } else if (operation.type === 'array-splice') {
      operation.insertedLength = operation.inserted.length;
      operation.inserted = null;
    } else if (operation.type === 'property') {
      operation.after = undefined;
    } else {
      operation.after = undefined;
    }
    operation.redoValueRetained = false;
  }
  entry.redoUnavailable = true;
  return true;
}

function appendHistoryEntry(entry, beforeDocument = null, afterDocument = null) {
  if (!entry.operations.length && !entry.geometry) return false;
  if (richTextHistoryIndex < richTextHistory.length) {
    richTextHistory = richTextHistory.slice(0, richTextHistoryIndex);
  }
  const previous = richTextHistory.at(-1);
  if (entry.kind === 'typing' && previous?.kind === 'typing'
      && entry.timestamp - previous.timestamp <= RICH_TEXT_TYPING_COALESCE_MS
      && adjacentTypingRanges(previous.textRange, entry.textRange)) {
    // Preserve one reversible typing unit without retaining every intermediate
    // DOM reconstruction. Recover the unit's original document by undoing the
    // existing patch against the current pre-input draft, then diff that
    // baseline directly to the latest draft. This keeps coalescing linear in
    // the current document size instead of accumulating O(n^2) patch payloads
    // when Chromium recreates line/run identities during select-all typing.
    if (beforeDocument && afterDocument) {
      let baseline = cloneRichTextDocument(beforeDocument);
      for (let index = previous.operations.length - 1; index >= 0; index -= 1) {
        baseline = applyHistoryOperation(baseline, previous.operations[index], 'undo');
      }
      previous.operations = diffHistoryValues(baseline, afterDocument);
      previous.textRange = plainTextEditRange(baseline, afterDocument);
    } else {
      previous.operations.push(...entry.operations);
    }
    previous.timestamp = entry.timestamp;
    previous.selectionAfter = cloneHistoryValue(entry.selectionAfter);
  } else {
    richTextHistory.push(entry);
  }
  richTextHistoryIndex = richTextHistory.length;
  recomputeHistoryBytes();
  while (richTextHistory.length > RICH_TEXT_HISTORY_MAX_ENTRIES
      || richTextHistoryApproxBytes > RICH_TEXT_HISTORY_MAX_BYTES) {
    if (richTextHistory.length === 1
        && richTextHistoryApproxBytes > RICH_TEXT_HISTORY_MAX_BYTES
        && compactEntryToUndoOnly(richTextHistory[0])) {
      recomputeHistoryBytes();
      continue;
    }
    richTextHistory.shift();
    richTextHistoryIndex = Math.max(0, richTextHistoryIndex - 1);
    recomputeHistoryBytes();
  }
  return true;
}

function recordDocumentHistory(before, after, kind = 'typing', geometry = null) {
  return appendHistoryEntry({
    kind,
    timestamp: performance.now(),
    operations: diffHistoryValues(before, after),
    selectionBefore: cloneHistoryValue(richTextSelection()),
    selectionAfter: cloneHistoryValue(richTextSelection()),
    geometry: cloneHistoryValue(geometry),
    textRange: plainTextEditRange(before, after),
  }, before, after);
}

export function showPdfTextEditor(style, initialText, handlers) {
  setEditorStyle(style);
  const placement = handlers.options?.placement;
  setEditorPlacement(placement ? {
    ...placement,
    sessionGeneration: ++editorSessionGeneration,
  } : null);
  setText(initialText);
  setCommitHandler(() => handlers.onCommit || null);
  setCancelHandler(() => handlers.onCancel || null);
  setKeyDownHandler(() => handlers.onKeyDown || null);
  setBlurHandler(() => handlers.onBlur || null);
  setEditorOptions(handlers.options || {});
  setEditorStatus('');
  setEditorLayoutState({ pending: false, valid: true, message: '' });
  editorDraftFlushHandler = null;
  // Never let the live contentEditable draft mutate the record (or a Solid
  // proxy for it) before commit. Re-editing always works on an isolated copy.
  const sourceRichText = handlers.options?.richTextDocument || null;
  const richText = sourceRichText ? cloneRichTextDocument(sourceRichText) : null;
  setRichTextDocument(richText);
  setRichTextDraftRevision((revision) => revision + 1);
  richTextHistory = [];
  richTextHistoryIndex = 0;
  richTextHistoryApproxBytes = 0;
  setRichTextSelection(richText ? {
    anchor: { line: 0, offset: 0 },
    focus: {
      line: richText.lines.length - 1,
      offset: richText.lines.at(-1).runs.reduce((sum, run) => sum + graphemeLength(run.text), 0),
    },
  } : null);
  setTypingStyle(null);
  setMixedFormatState(richText ? textFormatState(richText, richTextSelection()) : {});
  setSelectOnFocus(true);
  // Key the Solid subtree independently from active(). A fast close/re-open
  // can be batched as true -> false -> true, which otherwise preserves the
  // externally reparented portal from the previous editor session.
  const runtimeOwner = handlers.runtimeOwner || {};
  const mountOwner = Object.freeze({
    mountGeneration: editorMountGeneration() + 1,
    sessionId: runtimeOwner.sessionId ? String(runtimeOwner.sessionId) : null,
    documentId: runtimeOwner.documentId ? String(runtimeOwner.documentId) : null,
    documentGeneration: Number(runtimeOwner.documentGeneration) || 0,
  });
  activeMountOwner = mountOwner;
  setEditorMountGeneration(mountOwner.mountGeneration);
  setActive(true);
  recordEditorLifecycle({
    event: 'opened',
    result: 'active',
    mountGeneration: mountOwner.mountGeneration,
    sessionId: mountOwner.sessionId,
    documentId: mountOwner.documentId ?? placement?.documentId ?? null,
    documentGeneration: mountOwner.documentGeneration || Number(placement?.generation) || 0,
    pageNum: Number(placement?.pageNum) || null,
  });
  return mountOwner;
}

export function hidePdfTextEditor(owner, reason = 'unspecified') {
  const requestedOwner = immutableMountOwner(owner);
  const currentMountGeneration = activeMountOwner?.mountGeneration ?? null;
  const requestedMountGeneration = requestedOwner?.mountGeneration ?? null;
  if (!active()) {
    const result = Object.freeze({
      status: 'inactive',
      reason,
      requestedMountGeneration,
      activeMountGeneration: currentMountGeneration,
      requestedSessionId: requestedOwner?.sessionId ?? null,
      activeSessionId: activeMountOwner?.sessionId ?? null,
    });
    recordEditorLifecycle({ event: 'close', result: result.status, ...result });
    return result;
  }
  if (!requestedOwner || requestedMountGeneration !== currentMountGeneration) {
    const result = Object.freeze({
      status: 'superseded',
      reason,
      requestedMountGeneration,
      activeMountGeneration: currentMountGeneration,
      requestedSessionId: requestedOwner?.sessionId ?? null,
      activeSessionId: activeMountOwner?.sessionId ?? null,
    });
    recordEditorLifecycle({ event: 'close', result: result.status, ...result });
    return result;
  }
  // PdfTextEditOverlay reparents its portal into the active page so placement
  // shares the canvas coordinate system. Remove that moved subtree before
  // toggling Solid state: the original <Show> anchor cannot detach a node that
  // is no longer its child, and an orphaned editor would intercept re-edit
  // clicks after Apply/Cancel.
  for (const portal of globalThis.document?.querySelectorAll?.('.pdf-text-edit-portal') || []) {
    const host = portal.parentElement;
    portal.remove();
    if (host?.classList?.contains('pdf-text-edit-layer') && host.childElementCount === 0) {
      host.remove();
    }
  }
  activeMountOwner = null;
  setActive(false);
  setEditorPlacement(null);
  setSelectOnFocus(false);
  setEditorOptions({});
  setEditorStatus('');
  setEditorLayoutState({ pending: false, valid: true, message: '' });
  editorDraftFlushHandler = null;
  setRichTextDocument(null);
  setRichTextDraftRevision((revision) => revision + 1);
  setRichTextSelection(null);
  setTypingStyle(null);
  setMixedFormatState({});
  richTextHistory = [];
  richTextHistoryIndex = 0;
  richTextHistoryApproxBytes = 0;
  const result = Object.freeze({
    status: 'closed',
    reason,
    requestedMountGeneration,
    activeMountGeneration: currentMountGeneration,
    requestedSessionId: requestedOwner.sessionId,
    activeSessionId: activeMountOwner?.sessionId ?? requestedOwner.sessionId,
  });
  recordEditorLifecycle({ event: 'close', result: result.status, ...result });
  return result;
}

export function getEditorText() {
  return richTextDocument() ? richTextToPlainText(richTextDocument()) : text();
}

export function getEditorRichText() {
  return richTextDocument();
}

export function getEditorLayoutState() {
  return editorLayoutState();
}

export function getEditorFormatState() {
  return mixedFormatState();
}

export function updateRichTextDraft(document, {
  recordHistory = true,
  preserveDom = false,
  historyKind = 'typing',
  advanceDraftRevision = true,
} = {}) {
  const currentBeforeUpdate = richTextDocument();
  const before = currentBeforeUpdate ? cloneRichTextDocument(currentBeforeUpdate) : null;
  const nextDocument = cloneRichTextDocument(document);
  if (recordHistory && before) recordDocumentHistory(before, nextDocument, historyKind);
  if (preserveDom) {
    // contentEditable owns the live DOM while the user is typing. Replacing
    // the signal value on every input makes Solid reconcile the keyed line/run
    // nodes, which destroys the native caret and can turn a select-all
    // replacement into an empty document.
    const current = richTextDocument();
    if (current) {
      const snapshot = nextDocument;
      for (const key of Object.keys(current)) {
        if (!Object.hasOwn(snapshot, key)) delete current[key];
      }
      Object.assign(current, snapshot);
    } else {
      setRichTextDocument(nextDocument);
    }
  } else {
    setRichTextDocument(nextDocument);
  }
  if (advanceDraftRevision) setRichTextDraftRevision((revision) => revision + 1);
  setText(richTextToPlainText(nextDocument));
  if (richTextSelection()) setMixedFormatState(textFormatState(nextDocument, richTextSelection()));
}

export function undoRichTextDraft() {
  if (richTextHistoryIndex <= 0 || !richTextDocument()) return false;
  richTextHistoryIndex -= 1;
  const entry = richTextHistory[richTextHistoryIndex];
  let next = cloneRichTextDocument(richTextDocument());
  for (let index = entry.operations.length - 1; index >= 0; index -= 1) {
    next = applyHistoryOperation(next, entry.operations[index], 'undo');
    if (!next) return false;
  }
  updateRichTextDraft(next, { recordHistory: false });
  if (entry.geometry?.before) applyEditorGeometryHistory(entry.geometry.before);
  if (entry.selectionBefore) updateRichTextSelection(cloneHistoryValue(entry.selectionBefore));
  return true;
}

export function redoRichTextDraft() {
  if (richTextHistoryIndex >= richTextHistory.length || !richTextDocument()) return false;
  const entry = richTextHistory[richTextHistoryIndex];
  if (entry.redoUnavailable) return false;
  let next = cloneRichTextDocument(richTextDocument());
  for (const operation of entry.operations) {
    next = applyHistoryOperation(next, operation, 'redo');
    if (!next) return false;
  }
  richTextHistoryIndex += 1;
  updateRichTextDraft(next, { recordHistory: false });
  if (entry.geometry?.after) applyEditorGeometryHistory(entry.geometry.after);
  if (entry.selectionAfter) updateRichTextSelection(cloneHistoryValue(entry.selectionAfter));
  return true;
}

export function richTextHistoryMetrics() {
  return {
    entries: richTextHistory.length,
    appliedEntries: richTextHistoryIndex,
    approximateBytes: richTextHistoryApproxBytes,
    maxEntries: RICH_TEXT_HISTORY_MAX_ENTRIES,
    maxBytes: RICH_TEXT_HISTORY_MAX_BYTES,
    typingCoalesceMs: RICH_TEXT_TYPING_COALESCE_MS,
    redoUnavailableEntries: richTextHistory.filter((entry) => entry.redoUnavailable).length,
  };
}

export function updateRichTextSelection(selection) {
  setRichTextSelection(selection);
  const document = richTextDocument();
  if (document) setMixedFormatState(textFormatState(document, selection));
}

export function applyRichTextDraftFormat(patch) {
  const document = richTextDocument();
  const selection = richTextSelection();
  if (!document || !selection) return false;
  const result = applyTextFormat(document, selection, patch);
  if (result.collapsed) setTypingStyle((previous) => ({ ...(previous || {}), ...patch }));
  else {
    setTypingStyle(null);
    updateRichTextDraft(result.document, { historyKind: 'run-format' });
  }
  setMixedFormatState(textFormatState(result.document, selection));
  return true;
}

export function applyRichTextDraftParagraphFormat(key, value) {
  const document = richTextDocument();
  const selection = richTextSelection();
  if (!document || !selection) return false;
  const next = cloneRichTextDocument(document);
  const start = Math.min(selection.anchor.line, selection.focus.line);
  const end = Math.max(selection.anchor.line, selection.focus.line);
  for (let index = start; index <= end; index += 1) {
    if (key === 'alignment' && ['left', 'center', 'right'].includes(value)) {
      next.lines[index].alignment = value;
    } else if (key === 'baselineAdvance' && Number(value) > 0) {
      next.lines[index].baselineAdvance = Number(value);
    } else if (key === 'lineSpacingMultiplier' && Number(value) > 0) {
      const maximumRunSize = Math.max(...next.lines[index].runs.map((run) => Number(run.size) || 0));
      next.lines[index].baselineAdvance = maximumRunSize * Number(value);
    }
  }
  if (key === 'baselineAdvance' || key === 'lineSpacingMultiplier') {
    const baselineSign = next.region.baselineDirection === 'increasing-y' ? 1 : -1;
    for (let index = 1; index < next.lines.length; index += 1) {
      next.lines[index].baseline = next.lines[index - 1].baseline
        + baselineSign * next.lines[index - 1].baselineAdvance;
    }
  }
  updateRichTextDraft(next, { historyKind: 'paragraph-format' });
  return true;
}

// Merge a partial style object into the live editor style (used when the
// properties panel changes font/colour/weight while a text edit is open).
export function updateEditorStyle(partial, canonicalPatch = null) {
  setEditorStyle(prev => ({ ...(prev || {}), ...partial }));
  setEditorPlacement((previous) => {
    if (!previous || !canonicalPatch) return previous;
    return {
      ...previous,
      canonicalStyle: mergePageTextEditStyle(previous.canonicalStyle, canonicalPatch),
    };
  });
}

// Shift the live editor's fixed position by a pixel delta (used for keyboard
// nudge / move of the active text edit). left/top are 'Npx' strings.
export function shiftEditorPosition(dxPx, dyPx) {
  setEditorStyle(prev => {
    const s = { ...(prev || {}) };
    const l = parseFloat(s.left) || 0;
    const t = parseFloat(s.top) || 0;
    s.left = `${l + dxPx}px`;
    s.top = `${t + dyPx}px`;
    return s;
  });
  setEditorPlacement((previous) => {
    if (!previous) return previous;
    const delta = canonicalDeltaFromDisplayDelta({ x: dxPx, y: dyPx }, {
      scale: previous.sourceScale,
      rotation: previous.sourceRotation,
    });
    return {
      ...previous,
      canonicalBounds: {
        ...previous.canonicalBounds,
        x: previous.canonicalBounds.x + delta.x,
        y: previous.canonicalBounds.y + delta.y,
      },
    };
  });
}

export function updateEditorGeometry({ canonicalBounds, width, minimumHeight, anchorTop }) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(minimumHeight) || 1);
  setEditorPlacement((previous) => {
    if (!previous || !canonicalBounds) return previous;
    return {
      ...previous,
      canonicalBounds: { ...canonicalBounds },
      sourceClientAnchor: null,
      canonicalStyle: mergePageTextEditStyle(previous.canonicalStyle, {
        geometry: { width: safeWidth, height: safeHeight, offsetX: 0, offsetY: 0 },
      }),
    };
  });
  setEditorStyle((previous) => {
    const placement = editorPlacement();
    const sourceScale = Math.max(0.0001, Number(placement?.sourceScale) || 1);
    return {
      ...(previous || {}),
      width: `${safeWidth * sourceScale}px`,
      height: `${safeHeight * sourceScale}px`,
    };
  });
  setEditorOptions((previous) => {
    if (!previous?.expandableRegion) return previous;
    const priorWidth = Math.max(0.0001, Number(previous.expandableRegion.width) || safeWidth);
    const widthDelta = safeWidth - priorWidth;
    return {
      ...previous,
      expandableRegion: {
        ...previous.expandableRegion,
        width: safeWidth,
        contentWidth: Math.max(
          0.0001,
          (Number(previous.expandableRegion.contentWidth)
            || priorWidth - 2 * (previous.expandableRegion.contentInset || 0)) + widthDelta,
        ),
        effectiveContentWidth: Math.max(
          0.0001,
          (Number(previous.expandableRegion.effectiveContentWidth)
            || Number(previous.expandableRegion.contentWidth)
            || priorWidth - 2 * (previous.expandableRegion.contentInset || 0)) + widthDelta,
        ),
        minimumHeight: safeHeight,
        anchorTop: Number.isFinite(anchorTop) ? anchorTop : previous.expandableRegion.anchorTop,
      },
    };
  });
}

export function setEditorDraftFlushHandler(handler) {
  editorDraftFlushHandler = typeof handler === 'function' ? handler : null;
}

function immutableJson(value) {
  if (value == null || typeof value !== 'object') return value;
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = (item) => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(copy);
}

/** Synchronously seal the visible contentEditable draft for one Apply request. */
export function flushEditorDraftForCommit({
  sessionId,
  ownerDocumentId,
  ownerDocumentGeneration,
} = {}) {
  const authoredChangedByFlush = editorDraftFlushHandler?.() === true;
  const document = richTextDocument();
  if (!document) return null;
  const snapshot = immutableJson(document);
  const placement = editorPlacement();
  const config = editorOptions().expandableRegion;
  const { onDraftLayout: _onDraftLayout, ...layoutConfig } = config || {};
  const draftRevision = richTextDraftRevision();
  const identity = {
    sessionId: String(sessionId || ''),
    ownerDocumentId: String(ownerDocumentId || placement?.documentId || ''),
    ownerDocumentGeneration: Number(ownerDocumentGeneration) || 0,
    editorMountGeneration: editorMountGeneration(),
    draftRevision,
    placementGeneration: Number(placement?.sessionGeneration) || 0,
  };
  const frozenConfig = immutableJson(layoutConfig);
  return Object.freeze({
    sessionId: identity.sessionId,
    ownerDocumentId: identity.ownerDocumentId,
    ownerDocumentGeneration: identity.ownerDocumentGeneration,
    editorMountGeneration: identity.editorMountGeneration,
    placementGeneration: identity.placementGeneration,
    draftRevision,
    authoredChangedByFlush,
    document: snapshot,
    plainText: richTextToPlainText(snapshot),
    options: frozenConfig,
    identity: Object.freeze(identity),
    layoutRevision: createEditorLayoutRevision(snapshot, frozenConfig, identity),
    sourceHash: canonicalRichTextHash(snapshot),
  });
}

/** Adopt the exact final layout without creating a second authored draft unit. */
export function adoptFinalTextLayoutDecision(value) {
  if (!value || !['ready', 'auto-fitted', 'blocked', 'failed', 'superseded'].includes(value.status)) {
    return false;
  }
  const accepted = ['ready', 'auto-fitted'].includes(value.status);
  setEditorLayoutState({
    pending: false,
    valid: accepted,
    requestedFingerprint: value.requestedFingerprint,
    validatedFingerprint: value.validatedFingerprint,
    validatedRevision: null,
    message: (value.rejectionReasons || []).join('; '),
    finalDecision: value,
    statuses: accepted ? {} : {
      overflow: (value.rejectionReasons || []).join('; '),
    },
  });
  if (!accepted || !value.document) return true;
  const document = cloneRichTextDocument(value.document);
  updateRichTextDraft(document, {
    recordHistory: false,
    preserveDom: true,
    advanceDraftRevision: false,
  });
  const placement = editorPlacement();
  if (placement) {
    const canonicalBounds = canonicalEditorBoundsForRichText(
      document.region,
      placement.pageHeight,
    );
    updateEditorGeometry({
      canonicalBounds,
      width: document.region.width,
      minimumHeight: document.region.height,
      anchorTop: document.region.y + document.region.height,
    });
  }
  setEditorStatus('');
  return true;
}

/**
 * Publish exact-layout geometry without changing the immutable source width
 * used to decide whether automatic font compensation is permitted.
 */
export function updateEditorValidatedLayoutGeometry({ canonicalBounds, effectiveContentWidth }) {
  if (!canonicalBounds) return;
  const safeWidth = Math.max(0.0001, Number(canonicalBounds.width) || 0.0001);
  const safeHeight = Math.max(0.0001, Number(canonicalBounds.height) || 0.0001);
  setEditorPlacement((previous) => previous ? {
    ...previous,
    canonicalBounds: { ...canonicalBounds },
    sourceClientAnchor: null,
    canonicalStyle: mergePageTextEditStyle(previous.canonicalStyle, {
      geometry: { width: safeWidth, height: safeHeight, offsetX: 0, offsetY: 0 },
    }),
  } : previous);
  setEditorStyle((previous) => {
    const placement = editorPlacement();
    const sourceScale = Math.max(0.0001, Number(placement?.sourceScale) || 1);
    return {
      ...(previous || {}),
      width: `${safeWidth * sourceScale}px`,
      height: `${safeHeight * sourceScale}px`,
    };
  });
  setEditorOptions((previous) => previous?.expandableRegion ? {
    ...previous,
    expandableRegion: {
      ...previous.expandableRegion,
      effectiveContentWidth: Math.max(
        0.0001,
        Number(effectiveContentWidth) || previous.expandableRegion.contentWidth,
      ),
    },
  } : previous);
}

function applyEditorGeometryHistory(geometry) {
  if (!geometry?.canonicalBounds) return;
  updateEditorGeometry({
    canonicalBounds: cloneHistoryValue(geometry.canonicalBounds),
    width: geometry.width,
    minimumHeight: geometry.minimumHeight,
    anchorTop: geometry.anchorTop,
  });
}

/** Record an entire pointer move/resize as one reversible undo unit. */
export function recordEditorGeometryHistory({
  beforeDocument,
  afterDocument,
  beforeGeometry,
  afterGeometry,
}) {
  if (!beforeDocument || !afterDocument || !beforeGeometry || !afterGeometry) return false;
  return recordDocumentHistory(
    cloneRichTextDocument(beforeDocument),
    cloneRichTextDocument(afterDocument),
    'geometry',
    { before: beforeGeometry, after: afterGeometry },
  );
}

export { active, editorMountGeneration, editorStyle, editorPlacement, text, setText, commitHandler, cancelHandler, keyDownHandler, blurHandler,
  selectOnFocus, setSelectOnFocus, editorOptions, editorStatus, editorStatusKind,
  editorLayoutState, setEditorLayoutState,
  richTextDocument, richTextDraftRevision, richTextSelection, typingStyle, mixedFormatState };
