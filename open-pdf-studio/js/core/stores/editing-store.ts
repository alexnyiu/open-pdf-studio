import { createMutable } from 'solid-js/store';
import type { Annotation } from '../../types/annotation.js';
import type { RichTextDocumentV2, TextFormatCapabilities } from '../../types/rich-text.js';

export interface EditingState {
  isEditingText: boolean;
  editingAnnotation: Annotation | null;
  textEditElement: HTMLElement | null;
  isEditingPdfText: boolean;
  pdfTextEditState: {
    richText?: RichTextDocumentV2;
    capabilities?: TextFormatCapabilities;
    [key: string]: unknown;
  } | null;
}

export const editingState = createMutable<EditingState>({
  isEditingText: false,
  editingAnnotation: null,
  textEditElement: null,
  isEditingPdfText: false,
  pdfTextEditState: null,
});

export function resetTextEditing(): void {
  editingState.isEditingText = false;
  editingState.editingAnnotation = null;
  editingState.textEditElement = null;
}

export function resetPdfTextEditing(): void {
  editingState.isEditingPdfText = false;
  editingState.pdfTextEditState = null;
}

export function resetAllEditing(): void {
  resetTextEditing();
  resetPdfTextEditing();
}
