import { createSignal } from 'solid-js';

import Dialog from '../Dialog.jsx';
import { getActiveDocument } from '../../../core/state.js';
import { markDocumentModified } from '../../../ui/chrome/tabs.js';
import { refreshPendingOcrTextLayer } from '../../../text/text-layer.js';
import { mergeScannedTextEditRegionsForDocument } from '../../../ocr/editing/undo-commands.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { closeDialog } from '../../stores/dialogStore.js';

export default function OcrRegionMergeDialog(props) {
  const { t } = useTranslation('hardening');
  const data = props.data || {};
  const doc = getActiveDocument();
  const page = doc?.scannedTextEdits?.pages?.find((entry) => entry.index === data.pageNum - 1);
  const selections = (data.selectionIds || []).map((id) => page?.selections?.find((entry) => entry.id === id));
  const valid = selections.length === 2 && selections.every((selection) => selection?.repair?.status === 'applied');
  const [text, setText] = createSignal(valid
    ? selections.map((selection) => selection.content.replacementText).join('\n') : '');
  const [status, setStatus] = createSignal(valid ? '' : t('textEditor.status.operationFailed'));
  const [committing, setCommitting] = createSignal(false);

  function close() {
    if (!committing()) closeDialog('merge-ocr-regions');
  }

  async function commit() {
    if (!valid || committing() || !text().trim()) return;
    const liveDoc = getActiveDocument();
    const recognition = liveDoc?.ocr?.pages?.[data.pageNum]?.recognition;
    if (!liveDoc || !recognition?.result || !recognition?.geometry) {
      setStatus(t('textEditor.status.operationFailed'));
      return;
    }
    setCommitting(true);
    setStatus(t('textEditor.status.shaping'));
    try {
      await mergeScannedTextEditRegionsForDocument(liveDoc, data.selectionIds, {
        result: recognition.result,
        pageGeometry: recognition.geometry,
        replacementText: text(),
      });
      markDocumentModified();
      closeDialog('merge-ocr-regions');
      refreshPendingOcrTextLayer(data.pageNum);
      window.dispatchEvent(new CustomEvent('open-pdf-studio:request-text-edit-hover-refresh'));
    } catch (error) {
      console.warn('[ocr-region-merge] Merge failed:', error);
      setStatus(t('textEditor.status.operationFailed'));
      setCommitting(false);
    }
  }

  return (
    <Dialog
      title={t('ocrGrouping.mergeSelectedParagraphs')}
      dialogClass="ocr-region-merge-dialog"
      onClose={close}
      footer={
        <div style="display:flex;gap:6px;justify-content:flex-end;width:100%">
          <button class="ai-plan-btn" type="button" disabled={committing()} onClick={close}>
            {t('textEditor.actions.cancel')}
          </button>
          <button class="ai-plan-btn" type="button" disabled={!valid || committing() || !text().trim()}
            onClick={commit}>{t('ocrGrouping.mergeSelected')}</button>
        </div>
      }
    >
      <div style="min-width:500px">
        <p>{t('ocrGrouping.mergeDescription')}</p>
        <textarea class="ribbon-input" rows="10" aria-label={t('ocrGrouping.mergedText')}
          value={text()} disabled={committing()}
          onInput={(event) => setText(event.currentTarget.value)} />
        <div role="status" aria-live="polite" style="min-height:1.4em">{status()}</div>
      </div>
    </Dialog>
  );
}
