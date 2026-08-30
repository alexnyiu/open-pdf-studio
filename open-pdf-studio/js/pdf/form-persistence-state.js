const fieldNamesByDocument = new Map();

export function formFieldNameMapForDocument(documentState, { create = false } = {}) {
  const documentId = String(documentState?.id || '');
  if (!documentId) return new Map();
  let fields = fieldNamesByDocument.get(documentId);
  if (!fields && create) {
    fields = new Map();
    fieldNamesByDocument.set(documentId, fields);
  }
  return fields || new Map();
}

export function resetFormPersistenceState(documentState) {
  const documentId = String(documentState?.id || '');
  if (!documentId) return false;
  return fieldNamesByDocument.delete(documentId);
}

export function formAnnotationStorageForDocument(documentState) {
  return documentState?.pdfDoc?.annotationStorage || null;
}

export function captureFormPersistenceState(documentState) {
  const storage = formAnnotationStorageForDocument(documentState);
  const fields = [];
  for (const [annotationId, fieldName] of formFieldNameMapForDocument(documentState)) {
    const storedValue = storage?.getRawValue?.(annotationId);
    if (storedValue === undefined) continue;
    fields.push(structuredClone({
      annotationId: String(annotationId),
      fieldName: String(fieldName),
      storedValue,
    }));
  }
  fields.sort((left, right) => left.annotationId.localeCompare(right.annotationId));
  return Object.freeze({ fields: Object.freeze(fields.map((field) => Object.freeze(field))) });
}

