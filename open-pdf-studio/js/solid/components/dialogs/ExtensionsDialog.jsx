import { useTranslation } from '../../../i18n/useTranslation.js';
import Dialog from '../Dialog.jsx';
import { closeDialog } from '../../stores/dialogStore.js';
import ExtensionsPanel from '../app-menu/ExtensionsPanel.jsx';

export default function ExtensionsDialog() {
  const { t } = useTranslation('appMenu');
  const close = () => closeDialog('extensions');

  return (
    <Dialog
      title={t('extensions')}
      dialogClass="extensions-dialog"
      onClose={close}
    >
      <ExtensionsPanel />
    </Dialog>
  );
}
