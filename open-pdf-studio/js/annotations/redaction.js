import { state, getActiveDocument } from '../core/state.js';
import { createAnnotation } from './factory.js';
import { redrawAnnotations } from './rendering.js';
import { recordAdd } from '../core/undo-manager.js';
import i18next from '../i18n/config.js';
import { showMessage } from '../bridge.js';
import { showConfirm } from '../ui/chrome/confirm-dialog.js';

// Apply all redaction annotations permanently (flatten them)
export async function applyRedactions() {
  const doc = getActiveDocument();
  if (!doc) return;
  const curPage = doc.currentPage;
  const redactions = doc.annotations.filter(a => a.page === curPage && a.type === 'redaction');
  if (redactions.length === 0) {
    showMessage(i18next.t('noRedactionsOnPage'));
    return;
  }

  const count = redactions.length;
  const msg = `Apply ${count} redaction${count > 1 ? 's' : ''} on page ${curPage}?\n\nThis will permanently black out the marked areas. This action cannot be undone.`;
  const confirmed = await showConfirm({
    title: 'Apply Redactions',
    message: msg,
    confirmLabel: 'Apply',
    cancelLabel: 'Cancel',
  });

  if (!confirmed) return;

  // Convert redaction marks to permanent black rectangles (type 'box' with black fill)
  for (const r of redactions) {
    const idx = doc.annotations.indexOf(r);
    if (idx !== -1) {
      doc.annotations.splice(idx, 1);
    }
    // Add a permanent black filled box in its place
    doc.annotations.push(createAnnotation({
      type: 'box',
      page: r.page,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      color: r.overlayColor || '#000000',
      strokeColor: r.overlayColor || '#000000',
      fillColor: r.overlayColor || '#000000',
      lineWidth: 0,
      opacity: 1,
      locked: true,
      redacted: true // Mark as applied redaction
    }));
  }

  redrawAnnotations();
}

// Apply all redactions across all pages
export async function applyAllRedactions() {
  const doc = getActiveDocument();
  if (!doc) return;
  const allRedactions = doc.annotations.filter(a => a.type === 'redaction');
  if (allRedactions.length === 0) {
    showMessage(i18next.t('noRedactionsInDocument'));
    return;
  }

  const count = allRedactions.length;
  const pages = [...new Set(allRedactions.map(a => a.page))].sort((a, b) => a - b);
  const msg = `Apply ${count} redaction${count > 1 ? 's' : ''} across ${pages.length} page${pages.length > 1 ? 's' : ''}?\n\nThis will permanently black out all marked areas. This action cannot be undone.`;
  const confirmed = await showConfirm({
    title: 'Apply Redactions',
    message: msg,
    confirmLabel: 'Apply All',
    cancelLabel: 'Cancel',
  });

  if (!confirmed) return;

  for (const r of allRedactions) {
    const idx = doc.annotations.indexOf(r);
    if (idx !== -1) {
      doc.annotations.splice(idx, 1);
    }
    doc.annotations.push(createAnnotation({
      type: 'box',
      page: r.page,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      color: r.overlayColor || '#000000',
      strokeColor: r.overlayColor || '#000000',
      fillColor: r.overlayColor || '#000000',
      lineWidth: 0,
      opacity: 1,
      locked: true,
      redacted: true
    }));
  }

  redrawAnnotations();
}
