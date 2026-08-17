import type { DocumentState } from '../types/document.js';
import type {
  DocumentOcrState,
  OcrPageGenerationToken,
  OcrProductionResult,
} from '../types/ocr.js';

declare const documentState: DocumentState;
declare const recognizedResult: Readonly<OcrProductionResult>;

const typedOcrState: DocumentOcrState = documentState.ocr;
const typedToken: OcrPageGenerationToken = {
  documentId: typedOcrState.documentId,
  documentGeneration: typedOcrState.generation,
  pageId: typedOcrState.pages[1].pageId,
  pageNumber: 1,
  pageRevision: typedOcrState.pages[1].pageRevision,
};

void typedToken;
void recognizedResult;

// Review state is mutable and separate from the recognized engine result.
typedOcrState.pages[1].review.corrections['line-1'] = {
  id: 'correction-1',
  target: { kind: 'line', id: 'line-1' },
  originalText: 'engine text',
  correctedText: 'reviewed text',
  status: 'accepted',
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T00:00:00.000Z',
};

// @ts-expect-error recognized production lines are deeply immutable.
typedOcrState.pages[1].recognition.result!.lines[0].text = 'mutated engine text';

// @ts-expect-error OCR has a dedicated typed field and cannot be stored as a text edit.
documentState.textEdits.push({ ocr: typedOcrState });
