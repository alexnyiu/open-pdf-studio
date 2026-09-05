/** Display the existing primary-modifier bindings using platform conventions. */
export function usesMacShortcuts() {
  const os = globalThis.window?.__TAURI__?.os?.type?.();
  return os ? os === 'macos' || os === 'ios'
    : /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '');
}

export function shortcutLabel(key, { shift = false } = {}) {
  return usesMacShortcuts()
    ? `⌘${shift ? '⇧' : ''}${key}`
    : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}
