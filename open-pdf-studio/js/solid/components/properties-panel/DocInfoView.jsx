import { For, Show, createEffect, createSignal } from 'solid-js';
import { panelMode, docInfo } from '../../stores/propertiesStore.js';
import CollapsibleSection from './CollapsibleSection.jsx';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { getActiveDocument } from '../../../core/state.js';
import {
  DOCUMENT_METADATA_DATE_FIELDS,
  documentMetadataFieldToEditorValue,
} from '../../../pdf/document-metadata.js';
import { commitDocumentMetadataField } from '../../stores/documentMetadataEditorStore.js';

const EDITABLE_METADATA_FIELDS = Object.freeze([
  'title',
  'author',
  'subject',
  'keywords',
  'creator',
  'producer',
  'creationDate',
  'modificationDate',
]);

const DATE_FIELDS = new Set(DOCUMENT_METADATA_DATE_FIELDS);

function focusMetadataField(field) {
  const target = document.querySelector(`[data-metadata-field="${field}"]`);
  target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

function InlineMetadataValue(props) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [error, setError] = createSignal('');
  const [ownerDocumentId, setOwnerDocumentId] = createSignal(null);
  let inputRef;
  let settling = false;

  const startEditing = () => {
    if (editing()) return;
    const documentState = getActiveDocument();
    if (!documentState) return;
    setOwnerDocumentId(documentState.id);
    setDraft(documentMetadataFieldToEditorValue(
      props.field,
      documentState.metadata?.[props.field],
    ));
    setError('');
    setEditing(true);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select?.();
    });
  };

  const cancel = () => {
    settling = true;
    setError('');
    setEditing(false);
    queueMicrotask(() => { settling = false; });
  };

  const commit = async () => {
    if (!editing() || settling) return false;
    settling = true;
    try {
      const result = await commitDocumentMetadataField({
        documentId: ownerDocumentId(),
        field: props.field,
        value: draft(),
      });
      if (result.stale) {
        setEditing(false);
        return false;
      }
      setError('');
      setEditing(false);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      queueMicrotask(() => inputRef?.focus());
      return false;
    } finally {
      settling = false;
    }
  };

  const moveAfterCommit = async (direction) => {
    const current = EDITABLE_METADATA_FIELDS.indexOf(props.field);
    const next = current + direction;
    if (next < 0 || next >= EDITABLE_METADATA_FIELDS.length) {
      await commit();
      return;
    }
    if (await commit()) queueMicrotask(() => focusMetadataField(EDITABLE_METADATA_FIELDS[next]));
  };

  createEffect(() => {
    props.displayValue;
    if (editing() && String(getActiveDocument()?.id) !== String(ownerDocumentId())) cancel();
  });

  return (
    <Show when={editing()} fallback={
      <span
        class="prop-info-value doc-metadata-inline-value"
        role="button"
        tabIndex="0"
        data-metadata-field={props.field}
        aria-label={`${props.label}. Double-click or press Enter to edit.`}
        onDblClick={startEditing}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            startEditing();
          }
        }}
      >{props.displayValue}</span>
    }>
      <span class="doc-metadata-inline-editor">
        <input
          ref={inputRef}
          class="doc-metadata-inline-input"
          type={DATE_FIELDS.has(props.field) ? 'datetime-local' : 'text'}
          step={DATE_FIELDS.has(props.field) ? '1' : undefined}
          value={draft()}
          data-metadata-editor={props.field}
          aria-label={`Edit ${props.label}`}
          aria-invalid={error() ? 'true' : 'false'}
          aria-describedby={error() ? `doc-metadata-error-${props.field}` : undefined}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => { if (!settling) void commit(); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            } else if (event.key === 'Tab') {
              event.preventDefault();
              void moveAfterCommit(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <Show when={error()}>
          <span id={`doc-metadata-error-${props.field}`} class="doc-metadata-inline-error" role="alert">
            {props.invalidMessage}
          </span>
        </Show>
      </span>
    </Show>
  );
}

export default function DocInfoView() {
  const { t } = useTranslation('properties');
  const { t: tDialogs } = useTranslation('dialogs');
  const metadataFields = [
    ['title', 'title'],
    ['author', 'author'],
    ['subject', 'subject'],
    ['keywords', 'keywords'],
    ['creator', 'creator'],
    ['producer', 'producer'],
    ['creationDate', 'creationDate'],
    ['modificationDate', 'modificationDate'],
  ];

  return (
    <Show when={panelMode() === 'none'}>
      <div id="prop-no-selection">
        <CollapsibleSection title={t('docInfo.document')} name="docDocument">
          <div class="property-group"><label>{t('docInfo.file')}</label><span class="prop-info-value" style="word-break: break-all;">{docInfo.filename}</span></div>
          <div class="property-group"><label>{t('docInfo.path')}</label><span class="prop-info-secondary" style="word-break: break-all;">{docInfo.filepath}</span></div>
          <div class="property-group"><label>{t('docInfo.pages')}</label><span class="prop-info-value">{docInfo.pages}</span></div>
          <div class="property-group"><label>{t('docInfo.pageSize')}</label><span class="prop-info-value">{docInfo.pageSize}</span></div>
        </CollapsibleSection>

        <CollapsibleSection title={t('docInfo.metadata')} name="docMetadata">
          <For each={metadataFields}>{([field, label]) => (
            <div class="property-group doc-metadata-property">
              <label>{t(`docInfo.${label}`)}</label>
              <InlineMetadataValue
                field={field}
                label={t(`docInfo.${label}`)}
                displayValue={docInfo[field]}
                invalidMessage={tDialogs('docProperties.invalidDate')}
              />
            </div>
          )}</For>
          <div class="property-group"><label>{t('docInfo.pdfVersion')}</label><span class="prop-info-value" data-metadata-readonly="pdfVersion">{docInfo.version}</span></div>
        </CollapsibleSection>

        <CollapsibleSection title={t('docInfo.annotations')} name="docAnnotations">
          <div class="property-group"><label>{t('docInfo.total')}</label><span class="prop-info-value">{docInfo.annotCount}</span></div>
          <div class="property-group"><label>{t('docInfo.onPage')}</label><span class="prop-info-value">{docInfo.annotPage}</span></div>
        </CollapsibleSection>

        <div class="prop-hint-text">{t('docInfo.selectHint')}</div>
      </div>
    </Show>
  );
}
