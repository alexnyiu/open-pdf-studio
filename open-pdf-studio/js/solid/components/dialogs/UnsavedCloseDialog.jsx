import { onCleanup } from 'solid-js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import Dialog from '../Dialog.jsx';

export default function UnsavedCloseDialog(props) {
  const { t: tCommon } = useTranslation('common');
  const { t: tDialogs } = useTranslation('dialogs');
  const data = props.data || {};
  const settle = (action) => data.settle?.(action);
  onCleanup(() => settle('cancel'));
  const fileName = () => data.fileName || 'Untitled.pdf';

  const footer = (
    <div class="unsaved-close-actions">
      <button
        type="button"
        class="pref-btn pref-btn-secondary unsaved-close-cancel"
        onClick={() => settle('cancel')}
      >{tCommon('cancel')}</button>
      <button
        type="button"
        class="pref-btn pref-btn-secondary unsaved-close-dont-save"
        onClick={() => settle('dontsave')}
      >{tCommon('close')}</button>
      {!data.dirtyTextEdit && (
        <button
          type="button"
          class="pref-btn pref-btn-primary unsaved-close-save"
          onClick={() => settle('save')}
        >{tCommon('save')}</button>
      )}
    </div>
  );

  return (
    <Dialog
      title={tDialogs('unsavedChanges.title')}
      dialogClass="unsaved-close-dialog"
      initialFocusSelector=".unsaved-close-cancel"
      onClose={() => settle('cancel')}
      footer={footer}
    >
      <p class="unsaved-close-message">
        {tDialogs('unsavedChanges.message', { names: fileName() })}
      </p>
    </Dialog>
  );
}
