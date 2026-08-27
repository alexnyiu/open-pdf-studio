import { For, Show, createMemo } from 'solid-js';
import { createStore } from 'solid-js/store';
import Dialog from './Dialog.jsx';
import { closeDialog } from '../stores/dialogStore.js';
import { useTranslation } from '../../i18n/useTranslation.js';
import { getActiveDocument } from '../../core/state.js';
import {
  cloneDocumentMetadata,
  documentMetadataFieldFromEditorValue,
  documentMetadataFieldToEditorValue,
  normalizeDocumentMetadata,
} from '../../pdf/document-metadata.js';
import { commitDocumentMetadata } from '../stores/documentMetadataEditorStore.js';

function PropRow(props) {
  return (
    <div class="doc-props-row">
      <span class="doc-props-label">{props.label}</span>
      <span class="doc-props-value">{props.value}</span>
    </div>
  );
}

export default function DocPropertiesDialog(props) {
  const { t } = useTranslation('dialogs');
  const { t: tCommon } = useTranslation('common');
  const { t: tHardening } = useTranslation('hardening');
  const d = props.data || {};
  const activeOwner = getActiveDocument();
  const ownerDocumentId = d.ownerDocumentId ?? activeOwner?.id;
  const ownerDocumentGeneration = d.ownerDocumentGeneration
    ?? (Number(activeOwner?.lifecycleGeneration) || 0);
  const initial = cloneDocumentMetadata(d.metadata);
  const initialCreationEditorValue = documentMetadataFieldToEditorValue(
    'creationDate', initial.creationDate,
  );
  const initialModificationEditorValue = documentMetadataFieldToEditorValue(
    'modificationDate', initial.modificationDate,
  );
  const [form, setForm] = createStore({
    ...initial,
    creationDate: initialCreationEditorValue,
    modificationDate: initialModificationEditorValue,
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
        creationDate: form.creationDate === initialCreationEditorValue
          ? initial.creationDate
          : documentMetadataFieldFromEditorValue('creationDate', form.creationDate),
        modificationDate: form.modificationDate === initialModificationEditorValue
          ? initial.modificationDate
          : documentMetadataFieldFromEditorValue('modificationDate', form.modificationDate),
      });
    } catch {
      return null;
    }
  });

  const close = () => closeDialog('doc-properties');
  const save = async () => {
    const metadata = parsed();
    if (!metadata || ownerDocumentId == null) return;
    const result = await commitDocumentMetadata({
      documentId: ownerDocumentId,
      documentGeneration: ownerDocumentGeneration,
      metadata,
    });
    if (result.stale) return;
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
          <input type="datetime-local" step="0.001" value={form.creationDate} onInput={(event) => setForm('creationDate', event.currentTarget.value)} />
        </label>
        <label class="doc-props-edit-row">
          <span class="doc-props-label">{t('docProperties.modifiedDate')}</span>
          <input type="datetime-local" step="0.001" value={form.modificationDate} onInput={(event) => setForm('modificationDate', event.currentTarget.value)} />
        </label>
        <div class="doc-metadata-timezone-hint">
          {tHardening('metadata.timezoneHint', {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
          })}
        </div>
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
