import { state, createDocument, getActiveDocument, findDocumentByPath, clearSelection } from '../../core/state.js';
import {
  renderPage,
  renderContinuous,
  clearPdfView,
  clearBitmapJSCacheForFile,
  clearActiveDocumentTextLayers,
} from '../../pdf/renderer.js';
import { hideFormFieldsBar } from '../../pdf/form-layer.js';
import { redrawAnnotations, redrawContinuous, updateQuickAccessButtons } from '../../annotations/rendering.js';
import { updateAllStatus } from './status-bar.js';
import { generateThumbnails, clearThumbnails, clearThumbnailCache, refreshActiveTab, refreshAllTabs, saveThumbnailScrollPosition } from '../panels/left-panel.js';
import { cancelAnnotationLoading, hidePdfABar, clearCachedPdfBytes } from '../../pdf/loader.js';
import { savePDF } from '../../pdf/saver.js';
import { saveResultIsDurable } from '../../pdf/save-result.js';
import { unlockFile, lockFile, renameFile, fileExists, invoke, isTauri } from '../../core/platform.js';
import { cancelPendingZoom } from '../setup/navigation-events.js';
import { closeAllPopups } from '../../bridge.js';
import { cancelOcrWorkflowDocument } from '../../ocr/workflow-service.js';
import { forgetRegisteredDocumentOcrCache } from '../../ocr/cache.js';
import { invalidateTextCache } from '../../search/text-cache.js';
import {
  cancelTextEditingForDocument,
  isTextEditingDirtyForDocument,
} from '../../text/text-edit-session.js';
import {
  LIFECYCLE_TRANSITION_POLICIES,
  replaceDocumentPdfProxy,
} from '../../core/document-lifecycle.js';
import { authorizeDocumentClose } from './document-close-authorization.js';
import { showUnsavedClosePrompt } from './unsaved-close-prompt.js';
import { restoreDocumentScrollPosition } from '../../pdf/document-scroll-position.js';
import { noteDocumentViewActivation } from '../../pdf/view-state-transaction.js';
import {
  documentHasRevisionPersistenceDebt,
  initializeDocumentRevisionState,
  noteDocumentMutation,
} from '../../core/document-revision-state.runtime.js';

const pendingTabCloses = new Map();

/**
 * Create a new tab for a document
 * @param {string} filePath - Path to the PDF file (null for new untitled document)
 * @param {boolean} autoSwitch - Whether to switch to the new tab (default: true)
 * @returns {{ doc: Object, index: number }} The created document object and its index
 */
export function createTab(filePath = null, autoSwitch = true) {
  // Check if file is already open
  if (filePath) {
    const existingIndex = findDocumentByPath(filePath);
    if (existingIndex !== -1) {
      // File already open, switch to its tab
      if (autoSwitch) {
        switchToTab(existingIndex);
      }
      return { doc: state.documents[existingIndex], index: existingIndex };
    }
  }

  // Create new document
  const doc = createDocument(filePath);
  state.documents.push(doc);

  // Switch to the new tab
  const newIndex = state.documents.length - 1;
  if (autoSwitch) {
    switchToTab(newIndex);
  }

  // Update tab bar UI
  updateTabBar();

  return { doc, index: newIndex };
}

/**
 * Switch to a specific tab
 * @param {number} index - Index of the tab to switch to
 */
