import { state, getActiveDocument } from '../../core/state.js';
import { isTauri } from '../../core/platform.js';
import {
  openDialog, closeDialog, showMessage,
  openAppMenu, setAppMenuPanel as setActivePanel,
  setLoadingVisible as setVisible, setLoadingMessage as setMessage,
} from '../../bridge.js';
import i18next from '../../i18n/config.js';

// Show loading overlay
export function showLoading(message = 'Loading...') {
  setMessage(message);
  setVisible(true);
}

// Hide loading overlay
export function hideLoading() {
  setVisible(false);
}

// ============================================
// About Panel (bridge to Solid app menu)
// ============================================

export function showAboutPanel() {
  openAppMenu();
  setActivePanel('about');
}

// ============================================
// Document Properties Dialog (Solid.js)
// ============================================

let docPropertiesRequestGeneration = 0;

export async function showDocPropertiesDialog() {
  const ownerDocument = getActiveDocument();
  if (!ownerDocument?.pdfDoc) {
    showMessage(i18next.t('noDocumentOpen'));
    return;
  }

  const requestGeneration = ++docPropertiesRequestGeneration;
  const ownerDocumentId = ownerDocument.id;
  const ownerDocumentGeneration = Number(ownerDocument.lifecycleGeneration) || 0;
  const ownerPdfDocument = ownerDocument.pdfDoc;
  const isCurrent = () => {
    const current = getActiveDocument();
    return requestGeneration === docPropertiesRequestGeneration
      && current === ownerDocument
      && String(current?.id) === String(ownerDocumentId)
      && (Number(current?.lifecycleGeneration) || 0) === ownerDocumentGeneration
      && current?.pdfDoc === ownerPdfDocument;
  };
  const data = await gatherDocProperties(ownerDocument, isCurrent);
  if (data && isCurrent()) openDialog('doc-properties', data);
}

export function hideDocPropertiesDialog() {
  closeDialog('doc-properties');
}

async function gatherDocProperties(doc, isCurrent) {
  const filePath = doc?.filePath || '-';
  const fileName = filePath !== '-' ? filePath.split(/[\\/]/).pop() : '-';

  let fileSize = '-';
  if (filePath !== '-' && isTauri() && window.__TAURI__?.fs) {
    try {
      const stats = await window.__TAURI__.fs.stat(filePath);
      if (!isCurrent()) return null;
      fileSize = formatFileSize(stats.size);
    } catch (e) {
      if (!isCurrent()) return null;
      fileSize = '-';
    }
  }

  let pdfVersion = '-';

  try {
    const metadata = await doc.pdfDoc.getMetadata();
    if (!isCurrent()) return null;
    const info = metadata.info || {};
    pdfVersion = info.PDFFormatVersion || '-';
  } catch (e) {
    if (!isCurrent()) return null;
    console.error('Error getting PDF metadata:', e);
  }

  const pageCount = doc.pdfDoc.numPages || '-';

  let pageSize = '-';
  try {
    const page = await doc.pdfDoc.getPage(1);
    if (!isCurrent()) return null;
    const viewport = page.getViewport({ scale: 1 });
    const widthMm = (viewport.width / 72 * 25.4).toFixed(1);
    const heightMm = (viewport.height / 72 * 25.4).toFixed(1);
    pageSize = `${viewport.width.toFixed(0)} x ${viewport.height.toFixed(0)} pts (${widthMm} x ${heightMm} mm)`;
  } catch (e) {
    if (!isCurrent()) return null;
    // keep '-'
  }

  return {
    ownerDocumentId: doc.id,
    ownerDocumentGeneration: Number(doc.lifecycleGeneration) || 0,
    fileName, filePath, fileSize,
    metadata: { ...(doc.metadata || {}) },
    pdfVersion, pageCount, pageSize,
  };
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================
// New Document Dialog (Solid.js)
// ============================================

export function showNewDocDialog() {
  openDialog('new-doc');
}

export function hideNewDocDialog() {
  closeDialog('new-doc');
}

// ============================================
// Insert Page Dialog (Solid.js)
// ============================================

export function showInsertPageDialog() {
  if (!getActiveDocument()?.pdfDoc) {
    showMessage(i18next.t('noDocumentOpen'));
    return;
  }
  openDialog('insert-page');
}

export function hideInsertPageDialog() {
  closeDialog('insert-page');
}

// ============================================
// Extract Pages Dialog (Solid.js)
// ============================================

export function showExtractPagesDialog() {
  const activeDoc = getActiveDocument();
  if (!activeDoc?.pdfDoc) {
    showMessage(i18next.t('noDocumentOpen'));
    return;
  }
  openDialog('extract-pages', {
    currentPage: activeDoc.currentPage,
    totalPages: activeDoc.pdfDoc.numPages,
  });
}

export function hideExtractPagesDialog() {
  closeDialog('extract-pages');
}

// ============================================
// Merge PDFs Dialog (Solid.js)
// ============================================

export function showMergePdfsDialog() {
  if (!getActiveDocument()?.pdfDoc) {
    showMessage(i18next.t('noDocumentOpen'));
    return;
  }
  openDialog('merge-pdfs');
}

export function hideMergePdfsDialog() {
  closeDialog('merge-pdfs');
}

// ============================================
// Print Dialog (Solid.js)
// ============================================

export function showPrintDialog() {
  if (!getActiveDocument()?.pdfDoc) {
    showMessage(i18next.t('noDocumentOpen'));
    return;
  }
  openDialog('print', { currentPage: getActiveDocument()?.currentPage || 1 });
}

export function hidePrintDialog() {
  closeDialog('print');
}

// ============================================
// Page Setup Dialog (Solid.js)
// ============================================

export function showPageSetupDialog() {
  openDialog('page-setup');
}

export function hidePageSetupDialog() {
  closeDialog('page-setup');
}

export { getPageSetupSettings } from '../../solid/components/dialogs/PageSetupDialog.jsx';
