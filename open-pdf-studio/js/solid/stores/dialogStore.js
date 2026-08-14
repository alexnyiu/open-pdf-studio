import { createSignal } from 'solid-js';

const [dialogs, setDialogs] = createSignal([]);

function captureReturnFocus() {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  if (active.closest?.('[role="dialog"], .app-menu-overlay, .context-menu')) return null;
  return active;
}

function restoreFocus(element) {
  if (!element || !element.isConnected || element.disabled) return;
  queueMicrotask(() => {
    if (element.isConnected && !element.disabled) {
      element.focus?.({ preventScroll: true });
    }
  });
}

export function openDialog(name, data = {}) {
  setDialogs(prev => {
    if (prev.some(d => d.name === name)) return prev;
    return [...prev, {
      name,
      data: {
        ...data,
        returnFocus: data.returnFocus ?? (prev.length === 0 ? captureReturnFocus() : null),
      },
    }];
  });
}

export function closeDialog(name) {
  let closedDialog = null;
  let remainingDialogs = [];
  setDialogs(prev => {
    closedDialog = prev.find(d => d.name === name) || null;
    remainingDialogs = prev.filter(d => d.name !== name);
    return remainingDialogs;
  });
  if (closedDialog && remainingDialogs.length === 0) {
    restoreFocus(closedDialog.data?.returnFocus);
  }
}

export function getDialogs() {
  return dialogs();
}

export function showMessage(message, title) {
  openDialog('message', { message, title });
}
