export type DeepReadonly<T> =
  T extends (...args: any[]) => any ? T
    : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
      : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

export type OcrPageStatus =
  | 'idle'
  | 'checking-existing-text'
  | 'skipped-existing-text'
  | 'queued'
  | 'rasterizing'
  | 'preprocessing'
  | 'recognizing'
  | 'validating'
  | 'applying'
  | 'ready'
  | 'unsupported'
  | 'failed'
  | 'cancelled'
  | 'stale';

export interface OcrFingerprint {
  algorithm: 'sha256';
  value: string;
}

export interface OcrCoordinatePolygon {
  coordinateSpace: string;
  points: readonly (readonly [number, number])[];
}

export interface OcrCoordinateBaseline {
  status: 'provided' | 'unavailable';
  coordinateSpace: string;
  points?: readonly (readonly [number, number])[];
  provenance?: string;
  reason?: string;
}

export interface OcrRecognizedLine {
  id: string;
  text: string;
  confidence: number;
  polygon: OcrCoordinatePolygon;
  baseline: OcrCoordinateBaseline;
  detectedLanguage?: { tag: string; confidence: number };
  detectedWritingDirection?: 'ltr' | 'rtl' | 'ttb' | 'btt';
  [key: string]: unknown;
}

/**
 * The validated production result is deliberately structural here. Runtime
 * validation remains authoritative, while DeepReadonly prevents review state
 * from being written back into the cached engine result.
 */
export interface OcrProductionResult {
  contract: 'open-pdf-studio.ocr.result';
  schemaVersion: 2;
  jobId: string;
  requestId: string;
  document: {
    id: string;
    fingerprint: OcrFingerprint;
    revision: number;
    generation: string;
    pageCount: number;
  };
  page: {
    id: string;
    index: number;
    revision: number;
    status: 'completed' | 'partial' | 'unsupported' | 'failed' | 'cancelled';
  };
  sourceRaster: {
    id: string;
    fingerprint: OcrFingerprint;
    coordinateSpace: string;
    widthPx: number;
    heightPx: number;
    dpi: number;
  };
  text: string;
  lines: OcrRecognizedLine[];
  warnings: OcrWarning[];
  [key: string]: unknown;
}

export interface OcrPageGeometry {
  contract: 'open-pdf-studio.ocr.page-geometry';
  schemaVersion: 1;
  geometryId: string;
  document: OcrProductionResult['document'];
  page: Omit<OcrProductionResult['page'], 'status'>;
  sourceRaster: OcrProductionResult['sourceRaster'];
  [key: string]: unknown;
}

export interface OcrWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  entityIds: string[];
}

export interface OcrExistingTextAssessment {
  source: 'pdfjs-text-content';
  meaningful: boolean;
  reason: 'empty' | 'insignificant' | 'substantial-text' | 'multiple-words' | 'multiple-items';
  normalizedCharacters: number;
  alphanumericCharacters: number;
  wordCount: number;
  nonEmptyItemCount: number;
  revision: number;
}

export interface OcrOwnershipMetadata {
  owner: 'open-pdf-studio';
  stream: 'pending-searchable-text' | 'pdf-owned-invisible-text';
  jobId: string;
  requestId: string;
  createdAt: string;
  persisted?: boolean;
  schemaVersion?: number;
  writerVersion?: string;
  streamRef?: string;
  fontRef?: string;
  contentDigest?: string;
  persistedAt?: string;
}

export interface OcrUserCorrection {
  id: string;
  target: { kind: 'line'; id: string };
  originalText: string;
  correctedText: string;
  status: 'accepted';
  createdAt: string;
  updatedAt: string;
}

export interface OcrPageGenerationToken {
  documentId: string;
  documentGeneration: string;
  pageId: string;
  pageNumber: number;
  pageRevision: number;
}

