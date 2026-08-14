import { createSignal, For, Show, onMount } from 'solid-js';
import { openPDFFile } from '../../pdf/loader.js';
import { openRecentFile } from '../../pdf/recent-file-opener.js';
import { getRecentFiles } from '../../mobile/recent-files.js';
import { openAppMenu } from '../../ui/chrome/menus.js';
import { useTranslation } from '../../i18n/useTranslation.js';
import UiButton from './ui/UiButton.jsx';

const EMPTY_STATE_RECENT_LIMIT = 4;

export default function EmptyState() {
  const { t: tCommon } = useTranslation('common');
  const { t: tMenu } = useTranslation('appMenu');
  const [recentFiles, setRecentFiles] = createSignal([]);

  function refreshRecentFiles() {
    const files = getRecentFiles();
    files.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    setRecentFiles(files.slice(0, EMPTY_STATE_RECENT_LIMIT));
  }

  onMount(refreshRecentFiles);

  async function handleOpenRecent(file) {
    const result = await openRecentFile(file);
    if (result.removed) {
      refreshRecentFiles();
    }
  }

  return (
    <div id="placeholder" class="empty-state" data-phase7="open-recent-empty" data-phase8="interaction-quality">
      <div class="empty-state-card">
        <div class="empty-state-hero">
          <div class="empty-state-icon" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M9 13h6M9 17h4" />
            </svg>
          </div>
          <div class="empty-state-copy">
            <h2>{tCommon('noDocuments')}</h2>
            <p>{tCommon('noDocumentsHint')}</p>
          </div>
        </div>

        <div class="empty-state-actions">
          <UiButton
            type="button"
            variant="primary"
            class="empty-state-open"
            label={tCommon('open')}
            tooltip={tCommon('open')}
            shortcut="Ctrl+O"
            onClick={() => openPDFFile()}
            aria-label={tCommon('open')}
          />
          <UiButton
            type="button"
            variant="secondary"
            class="empty-state-secondary"
            label={tMenu('openPanel.recentFiles')}
            onClick={openAppMenu}
          />
        </div>

        <Show when={recentFiles().length > 0}>
          <section class="empty-state-recent" aria-labelledby="empty-state-recent-heading">
            <div class="empty-state-recent-header">
              <h3 id="empty-state-recent-heading">{tMenu('openPanel.recentFiles')}</h3>
              <button type="button" class="empty-state-recent-link" onClick={openAppMenu}>
                {tMenu('openPanel.recentFiles')}
              </button>
            </div>
            <div class="empty-state-recent-list">
              <For each={recentFiles()}>
                {(file) => (
                  <button
                    type="button"
                    class="empty-state-recent-item"
                    onClick={() => handleOpenRecent(file)}
                    title={file.path}
                    aria-label={`${tCommon('open')} ${file.name || file.path}`}
                  >
                    <span class="empty-state-recent-icon" aria-hidden="true">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" d="M9 13h6M9 17h4" />
                      </svg>
                    </span>
                    <span class="empty-state-recent-info">
                      <span class="empty-state-recent-name">{file.name || file.path}</span>
                      <span class="empty-state-recent-path">{file.path}</span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </section>
        </Show>
      </div>
    </div>
  );
}
