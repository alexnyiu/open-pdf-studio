export type SupportedFontFaceId =
  | 'liberation-sans-regular'
  | 'liberation-sans-bold'
  | 'liberation-sans-italic'
  | 'liberation-sans-bold-italic'
  | 'liberation-serif-regular'
  | 'liberation-serif-bold'
  | 'liberation-serif-italic'
  | 'liberation-serif-bold-italic'
  | 'liberation-mono-regular'
  | 'liberation-mono-bold'
  | 'liberation-mono-italic'
  | 'liberation-mono-bold-italic';

export type TextDirection = 'ltr';

export interface TextRunStyle {
  faceId: SupportedFontFaceId;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  direction: TextDirection;
}

export interface ShapedGlyph {
  id: number;
  cluster: number;
  advance: number;
  xOffset: number;
  yOffset: number;
}

export interface ShapedRun {
  engine: 'fontkit-liberation-ltr-v1';
  glyphs: ShapedGlyph[];
  advance: number;
  inkBounds: { left: number; top: number; right: number; bottom: number };
  metrics: {
    ascent: number;
    descent: number;
    underlinePosition: number;
    underlineThickness: number;
    strikeoutPosition: number;
    strikeoutThickness: number;
  };
}

export interface TextRun extends TextRunStyle {
  id: string;
  text: string;
  shaped: ShapedRun | null;
  geometry: { x: number; baseline: number; width: number; height: number };
  sourceConfidence: number;
}

export interface TextLine {
  id: string;
  baseline: number;
  baselineAdvance: number;
  alignment: 'left' | 'center' | 'right';
  breakAfter?: 'hard' | 'soft';
  runs: TextRun[];
}

export interface TextEditSelectionItem {
  key: string;
  kind: 'native' | 'record';
  page: number;
  rotation: 0 | 90 | 180 | 270;
  eligible: boolean;
  geometry: { left: number; top: number; width: number; height: number };
  viewRect: { left: number; top: number; width: number; height: number };
  visualBaseline: number;
  richText: RichTextDocumentV2;
  original: RichTextDocumentV2 | null;
  sourceProvenance: NativeTextSourceProvenanceV1[] | null;
  substitution: FontSubstitution | null;
  sourceRecord?: TextEditRecordV2;
}

export interface RichTextDocumentV2 {
  schema: 'open-pdf-studio.rich-text-document';
  version: 2;
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    baselineDirection: 'decreasing-y' | 'increasing-y';
  };
  lines: TextLine[];
}

export interface NativeTextSourceProvenanceV1 {
  schema: 'open-pdf-studio.native-text-source';
  version: 1;
  documentSha256: string;
  pageIndex: number;
  pageObjectId: string;
  streamObjectId: string;
  streamSha256: string;
  invocationPath: Array<Record<string, unknown>>;
  operatorKind: 'Tj' | 'TJ' | "'" | '"';
  operatorIndex: number;
  operatorRange: [number, number];
  operatorSha256: string;
  originalOperatorBase64: string;
  decodedText: string;
  totalAdvance: number;
  markerId: string;
  ownershipState: 'source' | 'neutralized' | 'restored';
  eligibility: { eligible: boolean; code: string; reason: string };
}

export interface FontSubstitution {
  sourceFont: string;
  faceId: SupportedFontFaceId;
  approved: boolean;
  approvedAt: string | null;
}

export interface TextEditRecordV2 {
  schema: 'open-pdf-studio.text-edit-record';
  version: 2;
  id: string;
  page: number;
  revision: number;
  richText: RichTextDocumentV2;
  original: RichTextDocumentV2 | null;
  sourceProvenance: NativeTextSourceProvenanceV1[] | null;
  substitution: FontSubstitution | null;
  originalSnapshotHash: string;
  ownedLayerId: string;
}

export interface TextFormatCapabilities {
  family: boolean;
  size: boolean;
  color: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  alignment: boolean;
  spacing: boolean;
  directions: TextDirection[];
}

export interface ShapedTextLayout {
  schema: 'open-pdf-studio.shaped-text-layout';
  version: 1;
  width: number;
  height: number;
  lines: TextLine[];
  overflow: boolean;
  rejectionReasons: string[];
}

export interface OwnedTextEditManifestV2 {
  schema: 'open-pdf-studio.owned-text-edit-manifest';
  version: 2;
  documentId: string;
  revision: number;
  pages: Array<{ page: number; layerId: string; edits: TextEditRecordV2[] }>;
  integrityHash: string;
}

export interface FontCatalogFace {
  id: SupportedFontFaceId;
  family: 'Liberation Sans' | 'Liberation Serif' | 'Liberation Mono';
  weight: 400 | 700;
  italic: boolean;
  assetUrl: string;
  sha256: string;
  license: 'SIL Open Font License 1.1';
}

export interface FontCatalog {
  faces: readonly FontCatalogFace[];
  resolveFace(family: string, bold: boolean, italic: boolean): FontCatalogFace | null;
  proposeSubstitution(sourceFont: string, bold: boolean, italic: boolean): FontSubstitution;
  loadFaceBytes(faceId: SupportedFontFaceId): Promise<Uint8Array>;
  verifyAssets(): Promise<boolean>;
}
