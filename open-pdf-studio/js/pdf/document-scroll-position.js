function finiteScrollCoordinate(value) {
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? Math.max(0, coordinate) : 0;
}

/**
 * Restore only the scroll position owned by the document being displayed.
 * The PDF container is shared across tabs and remains mounted while a new
 * document is loading, so leaving its previous offset in place can make the
 * first page (and transparent text-edit hit targets) start outside the view.
 */
export function restoreDocumentScrollPosition(container, documentState) {
  if (!container) return { x: 0, y: 0 };
  const position = {
    x: finiteScrollCoordinate(documentState?.scrollPosition?.x),
    y: finiteScrollCoordinate(documentState?.scrollPosition?.y),
  };
  container.scrollLeft = position.x;
  container.scrollTop = position.y;
  return position;
}
