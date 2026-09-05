// Non-modal print progress. The print dialog closes the moment the user
// clicks "Afdrukken"; the actual render + spool runs in the background
// (pdf/print-job.js) and drives the floating progress bar through these
// signals, so the user keeps working meanwhile.

import i18next from '../../i18n/config.js';
import { createSignal } from 'solid-js';

export const [printOutputPaths, setPrintOutputPaths] = createSignal([]);
export function dismissPrintProgress() { clearTimeout(dismissTimer); setActive(false); setPrintOutputPaths([]); }

export const [printCancellation, setCancellation] = createSignal(null);
export function setPrintCancellation(callback) { setCancellation(() => callback); }
let dismissTimer = null;
const [active, setActive] = createSignal(false);
const [label, setLabel] = createSignal('');
const [value, setValue] = createSignal(0);     // 0..1
const [isError, setIsError] = createSignal(false);

export {
  active as printProgressActive,
  label as printProgressLabel,
  value as printProgressValue,
  isError as printProgressError,
};

export function startPrintProgress(l) {
  clearTimeout(dismissTimer);
  setPrintOutputPaths([]);
  setIsError(false);
  setLabel(l || '');
  setValue(0);
  setActive(true);
}

export function updatePrintProgress(l, v) {
  if (l != null) setLabel(l);
  if (v != null) setValue(Math.max(0, Math.min(1, v)));
}

export function finishPrintProgress(l) {
  setLabel(l || '');
  setValue(1);
  if (!printOutputPaths().length) dismissTimer = setTimeout(() => setActive(false), 1800);
}

export function failPrintProgress(msg) {
  setIsError(true);
  setLabel(msg || i18next.t('common:repair.outputFailed'));
  setValue(1);
  if (!printOutputPaths().length) dismissTimer = setTimeout(() => { setActive(false); setIsError(false); }, 6000);
}
