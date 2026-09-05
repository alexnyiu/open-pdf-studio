import { useTranslation } from '../../i18n/useTranslation.js';
// Floating, non-modal print progress bar (bottom-right). Shown while a
// background print job runs so the user can keep working.
import { revealInFileManager } from '../../core/file-manager-reveal.js';
import { Show, For } from 'solid-js';
import {
  printOutputPaths, dismissPrintProgress, printCancellation, printProgressActive, printProgressLabel, printProgressValue, printProgressError,
} from '../stores/printProgressStore.js';

export default function PrintProgressToast() {
  const { t } = useTranslation('common');
  return (
    <Show when={printProgressActive()}>
      <div class="print-progress-toast" classList={{ 'print-progress-error': printProgressError() }}>
        <div class="print-progress-label" role="status" aria-live="polite">{printProgressLabel()}</div>
        <Show when={printCancellation()}><button type="button" onClick={() => printCancellation()?.()}>{t('repair.cancel')}</button></Show>
        <Show when={printOutputPaths().length}>
          <details>
            <summary>{t('repair.writtenFiles', { count: printOutputPaths().length })}</summary>
            <ul style="max-height:160px; overflow:auto;">
              <For each={printOutputPaths()}>{path => <li>{path}</li>}</For>
            </ul>
          </details>
          <button type="button" onClick={async () => {
            if (!await revealInFileManager(printOutputPaths()[0])) {
              const { failPrintProgress } = await import('../stores/printProgressStore.js');
              failPrintProgress(t('repair.revealFailed'));
            }
          }}>{t('repair.revealFolder')}</button>
          <button type="button" onClick={dismissPrintProgress}>{t('repair.dismiss')}</button>
        </Show>
        <div class="print-progress-track" role="progressbar" aria-label={printProgressLabel()} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(printProgressValue() * 100)}>
          <div class="print-progress-fill" style={{ width: Math.round((printProgressValue() || 0) * 100) + '%' }} />
        </div>
      </div>
    </Show>
  );
}
