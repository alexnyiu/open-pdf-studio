import { createMemo, createSignal, onMount, Show } from 'solid-js';
import Dialog from '../Dialog.jsx';
import { getActiveDocument } from '../../../core/state.js';
import {
  CORE_OCR_RECOGNITION_UI_PROFILE,
  estimateOcrStorageImpact,
  resolveOcrDialogPageSelection,
  resolveOcrDialogRecognitionPolicy,
} from '../../../ocr/recognition-dialog-model.js';
import { closeDialog } from '../../stores/dialogStore.js';
import {
  activeDocumentOcrWorkflow,
  ocrModelPackState,
  ocrWorkflowActionFailure,
  refreshOcrModelPackState,
  startOcrFromApplicationAction,
} from '../../stores/ocrWorkflowStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';

const FORM_ID = 'ocr-recognition-form';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

export default function RecognizeTextDialog() {
  const { t } = useTranslation('dialogs');
  const { t: tCommon } = useTranslation('common');
  const document = getActiveDocument();
  const pageCount = document?.pdfDoc?.numPages ?? 0;
  const currentPage = document?.currentPage ?? 1;
  const [scopeKind, setScopeKind] = createSignal('current-page');
  const [rangeStart, setRangeStart] = createSignal(String(currentPage));
  const [rangeEnd, setRangeEnd] = createSignal(String(currentPage));
  const [existingText, setExistingText] = createSignal('skip');
  const [keepCompletedPages, setKeepCompletedPages] = createSignal(true);
  const [rangeTouched, setRangeTouched] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [startFailure, setStartFailure] = createSignal(null);

  const close = () => {
    if (!starting()) closeDialog('recognize-text');
  };

  const selection = createMemo(() => {
    try {
      return {
        value: resolveOcrDialogPageSelection({
          scopeKind: scopeKind(),
          startPage: rangeStart(),
          endPage: rangeEnd(),
          currentPage,
          pageCount,
        }),
        error: null,
      };
    } catch (error) {
      return { value: null, error };
    }
  });
  const modelReady = () => ocrModelPackState().status === 'installed';
  const activeJob = () => activeDocumentOcrWorkflow()?.finishedAt === null;
  const storage = createMemo(() => estimateOcrStorageImpact({
    pageCount: selection().value?.pageNumbers.length ?? 0,
    modelState: ocrModelPackState(),
  }));
  const rangeInvalid = () => scopeKind() === 'range' && !!selection().error;
  const startDisabled = () => starting() || activeJob() || !modelReady() || !!selection().error;

  async function verifyModel(force = false) {
    setStartFailure(null);
    try {
      await refreshOcrModelPackState({ force });
    } catch (error) {
      setStartFailure(error?.code ?? 'OCR_MODEL_UNAVAILABLE');
    }
  }

  async function handleStart(event) {
    event.preventDefault();
    setRangeTouched(true);
    setStartFailure(null);
    if (startDisabled()) return;
    setStarting(true);
    try {
      const recognitionPolicy = resolveOcrDialogRecognitionPolicy({
        existingText: existingText(),
        keepCompletedPages: keepCompletedPages(),
      });
      await startOcrFromApplicationAction({
        pageScope: selection().value.pageScope,
        recognitionPolicy,
      });
      closeDialog('recognize-text');
    } catch (error) {
      setStartFailure(error?.code ?? 'OCR_WORKFLOW_FAILED');
      setStarting(false);
    }
  }

  onMount(() => { void verifyModel(false); });

  const footer = (
    <>
      <div class="ocr-dialog-footer-status" role="status" aria-live="polite">
        <Show when={starting()}>{t('recognizeText.starting')}</Show>
      </div>
      <div class="ocr-dialog-footer-actions">
        <button
          type="submit"
          form={FORM_ID}
          class="pref-btn pref-btn-primary"
          disabled={startDisabled()}
        >
          {t('recognizeText.start')}
        </button>
        <button type="button" class="pref-btn pref-btn-secondary" onClick={close} disabled={starting()}>
          {tCommon('cancel')}
        </button>
      </div>
    </>
  );

  return (
    <Dialog
      title={t('recognizeText.title')}
      closeLabel={tCommon('close')}
      dialogClass="ocr-recognition-dialog"
      bodyClass="ocr-recognition-content"
      footerClass="ocr-recognition-footer"
      onClose={close}
      initialFocusSelector="input[name='ocr-page-scope']:checked"
      trapFocus
      footer={footer}
    >
      <form id={FORM_ID} class="ocr-recognition-form" onSubmit={handleStart}>
        <fieldset class="ocr-dialog-section">
          <legend>{t('recognizeText.pages')}</legend>
          <label class="ocr-radio-row">
            <input
              type="radio"
              name="ocr-page-scope"
              value="current-page"
              checked={scopeKind() === 'current-page'}
              onChange={() => setScopeKind('current-page')}
            />
            <span>{t('recognizeText.currentPage', { page: currentPage })}</span>
          </label>
          <label class="ocr-radio-row">
            <input
              type="radio"
              name="ocr-page-scope"
              value="range"
              checked={scopeKind() === 'range'}
              onChange={() => setScopeKind('range')}
            />
            <span>{t('recognizeText.pageRange')}</span>
          </label>
          <div class="ocr-range-inputs" aria-describedby="ocr-page-range-help ocr-page-range-error">
            <label for="ocr-range-start">{t('recognizeText.from')}</label>
            <input
              id="ocr-range-start"
              type="number"
              min="1"
              max={pageCount}
              value={rangeStart()}
              disabled={scopeKind() !== 'range'}
              aria-invalid={rangeTouched() && rangeInvalid() ? 'true' : 'false'}
              onInput={(event) => { setRangeTouched(true); setRangeStart(event.currentTarget.value); }}
            />
            <label for="ocr-range-end">{t('recognizeText.to')}</label>
            <input
              id="ocr-range-end"
              type="number"
              min="1"
              max={pageCount}
              value={rangeEnd()}
              disabled={scopeKind() !== 'range'}
              aria-invalid={rangeTouched() && rangeInvalid() ? 'true' : 'false'}
              onInput={(event) => { setRangeTouched(true); setRangeEnd(event.currentTarget.value); }}
            />
          </div>
          <div id="ocr-page-range-help" class="ocr-dialog-help">
            {t('recognizeText.rangeHelp', { pages: pageCount })}
          </div>
          <Show when={rangeTouched() && rangeInvalid()}>
            <div id="ocr-page-range-error" class="ocr-dialog-error" role="alert">
              {t('recognizeText.rangeError', { pages: pageCount })}
            </div>
          </Show>
          <label class="ocr-radio-row">
            <input
              type="radio"
              name="ocr-page-scope"
              value="entire-document"
              checked={scopeKind() === 'entire-document'}
              onChange={() => setScopeKind('entire-document')}
            />
            <span>{t('recognizeText.entireDocument', { pages: pageCount })}</span>
          </label>
        </fieldset>

        <fieldset class="ocr-dialog-section">
          <legend>{t('recognizeText.recognition')}</legend>
          <label class="ocr-control-row" for="ocr-language-mode">
            <span>{t('recognizeText.language')}</span>
            <select id="ocr-language-mode" disabled aria-describedby="ocr-language-help">
              <option>{t('recognizeText.automaticMultilingual')}</option>
            </select>
          </label>
          <div id="ocr-language-help" class="ocr-dialog-help">
            {t('recognizeText.fixedMultilingualHelp', {
              languages: ocrModelPackState().supportedLanguages?.length ?? 0,
            })}
          </div>
          <label class="ocr-checkbox-row" aria-describedby="ocr-orientation-help">
            <input type="checkbox" disabled checked={false} />
            <span>{t('recognizeText.automaticOrientation')}</span>
          </label>
          <div id="ocr-orientation-help" class="ocr-dialog-help">
            {t('recognizeText.orientationUnavailable')}
          </div>
          <label class="ocr-checkbox-row" aria-describedby="ocr-deskew-help">
            <input type="checkbox" disabled checked={false} />
            <span>{t('recognizeText.deskew')}</span>
          </label>
          <div id="ocr-deskew-help" class="ocr-dialog-help">
            {t('recognizeText.deskewUnavailable')}
          </div>
        </fieldset>

        <fieldset class="ocr-dialog-section">
          <legend>{t('recognizeText.existingText')}</legend>
          <label class="ocr-radio-row">
            <input
              type="radio"
              name="ocr-existing-text"
              value="skip"
              checked={existingText() === 'skip'}
              onChange={() => setExistingText('skip')}
            />
            <span>
              <strong>{t('recognizeText.skipExisting')}</strong>
              <small>{t('recognizeText.skipExistingHelp')}</small>
            </span>
          </label>
          <label class="ocr-radio-row">
            <input
              type="radio"
              name="ocr-existing-text"
              value="force-rerun"
              checked={existingText() === 'force-rerun'}
              onChange={() => setExistingText('force-rerun')}
            />
            <span>
              <strong>{t('recognizeText.forceRerun')}</strong>
              <small>{t('recognizeText.forceRerunHelp')}</small>
            </span>
          </label>
          <label class="ocr-checkbox-row">
            <input
              type="checkbox"
              checked={keepCompletedPages()}
              onChange={(event) => setKeepCompletedPages(event.currentTarget.checked)}
            />
            <span>{t('recognizeText.keepCompleted')}</span>
          </label>
        </fieldset>

        <section class="ocr-dialog-section" aria-labelledby="ocr-model-heading">
          <h3 id="ocr-model-heading">{t('recognizeText.modelPack')}</h3>
          <dl class="ocr-status-list">
            <div>
              <dt>{t('recognizeText.status')}</dt>
              <dd data-status={ocrModelPackState().status}>
                {t(`recognizeText.modelStatus.${ocrModelPackState().status}`)}
              </dd>
            </div>
            <div>
              <dt>{t('recognizeText.pack')}</dt>
              <dd>{ocrModelPackState().identity?.packId ?? t('recognizeText.notVerified')}</dd>
            </div>
            <div>
              <dt>{t('recognizeText.verification')}</dt>
              <dd>
                {ocrModelPackState().verifiedAt
                  ? t('recognizeText.verified', { date: new Date(ocrModelPackState().verifiedAt).toLocaleString() })
                  : t('recognizeText.notVerified')}
              </dd>
            </div>
          </dl>
          <Show when={!modelReady() && ocrModelPackState().status !== 'updating'}>
            <button type="button" class="ocr-inline-action" onClick={() => void verifyModel(true)}>
              {tCommon('retry')}
            </button>
          </Show>
          <Show when={ocrModelPackState().error?.code}>
            <div class="ocr-dialog-error" role="alert">
              {t('recognizeText.modelError', { code: ocrModelPackState().error.code })}
            </div>
          </Show>
        </section>

        <section class="ocr-dialog-section" aria-labelledby="ocr-impact-heading">
          <h3 id="ocr-impact-heading">{t('recognizeText.offlineAndStorage')}</h3>
          <p class="ocr-dialog-status-text">
            <strong>{CORE_OCR_RECOGNITION_UI_PROFILE.offline ? t('recognizeText.offline') : ''}</strong>
            {' '}{t('recognizeText.offlineHelp')}
          </p>
          <p class="ocr-dialog-status-text">
            {t('recognizeText.storageEstimate', {
              model: formatBytes(storage().modelPackBytes),
              cache: formatBytes(storage().estimatedCacheBytes),
              pages: storage().selectedPages,
              maximum: formatBytes(storage().cacheMaximumBytes),
            })}
          </p>
        </section>

        <section class="ocr-dialog-section" aria-labelledby="ocr-support-heading">
          <h3 id="ocr-support-heading">{t('recognizeText.contentSupport')}</h3>
          <p class="ocr-dialog-status-text"><strong>{t('recognizeText.supportedLabel')}</strong> {t('recognizeText.supported')}</p>
          <p class="ocr-dialog-status-text"><strong>{t('recognizeText.unsupportedLabel')}</strong> {t('recognizeText.unsupported')}</p>
        </section>

        <Show when={startFailure() || ocrWorkflowActionFailure()}>
          <div class="ocr-dialog-error ocr-start-error" role="alert">
            {t('recognizeText.startError', {
              code: startFailure() ?? ocrWorkflowActionFailure()?.code ?? 'OCR_WORKFLOW_FAILED',
            })}
          </div>
        </Show>
      </form>
    </Dialog>
  );
}
