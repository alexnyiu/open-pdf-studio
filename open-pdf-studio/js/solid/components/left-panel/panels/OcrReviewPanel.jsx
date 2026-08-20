import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { activeTab } from '../../../stores/leftPanelStore.js';
import {
  acceptActiveOcrReviewCorrection,
  activeOcrReviewDocument,
  activeOcrReviewPage,
  canRedoOcrReviewAction,
  canUndoOcrReviewAction,
  navigateToNextLowConfidenceOcrItem,
  navigateToNextOcrReviewWarning,
  navigateToOcrReviewPage,
  ocrReviewAnnouncement,
  ocrReviewLowConfidenceOnly,
  redoOcrReviewAction,
  removeActiveOcrReviewDocument,
  removeActiveOcrReviewPage,
  rerunActiveOcrReviewPage,
  selectOcrReviewLine,
  selectedOcrReviewLineId,
  setOcrReviewLowConfidenceOnly,
  undoOcrReviewAction,
  visibleOcrReviewLines,
} from '../../../stores/ocrReviewStore.js';
import { activeDocumentOcrWorkflow } from '../../../stores/ocrWorkflowStore.js';
import { MAX_OCR_CORRECTION_CODE_UNITS } from '../../../../ocr/document-state.js';
import { getOwnedOcrReviewPageNumbers } from '../../../../ocr/review-model.js';
import { useTranslation } from '../../../../i18n/useTranslation.js';

