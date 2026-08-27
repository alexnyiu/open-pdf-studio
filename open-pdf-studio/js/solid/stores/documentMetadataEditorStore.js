import { getActiveDocument } from '../../core/state.js';
import { recordDocumentMetadata } from '../../core/undo-manager.js';
import {
  cloneDocumentMetadata,
  documentMetadataEqual,
  documentMetadataWithEditorField,
  normalizeDocumentMetadata,
} from '../../pdf/document-metadata.js';
import { populateDocInfo } from './propertiesStore.js';

function activeOwnedDocument(documentId, lifecycleGeneration) {
  const document = getActiveDocument();
  if (!document || String(document.id) !== String(documentId)) return null;
  if (lifecycleGeneration !== undefined
      && (Number(document.lifecycleGeneration) || 0) !== Number(lifecycleGeneration)) return null;
  return document;
}

export async function commitDocumentMetadata({ documentId, documentGeneration, metadata }) {
  const document = activeOwnedDocument(documentId, documentGeneration);
  if (!document) return { changed: false, stale: true };
  const before = cloneDocumentMetadata(document.metadata);
  const after = normalizeDocumentMetadata(metadata);
  if (documentMetadataEqual(before, after)) return { changed: false, stale: false, metadata: before };
  document.metadata = cloneDocumentMetadata(after);
  recordDocumentMetadata(before, after);
  await populateDocInfo();
  return { changed: true, stale: false, metadata: cloneDocumentMetadata(after) };
}

export async function commitDocumentMetadataField({ documentId, documentGeneration, field, value }) {
  const document = activeOwnedDocument(documentId, documentGeneration);
  if (!document) return { changed: false, stale: true };
  const metadata = documentMetadataWithEditorField(document.metadata, field, value);
  return commitDocumentMetadata({ documentId, documentGeneration, metadata });
}
