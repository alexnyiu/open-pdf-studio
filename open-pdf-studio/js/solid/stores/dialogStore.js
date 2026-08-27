import { createSignal } from 'solid-js';

const [dialogs, setDialogs] = createSignal([]);
let nextDialogId = 1;

export function openDialog(name, data = {}) {
  let openedId = null;
  setDialogs(prev => {
    const existing = prev.find((dialog) => dialog.name === name);
    if (existing) {
      openedId = existing.id;
      return prev;
    }
    openedId = `dialog-${nextDialogId++}`;
    return [...prev, { id: openedId, name, data }];
  });
  return openedId;
}

export function closeDialog(nameOrId) {
  setDialogs(prev => prev.filter(d => d.name !== nameOrId && d.id !== nameOrId));
}

export function getDialogs() {
  return dialogs();
}

export function getTopDialog() {
  return dialogs().at(-1) || null;
}

export function showMessage(message, title) {
  openDialog('message', { message, title });
}