function OcrReviewLine(props) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(props.line.effectiveText);
  const [error, setError] = createSignal('');
  let cardRef;
  let inputRef;

  createEffect(() => {
    if (!editing()) setDraft(props.line.effectiveText);
  });

  const beginEditing = (text = props.line.effectiveText) => {
    setDraft(text);
    setError('');
    setEditing(true);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  };

  const cancelEditing = () => {
    setDraft(props.line.effectiveText);
    setError('');
    setEditing(false);
    queueMicrotask(() => cardRef?.focus());
  };

  const acceptCorrection = () => {
    try {
      props.onAccept(props.line.id, draft());
      setError('');
      setEditing(false);
      queueMicrotask(() => cardRef?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : props.t('ocrReview.invalidCorrection'));
    }
  };

  const handleCardKeyDown = (event) => {
    if (event.target !== event.currentTarget) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      props.onMove(event.key);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      beginEditing();
    }
  };

  return (
    <li class="ocr-review-line-item">
      <article
        ref={cardRef}
        class={`ocr-review-line${props.selected ? ' selected' : ''}`}
        data-ocr-review-line={props.line.id}
        data-ocr-engine-text={props.line.engineText}
        data-ocr-effective-text={props.line.effectiveText}
        data-confidence-band={props.line.confidenceBand}
        tabIndex={props.focusable ? 0 : -1}
        aria-current={props.selected ? 'true' : undefined}
        aria-label={props.t('ocrReview.lineAccessibleLabel', {
          line: props.line.readingOrder + 1,
          confidence: props.line.confidencePercent ?? 0,
          indicator: props.t(`ocrReview.confidence.${props.line.confidenceBand}`),
        })}
        onClick={() => props.onSelect(props.line.id)}
        onFocus={() => props.onSelect(props.line.id)}
        onKeyDown={handleCardKeyDown}
      >
        <div class="ocr-review-line-meta">
          <span>{props.t('ocrReview.lineNumber', { line: props.line.readingOrder + 1 })}</span>
          <span
            class={`ocr-review-confidence confidence-${props.line.confidenceBand}`}
            aria-label={props.t('ocrReview.confidenceAccessibleLabel', {
              confidence: props.line.confidencePercent ?? 0,
              indicator: props.t(`ocrReview.confidence.${props.line.confidenceBand}`),
            })}
          >
            <span aria-hidden="true">{props.line.lowConfidence ? '!' : '✓'}</span>
            {props.line.confidencePercent === null ? '—' : `${props.line.confidencePercent}%`}
            {' · '}{props.t(`ocrReview.confidence.${props.line.confidenceBand}`)}
          </span>
        </div>

        <p class="ocr-review-effective-text">{props.line.effectiveText}</p>

        <Show when={props.line.correction}>
          <p class="ocr-review-correction-state">{props.t('ocrReview.acceptedCorrection')}</p>
        </Show>
        <Show when={props.line.warningCount > 0}>
          <p class="ocr-review-line-warning">
            {props.t('ocrReview.lineWarnings', { count: props.line.warningCount })}
          </p>
        </Show>

        <Show when={props.line.alternatives !== null}>
          <section class="ocr-review-alternatives" aria-label={props.t('ocrReview.alternatives')}>
            <h4>{props.t('ocrReview.alternatives')}</h4>
            <Show
              when={props.line.alternatives.length > 0}
              fallback={<p>{props.t('ocrReview.noAlternatives')}</p>}
            >
              <div class="ocr-review-alternative-list">
                <For each={props.line.alternatives}>
                  {(alternative) => (
                    <button
                      type="button"
                      class="ocr-review-alternative"
                      aria-label={props.t('ocrReview.useAlternative', {
                        text: alternative.text,
                        confidence: Math.round(alternative.confidence * 100),
                      })}
                      onClick={(event) => {
                        event.stopPropagation();
                        beginEditing(alternative.text);
                      }}
                    >
                      {alternative.text} ({Math.round(alternative.confidence * 100)}%)
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </Show>

        <Show
          when={editing()}
          fallback={(
            <button
              type="button"
              class="ocr-review-secondary-button"
              onClick={(event) => {
                event.stopPropagation();
                beginEditing();
              }}
            >
              {props.line.correction ? props.t('ocrReview.editCorrection') : props.t('ocrReview.correctText')}
            </button>
          )}
        >
          <div class="ocr-review-correction-editor" onClick={(event) => event.stopPropagation()}>
            <label for={`ocr-review-correction-${props.line.id}`}>
              {props.t('ocrReview.correctionLabel', { line: props.line.readingOrder + 1 })}
            </label>
            <input
              ref={inputRef}
              id={`ocr-review-correction-${props.line.id}`}
              type="text"
              value={draft()}
              maxLength={MAX_OCR_CORRECTION_CODE_UNITS}
              aria-invalid={error() ? 'true' : 'false'}
              aria-describedby={error() ? `ocr-review-correction-error-${props.line.id}` : undefined}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  acceptCorrection();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelEditing();
                }
              }}
            />
            <Show when={error()}>
              <p id={`ocr-review-correction-error-${props.line.id}`} class="ocr-review-error" role="alert">
                {error()}
              </p>
            </Show>
            <div class="ocr-review-editor-actions">
              <button type="button" class="ocr-review-primary-button" onClick={acceptCorrection}>
                {props.t('ocrReview.acceptCorrection')}
              </button>
              <button type="button" class="ocr-review-secondary-button" onClick={cancelEditing}>
                {props.t('ocrReview.cancelCorrection')}
              </button>
            </div>
          </div>
        </Show>
      </article>
    </li>
  );
}

