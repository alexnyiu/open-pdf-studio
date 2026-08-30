import type { DocumentState } from '../../types/document.js';
import { createDocumentOcrState } from '../../ocr/document-state.js';
import { createEmptyDocumentMetadata } from '../../pdf/document-metadata.js';
import { createInitialDocumentRevisionState } from '../document-revision-state.runtime.js';

/**
 * Creates a new document state object
 */
export function createDocument(filePath: string | null = null): DocumentState {
  const id = Date.now() + Math.random().toString(36).substr(2, 9);
  const revisionState = createInitialDocumentRevisionState() as DocumentState['revisionState'];
  return {
    id,
    lifecycleGeneration: 0,
    viewportRevision: 0,
    viewMutationState: {
      userRevision: 0,
      activationRevision: 0,
      fields: {
        page: 0, mode: 0, spread: 0, zoom: 0, pan: 0, scroll: 0,
        rotation: 0, tool: 0, selection: 0, panels: 0, search: 0,
      },
    },
    revisionState,
    filePath: filePath,
    fileName: filePath ? filePath.split(/[\\/]/).pop()! : 'Untitled',
    pdfDoc: null,
    metadata: createEmptyDocumentMetadata(),
    preloadStatus: { state: 'idle', completed: 0, total: 0, retainedBytes: 0, limitReason: null },
    sourceByteLength: 0,
    performanceProfile: null,
    pageGeometryIndex: null,
    pageGeometryBaseDimensions: null,
    pageGeometryRevision: null,
    pageEditReadiness: {},
    pageRenderRevisions: revisionState.pageContentRevisions,
    currentPage: 1,
    scale: 1.5,
    viewMode: 'continuous',
    annotations: [],
    textEdits: [],
    textEditManifest: null,
    ocr: createDocumentOcrState(id),
    scannedTextEdits: null,
    scannedTextEditPersistedRevision: 0,
    scannedTextEditRemovalPending: false,
    watermarks: [],
    bookmarks: [],
    undoStack: [],
    redoStack: [],
    savedUndoStackLength: 0,
    selectedAnnotation: null,
    selectedAnnotations: [],
    modified: false,
    scrollPosition: { x: 0, y: 0 },
    pageRotations: {},
    pdfaCompliance: null,
    pdfADismissed: false,
    measureScale: null,
    stylePresets: [],
    _loadedAnnotationPages: new Set(),
    _sharedPdfLibDoc: null,
    _sharedPdfLibDocPromise: null,
    _pagesNeedingColorUpdate: new Set(),
    _annotationLoadId: 0,
    _isLoading: false,
  };
}

let untitledCounter = 0;

/**
 * Get the next untitled document name
 */
export function getNextUntitledName(): string {
  untitledCounter++;
  if (untitledCounter === 1) return 'Untitled.pdf';
  return `Untitled ${untitledCounter}.pdf`;
}
