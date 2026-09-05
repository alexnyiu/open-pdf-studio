import { clonePersistenceValue } from './save-document-snapshot.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const recordIdentity = records => JSON.stringify(canonical([...records].sort((a, b) => String(a.id).localeCompare(String(b.id)))));

export function captureOutputSnapshot(doc, sourceBytes) {
  if (!doc?.pdfDoc || !sourceBytes?.byteLength) throw new Error('The document is not ready for output.');
  const owned = (doc.textEdits || []).filter(edit => edit?.schema);
  const persisted = (doc.textEditManifest?.pages || []).flatMap(page => page.edits || []);
  const needsTextPersistence = recordIdentity(owned) !== recordIdentity(persisted)
      || doc.scannedTextEditRemovalPending
      || Number(doc.scannedTextEdits?.stateRevision || 0) !== Number(doc.scannedTextEditPersistedRevision || 0);
  const snapshot = { id: doc.id, lifecycleGeneration: Number(doc.lifecycleGeneration) || 0,
    revisionState: clonePersistenceValue(doc.revisionState), bytes: sourceBytes.slice(),
    outputPersistedRevision: Number(doc.revisionState?.persistedRevision) || 0,
    needsTextPersistence: !!needsTextPersistence,
    filePath: doc.filePath, fileName: doc.fileName, scale: 1, selectedAnnotations: [] };
  for (const field of ['annotations', 'textEdits', 'watermarks', 'pageRotations', 'pageDims', 'measureScale']) {
    snapshot[field] = clonePersistenceValue(doc[field]);
  }
  return snapshot;
}

export function assertOutputRasterSize(width, height) {
  // Two RGBA surfaces and encoder working memory must fit a bounded page job.
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
      || Math.ceil(width) * Math.ceil(height) > 32 * 1024 * 1024
      || width > 32767 || height > 32767) {
    throw new Error('This page exceeds the output memory limit. Choose a lower DPI or a smaller page size.');
  }
}

/** Bound encoded pages retained by pdf-lib before final serialization. */
export function createOutputBufferBudget(limitBytes = 128 * 1024 * 1024) {
  let retainedBytes = 0;
  return {
    retain(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || retainedBytes + bytes > limitBytes) {
        throw new Error('This output exceeds the document memory limit. Export fewer pages at a time or choose a lower DPI.');
      }
      retainedBytes += bytes;
      return retainedBytes;
    },
    get retainedBytes() { return retainedBytes; },
  };
}
