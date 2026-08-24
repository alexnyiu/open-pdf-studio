import type {
  OcrCoordinateBaseline,
  OcrCoordinatePolygon,
  OcrFingerprint,
  OcrPageGeometry,
} from './ocr.js';

export interface ScannedTextEstimatedValue<T> {
  value: T;
  estimated: true;
  confidence: number;
  method: string;
}

export interface ScannedTextRgbaPatch {
  encoding: 'rgba8-base64';
  coordinateSpace: 'source-raster-pixels';
  originX: number;
  originY: number;
  widthPx: number;
  heightPx: number;
  rowBytes: number;
  byteLength: number;
  sha256: string;
  data: string;
}

export interface ScannedTextSingleLineContent {
  scope: 'isolated-horizontal-line';
  source: {
    ocrIds: { lineId: string; wordIds: string[] };
    originalText: string;
    originalPolygon: OcrCoordinatePolygon;
    canonicalPolygon: OcrCoordinatePolygon;
    canonicalBaseline: OcrCoordinateBaseline;
  };
  replacementText: string;
  estimatedStyle: {
    fontClass: ScannedTextEstimatedValue<'serif' | 'sans-serif' | 'monospace'>;
    fontSize: ScannedTextEstimatedValue<number>;
    weight: ScannedTextEstimatedValue<'normal' | 'bold'>;
    italic: ScannedTextEstimatedValue<boolean>;
    textColor: ScannedTextEstimatedValue<string>;
    alignment: ScannedTextEstimatedValue<'left' | 'center' | 'right'>;
  };
  layout: {
    fontName: string;
    direction: 'ltr';
    shaping: string;
    glyphCoverage: 'complete';
    encodedGlyphCount: number;
    encodedText: string;
    widthPt: number;
    heightPt: number;
    availableWidthPt: number;
    availableHeightPt: number;
    origin: { coordinateSpace: 'pdf-default-user-space'; point: [number, number] };
    angleDegrees: number;
    baselineAligned: true;
    overflow: false;
  };
  repairPatch: ScannedTextRgbaPatch;
  visibleReplacement: {
    text: string;
    patch: ScannedTextRgbaPatch;
    halo: {
      maxBoundaryChannelDelta: number;
      meanBoundaryChannelDelta: number;
      sampleCount: number;
      tolerance: { maxBoundaryChannelDelta: number; meanBoundaryChannelDelta: number };
      passed: true;
    };
    outsideEditRegionChangedPixels: 0;
  };
  searchableText: {
    text: string;
    renderingMode: 'owned-invisible-ocr';
    synchronized: true;
  };
  undo: {
    kind: 'scanned-text-edit';
    before: { text: string; repairStatus: 'original' | 'applied' };
    after: { text: string; repairStatus: 'applied' };
    revision: number;
    parentRevision: number;
  };
}

export interface ScannedTextEditSelection {
  id: string;
  revision: number;
  target: Record<string, unknown>;
  geometry: Record<string, any>;
  originalPatch: ScannedTextRgbaPatch;
  analysis: Record<string, any>;
  repair: {
    status: 'applied' | 'rejected' | 'reverted';
    method: string | null;
    approvedRegion: Record<string, any>;
    repairedPatch: ScannedTextRgbaPatch | null;
    changedRegion: Record<string, any> | null;
  };
  /** Absent only on legacy foundation-v1 state written before line content existed. */
  content?: ScannedTextSingleLineContent | null;
  ownership: Record<string, any>;
}

export interface ScannedTextSearchableLineSnapshot {
  lineId: string;
  text: string;
  confidence: number;
  readingOrder: number;
  direction: 'ltr' | 'rtl' | 'ttb' | 'btt' | null;
  polygon: OcrCoordinatePolygon;
  baseline: OcrCoordinateBaseline;
  words?: Array<{
    id: string;
    text: string;
    direction: 'ltr' | 'rtl' | 'ttb' | 'btt' | null;
    polygon: OcrCoordinatePolygon;
  }>;
}

export interface ScannedTextEditStateV1 {
  contract: 'open-pdf-studio.scanned-text-edit-state';
  schemaVersion: 1;
  stateId: string;
  owner: {
    application: 'open-pdf-studio';
    feature: 'scanned-text-editing';
    instanceId: string;
  };
  document: {
    id: string;
    fingerprint: OcrFingerprint;
    revision: number;
    generation: string;
    pageCount: number;
  };
  stateRevision: number;
  pages: Array<{
    id: string;
    index: number;
    revision: number;
    sourceRaster: {
      id: string;
      fingerprint: OcrFingerprint;
      coordinateSpace: 'source-raster-pixels';
      widthPx: number;
      heightPx: number;
      dpi: number;
      rgbaSha256: string;
    };
    /** Full for editable lines; the short form remains readable for older foundation state. */
    pageGeometry: OcrPageGeometry | {
      contract: 'open-pdf-studio.ocr.page-geometry';
      schemaVersion: 1;
      geometryId: string;
    };
    searchableTextSnapshot?: ScannedTextSearchableLineSnapshot[];
    selections: ScannedTextEditSelection[];
  }>;
  history: {
    generation: number;
    undoDepth: number;
    redoDepth: number;
    lastOperationId: string | null;
  };
  createdAt: string;
  updatedAt: string;
}
