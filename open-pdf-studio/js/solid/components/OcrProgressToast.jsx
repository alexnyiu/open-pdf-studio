import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import {
  allOcrWorkflows,
  cancelOcrForDocument,
  collapseOcrWorkflow,
  dismissOcrWorkflow,
  dismissOcrWorkflowFailure,
  expandOcrWorkflow,
  navigateToOcrWorkflowDocument,
  ocrWorkflowActionFailure,
  ocrWorkflowCollapsed,
  ocrWorkflowDismissed,
  ocrWorkflowForDocument,
  ocrWorkflowHasRetryableFailure,
  retryOcrWorkflow,
} from '../stores/ocrWorkflowStore.js';
import { useTranslation } from '../../i18n/useTranslation.js';

export const OCR_LIVE_ANNOUNCEMENT_THROTTLE_MS = 1500;

const COUNT_STATES = ['completed', 'skipped', 'unsupported', 'failed', 'cancelled'];

function OcrProgressCard(props) {
  const { t } = useTranslation('ribbon');
  const job = props.job;
  const terminal = () => !!job()?.finishedAt;
  const cancelling = () => !!job()?.cancellationRequested && !terminal();
  const collapsed = () => !!job() && !terminal() && ocrWorkflowCollapsed(job().jobId);
  const percentage = () => Math.max(0, Math.min(100, Math.round((job()?.progress ?? 0) * 100)));
  const stateName = () => cancelling() ? 'cancelling' : (job()?.currentPageState ?? 'queued');
  const currentPageCacheState = () => job()?.pages.find(
    (page) => page.pageNumber === job()?.currentPageNumber,
  )?.cache;
  const stateLabel = () => t(`organize.ocrStates.${stateName()}`);
  const pageLabel = () => t('organize.ocrPage', {
    page: job()?.currentPageNumber ?? 1,
    total: job()?.pages.length ?? 1,
  });
  const retryable = () => ocrWorkflowHasRetryableFailure(job());
  const titleId = () => `ocr-progress-title-${job()?.jobId ?? 'unknown'}`;
  const packagedPerformanceEvidence = () => {
    const performance = job()?.terminalSummary?.performance;
    return performance ? JSON.stringify(performance) : undefined;
  };
  const [liveAnnouncement, setLiveAnnouncement] = createSignal('');
  let liveTimer = null;
  let pendingAnnouncement = '';
  let committedAnnouncement = '';
  let lastAnnouncementAt = 0;
  let observedCancelling = false;
  let observedTerminal = false;

  const announcementText = () => {
    const value = job();
    if (!value) return '';
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
    const nextCancelling = cancelling();
    const nextTerminal = terminal();
    const immediate = (nextCancelling && !observedCancelling) || (nextTerminal && !observedTerminal);
    observedCancelling = nextCancelling;
    observedTerminal = nextTerminal;
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
    <Show when={job()}>
      <section
        class="ocr-progress-toast"
        classList={{ 'ocr-progress-collapsed': collapsed(), 'ocr-progress-terminal': terminal() }}
        data-job-id={job()?.jobId}
        data-document-id={job()?.documentId}
        data-current-cache-state={currentPageCacheState() ?? undefined}
        data-cache-states={job()?.pages.map(
          (page) => `${page.pageNumber}:${page.cache ?? 'missing'}`,
        ).join(',') ?? undefined}
        data-ocr-performance={packagedPerformanceEvidence()}
        aria-labelledby={titleId()}
      >
        <div id={titleId()} class="ocr-progress-title">{t('organize.ocrProgressTitle')}</div>
        <button
          type="button"
          class="ocr-progress-document"
          title={job()?.documentName}
          onClick={() => { void navigateToOcrWorkflowDocument(job()?.documentId); }}
        >
          {job()?.documentName}
        </button>

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
                  data-ocr-action="cancel"
                  onClick={() => { void cancelOcrForDocument(job()?.documentId).catch(() => {}); }}
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
                data-ocr-action="cancel"
                onClick={() => { void cancelOcrForDocument(job()?.documentId).catch(() => {}); }}
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

        <div class="ocr-progress-live-region" aria-live="polite" aria-atomic="true">
          {liveAnnouncement()}
        </div>
      </section>
    </Show>
  );
}

function OcrActionFailureCard() {
  const { t } = useTranslation('ribbon');
  return (
    <Show when={ocrWorkflowActionFailure()}>
      <section class="ocr-progress-toast ocr-progress-terminal" aria-labelledby="ocr-progress-action-failure-title">
        <div id="ocr-progress-action-failure-title" class="ocr-progress-title">
          {t('organize.ocrProgressTitle')}
        </div>
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
      </section>
    </Show>
  );
}

export default function OcrProgressToast() {
  const { t } = useTranslation('ribbon');
  const visibleDocumentIds = createMemo(() => allOcrWorkflows()
    .filter((job) => !ocrWorkflowDismissed(job.jobId))
    .map((job) => job.documentId));

  return (
    <Show when={visibleDocumentIds().length > 0 || ocrWorkflowActionFailure()}>
      <aside class="ocr-progress-tray" aria-label={t('organize.ocrProgressTitle')}>
        <For each={visibleDocumentIds()}>{(documentId) => (
          <OcrProgressCard job={() => ocrWorkflowForDocument(documentId)} />
        )}</For>
        <OcrActionFailureCard />
      </aside>
    </Show>
  );
}
