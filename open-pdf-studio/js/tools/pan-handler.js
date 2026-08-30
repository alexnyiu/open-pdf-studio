import { state, getActiveDocument } from '../core/state.js';
import { noteDocumentViewMutation } from '../pdf/view-state-transaction.js';

// Pan handler — manages legacy (non-viewport) scroll-based panning.
// Cursor is reactive: it follows state.isPanning + state.isMiddleButtonPanning
// via js/ui/cursor.js. This file ONLY manipulates state and scroll position.

export function getScrollContainer() {
  return document.getElementById('pdf-container');
}

export function handlePanMove(e) {
  if (!state.isPanning) return;
  const scrollContainer = getScrollContainer();
  if (!scrollContainer) return;
  const deltaX = e.clientX - state.panStartX;
  const deltaY = e.clientY - state.panStartY;
  scrollContainer.scrollLeft = state.panScrollStartX - deltaX;
  scrollContainer.scrollTop = state.panScrollStartY - deltaY;
}

export function handlePanEnd(e) {
  if (!state.isPanning) return;
  state.isPanning = false;
  document.removeEventListener('pointermove', handlePanMove);
  document.removeEventListener('pointerup', handlePanEnd);
  document.removeEventListener('mousemove', handlePanMove);
  document.removeEventListener('mouseup', handlePanEnd);
}

export function handleMiddleButtonPanEnd(e) {
  if (!state.isPanning || !state.isMiddleButtonPanning) return;
  state.isPanning = false;
  state.isMiddleButtonPanning = false;
  document.removeEventListener('pointermove', handlePanMove);
  document.removeEventListener('pointerup', handleMiddleButtonPanEnd);
  document.removeEventListener('mousemove', handlePanMove);
  document.removeEventListener('mouseup', handleMiddleButtonPanEnd);
}

export function startPan(e, isMiddleButton) {
  const scrollContainer = getScrollContainer();
  noteDocumentViewMutation(getActiveDocument(), ['pan']);
  state.isPanning = true;
  if (isMiddleButton) state.isMiddleButtonPanning = true;
  state.panStartX = e.clientX;
  state.panStartY = e.clientY;
  state.panScrollStartX = scrollContainer ? scrollContainer.scrollLeft : 0;
  state.panScrollStartY = scrollContainer ? scrollContainer.scrollTop : 0;
  document.addEventListener('pointermove', handlePanMove);
  document.addEventListener('pointerup', isMiddleButton ? handleMiddleButtonPanEnd : handlePanEnd);
  e.preventDefault();
}

export function startContinuousPan(e, isMiddleButton) {
  const scrollContainer = getScrollContainer();
  noteDocumentViewMutation(getActiveDocument(), ['scroll', 'page']);
  state.isPanning = true;
  if (isMiddleButton) state.isMiddleButtonPanning = true;
  state.panStartX = e.clientX;
  state.panStartY = e.clientY;
  state.panScrollStartX = scrollContainer ? scrollContainer.scrollLeft : 0;
  state.panScrollStartY = scrollContainer ? scrollContainer.scrollTop : 0;
  document.addEventListener('pointermove', handlePanMove);
  document.addEventListener('pointerup', isMiddleButton ? handleMiddleButtonPanEnd : handlePanEnd);
  e.preventDefault();
}
