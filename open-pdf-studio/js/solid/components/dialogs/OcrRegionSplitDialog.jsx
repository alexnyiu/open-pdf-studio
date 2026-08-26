import { createSignal } from 'solid-js';

import Dialog from '../Dialog.jsx';
import { getActiveDocument } from '../../../core/state.js';
import { markDocumentModified } from '../../../ui/chrome/tabs.js';
import { refreshPendingOcrTextLayer } from '../../../text/text-layer.js';
import {
  prepareScannedTextRegionSplit,
  splitScannedTextEditRegionForDocument,
} from '../../../ocr/editing/undo-commands.js';
import { closeDialog } from '../../stores/dialogStore.js';

export default function OcrRegionSplitDialog(props) {
  const data = props.data || {};
  const doc = getActiveDocument();
  const page = doc?.scannedTextEdits?.pages?.find((entry) => entry.index === data.pageNum - 1);
  const selection = page?.selections?.find((entry) => entry.id === data.selectionId);
  let prepared = null;
  let preparationError = '';
  try { prepared = prepareScannedTextRegionSplit(selection, data.boundaryIndex); }
  catch (error) { preparationError = error?.message || String(error); }
  const [leftText, setLeftText] = createSignal(prepared?.leftText || '');
  const [rightText, setRightText] = createSignal(prepared?.rightText || '');
  const [status, setStatus] = createSignal(preparationError);
  const [committing, setCommitting] = createSignal(false);

  function close() {
    if (!committing()) closeDialog('split-ocr-region');
  }

  async function commit() {
    if (!prepared || committing() || !leftText().trim() || !rightText().trim()) return;
    const liveDoc = getActiveDocument();
    const recognition = liveDoc?.ocr?.pages?.[data.pageNum]?.recognition;
    if (!liveDoc || !recognition?.result || !recognition?.geometry) {
      setStatus('The current application-owned OCR source is unavailable.');
      return;
    }
    setCommitting(true);
    setStatus('Validating both child regions…');
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
      setStatus(`Split rejected: ${error?.message || String(error)}`);
      setCommitting(false);
    }
  }

  return (
    <Dialog
      title="Split OCR Region"
      dialogClass="ocr-region-split-dialog"
      onClose={close}
      footer={
        <div style="display:flex;gap:6px;justify-content:flex-end;width:100%">
          <button class="ai-plan-btn" type="button" disabled={committing()} onClick={close}>Cancel</button>
          <button class="ai-plan-btn" type="button"
            disabled={!prepared || committing() || !leftText().trim() || !rightText().trim()}
            onClick={commit}>Split</button>
        </div>
      }
    >
      <div style="min-width:560px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <section>
          <label for="ocr-split-left">First region</label>
          <div class="property-hint">Source lines: {prepared?.leftLineIds.join(', ') || '—'}</div>
          <textarea id="ocr-split-left" class="ribbon-input" rows="8"
            value={leftText()} disabled={committing()}
            onInput={(event) => setLeftText(event.currentTarget.value)} />
        </section>
        <section>
          <label for="ocr-split-right">Second region</label>
          <div class="property-hint">Source lines: {prepared?.rightLineIds.join(', ') || '—'}</div>
          <textarea id="ocr-split-right" class="ribbon-input" rows="8"
            value={rightText()} disabled={committing()}
            onInput={(event) => setRightText(event.currentTarget.value)} />
        </section>
        <div role="status" aria-live="polite" style="grid-column:1 / -1;min-height:1.4em">{status()}</div>
      </div>
    </Dialog>
  );
}
