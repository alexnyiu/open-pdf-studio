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
  const [ownerDocumentGeneration, setOwnerDocumentGeneration] = createSignal(0);
  const [initialDraft, setInitialDraft] = createSignal('');
  let inputRef;
  let settling = false;

  const startEditing = () => {
    if (editing()) return;
    const documentState = getActiveDocument();
    if (!documentState) return;
    setOwnerDocumentId(documentState.id);
    setOwnerDocumentGeneration(Number(documentState.lifecycleGeneration) || 0);
    const editorValue = documentMetadataFieldToEditorValue(
      props.field,
      documentState.metadata?.[props.field],
    );
    setInitialDraft(editorValue);
    setDraft(editorValue);
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

  const commit = async ({ retainFocusOnFailure = false } = {}) => {
    if (!editing() || settling) return false;
    settling = true;
    try {
      if (draft() === initialDraft()) {
        setError('');
        setEditing(false);
        return true;
      }
      const result = await commitDocumentMetadataField({
        documentId: ownerDocumentId(),
        documentGeneration: ownerDocumentGeneration(),
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
      if (retainFocusOnFailure) queueMicrotask(() => inputRef?.focus());
      return false;
    } finally {
      settling = false;
    }
  };

  const moveAfterCommit = async (direction) => {
    const current = EDITABLE_METADATA_FIELDS.indexOf(props.field);
    const next = current + direction;
    if (await commit({ retainFocusOnFailure: true })) {
      queueMicrotask(() => focusMetadataField(EDITABLE_METADATA_FIELDS[next]));
    }
  };

  createEffect(() => {
    props.displayValue;
    const active = getActiveDocument();
    if (editing() && (String(active?.id) !== String(ownerDocumentId())
      || (Number(active?.lifecycleGeneration) || 0) !== ownerDocumentGeneration())) cancel();
  });

  return (
    <Show when={editing()} fallback={
      <span
        class="prop-info-value doc-metadata-inline-value"
        role="button"
        tabIndex="0"
        data-metadata-field={props.field}
        aria-label={props.editHint}
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
          step={DATE_FIELDS.has(props.field) ? '0.001' : undefined}
          value={draft()}
          data-metadata-editor={props.field}
          aria-label={props.editLabel}
          aria-invalid={error() ? 'true' : 'false'}
          aria-describedby={error() ? `doc-metadata-error-${props.field}` : undefined}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
          }}
          onBlur={() => { if (!settling) void commit({ retainFocusOnFailure: false }); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              void commit({ retainFocusOnFailure: true });
            } else if (event.key === 'Tab') {
              const current = EDITABLE_METADATA_FIELDS.indexOf(props.field);
              const next = current + (event.shiftKey ? -1 : 1);
              if (next < 0 || next >= EDITABLE_METADATA_FIELDS.length) return;
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
  const { t: tHardening } = useTranslation('hardening');
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
                editLabel={tHardening('metadata.editValue', { label: t(`docInfo.${label}`) })}
                editHint={tHardening('metadata.editValueHint', { label: t(`docInfo.${label}`) })}
              />
            </div>
          )}</For>
          <div class="doc-metadata-timezone-hint">
            {tHardening('metadata.timezoneHint', {
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
            })}
          </div>
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
