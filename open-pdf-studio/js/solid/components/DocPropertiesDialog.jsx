import { For, Show, createMemo } from 'solid-js';
import { createStore } from 'solid-js/store';
import Dialog from './Dialog.jsx';
import { closeDialog } from '../stores/dialogStore.js';
import { useTranslation } from '../../i18n/useTranslation.js';
import { getActiveDocument } from '../../core/state.js';
import { recordDocumentMetadata } from '../../core/undo-manager.js';
import {
  cloneDocumentMetadata,
  documentMetadataEqual,
  normalizeDocumentMetadata,
} from '../../pdf/document-metadata.js';
import { populateDocInfo } from '../stores/propertiesStore.js';

function PropRow(props) {
  return (
    <div class="doc-props-row">
      <span class="doc-props-label">{props.label}</span>
      <span class="doc-props-value">{props.value}</span>
    </div>
  );
}

function toLocalDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 19);
}

function fromLocalDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid date');
  return date.toISOString();
}

export default function DocPropertiesDialog(props) {
  const { t } = useTranslation('dialogs');
  const { t: tCommon } = useTranslation('common');
  const d = props.data;
  const initial = cloneDocumentMetadata(d.metadata);
  const [form, setForm] = createStore({
    ...initial,
    creationDate: toLocalDateTime(initial.creationDate),
    modificationDate: toLocalDateTime(initial.modificationDate),
  });
  const fields = [
    ['title', 'docTitle'],
    ['author', 'author'],
    ['subject', 'subject'],
    ['keywords', 'keywords'],
    ['creator', 'creator'],
    ['producer', 'producer'],
  ];

  const parsed = createMemo(() => {
    try {
      return normalizeDocumentMetadata({
        ...form,
        creationDate: fromLocalDateTime(form.creationDate),
        modificationDate: fromLocalDateTime(form.modificationDate),
      });
    } catch {
      return null;
    }
  });

  const close = () => closeDialog('doc-properties');
  const save = async () => {
    const metadata = parsed();
    const doc = getActiveDocument();
    if (!metadata || !doc) return;
    if (!documentMetadataEqual(initial, metadata)) {
      doc.metadata = cloneDocumentMetadata(metadata);
      recordDocumentMetadata(initial, metadata);
      await populateDocInfo();
    }
    close();
  };

  const footer = (
    <>
      <button onClick={close}>{tCommon('cancel')}</button>
      <button class="doc-props-save" disabled={!parsed()} onClick={save}>{tCommon('save')}</button>
    </>
  );

  return (
    <Dialog
      title={t('docProperties.title')}
      overlayClass="doc-props-overlay"
      dialogClass="doc-props-dialog"
      bodyClass="doc-props-content"
      footerClass="doc-props-footer"
      onClose={close}
      footer={footer}
    >
      <div class="doc-props-section">
        <h3>{t('docProperties.file')}</h3>
        <PropRow label={t('docProperties.fileName')} value={d.fileName} />
        <PropRow label={t('docProperties.filePath')} value={d.filePath} />
        <PropRow label={t('docProperties.fileSize')} value={d.fileSize} />
      </div>
      <div class="doc-props-section">
        <h3>{t('docProperties.document')}</h3>
        <For each={fields}>{([field, label]) => (
          <label class="doc-props-edit-row">
            <span class="doc-props-label">{t(`docProperties.${label}`)}</span>
            <input
              type="text"
              value={form[field]}
              onInput={(event) => setForm(field, event.currentTarget.value)}
            />
          </label>
        )}</For>
        <label class="doc-props-edit-row">
          <span class="doc-props-label">{t('docProperties.creationDate')}</span>
          <input type="datetime-local" step="1" value={form.creationDate} onInput={(event) => setForm('creationDate', event.currentTarget.value)} />
        </label>
        <label class="doc-props-edit-row">
          <span class="doc-props-label">{t('docProperties.modifiedDate')}</span>
          <input type="datetime-local" step="1" value={form.modificationDate} onInput={(event) => setForm('modificationDate', event.currentTarget.value)} />
        </label>
        <Show when={!parsed()}><div class="doc-props-error">{t('docProperties.invalidDate')}</div></Show>
      </div>
      <div class="doc-props-section">
        <h3>{t('docProperties.pdfInfo')}</h3>
        <PropRow label={t('docProperties.pdfVersion')} value={d.pdfVersion} />
        <PropRow label={t('docProperties.pageCount')} value={d.pageCount} />
        <PropRow label={t('docProperties.pageSize')} value={d.pageSize} />
      </div>
    </Dialog>
  );
}
