export type OcrParagraphBoundaryDecision = 'join' | 'split' | 'ambiguous';

export interface OcrParagraphBoundaryEvidence {
  beforeLineId: string;
  afterLineId: string;
  decision: OcrParagraphBoundaryDecision;
  score: number;
  forced: boolean;
  reason: string;
  evidence: Array<{ id: string; weight: number; value: number | null }>;
}

export interface OcrParagraphRegion {
  id: string;
  lineIds: string[];
  columnId: string;
  bounds: { coordinateSpace: 'source-raster-pixels'; x: number; y: number; width: number; height: number } | null;
  alignment: 'left' | 'unknown';
  confidence: number;
  editable: boolean;
  rejectionReason: string | null;
  readingOrder: number;
  boundaryEvidence: OcrParagraphBoundaryEvidence[];
}