export interface OcrPageState {
  pageNumber: number;
  pageId: string;
  status: OcrPageStatus;
  pageRevision: number;
  generation: string;
  recognition: {
    revision: number;
    result: DeepReadonly<OcrProductionResult> | null;
    geometry: DeepReadonly<OcrPageGeometry> | null;
    ownership: OcrOwnershipMetadata | null;
    warnings: OcrWarning[];
  };
  review: {
    revision: number;
    corrections: Record<string, OcrUserCorrection>;
    estimatedBaselines: Record<string, OcrCoordinateBaseline>;
    dirty: boolean;
  };
  existingText: OcrExistingTextAssessment | null;
}

/**
 * SolidJS runtime view model. This is intentionally not a second serialized
 * OCR contract; recognized results/page geometry retain their production
 * validators, while mutable correction records follow document-state v1.
 */
export interface DocumentOcrState {
  documentId: string;
  generation: string;
  revision: number;
  pages: Record<number, OcrPageState>;
  warnings: OcrWarning[];
  dirty: boolean;
}

export type OcrApplicationPageState =
  | 'queued'
  | 'rasterizing'
  | 'preprocessing'
  | 'recognizing'
  | 'validating'
  | 'applying'
  | 'completed'
  | 'skipped'
  | 'unsupported'
  | 'failed'
  | 'cancelled';

export type OcrModelPackStateName =
  | 'installed'
  | 'missing'
  | 'incompatible'
  | 'corrupt'
  | 'updating';

export interface OcrPageJobSummary {
  pageNumber: number;
  state: OcrApplicationPageState;
  fraction: number;
  attempts: number;
  retries: number;
  retryableFailureSeen: boolean;
  failure: { code: string; stage: string; retryable: boolean } | null;
  staleRejected: boolean;
  cache: string;
  retained: boolean;
  measuredStageCosts: {
    sampleCount: number;
    costsMs: Record<string, number>;
  } | null;
}

export interface OcrDocumentJobSummary {
  jobId: string;
  documentId: string;
  documentGeneration: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  cancellationReason: string | null;
  keepCompletedPages: boolean;
  startedAt: string;
  finishedAt: string | null;
  counts: Record<OcrApplicationPageState, number>;
  pages: OcrPageJobSummary[];
  stageCosts: {
    sampleCount: number;
    costsMs: Record<string, number>;
  };
  appliedPageNumbers: number[];
  rolledBackPageNumbers: number[];
}

export type OcrPageScope =
  | { kind: 'current-page' }
  | { kind: 'range'; startPage: number; endPage: number }
  | { kind: 'entire-document' };

export interface OcrWorkflowRecognitionPolicy {
  existingText: 'skip' | 'force-rerun';
  keepCompletedPages: boolean;
  useCache: boolean;
  maximumRetries: number;
  recognitionOptions: {
    languagePolicy: { mode: 'automatic'; languages: readonly string[]; scripts: readonly string[] };
    includeWords: false;
    orientation: { mode: 'none'; degrees: null };
    deskew: false;
    preprocessing: { mode: 'none'; operations: readonly string[] };
    rasterDpi: number;
    maximumPixels: number;
    maximumSide: number;
    timeoutMs: number;
  };
}

export interface OcrWorkflowFailureDetail {
  pageNumber: number | null;
  code: string;
  stage: string;
  retryable: boolean;
}

export interface OcrWorkflowJobState {
  jobId: string;
  documentId: string;
  status: OcrDocumentJobSummary['status'];
  progress: number;
  pages: OcrPageJobSummary[];
  terminalSummary: OcrDocumentJobSummary | null;
  failureDetails: OcrWorkflowFailureDetail[];
  cancellationAvailable: boolean;
  cancellationRequested: boolean;
  pageScope: OcrPageScope;
  recognitionPolicy: OcrWorkflowRecognitionPolicy;
  model: {
    status: OcrModelPackStateName;
    identity: Record<string, unknown> | null;
  };
  startedAt: string;
  finishedAt: string | null;
}

export interface OcrWorkflowSnapshot {
  jobsByDocumentId: Record<string, OcrWorkflowJobState>;
}
