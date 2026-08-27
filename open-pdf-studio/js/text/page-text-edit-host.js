import { getActiveDocument, getPageRotation } from '../core/state.js';
import { getRotatedPageSize, normalizePageRotation } from './text-edit-appearance.js';
import { recordPageTextEditPlacementRead } from './page-text-edit-metrics.js';
import { pageTextEditHostMatchesPlacement } from './page-text-edit-host-identity.js';

export { pageTextEditHostMatchesPlacement } from './page-text-edit-host-identity.js';

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
  if (!placement || String(activeDocument?.id) !== placement.documentId
      || Number(activeDocument?.lifecycleGeneration) !== Number(placement.generation)) return null;
  const container = pageContainer(placement.pageNum, activeDocument, root);
  if (!container) return null;
  const hosts = [...container.children]
    .filter((child) => child.classList?.contains(PAGE_TEXT_EDIT_HOST_CLASS));
  let host = hosts.find((candidate) => pageTextEditHostMatchesPlacement(candidate, placement));
  // A page container can survive a document/view transition. Never relabel or
  // reuse its old editor subtree for a different immutable owner generation.
  for (const staleHost of hosts) {
    if (staleHost !== host) staleHost.remove();
  }
  if (!host) {
    host = root.createElement('div');
    host.className = PAGE_TEXT_EDIT_HOST_CLASS;
    host.dataset.documentId = placement.documentId;
    host.dataset.page = String(placement.pageNum);
    container.appendChild(host);
  }
  host.dataset.documentId = placement.documentId;
  host.dataset.page = String(placement.pageNum);
  host.dataset.generation = String(placement.generation);
  return host;
}

/** Resolve an existing owner/page host without mutating the DOM. */
export function findPageTextEditHost(placement, root = document) {
  const activeDocument = getActiveDocument();
  if (!placement || String(activeDocument?.id) !== placement.documentId
      || Number(activeDocument?.lifecycleGeneration) !== Number(placement.generation)) return null;
  const container = pageContainer(placement.pageNum, activeDocument, root);
  if (!container) return null;
  return [...container.children]
    .find((child) => pageTextEditHostMatchesPlacement(child, placement)) || null;
}

export function measurePageTextEditFrame(placement, host) {
  const activeDocument = getActiveDocument();
  if (!placement || !host || String(activeDocument?.id) !== placement.documentId
      || Number(activeDocument?.lifecycleGeneration) !== Number(placement.generation)) return null;
  const container = host.parentElement;
  if (!container) return null;
  const dims = activeDocument?.pageDims?.[placement.pageNum];
  const rotation = normalizePageRotation(
    (Number(dims?.rotation) || 0) + getPageRotation(placement.pageNum),
  );
  const pageWidth = Number(dims?.widthPt) > 0 ? Number(dims.widthPt) : placement.pageWidth;
  const pageHeight = Number(dims?.heightPt) > 0 ? Number(dims.heightPt) : placement.pageHeight;
  recordPageTextEditPlacementRead();
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

export function removeEmptyPageTextEditHosts(root = document) {
  for (const host of root.querySelectorAll?.(`.${PAGE_TEXT_EDIT_HOST_CLASS}`) || []) {
    if (!host.querySelector('.pdf-text-edit-portal') && host.childElementCount === 0) host.remove();
  }
}
