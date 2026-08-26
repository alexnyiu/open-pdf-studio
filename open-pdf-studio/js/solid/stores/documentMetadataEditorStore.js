import { getActiveDocument } from '../../core/state.js';
import { recordDocumentMetadata } from '../../core/undo-manager.js';
import {
  cloneDocumentMetadata,
  documentMetadataEqual,
  documentMetadataWithEditorField,
  normalizeDocumentMetadata,
} from '../../pdf/document-metadata.js';
import { populateDocInfo } from './propertiesStore.js';

function activeOwnedDocument(documentId) {
  const document = getActiveDocument();
  return document && String(document.id) === String(documentId) ? document : null;
}

export async function commitDocumentMetadata({ documentId, metadata }) {
  const document = activeOwnedDocument(documentId);
  if (!document) return { changed: false, stale: true };
  const before = cloneDocumentMetadata(document.metadata);
  const after = normalizeDocumentMetadata(metadata);
  if (documentMetadataEqual(before, after)) return { changed: false, stale: false, metadata: before };
  document.metadata = cloneDocumentMetadata(after);
  recordDocumentMetadata(before, after);
  await populateDocInfo();
  return { changed: true, stale: false, metadata: cloneDocumentMetadata(after) };
}

export async function commitDocumentMetadataField({ documentId, field, value }) {
  const document = activeOwnedDocument(documentId);
  if (!document) return { changed: false, stale: true };
  const metadata = documentMetadataWithEditorField(document.metadata, field, value);
  return commitDocumentMetadata({ documentId, metadata });
}
