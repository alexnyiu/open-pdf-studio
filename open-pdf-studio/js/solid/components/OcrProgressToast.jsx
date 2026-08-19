import { Show } from 'solid-js';
import {
  activeDocumentOcrWorkflow,
  cancelActiveDocumentOcr,
  dismissOcrWorkflowFailure,
  ocrWorkflowActionFailure,
} from '../stores/ocrWorkflowStore.js';
import { useTranslation } from '../../i18n/useTranslation.js';

export default function OcrProgressToast() {
  const { t } = useTranslation('ribbon');
  const job = () => activeDocumentOcrWorkflow();
  const running = () => !!job() && job().finishedAt === null;
  const currentPage = () => job()?.pages.find((page) => !['completed', 'skipped', 'unsupported', 'failed', 'cancelled'].includes(page.state))
    ?? job()?.pages.at(-1);
  const label = () => t('organize.ocrRunning', {
    page: currentPage()?.pageNumber ?? 1,
    total: job()?.pages.length ?? 1,
  });

  return (
    <Show when={running() || ocrWorkflowActionFailure()}>
      <div class="ocr-progress-toast" role="status" aria-live="polite">
        <Show when={running()} fallback={
          <div class="ocr-progress-label">
            {t('organize.ocrFailed', { code: ocrWorkflowActionFailure()?.code ?? 'OCR_WORKFLOW_FAILED' })}
          </div>
        }>
          <div class="ocr-progress-label">{label()}</div>
          <div class="ocr-progress-track" aria-hidden="true">
            <div class="ocr-progress-fill" style={{ width: `${Math.round((job()?.progress ?? 0) * 100)}%` }} />
          </div>
        </Show>
        <Show when={job()?.cancellationAvailable}>
          <button type="button" class="ocr-progress-action"
            onClick={() => { void cancelActiveDocumentOcr().catch(() => {}); }}>
            {t('organize.cancelOcr')}
          </button>
        </Show>
        <Show when={!running() && ocrWorkflowActionFailure()}>
          <button type="button" class="ocr-progress-action" onClick={dismissOcrWorkflowFailure}>
            {t('organize.dismissOcr')}
          </button>
        </Show>
      </div>
    </Show>
  );
}