export default function OcrReviewPanel() {
  const { t } = useTranslation('properties');
  const review = createMemo(() => activeOcrReviewPage());
  const activeDocument = () => activeOcrReviewDocument();
  const totalPages = () => activeDocument()?.pdfDoc?.numPages ?? 0;
  const lines = () => visibleOcrReviewLines();
  const ownedPageNumbers = createMemo(() => getOwnedOcrReviewPageNumbers(activeDocument()));
  const [actionError, setActionError] = createSignal('');
  const [actionBusy, setActionBusy] = createSignal(false);

  const workflowBusy = () => {
    const workflow = activeDocumentOcrWorkflow();
    return !!workflow && workflow.finishedAt === null;
  };

  const ownershipLabel = () => t(`ocrReview.ownership.${review()?.ownershipState ?? 'none'}`);

  const runAction = async (action) => {
    setActionError('');
    setActionBusy(true);
    try {
      return await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('ocrReview.actionFailed'));
      return null;
    } finally {
      setActionBusy(false);
    }
  };

  const moveLineFocus = (currentIndex, key) => {
    const visible = lines();
    if (visible.length === 0) return;
    let nextIndex = currentIndex;
    if (key === 'ArrowDown') nextIndex = Math.min(visible.length - 1, currentIndex + 1);
    if (key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
    if (key === 'Home') nextIndex = 0;
    if (key === 'End') nextIndex = visible.length - 1;
    selectOcrReviewLine(visible[nextIndex].id);
  };

  createEffect(() => {
    if (activeTab() !== 'ocr-review') return;
    const lineId = selectedOcrReviewLineId();
    if (!lineId) return;
    queueMicrotask(() => {
      const target = [...globalThis.document.querySelectorAll('[data-ocr-review-line]')]
        .find((element) => element.dataset.ocrReviewLine === lineId);
      target?.focus();
    });
  });

  const selectedVisible = () => lines().some((line) => line.id === selectedOcrReviewLineId());

  return (
    <div
      class={`left-panel-content ocr-review-panel${activeTab() === 'ocr-review' ? ' active' : ''}`}
      id="ocr-review-panel"
      role="region"
      aria-label={t('ocrReview.title')}
    >
      <div class="left-panel-header">
        <span>{t('ocrReview.title')}</span>
        <span class="ocr-review-ownership" data-ownership-state={review()?.ownershipState ?? 'none'}>
          {ownershipLabel()}
        </span>
      </div>

      <div class="ocr-review-scroll-area">
        <Show when={activeDocument()?.pdfDoc} fallback={<p class="ocr-review-empty">{t('ocrReview.noDocument')}</p>}>
          <nav class="ocr-review-page-navigation" aria-label={t('ocrReview.pageNavigation')}>
            <button
              type="button"
              aria-label={t('ocrReview.previousPage')}
              disabled={(activeDocument()?.currentPage ?? 1) <= 1 || actionBusy()}
              onClick={() => runAction(() => navigateToOcrReviewPage((activeDocument()?.currentPage ?? 1) - 1))}
            >
              ‹
            </button>
            <label>
              <span class="ocr-review-visually-hidden">{t('ocrReview.reviewPage')}</span>
              <select
                aria-label={t('ocrReview.reviewPage')}
                value={activeDocument()?.currentPage ?? 1}
                disabled={actionBusy()}
                onChange={(event) => runAction(() => navigateToOcrReviewPage(Number(event.currentTarget.value)))}
              >
                <For each={Array.from({ length: totalPages() }, (_, index) => index + 1)}>
                  {(pageNumber) => <option value={pageNumber}>{pageNumber}</option>}
                </For>
              </select>
            </label>
            <span aria-live="off">
              {t('ocrReview.pageOf', { page: activeDocument()?.currentPage ?? 1, total: totalPages() })}
            </span>
            <button
              type="button"
              aria-label={t('ocrReview.nextPage')}
              disabled={(activeDocument()?.currentPage ?? 1) >= totalPages() || actionBusy()}
              onClick={() => runAction(() => navigateToOcrReviewPage((activeDocument()?.currentPage ?? 1) + 1))}
            >
              ›
            </button>
          </nav>

          <div class="ocr-review-filter-row">
            <label>
              <input
                type="checkbox"
                checked={ocrReviewLowConfidenceOnly()}
                onChange={(event) => setOcrReviewLowConfidenceOnly(event.currentTarget.checked)}
              />
              {t('ocrReview.lowConfidenceFilter', { threshold: 80 })}
            </label>
            <span>
              {t('ocrReview.lowConfidenceCount', { count: review()?.lowConfidenceLines.length ?? 0 })}
            </span>
          </div>

          <div class="ocr-review-jump-actions">
            <button
              type="button"
              class="ocr-review-secondary-button"
              disabled={actionBusy()}
              onClick={() => runAction(navigateToNextOcrReviewWarning)}
            >
              {t('ocrReview.nextWarning')}
            </button>
            <button
              type="button"
              class="ocr-review-secondary-button"
              disabled={actionBusy()}
              onClick={() => runAction(navigateToNextLowConfidenceOcrItem)}
            >
              {t('ocrReview.nextLowConfidence')}
            </button>
          </div>

          <Show when={review()?.hasResult && !review()?.searchableEligible}>
            <p class="ocr-review-unsupported-summary" role="alert">
              {t('ocrReview.notSearchable')}
            </p>
          </Show>

          <Show when={(review()?.warnings.length ?? 0) > 0}>
            <section class="ocr-review-issues" aria-labelledby="ocr-review-warnings-heading">
              <h3 id="ocr-review-warnings-heading">{t('ocrReview.warnings')}</h3>
              <ul>
                <For each={review()?.warnings}>
                  {(warning) => <li><strong>{warning.code}</strong>: {warning.message}</li>}
                </For>
              </ul>
            </section>
          </Show>

          <Show when={(review()?.unsupportedReasons.length ?? 0) > 0}>
            <section class="ocr-review-issues unsupported" aria-labelledby="ocr-review-unsupported-heading">
              <h3 id="ocr-review-unsupported-heading">{t('ocrReview.unsupportedReasons')}</h3>
              <ul>
                <For each={review()?.unsupportedReasons}>
                  {(reason) => <li><strong>{reason.code}</strong>: {reason.message}</li>}
                </For>
              </ul>
            </section>
          </Show>

          <section class="ocr-review-recognized" aria-labelledby="ocr-review-recognized-heading">
            <h3 id="ocr-review-recognized-heading">{t('ocrReview.recognizedText')}</h3>
            <Show
              when={(review()?.lines.length ?? 0) > 0}
              fallback={<p class="ocr-review-empty">{t('ocrReview.noRecognizedText')}</p>}
            >
              <Show
                when={lines().length > 0}
                fallback={<p class="ocr-review-empty">{t('ocrReview.noLowConfidenceText')}</p>}
              >
                <ol class="ocr-review-line-list" aria-label={t('ocrReview.readingOrder')}>
                  <For each={lines()}>
                    {(line, index) => (
                      <OcrReviewLine
                        line={line}
                        t={t}
                        selected={selectedOcrReviewLineId() === line.id}
                        focusable={selectedOcrReviewLineId() === line.id || (!selectedVisible() && index() === 0)}
                        onSelect={selectOcrReviewLine}
                        onMove={(key) => moveLineFocus(index(), key)}
                        onAccept={acceptActiveOcrReviewCorrection}
                      />
                    )}
                  </For>
                </ol>
              </Show>
            </Show>
          </section>

          <Show when={actionError()}>
            <p class="ocr-review-error" role="alert">{actionError()}</p>
          </Show>

          <div class="ocr-review-document-actions" aria-label={t('ocrReview.actions')}>
            <button
              type="button"
              class="ocr-review-primary-button"
              data-ocr-action="rerun-page"
              disabled={actionBusy() || workflowBusy()
                || !ownedPageNumbers().includes(activeDocument()?.currentPage)}
              onClick={() => runAction(rerunActiveOcrReviewPage)}
            >
              {workflowBusy() ? t('ocrReview.rerunRunning') : t('ocrReview.rerunPage')}
            </button>
            <button
              type="button"
              class="ocr-review-danger-button"
              data-ocr-action="remove-page"
              disabled={actionBusy() || !ownedPageNumbers().includes(activeDocument()?.currentPage)}
              onClick={removeActiveOcrReviewPage}
            >
              {t('ocrReview.removePage')}
            </button>
            <Show when={ownedPageNumbers().length > 1}>
              <button
                type="button"
                class="ocr-review-danger-button"
                data-ocr-action="remove-document"
                disabled={actionBusy()}
                onClick={removeActiveOcrReviewDocument}
              >
                {t('ocrReview.removeDocument', { count: ownedPageNumbers().length })}
              </button>
            </Show>
            <div class="ocr-review-undo-actions">
              <button
                type="button"
                class="ocr-review-secondary-button"
                data-ocr-action="undo"
                aria-label={t('ocrReview.undoAccessible')}
                disabled={!canUndoOcrReviewAction() || actionBusy()}
                onClick={() => runAction(undoOcrReviewAction)}
              >
                {t('ocrReview.undo')}
              </button>
              <button
                type="button"
                class="ocr-review-secondary-button"
                data-ocr-action="redo"
                aria-label={t('ocrReview.redoAccessible')}
                disabled={!canRedoOcrReviewAction() || actionBusy()}
                onClick={() => runAction(redoOcrReviewAction)}
              >
                {t('ocrReview.redo')}
              </button>
            </div>
          </div>
        </Show>
      </div>

      <p class="ocr-review-live-region" role="status" aria-live="polite" aria-atomic="true">
        {ocrReviewAnnouncement()}
      </p>
    </div>
  );
}
