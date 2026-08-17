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
  | 'recognizing'
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
  stream: 'pending-searchable-text';
  jobId: string;
  requestId: string;
  createdAt: string;
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
