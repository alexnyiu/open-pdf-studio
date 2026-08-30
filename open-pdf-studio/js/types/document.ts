import type { Annotation } from './annotation.js';
import type { DocumentOcrState } from './ocr.js';
import type { ScannedTextEditStateV1 } from './scanned-text-edit.js';
import type { OwnedTextEditManifestV2, TextEditRecordV2 } from './rich-text.js';

export interface MeasureScale {
  pixelsPerUnit: number;
  unit: string;
  method: string;
  scaleRatio: number;
}

/** Legacy flat text edit. Load boundaries migrate safe records to V2. */
export interface LegacyTextEdit {
  id?: string;
  page: number;
  originalText?: string;
  newText?: string;
  pdfX?: number;
  pdfY?: number;
  pdfWidth?: number;
  fontSize?: number;
  lineSpacing?: number;
  fontFamily?: string;
  color?: string;
  fontUnderline?: boolean;
  fontStrikethrough?: boolean;
  [key: string]: unknown;
}

export interface Watermark {
  id: string;
  type: 'text' | 'image';
  [key: string]: any;
}

export interface Bookmark {
  id: string;
  title: string;
  page: number;
  children?: Bookmark[];
  expanded?: boolean;
}

/**
 * Benoemde lijnstijl-preset (WEERGAVE-sectie van het Eigenschappen-paneel).
 * Reist mee met het document via de catalog-entry /OPS_StylePresets.
 */
export interface StylePreset {
  id: string;
  name: string;
  props: Record<string, unknown>;
}

export interface UndoCommand {
  type: string;
  [key: string]: any;
}

export interface ScrollPosition {
  x: number;
  y: number;
}

export interface DocumentMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string | null;
  modificationDate: string | null;
}

export interface PreloadStatus {
  readonly state: 'idle' | 'running' | 'paused' | 'complete' | 'limited' | 'cancelled';
  readonly completed: number;
  readonly total: number;
  readonly retainedBytes: number;
  readonly limitReason: 'pages' | 'bytes' | 'time' | null;
}

export type DocumentSaveState =
  | 'idle'
  | 'pending'
  | 'saving'
  | 'persisted'
  | 'synchronizing'
  | 'saved'
  | 'saved-with-warning'
  | 'saved-refresh-pending'
  | 'failed'
  | 'saved-refresh-failed'
  | 'save-as-required'
  | 'deferred'
  | 'superseded';

export interface DocumentRevisionState {
  contentRevision: number;
  serializedRevision: number;
  persistedRevision: number;
  livePdfRevision: number;
  visibleRenderRevision: number;
  visibleSemanticRevision: number;
  pageContentRevisions: Record<number, number>;
  pageRenderReadyRevisions: Record<number, number>;
  pageSemanticReadyRevisions: Record<number, number>;
  visibleRequiredPages: number[];
  pendingChangedPages: number[] | null;
  pendingStructuralChange: boolean;
  lastMutationReason: string | null;
  saveState: DocumentSaveState;
  activeSaveRequestId: string | null;
  lastPersistedPath: string | null;
  lastSaveError: string | null;
  lastSaveErrorCode: string | null;
  lastSaveWarnings: Array<Record<string, unknown>>;
  lastSaveRecovery: Record<string, unknown> | null;
  lastSynchronizationError: string | null;
}

export interface PdfPerformanceProfile {
  pageCount: number;
  fileBytes: number;
  maximumPageSurfaceBytes: number;
  foregroundRenderSamples: number[];
  slowForegroundSamples: number;
  budget: RenderResourceBudget;
  largeDocument: boolean;
  largeDocumentReasons: string[];
}

export interface RenderResourceBudget {
  physicalMemoryBytes: number | null;
  globalBytes: number;
  javascriptBytes: number;
  nativePixmapBytes: number;
  metadataBytes: number;
  activeDocumentShare: number;
}

export interface PageGeometryEntry {
  readonly pageNum: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly applicationRotation: 0 | 90 | 180 | 270;
}

export interface PageGeometryIndex {
  readonly entries: ReadonlyArray<PageGeometryEntry>;
  totalHeight(scale?: number, layout?: 'continuous' | 'book'): number;
  contentWidth(scale?: number, layout?: 'continuous' | 'book', minimumWidth?: number): number;
  pageAtOffset(offset: number, options?: Record<string, unknown>): number | null;
  pageRect(pageNum: number, options?: Record<string, unknown>): {
    pageNum: number; x: number; y: number; width: number; height: number; rowIndex: number;
  } | null;
  visiblePages(options?: Record<string, unknown>): number[];
}

export interface RenderWorkRequest {
  key: string;
  ownerKey: string;
  pageNum: number;
  priority: number;
  kind: 'foreground' | 'background';
}

export type RasterQuality = 'preview' | 'final';

export interface PageRasterKey {
  readonly documentId: string;
  readonly lifecycleGeneration: number;
  readonly pageRevision: number;
  readonly filePath: string;
  readonly pageNum: number;
  readonly rotation: number;
  readonly cssScaleBucket: number;
  readonly devicePixelRatio: number;
  readonly quality: RasterQuality;
}

export interface RasterLease {
  readonly key: PageRasterKey;
  readonly quality: RasterQuality;
  readonly targetRasterScale: number;
  readonly actualRasterScale: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  release(): void;
}