export function switchToTab(index) {
  if (index < 0 || index >= state.documents.length) return;

  // Save scroll position of current document
  const currentDoc = getActiveDocument();
  if (currentDoc) {
    cancelTextEditingForDocument(currentDoc.id, 'tab-switch');
    import('../../pdf/whole-pdf-preload.js').then((module) => module.cancelWholePdfPreload(currentDoc, { reason: 'tab-switch' }));
    const container = document.getElementById('pdf-container');
    if (container) {
      currentDoc.scrollPosition = {
        x: container.scrollLeft,
        y: container.scrollTop
      };
    }
  }

  // Save thumbnail panel scroll position
  saveThumbnailScrollPosition();

  // Cancel any pending zoom render from the previous document
  cancelPendingZoom();

  // Clear any selected annotation (panel stays open per user preference)
  const curDoc = getActiveDocument();
  if (curDoc) {
    noteDocumentViewActivation(curDoc);
    curDoc.selectedAnnotation = null;
    curDoc.selectedAnnotations = [];
  }
  import('../../solid/stores/propertiesStore.js').then(m => m.storeHideProperties());

  // Switch active document
  state.activeDocumentIndex = index;
  import('../../pdf/render-resource-budget.js').then((module) => {
    module.setActiveRenderDocument(getActiveDocument()?.id || null);
  });
  import('../../pdf/whole-pdf-preload.js').then((module) => module.startWholePdfPreload(getActiveDocument()));

  // Update tab bar UI
  updateTabBar();

  // Hide form fields bar and PDF/A bar before rendering (will be re-shown if new doc has them)
  hideFormFieldsBar();
  hidePdfABar();

  // CRITICAL: deactivate the vector viewport singleton BEFORE the new doc's
  // renderPage() runs. Multiple PDFs share #pdf-canvas; the viewport's RAF
  // loop holds the LAST rendered doc's filePath/pageNum and would keep drawing
  // that page on every dirty tick (resize, panel toggle) until the new doc's
  // setPage() call lands. That's the cross-document ghost the user reports
  // when switching tabs rapidly. The vector path will reactivate it via
  // setPage() once the new doc's commands are ready; raster docs leave it off.
  if (window.__pdfViewport) window.__pdfViewport.active = false;

  // Clear the shared single-page canvases immediately so the previous doc's
  // pixels are not visible during the (potentially multi-hundred-ms) async
  // chain that loads the new doc's page. Without this, switching from a
  // large vector PDF to another shows the previous PDF until the new one
  // finishes its IPC + decode pipeline.
  const _spc = document.getElementById('pdf-canvas');
  if (_spc) {
    const _spx = _spc.getContext('2d');
    if (_spx) _spx.clearRect(0, 0, _spc.width, _spc.height);
  }
  const _ann = document.getElementById('annotation-canvas');
  if (_ann) {
    const _anx = _ann.getContext('2d');
    if (_anx) _anx.clearRect(0, 0, _ann.width, _ann.height);
  }
  // Retire every registered semantic surface owned by the previous document.
  clearActiveDocumentTextLayers();

  // Render the new active document
  const newDoc = getActiveDocument();
  if (newDoc && newDoc !== curDoc) noteDocumentViewActivation(newDoc);
  const placeholder = document.getElementById('placeholder');
  const pdfContainer = document.getElementById('pdf-container');

  if (newDoc && newDoc.pdfDoc) {
    // Show PDF container, hide placeholder
    if (placeholder) placeholder.style.display = 'none';
    if (pdfContainer) pdfContainer.classList.add('visible');

    // Clamp currentPage to valid range (could drift if document was modified)
    if (newDoc.currentPage < 1 || newDoc.currentPage > newDoc.pdfDoc.numPages) {
      newDoc.currentPage = 1;
    }

    if (newDoc.viewMode === 'continuous') {
      renderContinuous();
    } else {
      renderPage(newDoc.currentPage);
    }

    // Restore scroll position
    if (pdfContainer && newDoc.scrollPosition) {
      setTimeout(() => {
        if (getActiveDocument() === newDoc) {
          restoreDocumentScrollPosition(pdfContainer, newDoc);
        }
      }, 50);
    }

    // Regenerate thumbnails for the new document
    generateThumbnails();

    // Refresh active left panel tab content
    refreshActiveTab();
  } else {
    // No PDF loaded for this document yet — show placeholder
    if (placeholder) placeholder.style.display = '';
    if (pdfContainer) pdfContainer.classList.remove('visible');
    clearPdfView();
    clearThumbnails();
  }

  // Update UI elements
  updateAllStatus();
  updateQuickAccessButtons();
  updateWindowTitle();

  // Persist the new active-tab index (debounced) for session restore.
  window.__OPDS_SESSION_SAVE__?.();

  // Update PDF/A read-only tool state and bar for the new document
  import('../../tools/manager.js').then(m => m.updatePdfAToolState());
  if (newDoc && newDoc.pdfaCompliance) {
    import('../../pdf/loader.js').then(({ isPdfAReadOnly }) => {
      if (isPdfAReadOnly()) {
        const label = `PDF/A-${newDoc.pdfaCompliance.part}${newDoc.pdfaCompliance.conformance ? newDoc.pdfaCompliance.conformance.toLowerCase() : ''}`;
        const text = `This document complies with the ${label} standard and has been opened read-only to prevent modification.`;
        import('../../solid/stores/pdfaBarStore.js').then(m => m.showPdfABar(text));
      }
    });
  }
}

