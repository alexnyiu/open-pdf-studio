import { loadPDF } from './loader.js';
import { removeRecentFile } from '../mobile/recent-files.js';
import { createTab } from '../ui/chrome/tabs.js';
import { isTauri, fileExists } from '../core/platform.js';

/**
 * Open a recent-file entry while keeping filesystem checks and tab creation
 * consistent across the empty state and File > Open.
 *
 * @param {{ path?: string }} file
 * @returns {Promise<{ opened: boolean, removed: boolean }>}
 */
export async function openRecentFile(file) {
  const path = file?.path;
  if (!path) {
    return { opened: false, removed: false };
  }

  if (isTauri()) {
    try {
      // Grant FS scope FIRST — fileExists needs it to access the path.
      await window.__TAURI__.core.invoke('allow_fs_scope', { path });
      const exists = await fileExists(path);
      if (!exists) {
        removeRecentFile(path);
        return { opened: false, removed: true };
      }
    } catch (e) {
      // If the check is unavailable, preserve the existing behavior and try opening.
    }
  }

  const { index } = createTab(path);
  await loadPDF(path, index);
  return { opened: true, removed: false };
}