export interface PageRasterRegistry {
  get(key: PageRasterKey, targetRasterScale: number): RasterLease | null;
  ensure(key: PageRasterKey, targetRasterScale: number): Promise<RasterLease | null>;
  invalidatePage(documentId: string, lifecycleGeneration: number, pageNum: number): void;
  clearDocument(documentId: string, lifecycleGeneration: number): void;
}

export interface RenderedSurfaceState {
  readonly targetRasterScale: number;
  readonly actualRasterScale: number;
  readonly cssScale: number;
  readonly devicePixelRatio: number;
  readonly quality: RasterQuality;
  readonly source: string;
  readonly ownerGeneration: number;
  readonly publicationRevision: number;
  readonly publishedAt: number;
}

export interface RenderStreamDescriptor {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly expiresAt: number;
}

export interface ZoomAnchor {
  documentId: string;
  lifecycleGeneration: number;
  pageNum: number;
  pdfX: number;
  pdfY: number;
  clientX: number;
  clientY: number;
}

export interface ZoomGestureSession {
  source: 'native-gesture' | 'trackpad' | 'wheel';
  ownerDocumentId: string;
  ownerDocumentGeneration: number;
  startedAt: number;
  anchor: ZoomAnchor;
}

export interface DocumentState {
  id: string;
  /**
   * Runtime-only identity for the currently installed PDF proxy/content tree.
   * Async editor, render, metadata, and OCR work must match this generation
   * before it may publish or mutate document-owned state.
   */
  lifecycleGeneration: number;
  /** Persistence, live-proxy, render, and semantic ownership state. */
  revisionState: DocumentRevisionState;
  /** UI acknowledgement is scoped to one exact failure identity. */
  acknowledgedSaveStatus?: string | null;
  /** Reopen is offered only after a refresh-only retry cannot recover. */
  saveRefreshRetryFailed?: boolean;
  filePath: string | null;
  fileName: string;
  pdfDoc: any; // pdfjs-dist PDFDocumentProxy
  metadata: DocumentMetadata;
  preloadStatus: PreloadStatus;
  /** Runtime-only source size and adaptive render profile. */
  sourceByteLength: number;
  performanceProfile: PdfPerformanceProfile | null;
  pageGeometryIndex: PageGeometryIndex | null;
  pageGeometryBaseDimensions: Array<[number, number]> | null;
  pageGeometryRevision?: {
    documentId: string;
    pdfDocument: any;
    lifecycleGeneration: number;
    contentRevision: number;
  } | null;
  pageEditReadiness?: Record<number, {
    identity: {
      documentId: string;
      pdfDocument: any;
      lifecycleGeneration: number;
      contentRevision: number;
      pageRevision: number;
      livePdfRevision: number;
      pageNum: number;
    };
    layers: Record<string, boolean>;
    failure: string | null;
  }>;
  /** Compatibility alias of revisionState.pageContentRevisions. */
  pageRenderRevisions: Record<number, number>;
  currentPage: number;
  scale: number;
  viewMode: 'single' | 'continuous';
  /** Boekweergave (issue #201): continuous met 2-pagina-spreads, pagina 1 rechts. */
  bookSpread?: boolean;
  /** Niet-doorlopende spreadweergave met maximaal twee gemonteerde pagina's. */
  facingSpread?: boolean;
  annotations: Annotation[];
  textEdits: Array<TextEditRecordV2 | LegacyTextEdit>;
  /** Application-owned rich text manifest. Unknown versions fail closed. */
  textEditManifest?: OwnedTextEditManifestV2 | null;
  /** Unsaved searchable OCR and review state; never serialized as textEdits. */
  ocr: DocumentOcrState;
  /** Application-owned mutable scan repairs; never written into immutable OCR results. */
  scannedTextEdits: ScannedTextEditStateV1 | null;
  /** Last visible scanned-text state revision installed in the saved PDF. */
  scannedTextEditPersistedRevision: number;
  /** A typed removal must delete the application-owned visible stream on save. */
  scannedTextEditRemovalPending: boolean;
  watermarks: Watermark[];
  bookmarks: Bookmark[];
  undoStack: UndoCommand[];
  redoStack: UndoCommand[];
  savedUndoStackLength: number;
  selectedAnnotation: Annotation | null;
  selectedAnnotations: Annotation[];
  modified: boolean;
  scrollPosition: ScrollPosition;
  pageRotations: Record<number, number>;
  pageDims?: Record<number, { widthPt: number; heightPt: number; rotation?: number }>;
  thumbnailDims?: Record<number, { width: number; height: number; rotation: number }>;
  pdfaCompliance: string | null;
  pdfADismissed: boolean;
  measureScale: MeasureScale | null;
  /** Benoemde lijnstijl-presets — persist in de PDF (catalog /OPS_StylePresets). */
  stylePresets: StylePreset[];
  // Internal loader state
  _loadedAnnotationPages: Set<number>;
  _sharedPdfLibDoc: any;
  _sharedPdfLibDocPromise: Promise<any> | null;
  _pagesNeedingColorUpdate: Set<number>;
  _annotationLoadId: number;
  _isLoading: boolean;
}