/**
 * Close a tab
 * @param {number} index - Index of the tab to close
 * @param {boolean} force - Force close without checking for unsaved changes
 * @returns {boolean} True if tab was closed, false if cancelled
 */
export async function closeTab(index, force = false) {
  if (index < 0 || index >= state.documents.length) return false;
  const doc = state.documents[index];
  const pending = pendingTabCloses.get(doc.id);
  if (pending) return pending;

  const operation = closeDocumentTab(doc, force);
  pendingTabCloses.set(doc.id, operation);
  try {
    return await operation;
  } finally {
    if (pendingTabCloses.get(doc.id) === operation) pendingTabCloses.delete(doc.id);
  }
}

async function closeDocumentTab(doc, force) {
  const authorized = await authorizeDocumentClose({
    documentState: doc,
    force,
    requestAction: showUnsavedClosePrompt,
    saveDocument: async (ownerDocument) => {
      // savePDF is active-document scoped. Never allow a stacked/programmatic
      // close prompt to save whichever unrelated tab happens to be visible.
      if (getActiveDocument() !== ownerDocument) return false;
      return savePDF();
    },
    isTextEditingDirtyForDocument,
    cancelTextEditingForDocument,
  });
  if (!authorized) return false;

  // The close has been authorized. Background work and transient editor state
  // remain untouched while a prompt is pending or after the user presses
  // Cancel; teardown begins only here.
  cancelAnnotationLoading(doc);

  // Document identity is the cancellation boundary for background OCR. Wait
  // for the disposable child to be reaped before removing application state.
  try {
    await cancelOcrWorkflowDocument(doc.id, 'document-close');
  } catch (error) {
    console.error('Failed to cancel and reap document OCR jobs:', error);
    return false;
  }

  // Close all open sticky note popups
  closeAllPopups();

  // Clear selection and hide contextual ribbon tabs
  clearSelection();
  import('../../solid/stores/ribbonStore.js').then(m => m.setContextualTabsVisible(false));

  // Release file lock so other apps can write to it again
  if (doc.filePath) {
    await unlockFile(doc.filePath);
  }

  // Release every path-owned PDF representation before dropping the final
  // document reference. This is required for large-document close/reopen:
  // otherwise PDF.js plus the native PDF/PDFium and bitmap caches retain the
  // closed document alongside its replacement.
  const closedPath = doc.filePath;
  const closedPdfDocument = doc.pdfDoc;
  const { clearEditableMetadataPreload } = await import('../../pdf/editable-metadata-preload.js');
  clearEditableMetadataPreload(doc);
  const { cancelWholePdfPreload } = await import('../../pdf/whole-pdf-preload.js');
  cancelWholePdfPreload(doc, { release: true, reason: 'close' });
  const { clearSavedDocumentSynchronization } = await import('../../pdf/saved-document-transition.js');
  await clearSavedDocumentSynchronization(doc.id);
  replaceDocumentPdfProxy(doc, null, LIFECYCLE_TRANSITION_POLICIES.DOCUMENT_CLOSE);
  try {
    await closedPdfDocument?.destroy?.();
  } catch (error) {
    console.warn('[tabs] PDF.js cleanup on close failed:', error);
  }
  if (closedPath) {
    clearCachedPdfBytes(closedPath);
    clearBitmapJSCacheForFile(closedPath);
    const vectorCache = await import('../../pdf/vector-renderer.js');
    vectorCache.clearVectorCacheForFile(closedPath);
    if (isTauri()) {
      try {
        await invoke('invalidate_pdf_cache', { path: closedPath });
      } catch (error) {
        console.warn('[tabs] Native PDF cache cleanup on close failed:', error);
      }
    }
  }

  // Delete the temp backing file of an untitled (never-saved) blank doc.
  if (doc.isUntitled && doc.filePath) {
    try {
      if (window.__TAURI__?.fs?.remove) await window.__TAURI__.fs.remove(doc.filePath);
    } catch (e) { console.warn('[blank-pdf] temp cleanup on close failed:', e); }
  }

  // Clear thumbnail cache for this document
  clearThumbnailCache(doc.id);
  const { clearRenderResourcesForDocument } = await import('../../pdf/render-resource-budget.js');
  clearRenderResourcesForDocument(doc.id, { release: true });
  invalidateTextCache(doc.id);
  forgetRegisteredDocumentOcrCache(doc.id);

  // Tabs can be reordered while asynchronous document cleanup runs. Resolve
  // the immutable owner again immediately before mutation rather than using
  // the caller's stale numeric index.
  const index = state.documents.indexOf(doc);
  if (index === -1) return true;

  // Remove the document
  state.documents.splice(index, 1);

  // Adjust active index
  if (state.documents.length === 0) {
    state.activeDocumentIndex = -1;
    clearPdfView();
    clearThumbnails();
    refreshAllTabs();
    updateWindowTitle();
    import('../../search/find-bar.js').then(m => m.closeFindBar());
  } else if (index <= state.activeDocumentIndex) {
    // If closing current or earlier tab, adjust index
    state.activeDocumentIndex = Math.max(0, state.activeDocumentIndex - 1);
    switchToTab(state.activeDocumentIndex);
  }

  // Update tab bar UI
  updateTabBar();
  updateQuickAccessButtons();

  // Keep the persisted session in sync (debounced) — survives dev reloads.
  window.__OPDS_SESSION_SAVE__?.();

  return true;
}

