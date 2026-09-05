import { initializeDocumentRevisionState } from '../core/document-revision-state.runtime.js';
import {
  collectOwnedOcrRemovalPageIndexes,
  collectOwnedOcrWriterPages,
} from '../ocr/pdf-persistence.js';
import { cloneOwnedTextEditPersistenceState } from '../text/rich-text.js';

export function clonePersistenceValue(value, seen = new WeakMap()) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return new value.constructor(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (typeof Node !== 'undefined' && value instanceof Node) return undefined;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const output = [];
    seen.set(value, output);
    for (const entry of value) {
      const cloned = clonePersistenceValue(entry, seen);
      if (cloned !== undefined) output.push(cloned);
    }
    return output;
  }
  if (value instanceof Map) {
    const output = [];
    seen.set(value, output);
    for (const [key, entry] of value) {
      output.push([clonePersistenceValue(key, seen), clonePersistenceValue(entry, seen)]);
    }
    return output;
  }
  if (value instanceof Set) {
    const output = [];
    seen.set(value, output);
    for (const entry of value) output.push(clonePersistenceValue(entry, seen));
    return output;
  }
  const output = {};
  seen.set(value, output);
  for (const key of Object.keys(value)) {
    const cloned = clonePersistenceValue(value[key], seen);
    if (cloned !== undefined) output[key] = cloned;
  }
  return output;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  seen.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function normalizedChangedPages(revisionState) {
  if (revisionState.pendingStructuralChange === true) return null;
  const pages = [...new Set((revisionState.pendingChangedPages || [])
    .map(Number)
    .filter((page) => Number.isSafeInteger(page) && page > 0))]
    .sort((left, right) => left - right);
  return pages.length > 0 ? pages : [];
}

/**
 * Capture the only mutable state allowed to cross the coordinated save
 * serialization boundary. PDF.js proxies, DOM objects, callbacks, and caches
 * are deliberately absent.
 */
export function createSaveDocumentSnapshot({
  documentState,
  outputPath,
  requestedRevision,
  formState = { fields: [] },
  capturedAt = new Date().toISOString(),
  expectedDocumentGeneration = documentState?.lifecycleGeneration,
} = {}) {
  if (!documentState?.id) throw new TypeError('A document owner is required');
  const documentGeneration = Number(documentState.lifecycleGeneration) || 0;
  if (documentGeneration !== (Number(expectedDocumentGeneration) || 0)) {
    throw Object.assign(new Error('Document lifecycle changed before save snapshot capture'), {
      code: 'SAVE_SNAPSHOT_STALE_OWNER',
    });
  }
  const revisionState = initializeDocumentRevisionState(documentState);
  const revision = Number(requestedRevision);
  if (!Number.isSafeInteger(revision) || revision < 0
      || revision !== revisionState.contentRevision) {
    throw Object.assign(new Error('Save snapshot revision is not the current committed revision'), {
      code: 'SAVE_SNAPSHOT_STALE_REVISION',
      requestedRevision: revision,
      contentRevision: revisionState.contentRevision,
    });
  }
  const output = String(outputPath || '');
  if (!output) throw new TypeError('A save snapshot output path is required');
  const { records, previousManifest } = cloneOwnedTextEditPersistenceState(documentState);
  const ocrWriterPages = collectOwnedOcrWriterPages(documentState);
  const ocrRemovalPageIndexes = collectOwnedOcrRemovalPageIndexes(documentState);
  const pageGeometries = Object.values(documentState?.ocr?.pages || {})
    .map((pageState) => pageState?.recognition?.geometry)
    .filter(Boolean);
  const snapshot = {
    documentId: String(documentState.id),
    lifecycleGeneration: documentGeneration,
    requestedRevision: revision,
    capturedAt: String(capturedAt),
    currentPath: documentState.filePath == null ? null : String(documentState.filePath),
    outputPath: output,
    fileName: String(documentState.fileName || ''),
    pageCount: Math.max(0, Number(documentState.pdfDoc?.numPages) || 0),
    pageRotations: clonePersistenceValue(documentState.pageRotations || {}),
    annotations: clonePersistenceValue(documentState.annotations || []),
    textEdits: clonePersistenceValue(records),
    textEditManifest: clonePersistenceValue(previousManifest),
    metadata: clonePersistenceValue(documentState.metadata || {}),
    watermarks: clonePersistenceValue(documentState.watermarks || []),
    bookmarks: clonePersistenceValue(documentState.bookmarks || []),
    stylePresets: clonePersistenceValue(documentState.stylePresets || []),
    formState: clonePersistenceValue(formState || { fields: [] }),
    ocrState: {
      dirty: documentState?.ocr?.dirty === true,
      writerPages: clonePersistenceValue(ocrWriterPages),
      removePageIndexes: clonePersistenceValue(ocrRemovalPageIndexes),
      pageGeometries: clonePersistenceValue(pageGeometries),
    },
    scannedTextState: {
      state: clonePersistenceValue(documentState.scannedTextEdits || null),
      persistedRevision: Number(documentState.scannedTextEditPersistedRevision) || 0,
      removalPending: documentState.scannedTextEditRemovalPending === true,
    },
    pdfaCompliance: clonePersistenceValue(documentState.pdfaCompliance),
    changedPages: normalizedChangedPages(revisionState),
    structuralChange: revisionState.pendingStructuralChange === true,
  };
  return deepFreeze(snapshot);
}

export function saveDocumentSnapshotOwns(snapshot, documentState) {
  return Boolean(snapshot && documentState
    && String(snapshot.documentId) === String(documentState.id)
    && Number(snapshot.lifecycleGeneration) === (Number(documentState.lifecycleGeneration) || 0));
}
