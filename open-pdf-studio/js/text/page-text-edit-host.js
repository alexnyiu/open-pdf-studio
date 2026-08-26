import { getActiveDocument, getPageRotation } from '../core/state.js';
import { getRotatedPageSize, normalizePageRotation } from './text-edit-appearance.js';

export const PAGE_TEXT_EDIT_HOST_CLASS = 'pdf-text-edit-layer';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pageContainer(pageNum, activeDocument, root = document) {
  if (activeDocument?.viewMode === 'continuous') {
    return root.querySelector?.(`.page-wrapper[data-page="${pageNum}"] .canvas-container-cont`)
      || null;
  }
  if (Number(activeDocument?.currentPage) !== pageNum) return null;
  return root.getElementById?.('canvas-container') || null;
}

export function ensurePageTextEditHost(placement, root = document) {
  const activeDocument = getActiveDocument();
  if (!placement || String(activeDocument?.id) !== placement.documentId) return null;
  const container = pageContainer(placement.pageNum, activeDocument, root);
  if (!container) return null;
  let host = [...container.children]
    .find((child) => child.classList?.contains(PAGE_TEXT_EDIT_HOST_CLASS));
  if (!host) {
    host = root.createElement('div');
    host.className = PAGE_TEXT_EDIT_HOST_CLASS;
    host.dataset.documentId = placement.documentId;
    host.dataset.page = String(placement.pageNum);
    container.appendChild(host);
  }
  host.dataset.documentId = placement.documentId;
  host.dataset.page = String(placement.pageNum);
  return host;
}

export function measurePageTextEditFrame(placement, host) {
  const activeDocument = getActiveDocument();
  if (!placement || !host || String(activeDocument?.id) !== placement.documentId) return null;
  const container = host.parentElement;
  if (!container) return null;
  const dims = activeDocument?.pageDims?.[placement.pageNum];
  const rotation = normalizePageRotation(
    (Number(dims?.rotation) || 0) + getPageRotation(placement.pageNum),
  );
  const pageWidth = Number(dims?.widthPt) > 0 ? Number(dims.widthPt) : placement.pageWidth;
  const pageHeight = Number(dims?.heightPt) > 0 ? Number(dims.heightPt) : placement.pageHeight;
  const containerRect = container.getBoundingClientRect();
  const viewport = globalThis.window?.__pdfViewport;
  const isSingleViewport = container.id === 'canvas-container'
    && viewport?.active
    && viewport.pageNum === placement.pageNum
    && viewport.zoom > 0;
  if (isSingleViewport) {
    return {
      pageWidth,
      pageHeight,
      rotation,
      scale: viewport.zoom,
      offsetX: finite(viewport.offsetX),
      offsetY: finite(viewport.offsetY),
      containerLeft: containerRect.left,
      containerTop: containerRect.top,
    };
  }
  const pageSize = getRotatedPageSize(pageWidth, pageHeight, rotation);
  const canvas = container.querySelector('canvas.pdf-canvas, #pdf-canvas');
  const canvasRect = canvas?.getBoundingClientRect();
  const displayWidth = canvasRect?.width || containerRect.width;
  const displayHeight = canvasRect?.height || containerRect.height;
  const scaleX = displayWidth / Math.max(0.0001, pageSize.width);
  const scaleY = displayHeight / Math.max(0.0001, pageSize.height);
  return {
    pageWidth,
    pageHeight,
    rotation,
    scale: Math.min(scaleX, scaleY),
    offsetX: canvasRect ? canvasRect.left - containerRect.left : 0,
    offsetY: canvasRect ? canvasRect.top - containerRect.top : 0,
    containerLeft: containerRect.left,
    containerTop: containerRect.top,
  };
}
