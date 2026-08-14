import { createSignal } from 'solid-js';
import { state } from '../../core/state.js';

// Active panel within app menu (UI-only state)
const [activePanel, setActivePanelSignal] = createSignal('none');
let returnFocus = null;

function captureFocus() {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (!active || active === document.body || active.closest?.('[role="dialog"]')) return null;
  return active;
}

function restoreFocus() {
  const target = returnFocus;
  returnFocus = null;
  queueMicrotask(() => {
    if (target?.isConnected && !target.disabled) target.focus?.({ preventScroll: true });
  });
}

export function openAppMenu() {
  if (!state.appMenuOpen) returnFocus = captureFocus();
  state.appMenuOpen = true;
  setActivePanelSignal('open');
}

export function closeAppMenu() {
  if (!state.appMenuOpen) return;
  state.appMenuOpen = false;
  restoreFocus();
}

export function setActivePanel(name) {
  setActivePanelSignal(name);
}

export function isAppMenuOpen() {
  return state.appMenuOpen;
}

export function getActivePanel() {
  return activePanel();
}
