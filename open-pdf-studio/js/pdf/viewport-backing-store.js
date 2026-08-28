/**
 * Release pixel memory without removing or resizing the canvas' CSS box.
 * The DOM nodes and their event listeners remain reusable when single-page
 * mode is activated again.
 */
export function releaseCanvasBackingStores(canvases = []) {
  let releasedBytes = 0;
  let releasedCount = 0;
  const visited = new Set();

  for (const canvas of canvases) {
    if (!canvas || visited.has(canvas)) continue;
    visited.add(canvas);
    const width = Math.max(0, Number(canvas.width) || 0);
    const height = Math.max(0, Number(canvas.height) || 0);
    releasedBytes += width * height * 4;
    if (width > 0 || height > 0) releasedCount += 1;
    canvas.width = 0;
    canvas.height = 0;
  }

  return Object.freeze({ releasedBytes, releasedCount });
}
