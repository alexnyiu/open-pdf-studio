import { For, Show, createSignal } from 'solid-js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import {
  createStylePreset,
  deleteStylePreset,
  getStylePresets,
  renameStylePreset,
} from '../../stores/stylePresetsStore.js';
import { closeDialog } from '../../stores/dialogStore.js';
import Dialog from '../Dialog.jsx';

const CREATE_DIALOG = 'style-preset-create';
const MANAGE_DIALOG = 'style-preset-manage';

export function StylePresetCreateDialog() {
  const { t } = useTranslation('properties');
  const { t: tCommon } = useTranslation('common');
  const [presetName, setPresetName] = createSignal(
    `${t('stylePresets.defaultName')} ${getStylePresets().length + 1}`,
  );
  const close = () => closeDialog(CREATE_DIALOG);
  const confirm = () => {
    if (createStylePreset(presetName())) close();
  };

  return (
    <Dialog
      title={t('stylePresets.createTitle')}
      dialogClass="style-preset-dialog style-preset-create-dialog"
      initialFocusSelector="#style-preset-name-input"
      onClose={close}
      footer={
        <>
          <button type="button" class="pref-btn pref-btn-secondary" onClick={close}>
            {tCommon('cancel')}
          </button>
          <button
            type="button"
            class="pref-btn pref-btn-primary"
            disabled={!presetName().trim()}
            onClick={confirm}
          >
            {tCommon('ok')}
          </button>
        </>
      }
    >
      <div class="style-preset-name-row">
        <label for="style-preset-name-input">{t('stylePresets.nameLabel')}</label>
        <input
          id="style-preset-name-input"
          type="text"
          value={presetName()}
          onFocus={(event) => event.currentTarget.select()}
          onInput={(event) => setPresetName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && presetName().trim()) confirm();
          }}
        />
      </div>
    </Dialog>
  );
}

export function StylePresetManageDialog() {
  const { t } = useTranslation('properties');
  const { t: tCommon } = useTranslation('common');
  const close = () => closeDialog(MANAGE_DIALOG);

  return (
    <Dialog
      title={t('stylePresets.manageTitle')}
      dialogClass="style-preset-dialog style-preset-manage-dialog"
      onClose={close}
      footer={
        <button type="button" class="pref-btn pref-btn-primary" onClick={close}>
          {tCommon('close')}
        </button>
      }
    >
      <div class="style-preset-list">
        <For each={getStylePresets()}>
          {(preset) => (
            <div class="style-preset-list-row">
              <input
                type="text"
                value={preset.name}
                onChange={(event) => renameStylePreset(preset.id, event.currentTarget.value)}
              />
              <button
                type="button"
                class="pref-btn"
                onClick={() => deleteStylePreset(preset.id)}
              >
                {tCommon('delete')}
              </button>
            </div>
          )}
        </For>
        <Show when={getStylePresets().length === 0}>
          <div class="style-preset-empty">{t('stylePresets.noPresets')}</div>
        </Show>
      </div>
    </Dialog>
  );
}