/**
 * Close the current active tab
 * @returns {boolean} True if tab was closed
 */
export async function closeActiveTab() {
  if (state.activeDocumentIndex === -1) return false;
  return closeTab(state.activeDocumentIndex);
}

/**
 * Check if any open document has unsaved changes
 * @returns {boolean}
 */
export function hasUnsavedChanges() {
  return state.documents.some(doc => doc.modified || documentHasRevisionPersistenceDebt(doc));
}

/**
 * Get list of unsaved document names
 * @returns {string[]}
 */
export function getUnsavedDocumentNames() {
  return state.documents
    .filter(doc => doc.modified || documentHasRevisionPersistenceDebt(doc))
    .map(doc => doc.fileName);
}

/**
 * Rename a document's file on disk and update state.
 * @param {number} index - Document index
 * @param {string} newName - New filename (without .pdf extension)
 * @returns {Promise<boolean>} True if renamed successfully
 */
export async function renameDocument(index, newName) {
  if (index < 0 || index >= state.documents.length) return false;

  const doc = state.documents[index];

  // Untitled docs — trigger Save As instead
  if (!doc.filePath) {
    const { savePDFAs } = await import('../../pdf/saver.js');
    return saveResultIsDurable(await savePDFAs());
  }

  // Validate: no invalid characters
  const invalidChars = /[\\/:*?"<>|]/;
  if (invalidChars.test(newName)) {
    const { showMessage } = await import('../../solid/stores/dialogStore.js');
    const i18next = (await import('../../i18n/config.js')).default;
    showMessage(i18next.t('statusbar:renameInvalidChars', { defaultValue: 'File name cannot contain \\ / : * ? " < > |' }));
    return false;
  }

  // Validate: not empty
  const trimmed = newName.trim();
  if (!trimmed) return false;

  // Auto-append .pdf if missing
  const finalName = trimmed.toLowerCase().endsWith('.pdf') ? trimmed : trimmed + '.pdf';

  // Build new path
  const oldPath = doc.filePath;
  const dir = oldPath.replace(/[\\/][^\\/]+$/, '');
  const sep = oldPath.includes('\\') ? '\\' : '/';
  const newPath = dir + sep + finalName;

  // Same name — no-op
  if (newPath === oldPath) return true;

  // Check if target already exists
  const exists = await fileExists(newPath);
  if (exists) {
    const { showMessage } = await import('../../solid/stores/dialogStore.js');
    const i18next = (await import('../../i18n/config.js')).default;
    showMessage(i18next.t('statusbar:renameFileExists', { defaultValue: 'A file with this name already exists.' }));
    return false;
  }

  try {
    // Unlock old file, rename, lock new file
    await unlockFile(oldPath);
    await renameFile(oldPath, newPath);
    await lockFile(newPath);

    // Update PDF byte cache
    const { getCachedPdfBytes, setCachedPdfBytes, clearCachedPdfBytes } = await import('../../pdf/loader.js');
    const cached = getCachedPdfBytes(oldPath);
    if (cached) {
      setCachedPdfBytes(newPath, cached);
      clearCachedPdfBytes(oldPath);
    }

    // Update document state
    const doc = getActiveDocument();
    if (doc) {
      const { clearEditableMetadataPreload } = await import('../../pdf/editable-metadata-preload.js');
      clearEditableMetadataPreload(doc);
      doc.filePath = newPath;
      doc.fileName = newPath ? newPath.split(/[\\/]/).pop() : 'Untitled';
    }
    updateWindowTitle();
    return true;
  } catch (err) {
    // Re-lock old path on failure
    await lockFile(oldPath);
    const { showMessage } = await import('../../solid/stores/dialogStore.js');
    const i18next = (await import('../../i18n/config.js')).default;
    showMessage(i18next.t('statusbar:renameError', { defaultValue: 'Failed to rename file: {{error}}', error: err?.message || String(err) }));
    return false;
  }
}

/**
 * Update the tab bar UI to reflect current documents
 */
export function updateTabBar() {
  // No-op: DocumentTabs.jsx now reads directly from reactive state
}

/**
 * Update window title based on active document
 */
export function updateWindowTitle() {
  const doc = getActiveDocument();
  const baseTitle = `Open PDF Studio v${__APP_VERSION__}`;

  // Update document.title (browser/OS window title)
  if (doc) {
    const modified = doc.modified ? '*' : '';
    document.title = `${modified}${doc.fileName} - ${baseTitle}`;
  } else {
    document.title = baseTitle;
  }

  // Tab bar and title bar derive from reactive state automatically
}

/**
 * Mark the active document as modified
 */
export function markDocumentModified(options = {}) {
  return markDocumentModifiedForDocument(getActiveDocument(), options);
}

/** Mark an immutable owner document modified even when another tab is visible. */
export function markDocumentModifiedForDocument(doc, {
  pages = [],
  structural = false,
  reason = 'direct-document-mutation',
} = {}) {
  if (doc) {
    noteDocumentMutation(doc, { pages, structural, reason });
    // Direct modification bypasses undo stack, so clean point is unreachable
    doc.savedUndoStackLength = -1;
    updateTabBar();
    updateWindowTitle();
    return true;
  }
  return false;
}

/**
 * Mark the active document as saved (not modified)
 */
export function markDocumentSaved() {
  return markDocumentSavedForDocument(getActiveDocument());
}

/** Mark the immutable saved owner clean even if another tab became visible. */
export function markDocumentSavedForDocument(doc) {
  if (doc) {
    const revisions = initializeDocumentRevisionState(doc);
    // A failed or non-macOS save leaves OCR dirty; validated macOS persistence
    // clears it only after native atomic replacement succeeds.
    const scannedDirty = doc.scannedTextEditRemovalPending === true
      || Number(doc.scannedTextEdits?.stateRevision ?? 0)
        !== Number(doc.scannedTextEditPersistedRevision ?? 0);
    const exactPersistedRevision = revisions.contentRevision === revisions.persistedRevision;
    doc.modified = !exactPersistedRevision || doc.ocr?.dirty === true || scannedDirty;
    if (exactPersistedRevision) doc.savedUndoStackLength = (doc.undoStack || []).length;
    updateTabBar();
    updateWindowTitle();
    return true;
  }
  return false;
}

/**
 * Initialize tab management
 */
export function initTabs() {
  updateTabBar();
}
