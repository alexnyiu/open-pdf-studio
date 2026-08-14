/**
 * Custom confirm dialog with "Don't show again" support.
 *
 * Usage:
 *   const confirmed = await showConfirm({
 *     title: 'Delete Annotation',
 *     message: 'Delete this annotation?',
 *     preferenceKey: 'confirmBeforeDelete'
 *   });
 *
 * If preferenceKey is provided and the corresponding preference is false,
 * the dialog is skipped and true is returned immediately.
 */

import { state } from '../../core/state.js';
import { openDialog } from '../../solid/stores/dialogStore.js';

export function showConfirm({
  title,
  message,
  preferenceKey,
  confirmLabel = 'Yes',
  cancelLabel = 'No',
}) {
  // Check if user has disabled this confirmation
  if (preferenceKey && state.preferences[preferenceKey] === false) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    openDialog('confirm', {
      title,
      message,
      preferenceKey,
      confirmLabel,
      cancelLabel,
      resolve,
    });
  });
}

export function showUnsavedChanges({ title, message }) {
  return new Promise((resolve) => {
    openDialog('unsaved-changes', { title, message, resolve });
  });
}
