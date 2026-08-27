import { createSignal } from 'solid-js';

import Dialog from '../Dialog.jsx';
import { getActiveDocument } from '../../../core/state.js';
import { markDocumentModified } from '../../../ui/chrome/tabs.js';
import { refreshPendingOcrTextLayer } from '../../../text/text-layer.js';
import {
  prepareScannedTextRegionSplit,
  splitScannedTextEditRegionForDocument,
} from '../../../ocr/editing/undo-commands.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { closeDialog } from '../../stores/dialogStore.js';

export default function OcrRegionSplitDialog(props) {
  const { t } = useTranslation('hardening');
  const data = props.data || {};
  const doc = getActiveDocument();
  const page = doc?.scannedTextEdits?.pages?.find((entry) => entry.index === data.pageNum - 1);
  const selection = page?.selections?.find((entry) => entry.id === data.selectionId);
  let prepared = null;
  let preparationFailed = false;
  try { prepared = prepareScannedTextRegionSplit(selection, data.boundaryIndex); }
  catch (error) {
    console.warn('[ocr-region-split] Preparation failed:', error);
    preparationFailed = true;
  }
  const [leftText, setLeftText] = createSignal(prepared?.leftText || '');
  const [rightText, setRightText] = createSignal(prepared?.rightText || '');
  const [status, setStatus] = createSignal(
    preparationFailed ? t('textEditor.status.operationFailed') : '',
  );
  const [committing, setCommitting] = createSignal(false);

  function close() {
    if (!committing()) closeDialog('split-ocr-region');
  }

  async function commit() {
    if (!prepared || committing() || !leftText().trim() || !rightText().trim()) return;
    const liveDoc = getActiveDocument();
    const recognition = liveDoc?.ocr?.pages?.[data.pageNum]?.recognition;
    if (!liveDoc || !recognition?.result || !recognition?.geometry) {
      setStatus(t('textEditor.status.operationFailed'));
      return;
    }
    setCommitting(true);
    setStatus(t('textEditor.status.shaping'));
    try {
      await splitScannedTextEditRegionForDocument(liveDoc, data.selectionId, {
        result: recognition.result,
        pageGeometry: recognition.geometry,
        boundaryIndex: data.boundaryIndex,
        leftText: leftText(),
        rightText: rightText(),
      });
      markDocumentModified();
      closeDialog('split-ocr-region');
      refreshPendingOcrTextLayer(data.pageNum);
      window.dispatchEvent(new CustomEvent('open-pdf-studio:request-text-edit-hover-refresh'));
    } catch (error) {
      console.warn('[ocr-region-split] Split failed:', error);
      setStatus(t('textEditor.status.operationFailed'));
      setCommitting(false);
    }
  }

  return (
    <Dialog
      title={t('ocrGrouping.splitRegion')}
      dialogClass="ocr-region-split-dialog"
      onClose={close}
      footer={
        <div style="display:flex;gap:6px;justify-content:flex-end;width:100%">
          <button class="ai-plan-btn" type="button" disabled={committing()} onClick={close}>
            {t('textEditor.actions.cancel')}
          </button>
          <button class="ai-plan-btn" type="button"
            disabled={!prepared || committing() || !leftText().trim() || !rightText().trim()}
            onClick={commit}>{t('ocrGrouping.splitRegion')}</button>
        </div>
      }
    >
      <div style="min-width:560px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <section>
          <label for="ocr-split-left">{t('ocrGrouping.firstRegion')}</label>
          <div class="property-hint">{t('ocrGrouping.sourceLines', {
            lines: prepared?.leftLineIds.join(', ') || '—',
          })}</div>
          <textarea id="ocr-split-left" class="ribbon-input" rows="8"
            value={leftText()} disabled={committing()}
            onInput={(event) => setLeftText(event.currentTarget.value)} />
        </section>
        <section>
          <label for="ocr-split-right">{t('ocrGrouping.secondRegion')}</label>
          <div class="property-hint">{t('ocrGrouping.sourceLines', {
            lines: prepared?.rightLineIds.join(', ') || '—',
          })}</div>
          <textarea id="ocr-split-right" class="ribbon-input" rows="8"
            value={rightText()} disabled={committing()}
            onInput={(event) => setRightText(event.currentTarget.value)} />
        </section>
        <div role="status" aria-live="polite" style="grid-column:1 / -1;min-height:1.4em">{status()}</div>
      </div>
    </Dialog>
  );
}
