import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import {
  activeDocumentOcrWorkflow,
  cancelActiveDocumentOcr,
  collapseOcrWorkflow,
  dismissOcrWorkflow,
  dismissOcrWorkflowFailure,
  expandOcrWorkflow,
  ocrWorkflowActionFailure,
  ocrWorkflowCollapsed,
  ocrWorkflowDismissed,
  ocrWorkflowHasRetryableFailure,
  retryOcrWorkflow,
} from '../stores/ocrWorkflowStore.js';
import { useTranslation } from '../../i18n/useTranslation.js';

export const OCR_LIVE_ANNOUNCEMENT_THROTTLE_MS = 1500;

const COUNT_STATES = ['completed', 'skipped', 'unsupported', 'failed', 'cancelled'];

export default function OcrProgressToast() {
  const { t } = useTranslation('ribbon');
  const job = () => {
    const value = activeDocumentOcrWorkflow();
    return value && !ocrWorkflowDismissed(value.jobId) ? value : null;
  };
  const terminal = () => !!job()?.finishedAt;
  const cancelling = () => !!job()?.cancellationRequested && !terminal();
  const collapsed = () => !!job() && !terminal() && ocrWorkflowCollapsed(job().jobId);
  const percentage = () => Math.max(0, Math.min(100, Math.round((job()?.progress ?? 0) * 100)));
  const stateName = () => cancelling() ? 'cancelling' : (job()?.currentPageState ?? 'queued');
  const stateLabel = () => t(`organize.ocrStates.${stateName()}`);
  const pageLabel = () => t('organize.ocrPage', {
    page: job()?.currentPageNumber ?? 1,
    total: job()?.pages.length ?? 1,
  });
  const retryable = () => ocrWorkflowHasRetryableFailure(job());
  const [liveAnnouncement, setLiveAnnouncement] = createSignal('');
  let liveTimer = null;
  let pendingAnnouncement = '';
  let committedAnnouncement = '';
  let lastAnnouncementAt = 0;
  let observedJobId = null;
  let observedCancelling = false;
  let observedTerminal = false;
  let observedFailureCode = null;

  const announcementText = () => {
    const value = job();
    if (!value) {
      const failure = ocrWorkflowActionFailure();
      return failure ? t('organize.ocrActionFailed', { code: failure.code }) : '';
    }
    return t('organize.ocrLiveUpdate', {
      document: value.documentName,
      state: stateLabel(),
      page: value.currentPageNumber ?? 1,
      total: value.pages.length,
      percent: percentage(),
      completed: value.counts.completed,
      failed: value.counts.failed,
      cancelled: value.counts.cancelled,
    });
  };

  function commitAnnouncement() {
    if (!pendingAnnouncement || pendingAnnouncement === committedAnnouncement) return;
    committedAnnouncement = pendingAnnouncement;
    setLiveAnnouncement(pendingAnnouncement);
    lastAnnouncementAt = Date.now();
  }

  function queueAnnouncement(value, immediate) {
    pendingAnnouncement = value;
    if (liveTimer !== null) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }
    const remaining = OCR_LIVE_ANNOUNCEMENT_THROTTLE_MS - (Date.now() - lastAnnouncementAt);
    if (immediate || lastAnnouncementAt === 0 || remaining <= 0) {
      commitAnnouncement();
      return;
    }
    liveTimer = setTimeout(() => {
      liveTimer = null;
      commitAnnouncement();
    }, remaining);
  }

  createEffect(() => {
    const value = job();
    const nextJobId = value?.jobId ?? null;
    const nextCancelling = cancelling();
    const nextTerminal = terminal();
    const nextFailureCode = value ? null : (ocrWorkflowActionFailure()?.code ?? null);
    const immediate = nextJobId !== observedJobId ||
      (nextCancelling && !observedCancelling) ||
      (nextTerminal && !observedTerminal) ||
      nextFailureCode !== observedFailureCode;
    observedJobId = nextJobId;
    observedCancelling = nextCancelling;
    observedTerminal = nextTerminal;
    observedFailureCode = nextFailureCode;
    queueAnnouncement(announcementText(), immediate);
  });

  onCleanup(() => {
    if (liveTimer !== null) clearTimeout(liveTimer);
  });

  const countEntries = () => COUNT_STATES.map((state) => ({
    state,
    count: job()?.counts[state] ?? 0,
  }));

  return (
    <Show when={job() || ocrWorkflowActionFailure()}>
      <aside
        class="ocr-progress-toast"
        classList={{ 'ocr-progress-collapsed': collapsed(), 'ocr-progress-terminal': terminal() }}
        data-job-id={job()?.jobId ?? undefined}
        aria-labelledby="ocr-progress-title"
      >
        <div id="ocr-progress-title" class="ocr-progress-title">
          {t('organize.ocrProgressTitle')}
        </div>

        <Show when={job()} fallback={
          <>
            <div class="ocr-progress-label">
              {t('organize.ocrActionFailed', {
                code: ocrWorkflowActionFailure()?.code ?? 'OCR_WORKFLOW_FAILED',
              })}
            </div>
            <Show when={ocrWorkflowActionFailure()?.retryable}>
              <p class="ocr-progress-guidance">{t('organize.ocrRetryGuidance')}</p>
            </Show>
            <div class="ocr-progress-actions">
              <button type="button" class="ocr-progress-action" onClick={dismissOcrWorkflowFailure}>
                {t('organize.dismissOcr')}
              </button>
            </div>
          </>
        }>
          <div class="ocr-progress-document" title={job()?.documentName}>{job()?.documentName}</div>

          <Show when={!collapsed()} fallback={
            <>
              <div class="ocr-progress-compact-status">
                {stateLabel()} · {pageLabel()} · {percentage()}%
              </div>
              <div class="ocr-progress-actions">
                <Show when={job()?.cancellationAvailable}>
                  <button
                    type="button"
                    class="ocr-progress-action"
                    onClick={() => { void cancelActiveDocumentOcr().catch(() => {}); }}
                  >
                    {t('organize.cancelOcr')}
                  </button>
                </Show>
                <Show when={cancelling()}>
                  <button type="button" class="ocr-progress-action" disabled>
                    {t('organize.ocrCancelling')}
                  </button>
                </Show>
                <button type="button" class="ocr-progress-action" onClick={() => expandOcrWorkflow(job()?.jobId)}>
                  {t('organize.showOcr')}
                </button>
              </div>
            </>
          }>
            <div class="ocr-progress-status-row">
              <span class="ocr-progress-state" data-page-state={stateName()}>{stateLabel()}</span>
              <span>{pageLabel()}</span>
            </div>
            <div
              class="ocr-progress-track"
              role="progressbar"
              aria-label={t('organize.ocrOverallProgress', { document: job()?.documentName })}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={percentage()}
              aria-valuetext={`${percentage()}%`}
            >
              <div class="ocr-progress-fill" style={{ width: `${percentage()}%` }} />
            </div>
            <div class="ocr-progress-fraction">{percentage()}%</div>

            <dl class="ocr-progress-counts" aria-label={t('organize.ocrCounts')}>
              <For each={countEntries()}>{({ state, count }) => (
                <div data-count-state={state}>
                  <dt>{t(`organize.ocrStates.${state}`)}</dt>
                  <dd>{count}</dd>
                </div>
              )}</For>
            </dl>

            <Show when={terminal()}>
              <div class="ocr-progress-summary" data-terminal-status={job()?.status}>
                {t(`organize.ocrTerminal.${job()?.status}`, {
                  completed: job()?.counts.completed ?? 0,
                  skipped: job()?.counts.skipped ?? 0,
                  unsupported: job()?.counts.unsupported ?? 0,
                  failed: job()?.counts.failed ?? 0,
                  cancelled: job()?.counts.cancelled ?? 0,
                })}
              </div>
              <Show when={job()?.failureDetails.length}>
                <ul class="ocr-progress-failures">
                  <For each={job()?.failureDetails}>{(failure) => (
                    <li>{t('organize.ocrFailureDetail', {
                      page: failure.pageNumber ?? '–',
                      code: failure.code,
                    })}</li>
                  )}</For>
                </ul>
              </Show>
              <Show when={retryable()}>
                <p class="ocr-progress-guidance">{t('organize.ocrRetryGuidance')}</p>
              </Show>
            </Show>

            <div class="ocr-progress-actions">
              <Show when={job()?.cancellationAvailable}>
                <button
                  type="button"
                  class="ocr-progress-action"
                  onClick={() => { void cancelActiveDocumentOcr().catch(() => {}); }}
                >
                  {t('organize.cancelOcr')}
                </button>
              </Show>
              <Show when={cancelling()}>
                <button type="button" class="ocr-progress-action" disabled>
                  {t('organize.ocrCancelling')}
                </button>
              </Show>
              <Show when={!terminal()}>
                <button type="button" class="ocr-progress-action" onClick={() => collapseOcrWorkflow(job()?.jobId)}>
                  {t('organize.hideOcr')}
                </button>
              </Show>
              <Show when={retryable()}>
                <button
                  type="button"
                  class="ocr-progress-action"
                  onClick={() => { void retryOcrWorkflow(job()).catch(() => {}); }}
                >
                  {t('organize.retryOcr')}
                </button>
              </Show>
              <Show when={terminal()}>
                <button type="button" class="ocr-progress-action" onClick={() => dismissOcrWorkflow(job()?.jobId)}>
                  {t('organize.dismissOcr')}
                </button>
              </Show>
            </div>
          </Show>
        </Show>

        <div class="ocr-progress-live-region" aria-live="polite" aria-atomic="true">
          {liveAnnouncement()}
        </div>
      </aside>
    </Show>
  );
}
