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
    fingerprint: { algorithm: 'sha256'; value: string };
    revision: number;
    generation: string;
    pageCount: number;
  };
  stateRevision: number;
  pages: Array<{
    id: string;
    index: number;
    revision: number;
    sourceRaster: Record<string, unknown>;
    pageGeometry: Record<string, unknown>;
    selections: Array<Record<string, unknown>>;
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
